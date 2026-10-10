begin;
create schema admin;
revoke all on schema admin from public,homemind_app;
create table admin.principals (
 id uuid primary key default gen_random_uuid(), bootstrap_key text not null unique check(bootstrap_key='initial'),
 email text not null unique check(email=lower(trim(email))), password_hash text not null,
 status text not null default 'ACTIVE' check(status in ('ACTIVE','DISABLED')),
 created_at timestamptz not null default now(), password_changed_at timestamptz not null default now()
);
create table admin.sessions (
 id uuid primary key default gen_random_uuid(), admin_id uuid not null references admin.principals(id),
 family_id uuid not null, token_hash text not null unique, created_at timestamptz not null default now(),
 last_seen_at timestamptz not null default now(), expires_at timestamptz not null, revoked_at timestamptz,
 rotated_at timestamptz, client text not null check(client in ('browser','other'))
);
create index admin_session_owner on admin.sessions(admin_id,created_at desc,id desc);
create table admin.audit_logs (
 id uuid primary key default gen_random_uuid(), actor_id uuid references admin.principals(id),
 request_id uuid not null, action text not null check(length(action)<=160), target_id uuid,scope_hash text check(length(scope_hash)=43),
 outcome text not null check(outcome in ('SUCCESS','DENIED','ERROR')), row_count integer check(row_count between 0 and 100000),
 occurred_at timestamptz not null default now()
);
create index admin_audit_recent on admin.audit_logs(occurred_at desc,id desc);
create index admin_audit_actor on admin.audit_logs(actor_id,occurred_at desc,id desc);
create table admin.audit_capacity(singleton boolean primary key default true check(singleton),row_count integer not null check(row_count between 0 and 100000));
insert into admin.audit_capacity values(true,0);
create function admin.audit_capacity_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' then
  update admin.audit_capacity set row_count=row_count+1 where singleton and row_count<100000;
  if not found then raise exception 'ADMIN_AUDIT_CAPACITY_EXHAUSTED'; end if;
  return new;
 end if;
 update admin.audit_capacity set row_count=row_count-1 where singleton;
 return old;
end $$;
revoke all on function admin.audit_capacity_guard() from public,homemind_app;
create trigger audit_capacity_insert before insert on admin.audit_logs for each row execute function admin.audit_capacity_guard();
create trigger audit_capacity_delete after delete on admin.audit_logs for each row execute function admin.audit_capacity_guard();
create table admin.login_limits (key text primary key, started_at timestamptz not null, attempts integer not null);
create index admin_limits_expiry on admin.login_limits(started_at);
-- Operator-owned reporting classification; never inferred from PII or current env.
-- Legacy rows remain explicitly unclassified until verified by an operator.
create table admin.customer_scope(user_id uuid primary key references public.users(id) on delete cascade,provenance text not null check(provenance in ('REAL','SIMULATED_TEST')),identified_at timestamptz not null default now());
create table admin.workspace_scope(workspace_id uuid primary key references public.workspaces(id) on delete cascade,provenance text not null check(provenance in ('REAL','SIMULATED_TEST')),identified_at timestamptz not null default now());
revoke all on all tables in schema admin from public,homemind_app;

-- Separate SELECT-only role identity. No existing customer policy is replaced.
do $$ declare t text; begin
 foreach t in array array['profiles','workspaces','workspace_members','workspace_entitlements','products','inventory_lots','shopping_items',
  'billing_orders','billing_grants','billing_transactions','assistant_quota_periods','assistant_quota_requests',
  'assistant_turns','notification_outbox','in_app_notifications'] loop
  execute format('create policy admin_inspection on public.%I for select using(current_user = %L)',t,'homemind_admin_api');
 end loop;
end $$;
create index admin_users_recent on public.users(created_at desc,id desc);
create index admin_user_email_search on public.users using gin(lower(email) gin_trgm_ops);
create index admin_profile_name_search on public.profiles using gin(lower(display_name) gin_trgm_ops);
create index admin_orders_recent on public.billing_orders(created_at desc,id desc);
create index admin_orders_payer on public.billing_orders(actor_id,created_at desc,id desc);
create index admin_orders_workspace on public.billing_orders(workspace_id,created_at desc,id desc);
create index admin_requests_recent on public.assistant_quota_requests(created_at desc,id desc);
create index admin_requests_actor on public.assistant_quota_requests(actor_id,created_at desc,id desc);
create index admin_activity_recipient on public.notification_outbox(recipient_id,occurred_at desc,id desc);
create index admin_explicit_login on public.notification_outbox(recipient_id,occurred_at desc) where kind='account.login';

