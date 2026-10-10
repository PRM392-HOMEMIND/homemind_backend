begin;
alter table public.assistant_quota_requests add column resource_workspace_id uuid references public.workspaces(id) on delete set null;
update public.assistant_quota_requests set resource_workspace_id=workspace_id;
create index assistant_quota_resource_actor on public.assistant_quota_requests(resource_workspace_id,actor_id,completed_at) where state='COMMITTED';
create unique index assistant_request_resource_unique on public.assistant_quota_requests(actor_id,resource_workspace_id,request_id);
-- Private data context stays separate. Active Family accounts always use ONE pool,
-- including when selecting their personal workspace: context switching cannot mint allowance.
create function public.assistant_quota_pool(p_resource uuid) returns uuid language plpgsql stable security definer set search_path='' as $$
declare pool uuid;
begin
 if not public.is_workspace_member(p_resource) then raise exception 'FORBIDDEN'; end if;
 select a.workspace_id into pool from public.family_accounts a where a.user_id=public.current_user_id() and public.family_eligible(a.workspace_id);
 return coalesce(pool,p_resource);
end $$;
revoke all on function public.assistant_quota_pool(uuid) from public,homemind_app;
alter function public.assistant_quota_admit_at(uuid,uuid,text,timestamptz) rename to assistant_quota_admit_before_family;
revoke all on function public.assistant_quota_admit_before_family(uuid,uuid,text,timestamptz) from public,homemind_app;
create function public.assistant_quota_admit_at(p_workspace uuid,p_request uuid,p_hash text,p_now timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare pool uuid;result jsonb;prior public.assistant_quota_requests%rowtype;
begin
 if not public.is_workspace_member(p_workspace) then raise exception 'FORBIDDEN'; end if;
 perform pg_advisory_xact_lock(hashtextextended('ai-request:'||public.current_user_id()::text||':'||p_workspace::text||':'||p_request::text,0));
 select * into prior from public.assistant_quota_requests where actor_id=public.current_user_id() and resource_workspace_id=p_workspace and request_id=p_request;
 if found then
  if prior.payload_hash<>p_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  if prior.state='COMMITTED' then return jsonb_build_object('replay',prior.response||jsonb_build_object('voiceQuota',public.assistant_quota_get(p_workspace))); end if;
 end if;
 pool:=public.assistant_quota_pool(p_workspace);
 perform 1 from public.workspaces where id=pool for update;
 if public.assistant_quota_pool(p_workspace)<>pool then raise exception 'ASSISTANT_REQUEST_EXPIRED'; end if;
 if prior.id is not null and prior.workspace_id<>pool then raise exception 'ASSISTANT_REQUEST_EXPIRED'; end if;
 result:=public.assistant_quota_admit_before_family(pool,p_request,p_hash,p_now);
 if result->>'reservationId' is not null then
  update public.assistant_quota_requests set resource_workspace_id=p_workspace where id=(result->>'reservationId')::uuid and actor_id=public.current_user_id();
 end if;
 return result;
end $$;
revoke all on function public.assistant_quota_admit_at(uuid,uuid,text,timestamptz) from public,homemind_app;
create or replace function public.assistant_quota_get(p_workspace uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.assistant_quota_periods%rowtype;t timestamptz:=clock_timestamp();pool uuid;
begin
 pool:=public.assistant_quota_pool(p_workspace);
 p:=public.assistant_period_at(pool,t);
 return public.assistant_quota_public(p,t)||jsonb_build_object('poolWorkspaceId',pool,'shared',pool<>p_workspace or exists(select 1 from public.family_accounts where user_id=public.current_user_id() and workspace_id=pool));
end $$;
create or replace function public.create_assistant_turn(p_workspace uuid,p_raw text,p_corrected text,p_kind text,p_tools jsonb,p_data jsonb,p_draft jsonb,p_message text,p_ms integer) returns uuid
language plpgsql security definer set search_path='' as $$
declare r uuid;l uuid;
begin
 r:=nullif(current_setting('app.assistant_quota_reservation',true),'')::uuid;
 l:=nullif(current_setting('app.assistant_quota_lease',true),'')::uuid;
 if r is null or l is null then raise exception 'ASSISTANT_RESERVATION_REQUIRED'; end if;
 if not exists(select 1 from public.assistant_quota_requests where id=r and coalesce(resource_workspace_id,workspace_id)=p_workspace and actor_id=public.current_user_id()) then raise exception 'FORBIDDEN'; end if;
 perform public.assistant_quota_assert_lease(r,l);
 return public.create_assistant_turn_unmetered_v1(p_workspace,p_raw,p_corrected,p_kind,p_tools,p_data,p_draft,p_message,p_ms);
end $$;
comment on function public.create_assistant_turn(uuid,text,text,text,jsonb,jsonb,jsonb,text,integer) is 'ASSISTANT_QUOTA_V2_FENCE';
-- Fast pure resolver: no private-workspace lock before acquiring the shared pool.
create or replace function public.billing_effective(p_workspace uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not public.is_workspace_member(p_workspace) then raise exception 'FORBIDDEN'; end if;
 result:=public.family_effective_at(p_workspace,clock_timestamp());
 return result||jsonb_build_object('accessLifetime',result->>'plan'='free');
end $$;
commit;
