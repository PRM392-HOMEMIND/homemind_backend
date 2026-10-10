begin;
create table public.family_validation_limits(owner_id uuid primary key references public.users(id),window_at timestamptz not null,attempts integer not null check(attempts between 1 and 5));
alter table public.family_validation_limits enable row level security;
revoke all on public.family_validation_limits from public,homemind_app;
create function public.family_validate_batch(p_workspace uuid,p_entries jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=public.current_user_id();t timestamptz:=clock_timestamp();lim public.family_validation_limits%rowtype;seats integer;result jsonb;
begin
 if not exists(select 1 from public.workspace_members m join public.workspaces w on w.id=m.workspace_id join public.users u on u.id=m.user_id
  where m.workspace_id=p_workspace and m.user_id=uid and m.role='owner' and u.status='ACTIVE' and w.archived_at is null) then raise exception 'FORBIDDEN'; end if;
 if public.family_effective_at(p_workspace,t)->>'plan'<>'family' then raise exception 'FAMILY_NOT_ELIGIBLE'; end if;
 if jsonb_typeof(p_entries)<>'array' or jsonb_array_length(p_entries) not between 1 and 5 then raise exception 'VALIDATION_ERROR'; end if;
 insert into public.family_validation_limits(owner_id,window_at,attempts) values(uid,t,1)
 on conflict(owner_id) do update set window_at=case when family_validation_limits.window_at<=t-interval '1 minute' then t else family_validation_limits.window_at end,
  attempts=case when family_validation_limits.window_at<=t-interval '1 minute' then 1 else family_validation_limits.attempts+1 end
 where family_validation_limits.window_at<=t-interval '1 minute' or family_validation_limits.attempts<5 returning * into lim;
 if not found then raise exception 'FAMILY_VALIDATION_RATE_LIMIT'; end if;
 select (select count(*) from public.workspace_members where workspace_id=p_workspace and role='member')+
  (select count(*) from public.family_invitations where workspace_id=p_workspace and state='PENDING' and expires_at>t) into seats;
 with entries as(select value->>'email' email,coalesce((value->>'valid')::boolean,false) valid,ord from jsonb_array_elements(p_entries) with ordinality x(value,ord)),
 checks as(select e.*,u.id recipient_id,
  case when not e.valid then 'INVALID_EMAIL'
   when count(*) over(partition by e.email)>1 then 'DUPLICATE_EMAIL'
   when seats+jsonb_array_length(p_entries)>5 then 'FAMILY_CAPACITY'
   when u.id is null then 'EMAIL_NOT_REGISTERED'
   when u.status<>'ACTIVE' then 'ACCOUNT_INACTIVE'
   when u.id=uid then 'SELF_INVITATION'
   when exists(select 1 from public.workspace_members m where m.workspace_id=p_workspace and m.user_id=u.id) then 'ALREADY_MEMBER'
   when exists(select 1 from public.family_accounts a where a.user_id=u.id) then 'ALREADY_FAMILY'
   when exists(select 1 from public.family_invitations i where i.inviter_id=uid and i.invitee_id=u.id and i.state='PENDING' and i.expires_at>t) then 'ALREADY_PENDING'
   when f.blocked_until>t then 'INVITE_COOLDOWN' else 'READY' end code,f.blocked_until
  from entries e left join public.users u on u.email=e.email left join public.family_refusals f on f.inviter_id=uid and f.invitee_id=u.id)
 select jsonb_build_object('results',jsonb_agg(jsonb_build_object('email',email,'code',code,'recipientId',recipient_id,'blockedUntil',case when code='INVITE_COOLDOWN' then blocked_until end) order by ord),
  'canSubmit',bool_and(code='READY'),'availableSeats',greatest(0,5-seats),'serverNow',t) into result from checks;
 return result;
end $$;
revoke all on function public.family_validate_batch(uuid,jsonb) from public;
grant execute on function public.family_validate_batch(uuid,jsonb) to homemind_app;

create function public.family_create_batch(p_workspace uuid,p_targets jsonb,p_key uuid,p_days integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=public.current_user_id();digest text;prior public.family_operations%rowtype;result jsonb:='[]'::jsonb;one jsonb;r record;n integer;
begin
 if p_key is null or jsonb_typeof(p_targets)<>'array' or jsonb_array_length(p_targets) not between 1 and 5 then raise exception 'VALIDATION_ERROR'; end if;
 perform public.family_lock();
 if not exists(select 1 from public.workspace_members m join public.users u on u.id=m.user_id where m.workspace_id=p_workspace and m.user_id=uid and m.role='owner' and u.status='ACTIVE') then raise exception 'FORBIDDEN'; end if;
 digest:=encode(sha256(convert_to(jsonb_build_array(p_workspace,p_targets)::text,'UTF8')),'hex');
 select * into prior from public.family_operations where actor_id=uid and operation_key=p_key;
 if found then
  if prior.action<>'invite_batch' or prior.payload_hash<>digest then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return prior.result||jsonb_build_object('replayed',true);
 end if;
 if public.family_effective_at(p_workspace,clock_timestamp())->>'plan'<>'family' then raise exception 'FAMILY_NOT_ELIGIBLE'; end if;
 perform 1 from public.workspaces where id=p_workspace and archived_at is null for update;
 if not found then raise exception 'FORBIDDEN'; end if;
 -- Identity rows locked in stable UUID order; emails cannot move to a different recipient mid-batch.
 for r in select u.id from public.users u join jsonb_to_recordset(p_targets) x(email text,"recipientId" uuid) on x."recipientId"=u.id order by u.id for update of u loop null; end loop;
 select count(*) into n from jsonb_to_recordset(p_targets) x(email text,"recipientId" uuid) join public.users u on u.id=x."recipientId" and u.email=x.email and u.status='ACTIVE' and u.id<>uid;
 if n<>jsonb_array_length(p_targets) or (select count(distinct value->>'recipientId') from jsonb_array_elements(p_targets))<>n then raise exception 'INVITATION_VALIDATION_CHANGED'; end if;
 -- Calls are bounded to5 in ONE database transaction, not HTTP fan-out. Any failure rolls back all invitations/events/receipts.
 for r in select * from jsonb_to_recordset(p_targets) x(email text,"recipientId" uuid) loop
  one:=public.family_operation_at('invite',p_workspace,r."recipientId",r.email,(md5(p_key::text||':'||r."recipientId"::text))::uuid,p_days,clock_timestamp());
  if coalesce((one->>'blocked')::boolean,false) then raise exception 'INVITATION_VALIDATION_CHANGED'; end if;
  result:=result||jsonb_build_array(one);
 end loop;
 result:=jsonb_build_object('invitations',result,'createdCount',jsonb_array_length(result),'workspaceId',p_workspace,'requestEmails',(select jsonb_agg(value->>'email') from jsonb_array_elements(p_targets)));
 insert into public.family_operations(actor_id,operation_key,action,payload_hash,result) values(uid,p_key,'invite_batch',digest,result);
 return result||jsonb_build_object('replayed',false);
end $$;
revoke all on function public.family_create_batch(uuid,jsonb,uuid,integer) from public;
grant execute on function public.family_create_batch(uuid,jsonb,uuid,integer) to homemind_app;
create function public.family_batch_receipt(p_workspace uuid,p_key uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if not exists(select 1 from public.workspace_members where workspace_id=p_workspace and user_id=public.current_user_id() and role='owner') then raise exception 'FORBIDDEN'; end if;
 select f.result into result from public.family_operations f where actor_id=public.current_user_id() and operation_key=p_key and action='invite_batch';
 if result is not null and result->>'workspaceId'<>p_workspace::text then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
 return result;
end $$;
revoke all on function public.family_batch_receipt(uuid,uuid) from public;
grant execute on function public.family_batch_receipt(uuid,uuid) to homemind_app;
commit;
