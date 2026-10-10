-- Preserve per-submission decisions; identify the shared nomination/issued allotment.
-- All changes are transactional. Ambiguous issued legacy data requires an operator decision.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
lock table public.feedback_popup_rewards in share row exclusive mode;
do $$ begin
 if exists(select 1 from public.feedback_popup_submissions s left join public.feedback_popup_rewards r on r.submission_id=s.id where r.id is null) then
  raise exception 'FEEDBACK_LEGACY_MISSING_DECISION_REQUIRES_REVIEW'; end if;
 if exists(select 1 from public.feedback_popup_rewards
   where state in ('WAITING_ENTITLEMENT','GRANTED') or (state='BLOCKED' and anchor_at is not null)
   group by user_id having count(*)>1)
 or exists(select 1 from public.feedback_popup_rewards
   where state in ('WAITING_ENTITLEMENT','GRANTED') or (state='BLOCKED' and anchor_at is not null)
   group by workspace_id having count(*)>1) then
  raise exception 'FEEDBACK_LEGACY_MULTIPLE_ALLOTMENTS_REQUIRES_REVIEW';
 end if;
end $$;

alter table public.feedback_popup_rewards
 add column logical_reward_id uuid references public.feedback_popup_rewards(id) deferrable initially deferred,
 add column allotment_consumed boolean not null default false,
 add column awarded_at timestamptz,
 add column nomination_key text;
-- Backfill metadata only: no grant, recipient, original timestamp or decision is rewritten.
update public.feedback_popup_rewards r set logical_reward_id=r.id,
 nomination_key=encode(sha256(convert_to(jsonb_build_array(s.email,s.phone)::text,'UTF8')),'hex'),
 allotment_consumed=(r.state in ('WAITING_ENTITLEMENT','GRANTED') or (r.state='BLOCKED' and r.anchor_at is not null)),
 awarded_at=case when r.state in ('WAITING_ENTITLEMENT','GRANTED') or (r.state='BLOCKED' and r.anchor_at is not null)
   then coalesce(r.bound_at,r.granted_at) end
 from public.feedback_popup_submissions s where s.id=r.submission_id;
update public.feedback_popup_rewards r set logical_reward_id=x.id
 from public.feedback_popup_rewards x
 where r.state='DUPLICATE' and r.reason='ACCOUNT_ALREADY_REWARDED'
 and x.allotment_consumed and x.user_id=r.user_id;
with roots as (
 select r.id,first_value(r.id) over(partition by r.nomination_key order by s.submitted_at,s.id) root
 from public.feedback_popup_rewards r join public.feedback_popup_submissions s on s.id=r.submission_id
 where r.state='PENDING_ACCOUNT'
) update public.feedback_popup_rewards r set logical_reward_id=roots.root from roots where r.id=roots.id;
-- Validate the self references before further ALTER TABLE operations: PostgreSQL
-- refuses those operations while deferred FK trigger events remain queued.
set constraints feedback_popup_rewards_logical_reward_id_fkey immediate;
alter table public.feedback_popup_rewards alter column logical_reward_id set not null;
alter table public.feedback_popup_rewards alter column nomination_key set not null;
alter table public.feedback_popup_rewards add constraint feedback_popup_allotment_shape check(
 (not allotment_consumed and awarded_at is null) or
 (allotment_consumed and logical_reward_id=id and user_id is not null and workspace_id is not null));
-- Program-wide and durable: neither campaign, state, contact changes nor expiry release the key.
create unique index feedback_popup_program_user on public.feedback_popup_rewards(user_id) where allotment_consumed;
create unique index feedback_popup_program_workspace on public.feedback_popup_rewards(workspace_id) where allotment_consumed;
create unique index feedback_popup_pending_nomination on public.feedback_popup_rewards(nomination_key)
 where state='PENDING_ACCOUNT' and logical_reward_id=id;
create index feedback_popup_logical_submission on public.feedback_popup_rewards(logical_reward_id,submission_id);
create index feedback_popup_account_decisions on public.feedback_popup_rewards(user_id,submission_id) where user_id is not null;

