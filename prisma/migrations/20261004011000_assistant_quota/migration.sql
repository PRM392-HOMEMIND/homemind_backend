begin;
create table public.assistant_quota_periods (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
 plan text not null, policy_version text not null, starts_at timestamptz not null, expires_at timestamptz not null,
 grant_id uuid references public.billing_grants(id) on delete set null, usage_limit integer not null check(usage_limit>0),
 used integer not null default 0 check(used>=0 and used<=usage_limit),
 unique(workspace_id,starts_at,plan,policy_version), check(expires_at>starts_at)
);
create table public.assistant_quota_requests (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id) on delete cascade,
 actor_id uuid not null references public.users(id) on delete cascade, request_id uuid not null, payload_hash text not null,
 period_id uuid not null references public.assistant_quota_periods(id) on delete cascade,
 state text not null check(state in ('RESERVED','RELEASED','COMMITTED')),
 lease_id uuid not null, lease_until timestamptz not null, response jsonb,
 created_at timestamptz not null, completed_at timestamptz,
 unique(workspace_id,actor_id,request_id),
 check((state='COMMITTED')=(response is not null))
);
create index assistant_quota_reservations on public.assistant_quota_requests(period_id,lease_until) where state='RESERVED';
alter table public.assistant_quota_periods enable row level security;
alter table public.assistant_quota_requests enable row level security;
revoke all on public.assistant_quota_periods,public.assistant_quota_requests from public,homemind_app;

-- Clock injection stays private: only migrator/test operator can call *_at.
create function public.assistant_period_at(p_workspace uuid,p_now timestamptz) returns public.assistant_quota_periods
 language plpgsql security definer set search_path='' as $$
declare e jsonb; g public.billing_grants%rowtype; p public.assistant_quota_periods%rowtype;
 anchor timestamptz; start_time timestamptz; end_time timestamptz; plan_name text; limit_count integer;
begin
 perform 1 from public.workspaces where id=p_workspace for update;
 e:=public.billing_refresh_at(p_workspace,p_now); plan_name:=e->>'plan';
 select * into g from public.billing_grants where workspace_id=p_workspace and starts_at<=p_now
  and coalesce(effective_until,expires_at)>p_now order by starts_at desc,id limit 1;
 select created_at into anchor from public.workspaces where id=p_workspace;
 if anchor is null then raise exception 'NOT_FOUND'; end if;
 if g.id is not null and e->>'source'='billing' then
  anchor:=g.starts_at;
 elsif plan_name='free' then
  select greatest(anchor,max(coalesce(effective_until,expires_at))) into anchor from public.billing_grants
   where workspace_id=p_workspace and coalesce(effective_until,expires_at)<=p_now;
 end if;
 start_time:=anchor+make_interval(secs=>(floor(extract(epoch from(p_now-anchor))/2592000)::integer*2592000));
 end_time:=start_time+interval '2592000 seconds';
 if g.id is not null and e->>'source'='billing' then end_time:=least(end_time,coalesce(g.effective_until,g.expires_at)); end if;
 limit_count:=case plan_name when 'personal' then 60 when 'family' then 100 when 'micro_pos' then 200 else 15 end;
 insert into public.assistant_quota_periods(workspace_id,plan,policy_version,starts_at,expires_at,grant_id,usage_limit)
  values(p_workspace,plan_name,'voice-30d-v2',start_time,end_time,case when e->>'source'='billing' then g.id end,limit_count)
  on conflict(workspace_id,starts_at,plan,policy_version) do nothing;
 select * into p from public.assistant_quota_periods where workspace_id=p_workspace and starts_at=start_time and plan=plan_name and policy_version='voice-30d-v2';
 return p;
end; $$;
create function public.assistant_quota_public(p public.assistant_quota_periods,p_now timestamptz) returns jsonb
 language sql stable security definer set search_path='' as $$
 select jsonb_build_object('periodId',p.id,'plan',p.plan,'policyVersion',p.policy_version,'used',p.used,'total',p.usage_limit,
  'reserved',(select count(*) from public.assistant_quota_requests where period_id=p.id and state='RESERVED' and lease_until>p_now),
  'remaining',greatest(0,p.usage_limit-p.used-(select count(*) from public.assistant_quota_requests where period_id=p.id and state='RESERVED' and lease_until>p_now)),
  'startsAt',p.starts_at,'expiresAt',p.expires_at,'serverNow',p_now); $$;
