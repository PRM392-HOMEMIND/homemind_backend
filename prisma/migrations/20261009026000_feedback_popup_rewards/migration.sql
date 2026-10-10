-- Homepage feedback popup + 30-day Premium reward.
-- Additive only: no existing row is rewritten, no existing migration is edited.
-- Reward time lives on the SAME entitlement timeline as paid time
-- (public.billing_grants), so the existing resolver, usage quota and product
-- limit logic apply unchanged. Every state change below is made by SECURITY
-- DEFINER functions; the runtime role gets no table privileges.
begin;

-- ---------------------------------------------------------------------------
-- 1. Campaign configuration: one stable identity, disabled until an admin
--    explicitly enables it. Toggling never creates a campaign or resets rewards.
-- ---------------------------------------------------------------------------
create table public.feedback_popup_campaigns (
 id text primary key check(id='homepage-feedback-premium-30d'),
 enabled boolean not null default false,
 revision integer not null default 1 check(revision>=1),
 plan text not null default 'personal' check(plan='personal'),
 duration_seconds integer not null default 2592000 check(duration_seconds=2592000),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 updated_by uuid references admin.principals(id) on delete set null
);
insert into public.feedback_popup_campaigns(id) values('homepage-feedback-premium-30d');

create table public.feedback_popup_config_events (
 id uuid primary key default gen_random_uuid(),
 campaign_id text not null references public.feedback_popup_campaigns(id),
 actor_id uuid references admin.principals(id) on delete set null,
 request_id uuid not null,
 previous_enabled boolean not null, enabled boolean not null,
 previous_revision integer not null, revision integer not null,
 occurred_at timestamptz not null default now(),
 check(previous_enabled<>enabled and revision=previous_revision+1),
 unique(campaign_id,request_id)
);
create index feedback_popup_config_events_recent on public.feedback_popup_config_events(occurred_at desc,id desc);