create function public.feedback_popup_nomination_insert() returns trigger language plpgsql set search_path='' as $$
declare s public.feedback_popup_submissions%rowtype; v_root uuid;
begin
 select * into s from public.feedback_popup_submissions where id=new.submission_id;
 new.nomination_key:=encode(sha256(convert_to(jsonb_build_array(s.email,s.phone)::text,'UTF8')),'hex');
 -- Exact canonical pair only. One unverified email OR phone must not reserve an identity.
 select r.id into v_root from public.feedback_popup_rewards r join public.feedback_popup_submissions x on x.id=r.submission_id
 where r.nomination_key=new.nomination_key and r.state='PENDING_ACCOUNT' and r.logical_reward_id=r.id
 and x.email=s.email and x.phone=s.phone;
 new.logical_reward_id:=coalesce(v_root,new.id);
 if new.state<>'PENDING_ACCOUNT' or new.allotment_consumed or new.awarded_at is not null then
  raise exception 'REWARD_INITIAL_STATE_INVALID'; end if;
 return new;
end $$;
create trigger feedback_popup_nomination_insert before insert on public.feedback_popup_rewards
 for each row execute function public.feedback_popup_nomination_insert();
revoke all on function public.feedback_popup_nomination_insert() from public,homemind_app;

create or replace function public.feedback_popup_reward_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if new.id<>old.id or new.submission_id<>old.submission_id or new.campaign_id<>old.campaign_id
 or new.created_at<>old.created_at or new.nomination_key<>old.nomination_key then raise exception 'REWARD_IDENTITY_IMMUTABLE'; end if;
 if old.user_id is not null and new.user_id is distinct from old.user_id then raise exception 'REWARD_BINDING_IMMUTABLE'; end if;
 if old.workspace_id is not null and new.workspace_id is distinct from old.workspace_id then raise exception 'REWARD_BINDING_IMMUTABLE'; end if;
 if old.allotment_consumed and (not new.allotment_consumed or new.awarded_at is distinct from old.awarded_at
   or new.logical_reward_id<>old.logical_reward_id or new.bound_at is distinct from old.bound_at
   or new.anchor_at is distinct from old.anchor_at and old.state<>'WAITING_ENTITLEMENT') then raise exception 'REWARD_ALLOTMENT_IMMUTABLE'; end if;
 if old.state<>'PENDING_ACCOUNT' and new.logical_reward_id<>old.logical_reward_id then raise exception 'REWARD_SOURCE_IMMUTABLE'; end if;
 if new.user_id is not null and exists(select 1 from public.feedback_popup_rewards x
   where x.id=new.logical_reward_id and x.user_id is not null and x.user_id<>new.user_id) then
  raise exception 'REWARD_BENEFICIARY_MISMATCH'; end if;
 if new.state in ('WAITING_ENTITLEMENT','GRANTED') then
  if new.logical_reward_id<>new.id then raise exception 'REWARD_NONCANONICAL_ALLOTMENT'; end if;
  new.allotment_consumed:=true;
  if not old.allotment_consumed then new.awarded_at:=new.bound_at; end if;
 end if;
 if not old.allotment_consumed and new.allotment_consumed and new.state not in ('WAITING_ENTITLEMENT','GRANTED') then
  raise exception 'REWARD_ALLOTMENT_STATE_INVALID'; end if;
 if old.state<>new.state and not (
   (old.state='PENDING_ACCOUNT' and new.state in ('WAITING_ENTITLEMENT','GRANTED','CONFLICT','BLOCKED','DUPLICATE'))
   or (old.state='WAITING_ENTITLEMENT' and new.state in ('GRANTED','BLOCKED'))) then raise exception 'REWARD_STATE_TRANSITION_INVALID'; end if;
 return new;
end $$;

create or replace function public.feedback_popup_bind_at(p_reward uuid,p_user uuid,p_now timestamptz) returns text
 language plpgsql security definer set search_path='' as $$
declare r public.feedback_popup_rewards%rowtype; s public.feedback_popup_submissions%rowtype; u public.users%rowtype;
 v_workspace uuid; e public.workspace_entitlements%rowtype; v_anchor timestamptz; v_existing uuid;
