begin;
alter table public.notification_outbox drop constraint notification_outbox_target_type_check;
alter table public.notification_outbox add constraint notification_outbox_target_type_check
 check(target_type in('home','profile','security','inventory','shopping','billing','notification','family_invitation','family'));
create table public.family_groups(
 workspace_id uuid primary key references public.workspaces(id) on delete cascade,
 owner_id uuid not null references public.users(id),sharing_enabled boolean not null default true,
 generation integer not null default 1,created_at timestamptz not null default now(),
 eligibility_grant_id uuid references public.billing_grants(id) on delete set null,eligibility_source text,eligibility_until timestamptz);
create table public.family_memberships(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.family_groups(workspace_id) on delete cascade,
 user_id uuid not null references public.users(id),joined_at timestamptz not null default now(),ended_at timestamptz,reason text,
 check(ended_at is null or ended_at>=joined_at));
create unique index family_one_membership on public.family_memberships(user_id) where ended_at is null;
create index family_members_workspace on public.family_memberships(workspace_id,joined_at,id) where ended_at is null;
-- One durable slot for both owner and relative, across all groups.
create table public.family_accounts(user_id uuid primary key references public.users(id),workspace_id uuid not null references public.family_groups(workspace_id) on delete cascade,role text not null check(role in('owner','member')));
create index family_accounts_workspace on public.family_accounts(workspace_id);
create table public.family_invitations(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.family_groups(workspace_id) on delete cascade,
 inviter_id uuid not null references public.users(id),invitee_id uuid not null references public.users(id),
 state text not null default 'PENDING' check(state in('PENDING','ACCEPTED','DECLINED','CANCELLED','EXPIRED','INVALIDATED')),
 created_at timestamptz not null default now(),expires_at timestamptz not null,responded_at timestamptz,
 check(inviter_id<>invitee_id),check(expires_at>created_at));
create unique index family_pending_pair on public.family_invitations(inviter_id,invitee_id) where state='PENDING';
create index family_invitation_recipient on public.family_invitations(invitee_id,created_at desc,id desc);
create index family_invitation_workspace on public.family_invitations(workspace_id,created_at desc,id desc);
create table public.family_refusals(inviter_id uuid references public.users(id),invitee_id uuid references public.users(id),
 declines integer not null default 0 check(declines between 0 and 3),blocked_until timestamptz,primary key(inviter_id,invitee_id));
create table public.family_operations(actor_id uuid references public.users(id),operation_key uuid not null,action text not null,payload_hash text not null,result jsonb not null,created_at timestamptz not null default now(),primary key(actor_id,operation_key));
create table public.family_personal_resets(workspace_id uuid primary key references public.workspaces(id) on delete cascade,user_id uuid not null references public.users(id),cutoff timestamptz not null,reason text not null);
alter table public.users add column active_workspace_id uuid references public.workspaces(id) on delete set null;
alter table public.products add column created_by uuid references public.users(id);
alter table public.inventory_lots add column created_by uuid references public.users(id);
-- Only evidence-backed attribution: original receipt actor, unique across original entries.
update public.inventory_lots l set created_by=x.actor from (
 select lot_id,(array_agg(distinct created_by))[1] actor from public.inventory_transactions
 where action='receive' and lot_id is not null group by lot_id having count(distinct created_by)=1
) x where l.id=x.lot_id;
update public.products p set created_by=x.actor from (
 select t.product_id,(array_agg(distinct t.created_by))[1] actor from public.inventory_transactions t
 join public.products original on original.id=t.product_id and original.created_at=t.created_at
 where t.action='receive' group by t.product_id having count(distinct t.created_by)=1
) x where p.id=x.product_id;
create index inventory_lots_author_month on public.inventory_lots(workspace_id,created_by,created_at desc,id desc);

create function public.family_lock() returns void language sql volatile security definer set search_path='' as $$
 select pg_advisory_xact_lock(131313,36000); $$;
revoke all on function public.family_lock() from public;
grant execute on function public.family_lock() to homemind_app;
-- No payment or grant rewrite: previously acquired access is excluded, financial facts remain.
create function public.family_grant_allowed(p_grant public.billing_grants) returns boolean language sql stable security definer set search_path='' as $$
 select not exists(select 1 from public.family_personal_resets r where r.workspace_id=p_grant.workspace_id
  and (p_grant.created_at<=r.cutoff
   or exists(select 1 from public.billing_orders o where o.id=p_grant.order_id and o.created_at<=r.cutoff)
   or exists(select 1 from public.feedback_popup_rewards f where f.id=p_grant.reward_id and f.created_at<=r.cutoff)));