create function public.assistant_quota_get(p_workspace uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare p public.assistant_quota_periods%rowtype; t timestamptz:=clock_timestamp();
begin
 if not public.is_workspace_member(p_workspace) then raise exception 'FORBIDDEN'; end if;
 p:=public.assistant_period_at(p_workspace,t);
 return public.assistant_quota_public(p,t);
end; $$;
create function public.assistant_quota_admit_at(p_workspace uuid,p_request uuid,p_hash text,p_now timestamptz) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare p public.assistant_quota_periods%rowtype; r public.assistant_quota_requests%rowtype; n integer;
begin
 if not public.is_workspace_member(p_workspace) then raise exception 'FORBIDDEN'; end if;
 perform 1 from public.workspaces where id=p_workspace for update;
 select * into r from public.assistant_quota_requests where workspace_id=p_workspace and actor_id=public.current_user_id() and request_id=p_request for update;
 if found then
  if r.payload_hash<>p_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  if r.state='COMMITTED' then return jsonb_build_object('replay',r.response); end if;
  if r.state='RESERVED' and r.lease_until>p_now then raise exception 'ASSISTANT_REQUEST_IN_PROGRESS'; end if;
  select * into p from public.assistant_quota_periods where id=r.period_id;
  if p.expires_at<=p_now then raise exception 'ASSISTANT_REQUEST_EXPIRED'; end if;
 else
  p:=public.assistant_period_at(p_workspace,p_now);
 end if;
 select count(*) into n from public.assistant_quota_requests where period_id=p.id and state='RESERVED' and lease_until>p_now;
 if p.used+n>=p.usage_limit then return jsonb_build_object('exhausted',true,'quota',public.assistant_quota_public(p,p_now)); end if;
 insert into public.assistant_quota_requests(workspace_id,actor_id,request_id,payload_hash,period_id,state,lease_id,lease_until,created_at)
  values(p_workspace,public.current_user_id(),p_request,p_hash,p.id,'RESERVED',gen_random_uuid(),p_now+interval '60 seconds',p_now)
  on conflict(workspace_id,actor_id,request_id) do update set state='RESERVED',lease_id=gen_random_uuid(),lease_until=p_now+interval '60 seconds'
  returning * into r;
 return jsonb_build_object('reservationId',r.id,'leaseId',r.lease_id,'quota',public.assistant_quota_public(p,p_now));
end; $$;
create function public.assistant_quota_admit(p_workspace uuid,p_request uuid,p_hash text) returns jsonb
 language sql security definer set search_path='' as $$ select public.assistant_quota_admit_at(p_workspace,p_request,p_hash,clock_timestamp()); $$;
create function public.assistant_quota_finish_at(p_id uuid,p_lease uuid,p_response jsonb,p_now timestamptz) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare r public.assistant_quota_requests%rowtype; p public.assistant_quota_periods%rowtype; result jsonb; ws uuid;
begin
 select workspace_id into ws from public.assistant_quota_requests where id=p_id and actor_id=public.current_user_id();
 if ws is null or not public.is_workspace_member(ws) then raise exception 'FORBIDDEN'; end if;
 perform 1 from public.workspaces where id=ws for update;
 select * into r from public.assistant_quota_requests where id=p_id for update;
 if r.state='COMMITTED' then return r.response; end if;
 if r.lease_id<>p_lease or r.state<>'RESERVED' or r.lease_until<=p_now then raise exception 'ASSISTANT_LEASE_LOST'; end if;
 if p_response is null then
  update public.assistant_quota_requests set state='RELEASED' where id=p_id;
  return null;
 end if;
 if p_response->>'schemaVersion'<>'1.0' or p_response->>'kind' not in ('read_result','write_draft','clarify','unknown')
  or p_response->>'turnId' is null then raise exception 'VALIDATION_ERROR'; end if;
 -- A request admitted before an upgrade/period boundary commits ONLY its original period.
 update public.assistant_quota_periods set used=used+1 where id=r.period_id and used<usage_limit returning * into p;
 if p.id is null then raise exception 'VOICE_QUOTA_EXHAUSTED'; end if;
 update public.assistant_quota_requests set state='COMMITTED',completed_at=p_now,response=p_response where id=p_id;
 result:=p_response||jsonb_build_object('voiceQuota',public.assistant_quota_public(p,p_now));
 update public.assistant_quota_requests set response=result where id=p_id;
 return result;
end; $$;
create function public.assistant_quota_finish(p_id uuid,p_lease uuid,p_response jsonb) returns jsonb
 language sql security definer set search_path='' as $$ select public.assistant_quota_finish_at(p_id,p_lease,p_response,clock_timestamp()); $$;
create function public.assistant_quota_assert_lease(p_id uuid,p_lease uuid) returns boolean
 language plpgsql security definer set search_path='' as $$
declare ws uuid;
begin
 select workspace_id into ws from public.assistant_quota_requests where id=p_id and actor_id=public.current_user_id();
 if ws is null or not public.is_workspace_member(ws) then raise exception 'FORBIDDEN'; end if;
 perform 1 from public.workspaces where id=ws for update;
 if not exists(select 1 from public.assistant_quota_requests where id=p_id and state='RESERVED'
  and lease_id=p_lease and lease_until>clock_timestamp()) then raise exception 'ASSISTANT_LEASE_LOST'; end if;
 perform set_config('app.assistant_quota_reservation',p_id::text,true);
 perform set_config('app.assistant_quota_lease',p_lease::text,true);
 return true;
end; $$;
-- A legacy API image cannot persist successful unmetered turns after upgrade.
-- New runtime calls assert_lease and creates/charges the turn in one transaction.
alter function public.create_assistant_turn(uuid,text,text,text,jsonb,jsonb,jsonb,text,int)
 rename to create_assistant_turn_unmetered_v1;
revoke all on function public.create_assistant_turn_unmetered_v1(uuid,text,text,text,jsonb,jsonb,jsonb,text,int) from public,homemind_app;
create function public.create_assistant_turn(p_workspace uuid,p_raw text,p_corrected text,p_kind text,p_tools jsonb,p_data jsonb,p_draft jsonb,p_message text,p_ms int)
 returns uuid language plpgsql security definer set search_path='' as $$
declare r uuid; l uuid;
begin
 r:=nullif(current_setting('app.assistant_quota_reservation',true),'')::uuid;
 l:=nullif(current_setting('app.assistant_quota_lease',true),'')::uuid;
 if r is null or l is null then raise exception 'ASSISTANT_RESERVATION_REQUIRED'; end if;
 if not exists(select 1 from public.assistant_quota_requests where id=r and workspace_id=p_workspace
  and actor_id=public.current_user_id()) then raise exception 'FORBIDDEN'; end if;
 perform public.assistant_quota_assert_lease(r,l);
 return public.create_assistant_turn_unmetered_v1(p_workspace,p_raw,p_corrected,p_kind,p_tools,p_data,p_draft,p_message,p_ms);
end; $$;
comment on function public.create_assistant_turn(uuid,text,text,text,jsonb,jsonb,jsonb,text,int) is 'ASSISTANT_QUOTA_V2_FENCE';
revoke all on function public.create_assistant_turn(uuid,text,text,text,jsonb,jsonb,jsonb,text,int) from public;
grant execute on function public.create_assistant_turn(uuid,text,text,text,jsonb,jsonb,jsonb,text,int) to homemind_app;
revoke all on function public.assistant_period_at(uuid,timestamptz),public.assistant_quota_public(public.assistant_quota_periods,timestamptz),public.assistant_quota_get(uuid),public.assistant_quota_admit_at(uuid,uuid,text,timestamptz),public.assistant_quota_admit(uuid,uuid,text),public.assistant_quota_finish_at(uuid,uuid,jsonb,timestamptz),public.assistant_quota_finish(uuid,uuid,jsonb) from public,homemind_app;
grant execute on function public.assistant_quota_get(uuid),public.assistant_quota_admit(uuid,uuid,text),public.assistant_quota_finish(uuid,uuid,jsonb) to homemind_app;
revoke all on function public.assistant_quota_assert_lease(uuid,uuid) from public;
grant execute on function public.assistant_quota_assert_lease(uuid,uuid) to homemind_app;
commit;