-- ---------------------------------------------------------------------------
-- 2. Accepted submissions (plain text, canonical contact values).
-- ---------------------------------------------------------------------------
create table public.feedback_popup_submissions (
 id uuid primary key default gen_random_uuid(),
 campaign_id text not null references public.feedback_popup_campaigns(id),
 full_name text not null check(full_name=btrim(full_name) and char_length(full_name) between 1 and 120),
 -- Canonicalised (trim + lower-case) by the API with the same function as account identifiers.
 email text not null check(email=btrim(email) and char_length(email) between 3 and 254),
 phone text not null check(phone ~ '^\+[1-9][0-9]{6,14}$'),
 review text not null check(review=btrim(review) and char_length(review) between 1 and 5000),
 idempotency_key uuid,
 payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
 submitter_user_id uuid references public.users(id),
 ip_hash text check(ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
 user_agent text check(user_agent is null or char_length(user_agent)<=300),
 submitted_at timestamptz not null,
 unique(campaign_id,idempotency_key)
);
create index feedback_popup_submissions_recent on public.feedback_popup_submissions(submitted_at desc,id desc);
create index feedback_popup_submissions_email on public.feedback_popup_submissions(email);
create index feedback_popup_submissions_phone on public.feedback_popup_submissions(phone);
create index feedback_popup_submissions_name_search on public.feedback_popup_submissions using gin(lower(full_name) gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 3. One reward record per accepted submission, created in the same
--    transaction (a missing reward record is impossible by construction).
--    The partial unique indexes make "one reward per account / workspace"
--    a database invariant, not a check-then-insert.
-- ---------------------------------------------------------------------------
create table public.feedback_popup_rewards (
 id uuid primary key default gen_random_uuid(),
 submission_id uuid not null unique references public.feedback_popup_submissions(id),
 campaign_id text not null references public.feedback_popup_campaigns(id),
 state text not null check(state in ('PENDING_ACCOUNT','WAITING_ENTITLEMENT','GRANTED','CONFLICT','BLOCKED','DUPLICATE')),
 reason text check(reason is null or reason in ('IDENTITY_CONFLICT','ACCOUNT_NOT_ACTIVE','NO_ELIGIBLE_WORKSPACE',
   'ACCOUNT_ALREADY_REWARDED','WORKSPACE_ALREADY_REWARDED','INDEFINITE_ENTITLEMENT')),
 user_id uuid references public.users(id),
 workspace_id uuid references public.workspaces(id),
 plan text not null default 'personal' check(plan='personal'),
 duration_seconds integer not null default 2592000 check(duration_seconds=2592000),
 anchor_at timestamptz,
 bound_at timestamptz,
 granted_at timestamptz,
 created_at timestamptz not null,
 updated_at timestamptz not null,
 constraint feedback_popup_rewards_shape check(
  (state='PENDING_ACCOUNT' and user_id is null and workspace_id is null and reason is null)
  or (state='CONFLICT' and user_id is null and reason='IDENTITY_CONFLICT')
  or (state='BLOCKED' and user_id is not null and reason in ('ACCOUNT_NOT_ACTIVE','NO_ELIGIBLE_WORKSPACE'))
  or (state='DUPLICATE' and user_id is not null and reason in ('ACCOUNT_ALREADY_REWARDED','WORKSPACE_ALREADY_REWARDED'))
  or (state='WAITING_ENTITLEMENT' and reason='INDEFINITE_ENTITLEMENT' and user_id is not null and workspace_id is not null and anchor_at is not null)
  or (state='GRANTED' and reason is null and user_id is not null and workspace_id is not null and anchor_at is not null and granted_at is not null))
);
create unique index feedback_popup_rewards_one_per_account on public.feedback_popup_rewards(campaign_id,user_id)
 where state in ('WAITING_ENTITLEMENT','GRANTED');
create unique index feedback_popup_rewards_one_per_workspace on public.feedback_popup_rewards(campaign_id,workspace_id)
 where state in ('WAITING_ENTITLEMENT','GRANTED');
create index feedback_popup_rewards_pending on public.feedback_popup_rewards(created_at,id) where state='PENDING_ACCOUNT';
create index feedback_popup_rewards_waiting on public.feedback_popup_rewards(updated_at,id) where state='WAITING_ENTITLEMENT';
create index feedback_popup_rewards_granted_workspace on public.feedback_popup_rewards(workspace_id) where state='GRANTED';
create index feedback_popup_rewards_user on public.feedback_popup_rewards(user_id) where user_id is not null;

-- A reward never moves to another account/workspace and never leaves a terminal state.
create function public.feedback_popup_reward_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if new.submission_id<>old.submission_id or new.campaign_id<>old.campaign_id or new.created_at<>old.created_at then
  raise exception 'REWARD_IDENTITY_IMMUTABLE'; end if;
 if old.user_id is not null and new.user_id is distinct from old.user_id then raise exception 'REWARD_BINDING_IMMUTABLE'; end if;
 if old.workspace_id is not null and new.workspace_id is distinct from old.workspace_id then raise exception 'REWARD_BINDING_IMMUTABLE'; end if;
 if old.state<>new.state and not (
   (old.state='PENDING_ACCOUNT' and new.state in ('WAITING_ENTITLEMENT','GRANTED','CONFLICT','BLOCKED','DUPLICATE'))
   or (old.state='WAITING_ENTITLEMENT' and new.state in ('GRANTED','BLOCKED'))) then
  raise exception 'REWARD_STATE_TRANSITION_INVALID'; end if;
 return new;
end $$;
create trigger feedback_popup_reward_guard before update on public.feedback_popup_rewards
 for each row execute function public.feedback_popup_reward_guard();

-- Registration claims that could not complete inline (lock timeout, transient
-- error). Holds only the account id, never contact data.
create table public.feedback_popup_claim_retries (
 user_id uuid primary key references public.users(id) on delete cascade,
 attempts integer not null default 1,
 last_error text,
 next_attempt_at timestamptz not null,
 created_at timestamptz not null default now()
);
create index feedback_popup_claim_retries_due on public.feedback_popup_claim_retries(next_attempt_at);

-- ---------------------------------------------------------------------------
-- 4. Promotional time on the shared entitlement timeline.
--    PAID rows keep their order; PROMOTION rows have no order and point at the
--    reward. At most one open (unsuperseded) segment exists per reward.
-- ---------------------------------------------------------------------------
alter table public.billing_grants alter column order_id drop not null;
alter table public.billing_grants
 add column source_kind text not null default 'PAID' check(source_kind in ('PAID','PROMOTION')),
 add column reward_id uuid references public.feedback_popup_rewards(id);
alter table public.billing_grants add constraint billing_grants_source_shape check(
 (source_kind='PAID' and order_id is not null and reward_id is null)
 or (source_kind='PROMOTION' and order_id is null and reward_id is not null));
create unique index billing_grants_reward_open_segment on public.billing_grants(reward_id)
 where reward_id is not null and superseded_at is null;
create index billing_grants_reward on public.billing_grants(reward_id) where reward_id is not null;

-- ---------------------------------------------------------------------------
-- 5. Row level security and privileges: nothing here is directly reachable by
--    the runtime role. The SELECT-only admin inspection role is added by the
--    operator grants file, exactly like the existing admin read models.
-- ---------------------------------------------------------------------------
do $$ declare t text; begin
 foreach t in array array['feedback_popup_campaigns','feedback_popup_config_events','feedback_popup_submissions',
  'feedback_popup_rewards','feedback_popup_claim_retries'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,homemind_app',t);
 end loop;
 foreach t in array array['feedback_popup_campaigns','feedback_popup_config_events','feedback_popup_submissions','feedback_popup_rewards'] loop
  execute format('create policy admin_inspection on public.%I for select using(current_user = %L)',t,'homemind_admin_api');
 end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Placement helpers (private: no EXECUTE for the runtime role).
-- ---------------------------------------------------------------------------
-- Same workspace the profile API shows first for the account's owner role.
create function public.feedback_popup_primary_workspace(p_user uuid) returns uuid
 language sql stable security definer set search_path='' as $$
 select m.workspace_id from public.workspace_members m join public.workspaces w on w.id=m.workspace_id
 where m.user_id=p_user and m.role='owner' and w.archived_at is null order by m.created_at,w.id limit 1 $$;

-- End of the last PAID coverage; promotional segments are never part of it.
create function public.feedback_popup_paid_end(p_workspace uuid,p_now timestamptz) returns timestamptz
 language sql stable security definer set search_path='' as $$
 select max(coalesce(g.effective_until,g.expires_at)) from public.billing_grants g
 where g.workspace_id=p_workspace and g.reward_id is null and coalesce(g.effective_until,g.expires_at)>p_now $$;

-- Creates the first promotional segment for a bound reward. The caller holds the
-- workspace lock. Start = max(eligibility anchor, end of paid coverage): never
-- the execution time, so a late worker cannot extend the reward.
create function public.feedback_popup_place_at(p_reward uuid,p_now timestamptz) returns void
 language plpgsql security definer set search_path='' as $$
declare r public.feedback_popup_rewards%rowtype; v_start timestamptz;
begin
 select * into r from public.feedback_popup_rewards where id=p_reward and state='GRANTED';
 if not found or exists(select 1 from public.billing_grants where reward_id=r.id) then return; end if;
 v_start:=greatest(r.anchor_at,coalesce(public.feedback_popup_paid_end(r.workspace_id,p_now),r.anchor_at));
 insert into public.billing_grants(workspace_id,plan,product_limit,starts_at,expires_at,price_snapshot,source_kind,reward_id)
 values(r.workspace_id,r.plan,null,v_start,v_start+make_interval(secs=>r.duration_seconds),
  jsonb_build_object('id','feedback-popup-premium-30d','plan',r.plan,'amount',0,'currency','VND','durationSeconds',r.duration_seconds,
   'voiceLimit',60,'productLimit',null,'policyVersion','voice-30d-v2','source','PROMOTION','campaignId',r.campaign_id,'rewardId',r.id),
  'PROMOTION',r.id);
 -- Hand the materialized row to the existing resolver (free rows only; a manual
 -- paid plan is never converted - see WAITING_ENTITLEMENT).
 update public.workspace_entitlements set source='billing' where workspace_id=r.workspace_id and source='free';
 perform public.billing_refresh_at(r.workspace_id,p_now);
end $$;

-- Binds a pending reward to one account and grants, defers or blocks it.
-- Idempotent: a reward that is no longer pending is returned unchanged.
create function public.feedback_popup_bind_at(p_reward uuid,p_user uuid,p_now timestamptz) returns text
 language plpgsql security definer set search_path='' as $$
declare r public.feedback_popup_rewards%rowtype; s public.feedback_popup_submissions%rowtype; u public.users%rowtype;
 v_workspace uuid; e public.workspace_entitlements%rowtype; v_anchor timestamptz;
begin
 select * into r from public.feedback_popup_rewards where id=p_reward for update;
 if not found then raise exception 'REWARD_NOT_FOUND'; end if;
 if r.state<>'PENDING_ACCOUNT' then return r.state; end if;
 select * into s from public.feedback_popup_submissions where id=r.submission_id;
 select * into u from public.users where id=p_user;
 if not found then raise exception 'USER_NOT_FOUND'; end if;
 if u.status<>'ACTIVE' then
  update public.feedback_popup_rewards set state='BLOCKED',reason='ACCOUNT_NOT_ACTIVE',user_id=u.id,bound_at=p_now,updated_at=p_now where id=r.id;
  return 'BLOCKED';
 end if;
 v_workspace:=public.feedback_popup_primary_workspace(u.id);
 if v_workspace is null then
  update public.feedback_popup_rewards set state='BLOCKED',reason='NO_ELIGIBLE_WORKSPACE',user_id=u.id,bound_at=p_now,updated_at=p_now where id=r.id;
  return 'BLOCKED';
 end if;
 -- Same order as billing: workspace first, then its entitlement/grant rows.
 perform 1 from public.workspaces where id=v_workspace for update;
 if exists(select 1 from public.feedback_popup_rewards x where x.campaign_id=r.campaign_id and x.user_id=u.id and x.state in ('WAITING_ENTITLEMENT','GRANTED')) then
  update public.feedback_popup_rewards set state='DUPLICATE',reason='ACCOUNT_ALREADY_REWARDED',user_id=u.id,workspace_id=v_workspace,bound_at=p_now,updated_at=p_now where id=r.id;
  return 'DUPLICATE';
 end if;
 if exists(select 1 from public.feedback_popup_rewards x where x.campaign_id=r.campaign_id and x.workspace_id=v_workspace and x.state in ('WAITING_ENTITLEMENT','GRANTED')) then
  update public.feedback_popup_rewards set state='DUPLICATE',reason='WORKSPACE_ALREADY_REWARDED',user_id=u.id,workspace_id=v_workspace,bound_at=p_now,updated_at=p_now where id=r.id;
  return 'DUPLICATE';
 end if;
 v_anchor:=greatest(u.created_at,s.submitted_at);
 insert into public.workspace_entitlements(workspace_id) values(v_workspace) on conflict do nothing;
 select * into e from public.workspace_entitlements where workspace_id=v_workspace for update;
 begin
  if e.source='legacy_manual' and e.plan<>'free' then
   -- A manually granted paid plan has no end date: keep the reward waiting, do not invent one.
   update public.feedback_popup_rewards set state='WAITING_ENTITLEMENT',reason='INDEFINITE_ENTITLEMENT',user_id=u.id,workspace_id=v_workspace,
    anchor_at=v_anchor,bound_at=p_now,updated_at=p_now where id=r.id;
   return 'WAITING_ENTITLEMENT';
  end if;
  update public.feedback_popup_rewards set state='GRANTED',reason=null,user_id=u.id,workspace_id=v_workspace,anchor_at=v_anchor,
   bound_at=p_now,granted_at=p_now,updated_at=p_now where id=r.id;
  perform public.feedback_popup_place_at(r.id,p_now);
  return 'GRANTED';
 exception when unique_violation then
  -- A concurrent decision already rewarded this account/workspace: the database
  -- invariant wins and this submission is only recorded as a duplicate.
  update public.feedback_popup_rewards set state='DUPLICATE',reason='ACCOUNT_ALREADY_REWARDED',user_id=u.id,workspace_id=v_workspace,bound_at=p_now,updated_at=p_now where id=r.id;
  return 'DUPLICATE';
 end;
end $$;

-- Keeps the promotional segment consistent with paid time. Paid time always wins:
--  * an unstarted segment is placed after the end of paid coverage;
--  * a started segment overlapped by a paid grant yields at the overlap point and
--    its unused remainder becomes a new segment after paid coverage.
-- Used time is never repeated and unused time is never discarded.
create function public.feedback_popup_realign_at(p_workspace uuid,p_now timestamptz) returns void
 language plpgsql security definer set search_path='' as $$
declare r public.feedback_popup_rewards%rowtype; s public.billing_grants%rowtype; g public.billing_grants%rowtype;
 v_yield timestamptz; v_paid_end timestamptz; v_start timestamptz; v_remaining numeric; v_changed boolean:=false; v_open boolean;
begin
 select * into r from public.feedback_popup_rewards where workspace_id=p_workspace and state='GRANTED';
 if not found then return; end if;
 perform 1 from public.workspaces where id=p_workspace for update;
 select * into s from public.billing_grants where reward_id=r.id and superseded_at is null;
 v_open:=found;
 -- A segment that has already started yields to paid time that overlaps it (history is never rewritten).
 if v_open and s.starts_at<=p_now then
  select * into g from public.billing_grants x where x.workspace_id=p_workspace and x.reward_id is null
   and x.starts_at<coalesce(s.effective_until,s.expires_at) and coalesce(x.effective_until,x.expires_at)>s.starts_at
   order by x.starts_at,x.id limit 1;
  if found then
   v_yield:=greatest(s.starts_at,g.starts_at);
   update public.billing_grants set effective_until=v_yield,superseded_at=v_yield,superseded_by=g.id where id=s.id;
   v_changed:=true; v_open:=false;
  end if;
 end if;
 v_paid_end:=public.feedback_popup_paid_end(p_workspace,p_now);
 if v_open then
  -- Not started yet: simply move it behind the end of paid coverage (earlier or later).
  if s.starts_at>p_now then
   v_start:=greatest(r.anchor_at,coalesce(v_paid_end,r.anchor_at));
   if v_start<>s.starts_at then
    update public.billing_grants set starts_at=v_start,expires_at=v_start+(s.expires_at-s.starts_at) where id=s.id;
    v_changed:=true;
   end if;
  end if;
 else
  select r.duration_seconds-coalesce(sum(extract(epoch from (coalesce(x.effective_until,x.expires_at)-x.starts_at))),0) into v_remaining
   from public.billing_grants x where x.reward_id=r.id;
  if v_remaining>0 then
   v_start:=coalesce(v_paid_end,p_now);
   insert into public.billing_grants(workspace_id,plan,product_limit,starts_at,expires_at,price_snapshot,source_kind,reward_id)
   values(r.workspace_id,r.plan,null,v_start,v_start+make_interval(secs=>v_remaining::double precision),
    jsonb_build_object('id','feedback-popup-premium-30d','plan',r.plan,'amount',0,'currency','VND','durationSeconds',r.duration_seconds,
     'voiceLimit',60,'productLimit',null,'policyVersion','voice-30d-v2','source','PROMOTION','campaignId',r.campaign_id,'rewardId',r.id,'continuation',true),
    'PROMOTION',r.id);
   v_changed:=true;
  end if;
 end if;
 if v_changed then perform public.billing_refresh_at(p_workspace,p_now); end if;
end $$;

-- Paid grants changed (new purchase, supersession): realign this workspace's
-- reward. Workspaces without a reward return immediately.
create function public.feedback_popup_grant_changed() returns trigger
 language plpgsql security definer set search_path='' as $$
begin
 if new.reward_id is null and exists(select 1 from public.feedback_popup_rewards where workspace_id=new.workspace_id and state='GRANTED') then
  perform public.feedback_popup_realign_at(new.workspace_id,clock_timestamp());
 end if;
 return null;
end $$;
create trigger feedback_popup_grant_changed after insert or update of starts_at,expires_at,effective_until,superseded_at
 on public.billing_grants for each row execute function public.feedback_popup_grant_changed();

-- Final safety net, checked at COMMIT after every realignment: a promotional
-- segment can never overlap paid time (or another segment of its reward).
create function public.feedback_popup_guard_overlap() returns trigger
 language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.feedback_popup_rewards where workspace_id=new.workspace_id) and exists(
  select 1 from public.billing_grants a join public.billing_grants b on b.workspace_id=a.workspace_id and b.id<>a.id
  where a.workspace_id=new.workspace_id and (a.reward_id is not null or b.reward_id is not null)
   and a.starts_at<coalesce(a.effective_until,a.expires_at) and b.starts_at<coalesce(b.effective_until,b.expires_at)
   and a.starts_at<coalesce(b.effective_until,b.expires_at) and b.starts_at<coalesce(a.effective_until,a.expires_at)) then
  raise exception 'PROMOTION_OVERLAPS_ENTITLEMENT';
 end if;
 return null;
end $$;
create constraint trigger feedback_popup_guard_overlap after insert or update on public.billing_grants
 deferrable initially deferred for each row execute function public.feedback_popup_guard_overlap();

-- ---------------------------------------------------------------------------
-- 7. Claim, submit, reconcile.
-- ---------------------------------------------------------------------------
-- Binds every pending reward whose contact matches this newly created account.
-- Both submitted identifiers are re-resolved first: if they belong to two
-- different accounts the reward is blocked as an identity conflict.
create function public.feedback_popup_claim_at(p_user uuid,p_now timestamptz) returns integer
 language plpgsql security definer set search_path='' as $$
declare u public.users%rowtype; r record; ua public.users%rowtype; ub public.users%rowtype; n integer:=0;
begin
 select * into u from public.users where id=p_user;
 if not found or u.status<>'ACTIVE' then return 0; end if;
 for r in select rw.id,s.email,s.phone from public.feedback_popup_rewards rw
  join public.feedback_popup_submissions s on s.id=rw.submission_id
  where rw.state='PENDING_ACCOUNT' and ((u.email is not null and s.email=u.email) or (u.phone is not null and s.phone=u.phone))
  order by s.submitted_at,s.id for update of rw skip locked loop
  select * into ua from public.users where email=r.email;
  select * into ub from public.users where phone=r.phone;
  if ua.id is not null and ub.id is not null and ua.id<>ub.id then
   update public.feedback_popup_rewards set state='CONFLICT',reason='IDENTITY_CONFLICT',updated_at=p_now where id=r.id;
  else
   perform public.feedback_popup_bind_at(r.id,p_user,p_now);
  end if;
  n:=n+1;
 end loop;
 return n;
end $$;

-- Registration hook. Registration must never fail or wait because of the
-- promotion: errors and lock timeouts queue a retry (anchored at the account's
-- creation time, so a retry cannot restart the 30 days).
create function public.feedback_popup_claim_new_account(p_user uuid) returns void
 language plpgsql security definer set search_path='' as $$
declare v_previous text:=current_setting('lock_timeout');
begin
 begin
  perform set_config('lock_timeout','1000ms',true);
  perform pg_advisory_xact_lock_shared(hashtextextended('homemind.feedback_popup.identity',0));
  perform set_config('lock_timeout',v_previous,true);
  perform public.feedback_popup_claim_at(p_user,clock_timestamp());
 exception when others then
  insert into public.feedback_popup_claim_retries(user_id,last_error,next_attempt_at)
  values(p_user,left(sqlstate||':'||sqlerrm,200),clock_timestamp()+interval '10 seconds')
  on conflict(user_id) do update set attempts=public.feedback_popup_claim_retries.attempts+1,last_error=excluded.last_error,next_attempt_at=excluded.next_attempt_at;
 end;
end $$;

-- Provisioning is the single place that creates a household for a new account.
create or replace function public.provision_home(p_user uuid,p_name text,p_type text default 'household')
returns uuid language plpgsql security definer set search_path='' as $$
declare v_workspace uuid; v_created boolean:=false;
begin
 if p_user is distinct from public.current_user_id() or not exists(select 1 from public.users where id=p_user and status='ACTIVE') then raise exception 'FORBIDDEN'; end if;
 if p_type not in ('household','store') or length(trim(p_name)) not between 1 and 120 then raise exception 'VALIDATION_ERROR'; end if;
 insert into public.profiles(id,display_name,phone)
 select p_user,trim(p_name),u.phone from public.users u where u.id=p_user
 on conflict do nothing;
 insert into public.notification_preferences(user_id) values(p_user) on conflict do nothing;
 select workspace_id into v_workspace from public.workspace_members where user_id=p_user and role='owner' order by created_at limit 1;
 if v_workspace is null then
   insert into public.workspaces(name,type) values(left(case when p_type='store' then 'Cửa hàng ' else 'Nhà ' end || trim(p_name),120),p_type) returning id into v_workspace;
   insert into public.workspace_members(workspace_id,user_id,role) values(v_workspace,p_user,'owner');
   insert into public.workspace_entitlements(workspace_id) values(v_workspace);
   v_created:=true;
 end if;
 if v_created then perform public.feedback_popup_claim_new_account(p_user); end if;
 return v_workspace;
end; $$;
revoke all on function public.provision_home(uuid,text,text) from public;
grant execute on function public.provision_home(uuid,text,text) to homemind_app;

create function public.feedback_popup_submit_at(p_campaign text,p_full_name text,p_email text,p_phone text,p_review text,
 p_idem uuid,p_hash text,p_submitter uuid,p_ip_hash text,p_user_agent text,p_now timestamptz) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare c public.feedback_popup_campaigns%rowtype; known public.feedback_popup_submissions%rowtype;
 sub public.feedback_popup_submissions%rowtype; rw public.feedback_popup_rewards%rowtype;
 ua public.users%rowtype; ub public.users%rowtype; v_state text; v_workspace uuid;
begin
 -- One writer at a time for identity resolution; registrations hold the shared side.
 perform pg_advisory_xact_lock(hashtextextended('homemind.feedback_popup.identity',0));
 if p_idem is not null then
  select * into known from public.feedback_popup_submissions where campaign_id=p_campaign and idempotency_key=p_idem;
  if found then
   if known.payload_hash<>p_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
   return jsonb_build_object('submissionId',known.id,'submittedAt',known.submitted_at,'replayed',true,'workspaceId',null,'rewardState',null);
  end if;
 end if;
 -- Share-lock the campaign row: a concurrent admin disable waits for this
 -- transaction, or this submission waits for the disable and is rejected.
 select * into c from public.feedback_popup_campaigns where id=p_campaign for share;
 if not found then raise exception 'FEEDBACK_POPUP_NOT_FOUND'; end if;
 if not c.enabled then raise exception 'FEEDBACK_POPUP_DISABLED'; end if;
 insert into public.feedback_popup_submissions(campaign_id,full_name,email,phone,review,idempotency_key,payload_hash,submitter_user_id,ip_hash,user_agent,submitted_at)
 values(c.id,p_full_name,p_email,p_phone,p_review,p_idem,p_hash,p_submitter,p_ip_hash,left(p_user_agent,300),p_now) returning * into sub;
 insert into public.feedback_popup_rewards(submission_id,campaign_id,state,created_at,updated_at)
 values(sub.id,c.id,'PENDING_ACCOUNT',p_now,p_now) returning * into rw;
 select * into ua from public.users where email=p_email;
 select * into ub from public.users where phone=p_phone;
 if ua.id is not null and ub.id is not null and ua.id<>ub.id then
  update public.feedback_popup_rewards set state='CONFLICT',reason='IDENTITY_CONFLICT',updated_at=p_now where id=rw.id;
  v_state:='CONFLICT';
 elsif ua.id is not null or ub.id is not null then
  v_state:=public.feedback_popup_bind_at(rw.id,coalesce(ua.id,ub.id),p_now);
  select workspace_id into v_workspace from public.feedback_popup_rewards where id=rw.id;
 else
  v_state:='PENDING_ACCOUNT';
 end if;
 return jsonb_build_object('submissionId',sub.id,'submittedAt',sub.submitted_at,'replayed',false,'workspaceId',v_workspace,'rewardState',v_state);
end $$;

-- Runtime entry point: the clock is read only AFTER the identity lock is held,
-- so submitted_at is monotonic in lock order.
create function public.feedback_popup_submit(p_campaign text,p_full_name text,p_email text,p_phone text,p_review text,
 p_idem uuid,p_hash text,p_submitter uuid,p_ip_hash text,p_user_agent text) returns jsonb
 language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('homemind.feedback_popup.identity',0));
 return public.feedback_popup_submit_at(p_campaign,p_full_name,p_email,p_phone,p_review,p_idem,p_hash,p_submitter,p_ip_hash,p_user_agent,clock_timestamp());
end $$;

create function public.feedback_popup_public_config() returns jsonb
 language sql stable security definer set search_path='' as $$
 select jsonb_build_object('campaignId',c.id,'enabled',c.enabled,'revision',c.revision,'updatedAt',c.updated_at)
 from public.feedback_popup_campaigns c where c.id='homepage-feedback-premium-30d' $$;

-- Admin toggle: optimistic revision, idempotent for the same value, audited.
create function public.feedback_popup_admin_set(p_enabled boolean,p_expected integer,p_actor uuid,p_request uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare c public.feedback_popup_campaigns%rowtype; v_changed boolean:=false;
begin
 select * into c from public.feedback_popup_campaigns where id='homepage-feedback-premium-30d' for update;
 if p_expected is not null and p_expected<>c.revision then raise exception 'CONFIG_REVISION_CONFLICT'; end if;
 if c.enabled is distinct from p_enabled then
  update public.feedback_popup_campaigns set enabled=p_enabled,revision=revision+1,updated_at=clock_timestamp(),updated_by=p_actor
   where id=c.id returning * into c;
  insert into public.feedback_popup_config_events(campaign_id,actor_id,request_id,previous_enabled,enabled,previous_revision,revision,occurred_at)
  values(c.id,p_actor,p_request,not p_enabled,p_enabled,c.revision-1,c.revision,c.updated_at);
  v_changed:=true;
 end if;
 return jsonb_build_object('campaignId',c.id,'enabled',c.enabled,'revision',c.revision,'createdAt',c.created_at,
  'updatedAt',c.updated_at,'updatedBy',c.updated_by,'changed',v_changed);
end $$;

-- Idempotent reconciliation, safe to run from any number of workers:
-- (1) retry registration claims that could not finish inline,
-- (2) place waiting rewards whose entitlement became finite,
-- (3) realign segments and refresh entitlement rows across start/end boundaries.
create function public.feedback_popup_reconcile(p_limit integer default 50) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare r record; v_now timestamptz:=clock_timestamp(); v_claims integer:=0; v_waiting integer:=0; v_workspaces integer:=0;
 e public.workspace_entitlements%rowtype; v_user public.users%rowtype;
begin
 if p_limit is null or p_limit not between 1 and 500 then raise exception 'VALIDATION_ERROR'; end if;
 if not pg_try_advisory_xact_lock(hashtextextended('homemind.feedback_popup.reconcile',0)) then
  return jsonb_build_object('skipped',true);
 end if;
 for r in select user_id from public.feedback_popup_claim_retries where next_attempt_at<=v_now order by next_attempt_at,user_id limit p_limit for update skip locked loop
  begin
   perform pg_advisory_xact_lock_shared(hashtextextended('homemind.feedback_popup.identity',0));
   perform public.feedback_popup_claim_at(r.user_id,clock_timestamp());
   delete from public.feedback_popup_claim_retries where user_id=r.user_id;
   v_claims:=v_claims+1;
  exception when others then
   update public.feedback_popup_claim_retries set attempts=attempts+1,last_error=left(sqlstate||':'||sqlerrm,200),
    next_attempt_at=clock_timestamp()+least(3600,10*power(2,least(attempts,8)))*interval '1 second' where user_id=r.user_id;
  end;
 end loop;
 for r in select rw.id,rw.user_id,rw.workspace_id from public.feedback_popup_rewards rw where rw.state='WAITING_ENTITLEMENT'
  order by rw.updated_at,rw.id limit p_limit for update skip locked loop
  begin
   perform 1 from public.workspaces where id=r.workspace_id for update skip locked;
   if not found then continue; end if;
   select * into e from public.workspace_entitlements where workspace_id=r.workspace_id for update;
   select * into v_user from public.users where id=r.user_id;
   if v_user.status<>'ACTIVE' then
    update public.feedback_popup_rewards set state='BLOCKED',reason='ACCOUNT_NOT_ACTIVE',updated_at=clock_timestamp() where id=r.id;
   elsif not (e.source='legacy_manual' and e.plan<>'free') then
    -- The entitlement stopped being indefinite when its row last changed: waiting time is never consumed.
    update public.feedback_popup_rewards set state='GRANTED',reason=null,anchor_at=greatest(anchor_at,e.updated_at),
     granted_at=clock_timestamp(),updated_at=clock_timestamp() where id=r.id;
    perform public.feedback_popup_place_at(r.id,clock_timestamp());
    v_waiting:=v_waiting+1;
   end if;
  exception when others then
   raise warning 'feedback_popup_reconcile: waiting reward % deferred (%)',r.id,sqlstate;
  end;
 end loop;
 -- Only workspaces whose materialized plan disagrees with the timeline need work;
 -- each repair removes the mismatch, so a busy backlog cannot starve later rows.
 for r in select rw.workspace_id from public.feedback_popup_rewards rw
  join public.workspace_entitlements en on en.workspace_id=rw.workspace_id and en.source='billing'
  left join lateral(select g.plan,g.product_limit from public.billing_grants g where g.workspace_id=rw.workspace_id
   and g.starts_at<=clock_timestamp() and coalesce(g.effective_until,g.expires_at)>clock_timestamp() order by g.starts_at desc,g.id limit 1) a on true
  where rw.state='GRANTED' and (en.plan is distinct from coalesce(a.plan,'free')
   or en.product_limit is distinct from (case when a.plan is null then 30 else a.product_limit end))
  limit p_limit loop
  begin
   perform 1 from public.workspaces where id=r.workspace_id for update skip locked;
   if not found then continue; end if;
   perform public.feedback_popup_realign_at(r.workspace_id,clock_timestamp());
   perform public.billing_refresh_at(r.workspace_id,clock_timestamp());
   v_workspaces:=v_workspaces+1;
  exception when others then
   raise warning 'feedback_popup_reconcile: workspace % deferred (%)',r.workspace_id,sqlstate;
  end;
 end loop;
 return jsonb_build_object('skipped',false,'claims',v_claims,'placed',v_waiting,'workspaces',v_workspaces);
end $$;

revoke all on function public.feedback_popup_reward_guard(),public.feedback_popup_primary_workspace(uuid),public.feedback_popup_paid_end(uuid,timestamptz),
 public.feedback_popup_place_at(uuid,timestamptz),public.feedback_popup_bind_at(uuid,uuid,timestamptz),public.feedback_popup_realign_at(uuid,timestamptz),
 public.feedback_popup_grant_changed(),public.feedback_popup_guard_overlap(),public.feedback_popup_claim_at(uuid,timestamptz),
 public.feedback_popup_claim_new_account(uuid),
 public.feedback_popup_submit_at(text,text,text,text,text,uuid,text,uuid,text,text,timestamptz),
 public.feedback_popup_submit(text,text,text,text,text,uuid,text,uuid,text,text),public.feedback_popup_public_config(),
 public.feedback_popup_admin_set(boolean,integer,uuid,uuid),public.feedback_popup_reconcile(integer) from public,homemind_app;
-- Runtime: the two public entry points and the bounded reconciliation worker only.
grant execute on function public.feedback_popup_submit(text,text,text,text,text,uuid,text,uuid,text,text),
 public.feedback_popup_public_config(),public.feedback_popup_reconcile(integer) to homemind_app;

-- ---------------------------------------------------------------------------
-- 8. Existing functions that must understand promotional time.
-- ---------------------------------------------------------------------------
-- Eligibility to BUY is decided from PAID time only: an active or scheduled
-- reward never blocks a purchase and never makes "this plan is already active".
create or replace function public.billing_purchase_reason(p_workspace uuid,p_plan text,p_now timestamptz) returns text
 language plpgsql security definer set search_path='' as $$
declare e jsonb; segment text; rank_current integer; rank_new integer; paid_plan text;
begin
 select type into segment from public.workspaces where id=p_workspace and archived_at is null;
 if segment is null then return 'ACTOR_NO_LONGER_ELIGIBLE'; end if;
 if (segment='household' and p_plan not in ('personal','family')) or (segment='store' and p_plan<>'micro_pos') then return 'PLAN_SEGMENT_MISMATCH'; end if;
 e:=public.billing_refresh_at(p_workspace,p_now);
 if e->>'source'='legacy_manual' then return 'MANUAL_PLAN_REQUIRES_REVIEW'; end if;
 -- Preserve committed legacy scheduled PAID coverage rather than silently superseding it.
 if exists(select 1 from public.billing_grants where workspace_id=p_workspace and reward_id is null and starts_at>p_now and coalesce(effective_until,expires_at)>p_now) then return 'LEGACY_COVERAGE_REQUIRES_REVIEW'; end if;
 select plan into paid_plan from public.billing_grants where workspace_id=p_workspace and reward_id is null
  and starts_at<=p_now and coalesce(effective_until,expires_at)>p_now order by starts_at desc,id limit 1;
 paid_plan:=coalesce(paid_plan,'free');
 if paid_plan=p_plan then return 'PLAN_ALREADY_ACTIVE'; end if;
 rank_current:=case paid_plan when 'free' then 0 when 'personal' then 1 else 2 end;
 rank_new:=case p_plan when 'personal' then 1 else 2 end;
 if rank_new<rank_current then return 'PLAN_DOWNGRADE_BLOCKED'; end if;
 if rank_current>0 and ((segment='store' and paid_plan<>'micro_pos') or (segment='household' and paid_plan='micro_pos')) then return 'LEGACY_COVERAGE_REQUIRES_REVIEW'; end if;
 return null;
end; $$;

-- Additive: the subscription/scheduled entries now carry "source" (PAID|PROMOTION).
create or replace function public.billing_read(p_workspace uuid,p_order uuid,p_offset integer default 0) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare result jsonb; e jsonb;
begin
 perform 1 from public.workspaces where id=p_workspace for update;
 if not public.billing_owner(p_workspace) then raise exception 'FORBIDDEN'; end if;
 e:=public.billing_refresh_internal(p_workspace);
 if p_order is not null then
  select public.billing_order_public(o) into result from public.billing_orders o where id=p_order and workspace_id=p_workspace;
  if result is null then raise exception 'NOT_FOUND'; end if;
  return result;
 end if;
 if p_offset not between 0 and 100000 then raise exception 'VALIDATION_ERROR'; end if;
 return jsonb_build_object('workspaceType',(select type from public.workspaces where id=p_workspace),
 'serverNow',clock_timestamp(), 'eligibility',jsonb_build_object(
  'personal',public.billing_purchase_reason(p_workspace,'personal',clock_timestamp()),
  'family',public.billing_purchase_reason(p_workspace,'family',clock_timestamp()),
  'micro_pos',public.billing_purchase_reason(p_workspace,'micro_pos',clock_timestamp())),
 'entitlement',e,'subscription',(
 select jsonb_build_object('plan',g.plan,'startsAt',g.starts_at,'expiresAt',coalesce(g.effective_until,g.expires_at),'originalExpiresAt',g.expires_at,'policyVersion',g.price_snapshot->>'policyVersion','productLimit',g.product_limit,'source',g.source_kind)
 from public.billing_grants g where workspace_id=p_workspace and starts_at<=now() and coalesce(effective_until,expires_at)>clock_timestamp() order by starts_at desc limit 1),
 'scheduled',coalesce((select jsonb_agg(jsonb_build_object('plan',plan,'startsAt',starts_at,'expiresAt',expires_at,'source',source_kind) order by starts_at,id) from public.billing_grants where workspace_id=p_workspace and starts_at>now()),'[]'::jsonb),
 'payments',coalesce((select jsonb_agg(public.billing_order_public(o) order by created_at desc,id desc) from
 (select * from public.billing_orders where workspace_id=p_workspace order by created_at desc,id desc limit 20 offset p_offset) o),'[]'::jsonb),
 'nextOffset',case when (select count(*) from public.billing_orders where workspace_id=p_workspace)>p_offset+20 then p_offset+20 end);
end; $$;

-- Verbatim copy of the settlement core from 20261005013000_payos_canonical_memo with ONE
-- change (marked below): promotional time is not a "newer purchase". Without it, a reward
-- that began between a payment and its settlement would strand that payment in review.
create or replace function public.billing_system_verified_at(p_action text,p_id uuid,p_data jsonb,p_now timestamptz) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare o public.billing_orders%rowtype; t jsonb; g public.billing_grants%rowtype;
 link text; ref text; total bigint:=0; paidtime timestamptz; tx_time timestamptz;
 canonical_memo text; previous public.billing_transactions%rowtype; start_at timestamptz; reason text; namespace_channel text;
begin
 if p_action='inbox' then
  insert into public.billing_webhook_inbox(channel,fingerprint,order_code,reference,payment_link_id,amount,currency,description)
  values(p_data->>'channel',p_data->>'fingerprint',(p_data->>'orderCode')::bigint,p_data->>'reference',p_data->>'paymentLinkId',(p_data->>'amount')::int,p_data->>'currency',p_data->>'description') on conflict do nothing;
  select id into p_id from public.billing_orders where order_code=(p_data->>'orderCode')::bigint and channel=p_data->>'channel';
  return jsonb_build_object('id',p_id,'durable',true);
 end if;
 if p_action='claim' then
  select * into o from public.billing_orders where (p_id is null or id=p_id) and channel=p_data->>'channel'
  and financial_state in ('UNPAID','PARTIAL') and status not in ('CANCELLED','EXPIRED','REVIEW')
  and (lease_until is null or lease_until<p_now) and (p_id is not null or next_check_at<=p_now)
  order by next_check_at,id limit 1 for update skip locked;
  if not found then return null; end if;
  update public.billing_orders set lease_id=gen_random_uuid(),lease_until=p_now+interval '25 seconds',attempts=attempts+1 where id=o.id returning * into o;
  return to_jsonb(o);
 end if;
 -- All workspace-affecting paths acquire workspace before order: no lock inversion.
 select workspace_id into g.workspace_id from public.billing_orders where id=p_id;
 if g.workspace_id is null then raise exception 'NOT_FOUND'; end if;
 perform 1 from public.workspaces where id=g.workspace_id for update;
 select * into o from public.billing_orders where id=p_id for update;
 if o.channel is distinct from p_data->>'channel' then raise exception 'BILLING_CHANNEL_CHANGED'; end if;
 if p_action='release' then
  if o.lease_id::text=p_data->>'leaseId' then
   update public.billing_orders set lease_id=null,lease_until=null,next_check_at=p_now+make_interval(secs=>least(3600,15*power(2,least(o.attempts,8)))::int),
   status=case when status='CREATED' then 'CREATE_UNCERTAIN' else status end,updated_at=p_now where id=o.id;
  end if;
  return public.billing_order_public(o);
 end if;
 if p_action='review' then
  update public.billing_orders set fulfillment=case when fulfillment='GRANTED' then fulfillment else 'REVIEW' end,
  status=case when financial_state='PAID' then 'PAID' else 'REVIEW' end,review_reason='PROVIDER_IDENTITY_CONFLICT',lease_until=null,lease_id=null,updated_at=p_now where id=o.id returning * into o;
  return public.billing_order_public(o);
 end if;
 if p_action='attach' then
  if (p_data->>'orderCode')::bigint<>o.order_code or (p_data->>'amount')::int<>(o.price_snapshot->>'amount')::int
   or p_data->>'currency' is distinct from 'VND' or not public.billing_memo_matches(o.description,p_data->>'description')
   or (o.provider_description is not null and p_data->>'description' is distinct from o.provider_description)
   or (o.payment_link_id is not null and o.payment_link_id<>p_data->>'paymentLinkId') then raise exception 'PROVIDER_IDENTITY_CONFLICT'; end if;
  update public.billing_orders set payment_link_id=p_data->>'paymentLinkId',checkout_url=p_data->>'checkoutUrl',provider_description=case when p_data->>'qrCode' is not null then p_data->>'description' else o.provider_description end,qr_code=p_data->>'qrCode',bank_bin=p_data->>'bin',bank_account=p_data->>'accountNumber',bank_name=p_data->>'accountName',
   status=case when status in ('CREATED','CREATE_UNCERTAIN') then 'PENDING' else status end,updated_at=p_now where id=o.id returning * into o;
  return public.billing_order_public(o);
 end if;
 if p_action<>'settle' then raise exception 'VALIDATION_ERROR'; end if;
 -- PAID/GRANTED can never be reversed by a delayed PENDING/CANCELLED response.
 if o.financial_state='PAID' and o.fulfillment='GRANTED' then return public.billing_order_public(o); end if;
 link:=p_data->>'id';
 if (p_data->>'orderCode')::bigint<>o.order_code or (p_data->>'amount')::int<>(o.price_snapshot->>'amount')::int or length(coalesce(link,''))=0 then reason:='PROVIDER_IDENTITY_CONFLICT';
 elsif o.payment_link_id is not null and o.payment_link_id<>link then reason:='PROVIDER_IDENTITY_CONFLICT';
 elsif o.payment_link_id is null and not exists(select 1 from public.billing_webhook_inbox where channel=o.channel and order_code=o.order_code and payment_link_id=link and public.billing_memo_matches(o.description,description) and currency='VND') then reason:='UNBOUND_PROVIDER_LINK'; end if;
 if reason is null and jsonb_array_length(p_data->'transactions')>0 then
  canonical_memo:=coalesce(o.provider_description,p_data->'transactions'->0->>'description');
  if not public.billing_memo_matches(o.description,canonical_memo) then reason:='PROVIDER_IDENTITY_CONFLICT'; end if;
 end if;
 if reason is null then
  for t in select value from jsonb_array_elements(p_data->'transactions') loop
   if t->>'description' is distinct from canonical_memo then reason:='PROVIDER_IDENTITY_CONFLICT'; exit; end if;
   ref:=t->>'reference'; tx_time:=(t->>'transactionDateTime')::timestamptz;
   if length(coalesce(ref,'')) not between 1 and 200 or (t->>'amount')::bigint not between 1 and 2147483647 or tx_time>p_now+interval '5 minutes' or tx_time<o.created_at-interval '5 minutes' then reason:='TRANSACTION_INVALID'; exit; end if;
   select * into previous from public.billing_transactions where channel=o.channel and reference=ref;
   if found and (previous.order_id<>o.id or previous.amount<>(t->>'amount')::int) then reason:='TRANSACTION_REPLAY'; exit; end if;
   insert into public.billing_transactions(channel,reference,order_id,amount,paid_at) values(o.channel,ref,o.id,(t->>'amount')::int,tx_time) on conflict do nothing;
   -- Recheck under concurrent unique-reference conflict across workspaces.
   select * into previous from public.billing_transactions where channel=o.channel and reference=ref;
   if previous.order_id<>o.id or previous.amount<>(t->>'amount')::int then reason:='TRANSACTION_REPLAY'; exit; end if;
   total:=total+(t->>'amount')::int; paidtime:=greatest(paidtime,tx_time);
  end loop;
  if reason is null and (total<>(p_data->>'amountPaid')::bigint or total>(o.price_snapshot->>'amount')::bigint) then reason:='AMOUNT_REVIEW'; end if;
 end if;
 if reason is not null then
  update public.billing_orders set status=case when o.financial_state='PAID' or (p_data->>'status'='PAID' and reason='AMOUNT_REVIEW') then 'PAID' else 'REVIEW' end,
   financial_state=case when o.financial_state='PAID' or (p_data->>'status'='PAID' and reason='AMOUNT_REVIEW') then 'PAID' else 'REVIEW' end,
   amount_paid=case when reason='AMOUNT_REVIEW' then greatest(amount_paid,(p_data->>'amountPaid')::int) else amount_paid end,
   fulfillment='REVIEW',review_reason=reason,lease_id=null,lease_until=null,updated_at=p_now where id=o.id returning * into o;
  return public.billing_order_public(o);
 end if;
 if canonical_memo is not null and o.provider_description is null then
  update public.billing_orders set provider_description=canonical_memo where id=o.id returning * into o;
 end if;
 if p_data->>'status'='PAID' and total=(o.price_snapshot->>'amount')::int and (p_data->>'amountRemaining')::int=0 then
  if paidtime is null or paidtime>o.expires_at then reason:='LATE_PAYMENT';
  elsif not exists(select 1 from public.users u join public.workspace_members m on m.user_id=u.id join public.workspaces w on w.id=m.workspace_id
   where u.id=o.actor_id and u.status='ACTIVE' and m.workspace_id=o.workspace_id and m.role='owner' and w.archived_at is null) then reason:='ACTOR_NO_LONGER_ELIGIBLE';
  elsif exists(select 1 from public.workspace_entitlements where workspace_id=o.workspace_id and source='legacy_manual') then reason:='MANUAL_PLAN_REQUIRES_REVIEW'; end if;
  if reason is null then
   if o.price_snapshot->>'policyVersion'='voice-30d-v2' then
    reason:=public.billing_purchase_reason(o.workspace_id,o.price_snapshot->>'plan',p_now);
    -- CHANGED: "and reward_id is null" (promotional time is not a newer purchase).
    if exists(select 1 from public.billing_grants where workspace_id=o.workspace_id and reward_id is null and starts_at>paidtime and starts_at<=p_now) then reason:='STALE_PAYMENT_REQUIRES_REVIEW'; end if;
    if reason is null then
     insert into public.billing_grants(order_id,workspace_id,plan,product_limit,starts_at,expires_at,price_snapshot)
      values(o.id,o.workspace_id,o.price_snapshot->>'plan',(o.price_snapshot->>'productLimit')::int,paidtime,
       paidtime+make_interval(secs=>(o.price_snapshot->>'durationSeconds')::int),o.price_snapshot) on conflict(order_id) do nothing returning * into g;
     update public.billing_grants set effective_until=paidtime,superseded_at=paidtime,superseded_by=g.id
      where workspace_id=o.workspace_id and id<>g.id and starts_at<=paidtime and coalesce(effective_until,expires_at)>paidtime;
    end if;
   else
    -- Historical purchases retain the calendar/scheduled contract they bought.
    select greatest(p_now,coalesce(max(expires_at),p_now)) into start_at from public.billing_grants where workspace_id=o.workspace_id;
    insert into public.billing_grants(order_id,workspace_id,plan,product_limit,starts_at,expires_at,price_snapshot)
     values(o.id,o.workspace_id,o.price_snapshot->>'plan',(o.price_snapshot->>'productLimit')::int,start_at,
      ((start_at at time zone 'Asia/Ho_Chi_Minh')+make_interval(months=>(o.price_snapshot->>'months')::int)) at time zone 'Asia/Ho_Chi_Minh',o.price_snapshot) on conflict(order_id) do nothing;
   end if;
   if reason is null then
    update public.workspace_entitlements set source='billing' where workspace_id=o.workspace_id;
    perform public.billing_refresh_at(o.workspace_id,p_now);
   end if;
  end if;
  update public.billing_orders set payment_link_id=link,status='PAID',financial_state='PAID',fulfillment=case when reason is null then 'GRANTED' else 'REVIEW' end,
   review_reason=reason,amount_paid=total,paid_at=paidtime,lease_id=null,lease_until=null,updated_at=p_now where id=o.id returning * into o;
 else
  if o.financial_state<>'PAID' then
   update public.billing_orders set payment_link_id=link,amount_paid=greatest(amount_paid,total),
    financial_state=case when total>0 then 'PARTIAL' else 'UNPAID' end,
    status=case when total>0 then 'UNDERPAID' when p_data->>'status' in ('CANCELLED','EXPIRED') then p_data->>'status' else 'PENDING' end,
    lease_id=null,lease_until=null,next_check_at=p_now+interval '30 seconds',updated_at=p_now where id=o.id returning * into o;
  end if;
 end if;
 return public.billing_order_public(o);
end; $$;

-- A promotional segment ending is not "a paid plan ended": it must neither send
-- the financial billing notice nor reference a non-existent order.
create or replace function public.notification_scan_due() returns integer language plpgsql security definer set search_path='' as $$
declare row record; member record; n int:=0; key text; read_time timestamptz; owner_id uuid; was_paid boolean; effective jsonb;
begin
 for row in select g.* from public.billing_grants g where coalesce(g.effective_until,g.expires_at)<=clock_timestamp() and g.superseded_at is null
  and g.reward_id is null
  and not exists(select 1 from public.notification_due_receipts r where r.kind='grant' and r.source_id=g.id)
  order by coalesce(g.effective_until,g.expires_at),g.id limit 50 loop
  perform 1 from public.workspaces where id=row.workspace_id and archived_at is null for update skip locked;
  if not found then continue; end if;
  if not exists(select 1 from public.billing_grants g where g.workspace_id=row.workspace_id and g.starts_at<=clock_timestamp()
   and coalesce(g.effective_until,g.expires_at)>clock_timestamp()) then
   select source='billing' and plan<>'free' into was_paid from public.workspace_entitlements where workspace_id=row.workspace_id;
   effective:=public.billing_refresh_internal(row.workspace_id);
   if was_paid and effective->>'plan'='free' then
   for member in select user_id from public.workspace_members where workspace_id=row.workspace_id and role='owner' loop
    perform public.notification_enqueue('grant-expired:v1:'||row.id,member.user_id,row.workspace_id,true,'billing.plan_expired',
     'Gói trả phí đã kết thúc','Không gian đã trở về gói Miễn phí.','Dữ liệu và lịch sử được giữ nguyên. Gói Miễn phí có quyền truy cập vĩnh viễn.',
     'billing',row.order_id::text,coalesce(row.effective_until,row.expires_at));
   end loop;
   end if;
  end if;
  insert into public.notification_due_receipts values('grant',row.id) on conflict do nothing; n:=n+1;
 end loop;
 for row in select p.* from public.assistant_quota_periods p where p.expires_at<=clock_timestamp()
  and not exists(select 1 from public.notification_due_receipts r where r.kind='quota' and r.source_id=p.id)
  order by p.expires_at,p.id limit 50 loop
  perform 1 from public.workspaces where id=row.workspace_id and archived_at is null for update skip locked;
  if not found then continue; end if;
  perform public.assistant_period_at(row.workspace_id,clock_timestamp());
  insert into public.notification_due_receipts values('quota',row.id) on conflict do nothing; n:=n+1;
 end loop;
 -- Existing expiry.product.date logical identity is retained; legacy reads are
 -- copied only for those facts, not fabricated account/payment history.
 for row in select l.*,p.name from public.inventory_lots l join public.products p on p.id=l.product_id and p.archived_at is null
  where l.quantity>0 and l.expiry_date<=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date+7
  and not exists(select 1 from public.notification_due_receipts r where r.kind='lot' and r.source_id=l.id)
  order by l.expiry_date,l.id limit 50 loop
  perform 1 from public.workspaces where id=row.workspace_id and archived_at is null for update skip locked;
  if not found then continue; end if;
  if not exists(select 1 from public.inventory_lots where id=row.id and quantity>0 and expiry_date=row.expiry_date) then continue; end if;
  key:='expiry.'||row.product_id||'.'||row.expiry_date;
  for member in select user_id from public.workspace_members where workspace_id=row.workspace_id and not exists(select 1 from public.notification_outbox o where o.event_key=key and o.recipient_id=user_id) limit 50 loop
   perform public.notification_enqueue(key,member.user_id,row.workspace_id,false,'inventory.expiry',row.name,
    'Hạn sử dụng: '||row.expiry_date,'Mở sản phẩm để xem tồn kho hiện tại.','inventory',row.product_id::text,
    greatest(row.created_at,(row.expiry_date-7)::timestamp at time zone 'Asia/Ho_Chi_Minh'));
  end loop;
  if not exists(select 1 from public.workspace_members m where m.workspace_id=row.workspace_id and not exists(select 1 from public.notification_outbox o where o.event_key=key and o.recipient_id=m.user_id)) then insert into public.notification_due_receipts values('lot',row.id) on conflict do nothing; end if; n:=n+1;
 end loop;
 return n;
end $$;
revoke all on function public.notification_scan_due() from public;
grant execute on function public.notification_scan_due() to homemind_app;

-- ---------------------------------------------------------------------------
-- 9. Admin read models. The inspection role gets SELECT only (see
--    prisma/admin-grants.sql); the one write is feedback_popup_admin_set().
-- ---------------------------------------------------------------------------
-- "grant_id"/"paid_expires_at" stay paid-only: promotional time has no order.
create or replace view admin.workspaces with(security_invoker=true) as
 with effective as (
 select w.id,w.name,w.type,w.created_at,w.updated_at,w.archived_at,coalesce(s.provenance,'UNCLASSIFIED_LEGACY') provenance,
 case when e.source='legacy_manual' then e.plan when e.source='billing' and g.id is not null then g.plan else 'free' end plan,
 case when e.source='legacy_manual' then e.source when e.source='billing' and g.id is not null then e.source else 'free' end source,
 e.workspace_id is not null entitlement_known,
 case when e.source='legacy_manual' then e.product_limit when e.source='billing' and g.id is not null then g.product_limit else 30 end product_limit,
 case when e.source='billing' and g.order_id is not null then g.id end grant_id,
 case when e.source='billing' and g.order_id is not null then coalesce(g.effective_until,g.expires_at) end paid_expires_at,
 case when e.source='billing' and g.id is not null then g.starts_at when e.source='legacy_manual' and e.plan<>'free' then w.created_at else greatest(w.created_at,(select max(coalesce(x.effective_until,x.expires_at)) from public.billing_grants x where x.workspace_id=w.id and coalesce(x.effective_until,x.expires_at)<=now())) end anchor
 from public.workspaces w left join public.workspace_entitlements e on e.workspace_id=w.id left join admin.workspace_scope s on s.workspace_id=w.id
 left join lateral(select id,order_id,plan,product_limit,starts_at,expires_at,effective_until from public.billing_grants where workspace_id=w.id and starts_at<=now() and coalesce(effective_until,expires_at)>now() order by starts_at desc,id limit 1) g on true
 ), periods as (
 select e.*,anchor+floor(extract(epoch from(now()-anchor))/2592000)*interval '2592000 seconds' period_start,
 case plan when 'personal' then 60 when 'family' then 100 when 'micro_pos' then 200 else 15 end usage_limit from effective e
 ) select e.id,e.created_at,e.type,e.plan,e.archived_at,e.provenance,e.entitlement_known,e.source,e.grant_id,e.paid_expires_at,greatest(0,e.usage_limit-coalesce(p.used,0)-r.n) remaining,
 jsonb_build_object('id',e.id,'name',e.name,'type',e.type,'createdAt',e.created_at,'updatedAt',e.updated_at,'archivedAt',e.archived_at,
 'plan',e.plan,'source',e.source,'entitlementKnown',e.entitlement_known,'freeLifetimeAccess',e.plan='free','membershipRole',null,'provenance',e.provenance,
 'productLimit',e.product_limit,'productCount',(select count(*) from public.products x where x.workspace_id=e.id and x.archived_at is null),
 'grantId',e.grant_id,'paidExpiresAt',e.paid_expires_at,
 'quota',jsonb_build_object('periodId',p.id,'plan',e.plan,'policyVersion','voice-30d-v2','startsAt',e.period_start,
 'expiresAt',least(e.period_start+interval '2592000 seconds',coalesce(e.paid_expires_at,e.period_start+interval '2592000 seconds')),
 'total',e.usage_limit,'used',coalesce(p.used,0),'reserved',r.n,'remaining',greatest(0,e.usage_limit-coalesce(p.used,0)-r.n),
 'projectionOnly',p.id is null,'entitlementKnown',e.entitlement_known)) data
 from periods e left join public.assistant_quota_periods p on p.workspace_id=e.id and p.starts_at=e.period_start and p.plan=e.plan and p.policy_version='voice-30d-v2'
 left join lateral(select count(*) n from public.assistant_quota_requests r where r.period_id=p.id and state='RESERVED' and lease_until>now()) r on true;

-- One row per accepted submission with its derived benefit state. The state is
-- computed from the stored reward + timeline at read time, never from a flag a
-- worker has to flip.
create view admin.feedback_submissions with(security_invoker=true) as
 select s.id,s.submitted_at,s.campaign_id,s.email,s.phone,s.full_name,r.user_id,r.workspace_id,
  case r.state when 'GRANTED' then
    case when seg.id is null then 'EXPIRED' when seg.starts_at>now() then 'SCHEDULED'
     when coalesce(seg.effective_until,seg.expires_at)>now() then 'ACTIVE' else 'EXPIRED' end
   else r.state end benefit_state,
  jsonb_build_object('id',s.id,'campaignId',s.campaign_id,'submittedAt',s.submitted_at,'fullName',s.full_name,
   'email',s.email,'phoneNumber',s.phone,'review',s.review,'reviewPreview',left(s.review,200),'reviewLength',char_length(s.review),
   'submitterUserId',s.submitter_user_id,'duplicate',r.state='DUPLICATE',
   'benefit',jsonb_build_object(
    'state',case r.state when 'GRANTED' then
      case when seg.id is null then 'EXPIRED' when seg.starts_at>now() then 'SCHEDULED'
       when coalesce(seg.effective_until,seg.expires_at)>now() then 'ACTIVE' else 'EXPIRED' end
      else r.state end,
    'reason',r.reason,'plan',r.plan,'durationSeconds',r.duration_seconds,'userId',r.user_id,'workspaceId',r.workspace_id,
    'anchorAt',r.anchor_at,'boundAt',r.bound_at,'grantedAt',r.granted_at,
    'startsAt',seg.starts_at,'endsAt',coalesce(seg.effective_until,seg.expires_at),
    'postponed',exists(select 1 from public.billing_grants p where p.reward_id=r.id and p.superseded_at is not null))) data
 from public.feedback_popup_submissions s join public.feedback_popup_rewards r on r.submission_id=s.id
 left join lateral(select g.id,g.starts_at,g.expires_at,g.effective_until from public.billing_grants g
  where g.reward_id=r.id and g.superseded_at is null order by g.starts_at desc,g.id limit 1) seg on true;
revoke all on admin.workspaces,admin.feedback_submissions from public,homemind_app;
commit;