$$;
revoke all on function public.family_grant_allowed(public.billing_grants) from public,homemind_app;
create function public.family_effective_at(p_workspace uuid,p_now timestamptz) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare e public.workspace_entitlements%rowtype;g public.billing_grants%rowtype;
begin
 select * into e from public.workspace_entitlements where workspace_id=p_workspace;
 if e.source='billing' or exists(select 1 from public.family_personal_resets where workspace_id=p_workspace) then
  select * into g from public.billing_grants b where workspace_id=p_workspace and starts_at<=p_now
   and coalesce(effective_until,expires_at)>p_now and public.family_grant_allowed(b) order by starts_at desc,id limit 1;
  return jsonb_build_object('plan',coalesce(g.plan,'free'),'productLimit',case when g.id is null then 30 else g.product_limit end,'source',case when g.id is null and e.source<>'billing' then 'free' else 'billing' end,'changed',false);
 end if;
 return jsonb_build_object('plan',coalesce(e.plan,'free'),'productLimit',case when e.workspace_id is null then 30 else e.product_limit end,'source',coalesce(e.source,'free'),'changed',false);
end $$;
revoke all on function public.family_effective_at(uuid,timestamptz) from public,homemind_app;
create function public.family_eligible(p_workspace uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.family_groups g join public.workspaces w on w.id=g.workspace_id
 join public.users u on u.id=g.owner_id join public.workspace_members m on m.workspace_id=g.workspace_id and m.user_id=g.owner_id and m.role='owner'
 where g.workspace_id=p_workspace and g.sharing_enabled and w.archived_at is null and u.status='ACTIVE'
 and w.type='household' and public.family_effective_at(w.id,statement_timestamp())->>'plan'='family'
 and ((g.eligibility_grant_id is not null and exists(select 1 from public.billing_grants b where b.id=g.eligibility_grant_id and coalesce(b.effective_until,b.expires_at)>statement_timestamp()))
  or (g.eligibility_grant_id is null and g.eligibility_source='legacy_manual' and public.family_effective_at(w.id,statement_timestamp())->>'source'='legacy_manual'))); $$;
revoke all on function public.family_eligible(uuid) from public,homemind_app;
create function public.family_access_end(p_workspace uuid,p_now timestamptz) returns timestamptz language sql stable security definer set search_path='' as $$
 select least(p_now,coalesce(w.archived_at,p_now),case when u.status<>'ACTIVE' then coalesce(u.deleted_at,u.updated_at,p_now) else p_now end,
  coalesce(b.effective_until,b.expires_at,p_now),case when g.eligibility_source='legacy_manual' and public.family_effective_at(w.id,p_now)->>'plan'<>'family' then greatest(g.created_at,e.updated_at) else p_now end)
 from public.family_groups g join public.workspaces w on w.id=g.workspace_id join public.users u on u.id=g.owner_id
 left join public.billing_grants b on b.id=g.eligibility_grant_id left join public.workspace_entitlements e on e.workspace_id=w.id where g.workspace_id=p_workspace;
$$;
revoke all on function public.family_access_end(uuid,timestamptz) from public,homemind_app;
create or replace function public.is_workspace_member(p_workspace uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.workspace_members m join public.workspaces w on w.id=m.workspace_id
 join public.users u on u.id=m.user_id where m.workspace_id=p_workspace and m.user_id=public.current_user_id()
 and w.archived_at is null and u.status='ACTIVE'
 and (m.role='owner' or not exists(select 1 from public.family_groups g where g.workspace_id=p_workspace)
 or (public.family_eligible(p_workspace) and exists(select 1 from public.family_accounts a where a.user_id=m.user_id and a.workspace_id=p_workspace and a.role='member')))); $$;
create or replace function public.notification_visible(p_recipient uuid,p_workspace uuid,p_financial boolean) returns boolean language sql stable security definer set search_path='' as $$
 select p_recipient=public.current_user_id() and exists(select 1 from public.users where id=p_recipient and status='ACTIVE')
 and (p_workspace is null or (public.is_workspace_member(p_workspace) and (not p_financial or exists(select 1 from public.workspace_members where workspace_id=p_workspace and user_id=p_recipient and role='owner')))); $$;

create function public.family_notice(p_key text,p_user uuid,p_kind text,p_title text,p_target uuid,p_now timestamptz) returns void language sql security definer set search_path='' as $$
 select public.notification_enqueue('family:v1:'||p_key,p_user,null,false,p_kind,p_title,p_title,
 'Thông báo gia đình. Quyền truy cập được kiểm tra lại khi mở; lịch sử riêng không được chuyển vào nhóm.','family_invitation',p_target::text,p_now); $$;
revoke all on function public.family_notice(text,uuid,text,text,uuid,timestamptz) from public,homemind_app;