create view admin.customers with(security_invoker=true) as
 select u.id,u.created_at,u.status,u.email,u.phone login_phone,p.phone contact_phone,p.display_name,coalesce(s.provenance,'UNCLASSIFIED_LEGACY') provenance,
 jsonb_build_object('id',u.id,'email',u.email,'loginPhone',u.phone,'contactPhone',p.phone,
 'displayName',p.display_name,'address',p.address,'language',p.language,'status',u.status,
 'createdAt',u.created_at,'updatedAt',u.updated_at,'deletedAt',u.deleted_at,
 'termsAcceptedAt',u.terms_accepted_at,'privacyAcceptedAt',u.privacy_accepted_at,
 'lastExplicitLoginAt',(select max(n.occurred_at) from public.notification_outbox n where n.recipient_id=u.id and n.kind='account.login'),
 'lastLoginSource','account.login outbox; null means unknown','provenance',coalesce(s.provenance,'UNCLASSIFIED_LEGACY')) data
 from public.users u left join public.profiles p on p.id=u.id left join admin.customer_scope s on s.user_id=u.id;

create view admin.payments with(security_invoker=true) as
 select o.id,o.workspace_id,o.actor_id,o.created_at,o.paid_at,o.status,o.financial_state,o.fulfillment,o.amount_paid,
 case when o.origin='SIMULATED_TEST' then 'SIMULATED_TEST' when o.origin='REAL_PAYOS' and o.price_snapshot->>'policyVersion'='voice-30d-v2' then 'REAL' else 'UNCLASSIFIED_LEGACY' end provenance,
 o.price_snapshot->>'currency' currency,(o.price_snapshot->>'amount')::numeric amount,
 (o.financial_state='PAID' and o.fulfillment='GRANTED' and exists(select 1 from public.billing_grants g where g.order_id=o.id)) completed,
 jsonb_build_object('id',o.id,'workspaceId',o.workspace_id,'payerId',o.actor_id,'orderCode',o.order_code::text,
 'plan',o.price_snapshot->>'plan','priceId',o.price_id,'money',jsonb_build_object('currency',o.price_snapshot->>'currency','amount',o.price_snapshot->>'amount'),
 'amountPaid',jsonb_build_object('currency',o.price_snapshot->>'currency','amount',o.amount_paid::text),
 'status',o.status,'financialState',o.financial_state,'fulfillment',o.fulfillment,'reviewReason',o.review_reason,
 'createdAt',o.created_at,'paidAt',o.paid_at,'cancelledAt',o.cancelled_at,'expiresAt',o.expires_at,
 'attempts',o.attempts,'nextCheckAt',o.next_check_at,
 'provenance',case when o.origin='SIMULATED_TEST' then 'SIMULATED_TEST' when o.origin='REAL_PAYOS' and o.price_snapshot->>'policyVersion'='voice-30d-v2' then 'REAL' else 'UNCLASSIFIED_LEGACY' end,
 'completedSale',o.financial_state='PAID' and o.fulfillment='GRANTED' and exists(select 1 from public.billing_grants g where g.order_id=o.id)) data
 from public.billing_orders o;

create view admin.workspaces with(security_invoker=true) as
 with effective as (
 select w.id,w.name,w.type,w.created_at,w.updated_at,w.archived_at,coalesce(s.provenance,'UNCLASSIFIED_LEGACY') provenance,
 case when e.source='legacy_manual' then e.plan when e.source='billing' and g.id is not null then g.plan else 'free' end plan,
 case when e.source='legacy_manual' then e.source when e.source='billing' and g.id is not null then e.source else 'free' end source,
 e.workspace_id is not null entitlement_known,
 case when e.source='legacy_manual' then e.product_limit when e.source='billing' and g.id is not null then g.product_limit else 30 end product_limit,
 case when e.source='billing' then g.id end grant_id,
 case when e.source='billing' then coalesce(g.effective_until,g.expires_at) end paid_expires_at,
 case when e.source='billing' and g.id is not null then g.starts_at when e.source='legacy_manual' and e.plan<>'free' then w.created_at else greatest(w.created_at,(select max(coalesce(x.effective_until,x.expires_at)) from public.billing_grants x where x.workspace_id=w.id and coalesce(x.effective_until,x.expires_at)<=now())) end anchor
 from public.workspaces w left join public.workspace_entitlements e on e.workspace_id=w.id left join admin.workspace_scope s on s.workspace_id=w.id
 left join lateral(select id,plan,product_limit,starts_at,expires_at,effective_until from public.billing_grants where workspace_id=w.id and starts_at<=now() and coalesce(effective_until,expires_at)>now() order by starts_at desc,id limit 1) g on true
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
revoke all on all tables in schema admin from public,homemind_app;
commit;