begin
 -- All claimers use account -> decision -> workspace -> entitlement. Billing never takes the account lock.
 perform pg_advisory_xact_lock(hashtextextended('homemind.feedback_popup.account:'||p_user::text,0));
 select * into r from public.feedback_popup_rewards where id=p_reward for update;
 if not found then raise exception 'REWARD_NOT_FOUND'; end if;
 if r.state<>'PENDING_ACCOUNT' then return r.state; end if;
 select * into s from public.feedback_popup_submissions where id=r.submission_id;
 select * into u from public.users where id=p_user;
 if not found then raise exception 'USER_NOT_FOUND'; end if;
 select id into v_existing from public.feedback_popup_rewards where user_id=u.id and allotment_consumed;
 if u.status<>'ACTIVE' then
  update public.feedback_popup_rewards set state='BLOCKED',reason='ACCOUNT_NOT_ACTIVE',user_id=u.id,
   logical_reward_id=coalesce(v_existing,r.id),bound_at=p_now,updated_at=p_now where id=r.id;
  return 'BLOCKED';
 end if;
 v_workspace:=public.feedback_popup_primary_workspace(u.id);
 if v_workspace is null then
  update public.feedback_popup_rewards set state='BLOCKED',reason='NO_ELIGIBLE_WORKSPACE',user_id=u.id,
   logical_reward_id=coalesce(v_existing,r.id),bound_at=p_now,updated_at=p_now where id=r.id;
  return 'BLOCKED';
 end if;
 if v_existing is not null then
  update public.feedback_popup_rewards set logical_reward_id=v_existing where logical_reward_id=r.id and state='PENDING_ACCOUNT' and id<>r.id;
  update public.feedback_popup_rewards set state='DUPLICATE',reason='ACCOUNT_ALREADY_REWARDED',user_id=u.id,
   workspace_id=v_workspace,logical_reward_id=v_existing,bound_at=p_now,updated_at=p_now where id=r.id;
  return 'DUPLICATE';
 end if;
 -- A pending follower resolves its original source first, under this same account lock.
 if r.logical_reward_id<>r.id then
  perform public.feedback_popup_bind_at(r.logical_reward_id,p_user,p_now);
  select id into v_existing from public.feedback_popup_rewards where user_id=u.id and allotment_consumed;
  if v_existing is not null then
   update public.feedback_popup_rewards set state='DUPLICATE',reason='ACCOUNT_ALREADY_REWARDED',user_id=u.id,
    workspace_id=v_workspace,logical_reward_id=v_existing,bound_at=p_now,updated_at=p_now where id=r.id;
   return 'DUPLICATE';
  end if;
  -- A blocked/conflicting nomination did not issue a reward. This decision is still independent.
  update public.feedback_popup_rewards set logical_reward_id=id where id=r.id;
 end if;
 perform 1 from public.workspaces where id=v_workspace for update;
 if exists(select 1 from public.feedback_popup_rewards x where x.workspace_id=v_workspace and x.allotment_consumed) then
  update public.feedback_popup_rewards set state='DUPLICATE',reason='WORKSPACE_ALREADY_REWARDED',user_id=u.id,
   workspace_id=v_workspace,bound_at=p_now,updated_at=p_now where id=r.id;
  return 'DUPLICATE';
 end if;
 v_anchor:=greatest(u.created_at,s.submitted_at);
 insert into public.workspace_entitlements(workspace_id) values(v_workspace) on conflict do nothing;
 select * into e from public.workspace_entitlements where workspace_id=v_workspace for update;
 if e.source='legacy_manual' and e.plan<>'free' then
  update public.feedback_popup_rewards set state='WAITING_ENTITLEMENT',reason='INDEFINITE_ENTITLEMENT',user_id=u.id,
   workspace_id=v_workspace,anchor_at=v_anchor,bound_at=p_now,updated_at=p_now where id=r.id;
  return 'WAITING_ENTITLEMENT';
 end if;
 update public.feedback_popup_rewards set state='GRANTED',reason=null,user_id=u.id,workspace_id=v_workspace,anchor_at=v_anchor,
  bound_at=p_now,granted_at=p_now,updated_at=p_now where id=r.id;
 perform public.feedback_popup_place_at(r.id,p_now);
 return 'GRANTED';
end $$;

-- Acquire the account lock before locking pending decision rows. The existing
-- shared identity lock at registration and exclusive submit lock are unchanged.
create or replace function public.feedback_popup_claim_at(p_user uuid,p_now timestamptz) returns integer
 language plpgsql security definer set search_path='' as $$