-- Departure preserves authored history and financial evidence. Workspace locks precede row changes.
create function public.family_depart(p_workspace uuid,p_user uuid,p_reason text,p_now timestamptz) returns void language plpgsql security definer set search_path='' as $$
declare m public.family_memberships%rowtype; personal uuid; owner_id uuid;locked_workspace record;
begin
 select * into m from public.family_memberships where workspace_id=p_workspace and user_id=p_user and ended_at is null;
 if not found then return; end if;
 select g.owner_id into owner_id from public.family_groups g where g.workspace_id=p_workspace;
 for locked_workspace in select workspace_id from public.workspace_members where (user_id=p_user and role='owner') or workspace_id=p_workspace order by workspace_id loop
  perform 1 from public.workspaces where id=locked_workspace.workspace_id for update;
 end loop;
 select w.id into personal from public.workspaces w join public.workspace_members wm on wm.workspace_id=w.id
 where wm.user_id=p_user and wm.role='owner' and w.archived_at is null and w.id<>p_workspace order by w.created_at,w.id limit 1;
 if personal is null then
  insert into public.workspaces(name,type) values('Không gian cá nhân','household') returning id into personal;
  insert into public.workspace_members(workspace_id,user_id,role) values(personal,p_user,'owner');
  insert into public.workspace_entitlements(workspace_id) values(personal);
 end if;
 insert into public.family_personal_resets(workspace_id,user_id,cutoff,reason)
 select wm.workspace_id,p_user,p_now,p_reason from public.workspace_members wm join public.workspaces w on w.id=wm.workspace_id
 where wm.user_id=p_user and wm.role='owner' and w.id<>p_workspace and w.archived_at is null
 on conflict(workspace_id) do update set cutoff=excluded.cutoff,reason=excluded.reason;
 update public.workspace_entitlements set plan='free',product_limit=30,source='free',updated_at=p_now
 where workspace_id in(select workspace_id from public.family_personal_resets where user_id=p_user);
 update public.assistant_quota_requests set state='RELEASED' where actor_id=p_user and state='RESERVED'
  and workspace_id in(select workspace_id from public.family_personal_resets where user_id=p_user);
 update public.family_memberships set ended_at=greatest(m.joined_at,p_now),reason=p_reason where id=m.id;
 delete from public.family_accounts where user_id=p_user and workspace_id=p_workspace;
 delete from public.workspace_members where user_id=p_user and workspace_id=p_workspace and role='member';
 update public.users set active_workspace_id=personal where id=p_user;
 update public.assistant_quota_requests set state='RELEASED' where workspace_id=p_workspace and actor_id=p_user and state='RESERVED';
 perform public.family_notice('departure:'||m.id,p_user,'family.'||p_reason,'Bạn đã rời nhóm gia đình và trở về Free',null,p_now);
 perform public.family_notice('departure:'||m.id,owner_id,'family.'||p_reason,'Một người thân đã rời nhóm gia đình',null,p_now);
end $$;
revoke all on function public.family_depart(uuid,uuid,text,timestamptz) from public,homemind_app;

create function public.family_end(p_workspace uuid,p_reason text,p_now timestamptz) returns void language plpgsql security definer set search_path='' as $$
declare r record;
begin
 perform 1 from public.workspaces where id=p_workspace for update;
 for r in select user_id from public.family_memberships where workspace_id=p_workspace and ended_at is null order by user_id loop
  perform public.family_depart(p_workspace,r.user_id,p_reason,p_now);
 end loop;
 for r in update public.family_invitations set state='INVALIDATED',responded_at=p_now where workspace_id=p_workspace and state='PENDING' returning * loop
  perform public.family_notice('invalidated:'||r.id,r.invitee_id,'family.invitation_invalidated','Lời mời gia đình không còn hiệu lực',r.id,p_now);
 end loop;
 update public.family_groups set sharing_enabled=false where workspace_id=p_workspace;
 delete from public.family_accounts where workspace_id=p_workspace and role='owner';
end $$;
revoke all on function public.family_end(uuid,text,timestamptz) from public,homemind_app;

create function public.family_reconcile_current() returns void language plpgsql security definer set search_path='' as $$
declare r record;t timestamptz:=clock_timestamp();
begin
 if not exists(select 1 from public.family_accounts where user_id=public.current_user_id()) then return; end if;
 if exists(select 1 from public.family_accounts a where a.user_id=public.current_user_id() and not public.family_eligible(a.workspace_id)) then
  perform public.family_lock();
  for r in select a.workspace_id from public.family_accounts a where a.user_id=public.current_user_id() and not public.family_eligible(a.workspace_id) loop
   perform public.family_end(r.workspace_id,'access_expired',public.family_access_end(r.workspace_id,t));
  end loop;
 end if;
end $$;
revoke all on function public.family_reconcile_current() from public;
grant execute on function public.family_reconcile_current() to homemind_app;

