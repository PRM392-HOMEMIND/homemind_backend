-- Preserve eligibility/paid/release boundaries across delayed processing.
-- Additive corrective migration; original feedback migration remains unchanged.
begin;

create or replace function public.feedback_popup_place_at(p_reward uuid,p_now timestamptz) returns void
 language plpgsql security definer set search_path='' as $$
declare r public.feedback_popup_rewards%rowtype; v_start timestamptz;
begin
 select * into r from public.feedback_popup_rewards where id=p_reward and state='GRANTED';
 if not found or exists(select 1 from public.billing_grants where reward_id=r.id) then return; end if;
 v_start:=greatest(r.anchor_at,coalesce(public.feedback_popup_paid_end(r.workspace_id,r.anchor_at),r.anchor_at));
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

create or replace function public.feedback_popup_realign_at(p_workspace uuid,p_now timestamptz) returns void
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
 v_paid_end:=public.feedback_popup_paid_end(p_workspace,r.anchor_at);
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
   v_start:=greatest(r.anchor_at,coalesce(v_yield,s.starts_at,r.anchor_at),coalesce(v_paid_end,r.anchor_at));
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


-- Capture only the actual indefinite -> finite transition. Generic entitlement
-- updated_at is subsequently overwritten by billing_refresh_at and is not an
-- immutable release event. No billing/payment/plan/usage value is changed here.
-- Store it on this already-locked row; do not invert the workspace/reward lock
-- order by updating another table from an entitlement update trigger.
alter table public.workspace_entitlements add column feedback_manual_released_at timestamptz;
create function public.feedback_popup_manual_release() returns trigger
 language plpgsql security definer set search_path='' as $$
begin
 if old.source='legacy_manual' and old.plan<>'free'
  and not (new.source='legacy_manual' and new.plan<>'free') then
  new.feedback_manual_released_at:=case when new.updated_at is distinct from old.updated_at
    then new.updated_at else clock_timestamp() end;
 elsif new.source='legacy_manual' and new.plan<>'free' then
  new.feedback_manual_released_at:=null;
 end if;
 return new;
end $$;
revoke all on function public.feedback_popup_manual_release() from public,homemind_app;
create trigger feedback_popup_manual_release before update of source,plan on public.workspace_entitlements
 for each row execute function public.feedback_popup_manual_release();

-- Only for pre-fix waiting records whose manual coverage has already ended.
-- The best persisted release boundary is retained, never replaced by now().
update public.workspace_entitlements e set feedback_manual_released_at=e.updated_at
 where not(e.source='legacy_manual' and e.plan<>'free')
 and exists(select 1 from public.feedback_popup_rewards r where r.workspace_id=e.workspace_id and r.state='WAITING_ENTITLEMENT');


create or replace function public.feedback_popup_reconcile(p_limit integer default 50) returns jsonb
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
    -- The release boundary is captured transactionally by the entitlement trigger.
    -- Later materialized refreshes and delayed workers must never restart time.
    update public.feedback_popup_rewards set state='GRANTED',reason=null,anchor_at=greatest(anchor_at,e.feedback_manual_released_at),
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

commit;