declare u public.users%rowtype; r record; ua public.users%rowtype; ub public.users%rowtype; n integer:=0;
begin
 perform pg_advisory_xact_lock(hashtextextended('homemind.feedback_popup.account:'||p_user::text,0));
 select * into u from public.users where id=p_user;
 if not found or u.status<>'ACTIVE' then return 0; end if;
 for r in select rw.id,s.email,s.phone from public.feedback_popup_rewards rw join public.feedback_popup_submissions s on s.id=rw.submission_id
  where rw.state='PENDING_ACCOUNT' and ((u.email is not null and s.email=u.email) or (u.phone is not null and s.phone=u.phone))
  order by s.submitted_at,s.id for update of rw skip locked loop
  select * into ua from public.users where email=r.email;
  select * into ub from public.users where phone=r.phone;
  if ua.id is not null and ub.id is not null and ua.id<>ub.id then
   update public.feedback_popup_rewards set state='CONFLICT',reason='IDENTITY_CONFLICT',updated_at=p_now where id=r.id;
  else perform public.feedback_popup_bind_at(r.id,p_user,p_now); end if;
  n:=n+1;
 end loop;
 return n;
end $$;
revoke all on function public.feedback_popup_bind_at(uuid,uuid,timestamptz),public.feedback_popup_claim_at(uuid,timestamptz) from public,homemind_app;
-- Admin view extension follows below; old columns, enums and benefit fields keep their meanings.

create or replace view admin.feedback_submissions with(security_invoker=true) as
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
    'postponed',exists(select 1 from public.billing_grants p where p.reward_id=r.id and p.superseded_at is not null)),
   'lifecycle',jsonb_build_object(
    'nominationId',root.id,'rewardId',case when root.allotment_consumed then root.id end,
    'sourceSubmissionId',root.submission_id,'accountId',root.user_id,'accountCreatedAt',u.created_at,
    'linkedAt',root.bound_at,'awardedAt',root.awarded_at,'allotmentConsumed',root.allotment_consumed,
    'logicalRewardCount',counts.awards,'submissionCount',counts.submissions,
    'firstSubmittedAt',counts.first_at,'lastSubmittedAt',counts.last_at,
    'state',case root.state when 'GRANTED' then case when current_segment.id is null then 'EXPIRED'
      when current_segment.starts_at>now() then 'SCHEDULED'
      when coalesce(current_segment.effective_until,current_segment.expires_at)>now() then 'ACTIVE' else 'EXPIRED' end else root.state end,
    'durationBudgetSeconds',root.duration_seconds,'segmentCount',timeline.segments,
    'allocatedSeconds',timeline.allocated,
    'elapsedSeconds',case when root.allotment_consumed then timeline.elapsed end,
    'remainingSeconds',case when root.allotment_consumed then root.duration_seconds-timeline.elapsed end,
    'expectedStartsAt',current_segment.starts_at,'expectedEndsAt',coalesce(current_segment.effective_until,current_segment.expires_at),
    'actualStartedAt',timeline.actual_started,'completedAt',case when timeline.allocated=root.duration_seconds and timeline.elapsed=root.duration_seconds then timeline.last_end end,
    'featureUsage',jsonb_build_object('status','NOT_TRACKED','used',null))) data
 from public.feedback_popup_submissions s join public.feedback_popup_rewards r on r.submission_id=s.id
 left join lateral(select g.id,g.starts_at,g.expires_at,g.effective_until from public.billing_grants g
  where g.reward_id=r.id and g.superseded_at is null order by g.starts_at desc,g.id limit 1) seg on true
 join public.feedback_popup_rewards root on root.id=r.logical_reward_id
 left join public.users u on u.id=root.user_id
 left join lateral(select g.id,g.starts_at,g.expires_at,g.effective_until from public.billing_grants g
   where g.reward_id=root.id and g.superseded_at is null order by g.starts_at desc,g.id limit 1) current_segment on true
 left join lateral(
   select count(*) submissions,min(x.submitted_at) first_at,max(x.submitted_at) last_at,
    count(*) filter(where d.allotment_consumed) awards
   from public.feedback_popup_rewards d join public.feedback_popup_submissions x on x.id=d.submission_id
   where (root.user_id is not null and d.user_id=root.user_id)
      or d.logical_reward_id=root.id
 ) counts on true
 left join lateral(
   select count(*) segments,coalesce(sum(extract(epoch from(coalesce(g.effective_until,g.expires_at)-g.starts_at))),0) allocated,
    coalesce(sum(greatest(0,extract(epoch from(least(now(),coalesce(g.effective_until,g.expires_at))-g.starts_at)))),0) elapsed,
    min(g.starts_at) filter(where g.starts_at<=now()) actual_started,max(coalesce(g.effective_until,g.expires_at)) last_end
   from public.billing_grants g where g.reward_id=root.id
 ) timeline on true;

revoke all on admin.feedback_submissions from public,homemind_app;
commit;