-- Materialized entitlement, actual authorization and quota share the same resolver.
create or replace function public.billing_refresh_at(p_workspace uuid,p_now timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;e public.workspace_entitlements%rowtype;changed boolean:=false;
begin
 perform 1 from public.workspaces where id=p_workspace for update;
 result:=public.family_effective_at(p_workspace,p_now);
 select * into e from public.workspace_entitlements where workspace_id=p_workspace for update;
 if found and (e.plan is distinct from result->>'plan' or e.product_limit is distinct from (result->>'productLimit')::integer or e.source is distinct from result->>'source') then
  update public.workspace_entitlements set plan=result->>'plan',product_limit=(result->>'productLimit')::integer,source=result->>'source',updated_at=p_now where workspace_id=p_workspace;
  changed:=true;
 end if;
 return result||jsonb_build_object('changed',changed,'accessLifetime',result->>'plan'='free');
end $$;
create or replace function public.billing_effective(p_workspace uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not public.is_workspace_member(p_workspace) then raise exception 'FORBIDDEN'; end if;
 return public.billing_refresh_at(p_workspace,clock_timestamp());
end $$;

-- Authored contributions: peers and owner cannot rewrite another author's source data.
create function public.family_authored_row() returns trigger language plpgsql security definer set search_path='' as $$
declare actor uuid:=public.current_user_id();family boolean;
begin
 if actor is null then return coalesce(new,old); end if;
 select exists(select 1 from public.family_groups where workspace_id=coalesce(new.workspace_id,old.workspace_id)) into family;
 if tg_op='INSERT' then
  new.created_by:=actor;
 elsif family then
  if tg_op='UPDATE' and tg_table_name='products' and
   (to_jsonb(new)-array['status','updated_at'])=(to_jsonb(old)-array['status','updated_at']) then return new; end if;
  if old.created_by is distinct from actor then raise exception 'CONTRIBUTION_FORBIDDEN'; end if;
  if tg_op='UPDATE' and new.created_by is distinct from old.created_by then raise exception 'CONTRIBUTION_FORBIDDEN'; end if;
 end if;
 return coalesce(new,old);
end $$;
create trigger family_product_author before insert or update or delete on public.products for each row execute function public.family_authored_row();
create trigger family_lot_author before insert or update or delete on public.inventory_lots for each row execute function public.family_authored_row();
create trigger family_shopping_author before insert or update or delete on public.shopping_items for each row execute function public.family_authored_row();
revoke all on function public.family_authored_row() from public,homemind_app;

-- Store private context on the account, re-authorized on every read/use.
create function public.workspace_context(p_select uuid default null) returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=public.current_user_id();selected uuid;
begin
 if uid is null then raise exception 'FORBIDDEN'; end if;
 if p_select is not null then
  if not public.is_workspace_member(p_select) then raise exception 'FORBIDDEN'; end if;
  update public.users set active_workspace_id=p_select where id=uid;
  return p_select;
 end if;
 select active_workspace_id into selected from public.users where id=uid and status='ACTIVE';
 if selected is not null and public.is_workspace_member(selected) then return selected; end if;
 select m.workspace_id into selected from public.workspace_members m where m.user_id=uid and public.is_workspace_member(m.workspace_id)
 order by (m.role='owner') desc,m.created_at,m.workspace_id limit 1;
 return selected;
end $$;
revoke all on function public.workspace_context(uuid) from public;
grant execute on function public.workspace_context(uuid) to homemind_app;

-- Read models return only permitted identity/usage, never peer contact or private prompts.
create function public.family_read(p_workspace uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;quota jsonb;
begin
 if not public.is_workspace_member(p_workspace) then raise exception 'FORBIDDEN'; end if;
 quota:=public.assistant_quota_get(p_workspace);
 select jsonb_build_object('workspaceId',w.id,'name',w.name,'eligible',public.family_effective_at(w.id,statement_timestamp())->>'plan'='family',
  'sharingEnabled',coalesce(g.sharing_enabled,false),'role',m.role,'ownerId',coalesce(g.owner_id,m.user_id),
  'relativeCount',(select count(*) from public.family_accounts a where a.workspace_id=w.id and a.role='member'),
  'pendingCount',(select count(*) from public.family_invitations i where i.workspace_id=w.id and i.state='PENDING' and i.expires_at>statement_timestamp()),
  'capacity',5,'serverNow',clock_timestamp(),'quota',quota,
  'members',coalesce((select jsonb_agg(jsonb_build_object('userId',wm.user_id,'displayName',p.display_name,'role',wm.role,'joinedAt',wm.created_at,
    'usage',coalesce(us.used,0),'recordedPurchases',coalesce(pu.n,0)) order by wm.role desc,wm.created_at,wm.user_id)
   from public.workspace_members wm join public.profiles p on p.id=wm.user_id join public.users u on u.id=wm.user_id and u.status='ACTIVE'
   left join (select actor_id,count(*) used from public.assistant_quota_requests where workspace_id=p_workspace and state='COMMITTED' and period_id=(quota->>'periodId')::uuid group by actor_id) us on us.actor_id=wm.user_id
   left join (select created_by,count(*) n from public.inventory_lots where workspace_id=p_workspace and created_at>=(quota->>'startsAt')::timestamptz and created_at<(quota->>'expiresAt')::timestamptz group by created_by) pu on pu.created_by=wm.user_id
   where wm.workspace_id=w.id),'[]'::jsonb)) into result
 from public.workspaces w join public.workspace_members m on m.workspace_id=w.id and m.user_id=public.current_user_id()
 left join public.family_groups g on g.workspace_id=w.id where w.id=p_workspace;
 return result||jsonb_build_object('availableSeats',greatest(0,5-(result->>'relativeCount')::int-(result->>'pendingCount')::int));
end $$;
revoke all on function public.family_read(uuid) from public;
grant execute on function public.family_read(uuid) to homemind_app;

-- Every table has RLS; mutation only through checked functions, never direct DML grants.
do $$declare t text;begin
 foreach t in array array['family_groups','family_memberships','family_accounts','family_invitations','family_refusals','family_operations','family_personal_resets'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,homemind_app',t);
 end loop;
end $$;
-- No direct table access is needed by the API role.
create function public.family_operation_at(p_action text,p_workspace uuid,p_target uuid,p_email text,p_key uuid,p_lifetime integer,p_now timestamptz) returns jsonb
language plpgsql security definer set search_path='' as $$
declare uid uuid:=public.current_user_id();target uuid;inv public.family_invitations%rowtype;g public.family_groups%rowtype;
 refusal public.family_refusals%rowtype;prior public.family_operations%rowtype;result jsonb;digest text;seats int;r record;
begin
 if uid is null or not exists(select 1 from public.users where id=uid and status='ACTIVE') then raise exception 'FORBIDDEN'; end if;
 if p_action not in('invite','accept','decline','cancel','remove','leave','end') or p_key is null or p_lifetime not between 1 and 30 then raise exception 'VALIDATION_ERROR'; end if;
 perform public.family_lock();
 digest:=encode(sha256(convert_to(jsonb_build_array(p_action,p_workspace,p_target,p_email)::text,'UTF8')),'hex');
 select * into prior from public.family_operations where actor_id=uid and operation_key=p_key;
 if found then
  if prior.action<>p_action or prior.payload_hash<>digest then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return prior.result||jsonb_build_object('replayed',true);
 end if;
 if p_action in('accept','decline','cancel') then
  select * into inv from public.family_invitations where id=p_target for update;
  if not found or (p_action='cancel' and inv.inviter_id<>uid) or (p_action<>'cancel' and inv.invitee_id<>uid) then raise exception 'INVITATION_NOT_FOUND'; end if;
  if p_workspace is not null and p_workspace<>inv.workspace_id then raise exception 'INVITATION_NOT_FOUND'; end if;
  p_workspace:=inv.workspace_id;
 end if;
 perform 1 from public.workspaces where id=p_workspace for update;
 select * into g from public.family_groups where workspace_id=p_workspace;
 if p_action in('invite','remove','cancel','end') then
  if not exists(select 1 from public.workspace_members m join public.workspaces w on w.id=m.workspace_id where m.workspace_id=p_workspace and m.user_id=uid and m.role='owner' and w.archived_at is null) then raise exception 'FORBIDDEN'; end if;
  if p_action<>'end' and public.family_effective_at(p_workspace,p_now)->>'plan'<>'family' then raise exception 'FAMILY_NOT_ELIGIBLE'; end if;
 end if;
 if p_action='invite' then
  select id into target from public.users where email=p_email and status='ACTIVE';
  if target is null then raise exception 'FAMILY_TARGET_UNAVAILABLE'; end if;
  if p_target is not null and p_target<>target then raise exception 'INVITATION_VALIDATION_CHANGED'; end if;
  if target=uid then raise exception 'FAMILY_SELF_INVITE'; end if;
  if g.workspace_id is null then
   insert into public.family_groups(workspace_id,owner_id) values(p_workspace,uid) returning * into g;
   -- Preserve any deterministic legacy members, but never silently move an active group.
   if exists(select 1 from public.workspace_members m join public.family_accounts a on a.user_id=m.user_id where m.workspace_id=p_workspace and a.workspace_id<>p_workspace) then raise exception 'FAMILY_ALREADY_ACTIVE'; end if;
   if (select count(*) from public.workspace_members where workspace_id=p_workspace and role='member')>5 then raise exception 'FAMILY_FULL'; end if;
   insert into public.family_accounts(user_id,workspace_id,role) select user_id,workspace_id,role from public.workspace_members where workspace_id=p_workspace;
   insert into public.family_memberships(workspace_id,user_id,joined_at) select workspace_id,user_id,created_at from public.workspace_members where workspace_id=p_workspace and role='member';
  elsif not g.sharing_enabled then
   if exists(select 1 from public.family_accounts where user_id=uid and workspace_id<>p_workspace) then raise exception 'FAMILY_ALREADY_ACTIVE'; end if;
   update public.family_groups set sharing_enabled=true,generation=generation+1 where workspace_id=p_workspace;
   insert into public.family_accounts(user_id,workspace_id,role) values(uid,p_workspace,'owner') on conflict(user_id) do nothing;
  end if;
  if g.workspace_id is not null and not public.family_eligible(p_workspace) and g.eligibility_source is not null then
   perform public.family_end(p_workspace,'access_expired',public.family_access_end(p_workspace,p_now));
   update public.family_groups set sharing_enabled=true,generation=generation+1 where workspace_id=p_workspace;
   insert into public.family_accounts(user_id,workspace_id,role) values(uid,p_workspace,'owner') on conflict(user_id) do nothing;
  end if;
  update public.family_groups set eligibility_source=public.family_effective_at(p_workspace,p_now)->>'source',
   eligibility_grant_id=(select b.id from public.billing_grants b where b.workspace_id=p_workspace and b.plan='family' and b.starts_at<=p_now and coalesce(b.effective_until,b.expires_at)>p_now and public.family_grant_allowed(b) order by b.starts_at desc,b.id limit 1),
   eligibility_until=(select coalesce(b.effective_until,b.expires_at) from public.billing_grants b where b.workspace_id=p_workspace and b.plan='family' and b.starts_at<=p_now and coalesce(b.effective_until,b.expires_at)>p_now and public.family_grant_allowed(b) order by b.starts_at desc,b.id limit 1)
   where workspace_id=p_workspace and (g.eligibility_source is null or not g.sharing_enabled or not public.family_eligible(p_workspace));
  if not public.family_eligible(p_workspace) then raise exception 'FAMILY_NOT_ELIGIBLE'; end if;
  if exists(select 1 from public.family_accounts where user_id=target) then raise exception 'FAMILY_ALREADY_ACTIVE'; end if;
  if exists(select 1 from public.workspace_members where workspace_id=p_workspace and user_id=target) then raise exception 'FAMILY_ALREADY_MEMBER'; end if;
  update public.family_invitations set state='EXPIRED',responded_at=p_now where inviter_id=uid and invitee_id=target and state='PENDING' and expires_at<=p_now;
  if exists(select 1 from public.family_invitations where inviter_id=uid and invitee_id=target and state='PENDING') then raise exception 'FAMILY_ALREADY_PENDING'; end if;
  insert into public.family_refusals(inviter_id,invitee_id) values(uid,target) on conflict do nothing;
  select * into refusal from public.family_refusals where inviter_id=uid and invitee_id=target for update;
  if refusal.blocked_until>p_now then return jsonb_build_object('blocked',true,'code','FAMILY_INVITE_COOLDOWN','blockedUntil',refusal.blocked_until,'serverNow',p_now); end if;
  if refusal.blocked_until is not null then update public.family_refusals set declines=0,blocked_until=null where inviter_id=uid and invitee_id=target; end if;
  select (select count(*) from public.family_accounts where workspace_id=p_workspace and role='member')+
   (select count(*) from public.family_invitations where workspace_id=p_workspace and state='PENDING' and expires_at>p_now) into seats;
  if seats>=5 then raise exception 'FAMILY_FULL'; end if;
  insert into public.family_invitations(workspace_id,inviter_id,invitee_id,expires_at) values(p_workspace,uid,target,p_now+make_interval(days=>p_lifetime)) returning * into inv;
  perform public.family_notice('invite:'||inv.id,target,'family.invited','Bạn có lời mời tham gia gia đình',inv.id,p_now);
  result:=jsonb_build_object('invitationId',inv.id,'state',inv.state,'expiresAt',inv.expires_at);
 elsif p_action in('accept','decline','cancel') then
  if inv.state=(case p_action when 'accept' then 'ACCEPTED' when 'decline' then 'DECLINED' else 'CANCELLED' end) then
   result:=jsonb_build_object('invitationId',inv.id,'state',inv.state,'changed',false);
  else
   if inv.state<>'PENDING' then raise exception 'INVITATION_STALE'; end if;
   if inv.expires_at<=p_now then raise exception 'INVITATION_EXPIRED'; end if;
   if not public.family_eligible(p_workspace) then raise exception 'FAMILY_NOT_ELIGIBLE'; end if;
   if p_action='accept' then
    if exists(select 1 from public.family_accounts where user_id=uid) then raise exception 'FAMILY_ALREADY_ACTIVE'; end if;
    if (select count(*) from public.family_accounts where workspace_id=p_workspace and role='member')>=5 then raise exception 'FAMILY_FULL'; end if;
    insert into public.family_accounts(user_id,workspace_id,role) values(uid,p_workspace,'member');
    insert into public.workspace_members(workspace_id,user_id,role) values(p_workspace,uid,'member');
    insert into public.family_memberships(workspace_id,user_id,joined_at) values(p_workspace,uid,p_now);
    update public.users set active_workspace_id=p_workspace where id=uid;
    update public.family_refusals set declines=0,blocked_until=null where inviter_id=inv.inviter_id and invitee_id=uid;
   elsif p_action='decline' then
    insert into public.family_refusals(inviter_id,invitee_id) values(inv.inviter_id,uid) on conflict do nothing;
    update public.family_refusals set declines=case when blocked_until<=p_now then 1 else least(3,declines+1) end,
     blocked_until=case when (case when blocked_until<=p_now then 1 else declines+1 end)>=3 then p_now+interval '24 hours' else null end
     where inviter_id=inv.inviter_id and invitee_id=uid;
   end if;
   update public.family_invitations set state=case p_action when 'accept' then 'ACCEPTED' when 'decline' then 'DECLINED' else 'CANCELLED' end,responded_at=p_now where id=inv.id returning * into inv;
   perform public.family_notice(inv.state||':'||inv.id,inv.inviter_id,'family.'||lower(inv.state),'Lời mời gia đình đã được phản hồi',inv.id,p_now);
   perform public.family_notice(inv.state||':'||inv.id,inv.invitee_id,'family.'||lower(inv.state),'Trạng thái lời mời gia đình đã cập nhật',inv.id,p_now);
   result:=jsonb_build_object('invitationId',inv.id,'state',inv.state,'changed',true);
  end if;
 elsif p_action in('remove','leave') then
  target:=case when p_action='leave' then uid else p_target end;
  if target is null or exists(select 1 from public.workspace_members where workspace_id=p_workspace and user_id=target and role='owner') then raise exception 'FAMILY_OWNER_CANNOT_LEAVE'; end if;
  if p_action='leave' and not exists(select 1 from public.family_memberships where workspace_id=p_workspace and user_id=uid) then raise exception 'FORBIDDEN'; end if;
  if p_action='remove' and not exists(select 1 from public.family_memberships where workspace_id=p_workspace and user_id=target) then raise exception 'FORBIDDEN'; end if;
  perform public.family_depart(p_workspace,target,p_action,p_now);
  result:=jsonb_build_object('ok',true,'workspaceId',p_workspace,'userId',target,'personalPlan','free');
 else
  if g.owner_id is distinct from uid then raise exception 'FORBIDDEN'; end if;
  perform public.family_end(p_workspace,'sharing_ended',p_now);
  result:=jsonb_build_object('ok',true,'sharingEnabled',false);
 end if;
 insert into public.family_operations(actor_id,operation_key,action,payload_hash,result) values(uid,p_key,p_action,digest,result);
 return result||jsonb_build_object('replayed',false);
end $$;
revoke all on function public.family_operation_at(text,uuid,uuid,text,uuid,integer,timestamptz) from public,homemind_app;
create function public.family_operation(p_action text,p_workspace uuid,p_target uuid,p_email text,p_key uuid,p_lifetime integer) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.family_lock();
 return public.family_operation_at(p_action,p_workspace,p_target,p_email,p_key,p_lifetime,clock_timestamp());
end $$;
revoke all on function public.family_operation(text,uuid,uuid,text,uuid,integer) from public;
grant execute on function public.family_operation(text,uuid,uuid,text,uuid,integer) to homemind_app;
create function public.family_invitation_list(p_workspace uuid,p_limit integer,p_time timestamptz,p_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;uid uuid:=public.current_user_id();
begin
 if uid is null or p_limit not between 1 and 51 then raise exception 'VALIDATION_ERROR'; end if;
 if p_workspace is not null and not exists(select 1 from public.workspace_members where workspace_id=p_workspace and user_id=uid and role='owner') then raise exception 'FORBIDDEN'; end if;
 select coalesce(jsonb_agg(x.data order by x.time desc,x.id desc),'[]'::jsonb) into result from (
  select i.id,i.created_at time,jsonb_build_object('id',i.id,'workspaceId',i.workspace_id,'workspaceName',w.name,
   'inviterName',p.display_name,'inviteeName',ip.display_name,'state',case when i.state='PENDING' and (not public.family_eligible(i.workspace_id)) then 'INVALIDATED' when i.state='PENDING' and i.expires_at<=statement_timestamp() then 'EXPIRED' else i.state end,
   'createdAt',to_char(i.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'expiresAt',i.expires_at,'respondedAt',i.responded_at,
   'declineCount',coalesce(f.declines,0),'blockedUntil',f.blocked_until) data
  from public.family_invitations i join public.workspaces w on w.id=i.workspace_id join public.profiles p on p.id=i.inviter_id join public.profiles ip on ip.id=i.invitee_id
  left join public.family_refusals f on f.inviter_id=i.inviter_id and f.invitee_id=i.invitee_id
  where ((p_workspace is null and i.invitee_id=uid) or (i.workspace_id=p_workspace and i.inviter_id=uid))
   and (p_time is null or (i.created_at,i.id)<(p_time,p_id)) order by i.created_at desc,i.id desc limit p_limit
 )x;
 return result;
end $$;
revoke all on function public.family_invitation_list(uuid,integer,timestamptz,uuid) from public;
grant execute on function public.family_invitation_list(uuid,integer,timestamptz,uuid) to homemind_app;
create function public.workspace_directory() returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',w.id,'name',w.name,'type',w.type,'role',m.role,
  'plan',public.family_effective_at(w.id,statement_timestamp())->>'plan') order by (m.role='owner') desc,m.created_at,w.id),'[]'::jsonb)
 from public.workspace_members m join public.workspaces w on w.id=m.workspace_id
 where m.user_id=public.current_user_id() and public.is_workspace_member(w.id);
$$;
revoke all on function public.workspace_directory() from public;
grant execute on function public.workspace_directory() to homemind_app;
alter function public.close_account_workspaces(uuid) rename to close_account_before_family;
revoke all on function public.close_account_before_family(uuid) from public,homemind_app;
create function public.close_account_workspaces(p_user uuid) returns void language plpgsql security definer set search_path='' as $$
declare r record;
begin
 if p_user is distinct from public.current_user_id() then raise exception 'FORBIDDEN'; end if;
 perform public.family_lock();
 for r in update public.family_invitations set state='INVALIDATED',responded_at=clock_timestamp() where invitee_id=p_user and state='PENDING' returning id,inviter_id loop
  perform public.family_notice('invalidated:'||r.id,r.inviter_id,'family.invitation_invalidated','Lời mời không còn hiệu lực vì tài khoản đã đóng',r.id,clock_timestamp());
 end loop;
 for r in select workspace_id,role from public.family_accounts where user_id=p_user loop
  if r.role='owner' then perform public.family_end(r.workspace_id,'owner_closed',clock_timestamp());
  else perform public.family_depart(r.workspace_id,p_user,'account_closed',clock_timestamp()); end if;
 end loop;
 perform public.close_account_before_family(p_user);
end $$;
revoke all on function public.close_account_workspaces(uuid) from public;
grant execute on function public.close_account_workspaces(uuid) to homemind_app;
create or replace function public.assistant_period_at(p_workspace uuid,p_now timestamptz) returns public.assistant_quota_periods
language plpgsql security definer set search_path='' as $$
declare e jsonb;g public.billing_grants%rowtype;p public.assistant_quota_periods%rowtype;anchor timestamptz;start_time timestamptz;end_time timestamptz;plan_name text;limit_count int;charged int;
begin
 perform 1 from public.workspaces where id=p_workspace for update;
 e:=public.billing_refresh_at(p_workspace,p_now);plan_name:=e->>'plan';
 select * into g from public.billing_grants b where workspace_id=p_workspace and starts_at<=p_now and coalesce(effective_until,expires_at)>p_now and public.family_grant_allowed(b) order by starts_at desc,id limit 1;
 select created_at into anchor from public.workspaces where id=p_workspace;
 if anchor is null then raise exception 'NOT_FOUND'; end if;
 if g.id is not null and plan_name<>'free' then anchor:=g.starts_at;
 elsif plan_name='free' and not exists(select 1 from public.family_personal_resets where workspace_id=p_workspace) then
  select greatest(anchor,max(coalesce(effective_until,expires_at))) into anchor from public.billing_grants where workspace_id=p_workspace and coalesce(effective_until,expires_at)<=p_now;
 end if;
 start_time:=anchor+make_interval(secs=>floor(extract(epoch from(p_now-anchor))/2592000)::integer*2592000);
 end_time:=start_time+interval '2592000 seconds';
 if g.id is not null and plan_name<>'free' then end_time:=least(end_time,coalesce(g.effective_until,g.expires_at)); end if;
 limit_count:=case plan_name when 'personal' then 60 when 'family' then 100 when 'micro_pos' then 200 else 15 end;
 insert into public.assistant_quota_periods(workspace_id,plan,policy_version,starts_at,expires_at,grant_id,usage_limit)
 values(p_workspace,plan_name,'voice-30d-v2',start_time,end_time,case when plan_name<>'free' then g.id end,limit_count)
 on conflict(workspace_id,starts_at,plan,policy_version) do nothing;
 select * into p from public.assistant_quota_periods where workspace_id=p_workspace and starts_at=start_time and plan=plan_name and policy_version='voice-30d-v2' for update;
 if plan_name='free' and exists(select 1 from public.family_personal_resets where workspace_id=p_workspace) then
  select least(limit_count,count(*)::int) into charged from public.assistant_quota_requests where workspace_id=p_workspace and state='COMMITTED' and completed_at>=start_time and completed_at<end_time;
  update public.assistant_quota_periods set used=greatest(used,charged) where id=p.id returning * into p;
 end if;
 return p;
end $$;
commit;
