-- Additive import: existing paid/manual entitlements and business data survive.
begin;
alter table public.workspace_entitlements add column source text not null default 'free'
 check(source in ('free','legacy_manual','billing'));
update public.workspace_entitlements set source='legacy_manual' where plan<>'free';

create table public.billing_prices (
 id text primary key, plan text not null check(plan in ('personal','family','micro_pos')),
 amount integer not null check(amount>0), currency text not null check(currency='VND'),
 months integer not null check(months=1), product_limit integer,
 active boolean not null default true, created_at timestamptz not null default now()
);
-- Owner-approved catalog already present in Flutter plan_catalog.dart.
insert into public.billing_prices values
 ('personal-month-v1','personal',29000,'VND',1,null,true,now()),
 ('family-month-v1','family',59000,'VND',1,null,true,now()),
 ('micro_pos-month-v1','micro_pos',149000,'VND',1,500,true,now());
create sequence public.billing_order_sequence minvalue 1 maxvalue 999999999999 no cycle;
create table public.billing_identity (
 singleton boolean primary key default true check(singleton),
 namespace integer not null check(namespace between 1 and 999), channel text not null
);
create table public.billing_orders (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
 actor_id uuid not null references public.users(id), idempotency_key uuid not null, payload_hash text not null,
 order_code bigint not null unique check(order_code between 1000000000001 and 999999999999999),
 channel text not null, price_id text not null references public.billing_prices(id), price_snapshot jsonb not null,
 description text not null check(length(description)=9),
 payment_link_id text unique, checkout_url text,
 status text not null default 'CREATED' check(status in ('CREATED','CREATE_UNCERTAIN','PENDING','UNDERPAID','PAID','CANCELLED','EXPIRED','REVIEW')),
 financial_state text not null default 'UNPAID' check(financial_state in ('UNPAID','PARTIAL','PAID','REVIEW')),
 fulfillment text not null default 'NONE' check(fulfillment in ('NONE','GRANTED','REVIEW')),
 review_reason text, amount_paid integer not null default 0 check(amount_paid>=0),
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '30 minutes',
 paid_at timestamptz, updated_at timestamptz not null default now(),
 lease_id uuid, lease_until timestamptz, next_check_at timestamptz not null default now(), attempts integer not null default 0,
 unique(workspace_id,actor_id,idempotency_key)
);
create index billing_orders_pending_idx on public.billing_orders(next_check_at) where financial_state in ('UNPAID','PARTIAL');
create index billing_orders_history_idx on public.billing_orders(workspace_id,created_at desc,id);
create table public.billing_webhook_inbox (
 channel text not null, fingerprint text not null, order_code bigint not null,
 reference text not null, payment_link_id text not null, amount integer not null, currency text not null,
 description text not null, received_at timestamptz not null default now(),
 primary key(channel,fingerprint)
);
create index billing_inbox_order_idx on public.billing_webhook_inbox(channel,order_code);
create table public.billing_transactions (
 channel text not null, reference text not null, order_id uuid not null references public.billing_orders(id),
 amount integer not null check(amount>0), paid_at timestamptz not null,
 primary key(channel,reference)
);
create table public.billing_grants (
 id uuid primary key default gen_random_uuid(), order_id uuid not null unique references public.billing_orders(id),
 workspace_id uuid not null references public.workspaces(id), plan text not null,
 product_limit integer, starts_at timestamptz not null, expires_at timestamptz not null,
 price_snapshot jsonb not null, created_at timestamptz not null default now(), check(expires_at>starts_at)
);
create index billing_grants_effective_idx on public.billing_grants(workspace_id,starts_at,expires_at);

create function public.billing_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if TG_TABLE_NAME='billing_prices' then
  if (to_jsonb(new)-'active') is distinct from (to_jsonb(old)-'active') then raise exception 'PRICE_VERSION_IMMUTABLE'; end if;
 else
  if (to_jsonb(new)-array['payment_link_id','checkout_url','status','financial_state','fulfillment','review_reason','amount_paid','paid_at','updated_at','lease_id','lease_until','next_check_at','attempts','expires_at'])
   is distinct from (to_jsonb(old)-array['payment_link_id','checkout_url','status','financial_state','fulfillment','review_reason','amount_paid','paid_at','updated_at','lease_id','lease_until','next_check_at','attempts','expires_at']) then raise exception 'ORDER_TERMS_IMMUTABLE'; end if;
  if old.financial_state='PAID' and new.financial_state<>'PAID' then raise exception 'PAID_STATE_IMMUTABLE'; end if;
  if old.payment_link_id is not null and new.payment_link_id is distinct from old.payment_link_id then raise exception 'PROVIDER_LINK_IMMUTABLE'; end if;
 end if;
 return new;
end; $$;
create trigger billing_prices_immutable before update on public.billing_prices for each row execute function public.billing_immutable();
create trigger billing_orders_immutable before update on public.billing_orders for each row execute function public.billing_immutable();

create function public.billing_owner(p_workspace uuid) returns boolean
 language sql stable security definer set search_path='' as $$
 select public.is_workspace_member(p_workspace) and exists(select 1 from public.workspace_members
 where workspace_id=p_workspace and user_id=public.current_user_id() and role='owner'); $$;

create function public.billing_refresh_internal(p_workspace uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare e public.workspace_entitlements%rowtype; g public.billing_grants%rowtype; changed boolean:=false;
begin
 perform 1 from public.workspaces where id=p_workspace for update;
 select * into e from public.workspace_entitlements where workspace_id=p_workspace for update;
 if e.source='billing' then
  select * into g from public.billing_grants where workspace_id=p_workspace and starts_at<=now() and expires_at>now() order by starts_at desc,id limit 1;
  if e.plan is distinct from coalesce(g.plan,'free') or e.product_limit is distinct from (case when g.id is null then 30 else g.product_limit end) then
   update public.workspace_entitlements set plan=coalesce(g.plan,'free'),product_limit=case when g.id is null then 30 else g.product_limit end,updated_at=now() where workspace_id=p_workspace returning * into e;
   changed:=true;
  end if;
 end if;
 return jsonb_build_object('plan',coalesce(e.plan,'free'),'productLimit',e.product_limit,'source',coalesce(e.source,'free'),'changed',changed);
end; $$;
create function public.billing_effective(p_workspace uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
begin
 if not public.is_workspace_member(p_workspace) then raise exception 'FORBIDDEN'; end if;
 return public.billing_refresh_internal(p_workspace);
end; $$;

create function public.billing_order_public(o public.billing_orders) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',o.id,'orderCode',o.order_code::text,'price',o.price_snapshot,
 'status',o.status,'financialState',o.financial_state,'fulfillment',o.fulfillment,
 'checkoutUrl',o.checkout_url,'amountPaid',o.amount_paid,'createdAt',o.created_at,'expiresAt',o.expires_at,
 'paidAt',o.paid_at,'reviewReason',o.review_reason); $$;

create function public.billing_prepare(p_workspace uuid,p_price text,p_key uuid,p_hash text,p_namespace integer,p_channel text)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.billing_orders%rowtype; p public.billing_prices%rowtype; e jsonb; tail text;
begin
 perform 1 from public.workspaces where id=p_workspace for update;
 if not public.billing_owner(p_workspace) then raise exception 'FORBIDDEN'; end if;
 select * into o from public.billing_orders where workspace_id=p_workspace and actor_id=public.current_user_id() and idempotency_key=p_key;
 if found then
  if o.payload_hash<>p_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return public.billing_order_public(o);
 end if;
 e:=public.billing_refresh_internal(p_workspace);
 if e->>'source'='legacy_manual' then raise exception 'MANUAL_PLAN_REQUIRES_REVIEW'; end if;
 select * into p from public.billing_prices where id=p_price and active;
 if not found then raise exception 'PRICE_NOT_AVAILABLE'; end if;
 select plan into tail from public.billing_grants where workspace_id=p_workspace and expires_at>now() order by expires_at desc limit 1;
 if exists(select 1 from public.billing_grants where workspace_id=p_workspace and starts_at>now() and plan<>p.plan and plan<>(e->>'plan'))
 or exists(select 1 from public.billing_orders where workspace_id=p_workspace and financial_state in ('UNPAID','PARTIAL')
 and status not in ('CANCELLED','EXPIRED','REVIEW') and price_snapshot->>'plan'<>p.plan and expires_at>now()) then raise exception 'PLAN_CHANGE_PENDING'; end if;
 if p_namespace not between 1 and 999 or length(p_channel)<>64 then raise exception 'BILLING_CONFIG_INVALID'; end if;
 insert into public.billing_identity(namespace,channel) values(p_namespace,p_channel) on conflict do nothing;
 if not exists(select 1 from public.billing_identity where namespace=p_namespace and channel=p_channel) then raise exception 'BILLING_CHANNEL_CHANGED'; end if;
 insert into public.billing_orders(workspace_id,actor_id,idempotency_key,payload_hash,order_code,channel,price_id,price_snapshot,description)
 values(p_workspace,public.current_user_id(),p_key,p_hash,p_namespace::bigint*1000000000000+nextval('public.billing_order_sequence'),p_channel,p.id,
 jsonb_build_object('id',p.id,'plan',p.plan,'amount',p.amount,'currency',p.currency,'months',p.months,'productLimit',p.product_limit,'transition','after_paid_coverage'),
 'HM'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,7))) returning * into o;
 return public.billing_order_public(o);
end; $$;

create function public.billing_read(p_workspace uuid,p_order uuid,p_offset integer default 0) returns jsonb
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
 return jsonb_build_object('entitlement',e,'subscription',(
 select jsonb_build_object('plan',g.plan,'startsAt',g.starts_at,'expiresAt',g.expires_at,'productLimit',g.product_limit)
 from public.billing_grants g where workspace_id=p_workspace and starts_at<=now() and expires_at>now() order by starts_at desc limit 1),
 'scheduled',coalesce((select jsonb_agg(jsonb_build_object('plan',plan,'startsAt',starts_at,'expiresAt',expires_at)) from public.billing_grants where workspace_id=p_workspace and starts_at>now()),'[]'::jsonb),
 'payments',coalesce((select jsonb_agg(public.billing_order_public(o) order by created_at desc,id desc) from
 (select * from public.billing_orders where workspace_id=p_workspace order by created_at desc,id desc limit 20 offset p_offset) o),'[]'::jsonb),
 'nextOffset',case when (select count(*) from public.billing_orders where workspace_id=p_workspace)>p_offset+20 then p_offset+20 end);
end; $$;

-- Only the trusted backend calls this boundary, after official SDK verification.
-- Runtime has no direct write privileges on billing/entitlements/grants.
create function public.billing_system(p_action text,p_id uuid,p_data jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare o public.billing_orders%rowtype; t jsonb; g public.billing_grants%rowtype;
 link text; ref text; total bigint:=0; paidtime timestamptz; tx_time timestamptz;
 previous public.billing_transactions%rowtype; start_at timestamptz; reason text; namespace_channel text;
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
  and (lease_until is null or lease_until<now()) and (p_id is not null or next_check_at<=now())
  order by next_check_at,id limit 1 for update skip locked;
  if not found then return null; end if;
  update public.billing_orders set lease_id=gen_random_uuid(),lease_until=now()+interval '25 seconds',attempts=attempts+1 where id=o.id returning * into o;
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
   update public.billing_orders set lease_id=null,lease_until=null,next_check_at=now()+make_interval(secs=>least(3600,15*power(2,least(o.attempts,8)))::int),
   status=case when status='CREATED' then 'CREATE_UNCERTAIN' else status end,updated_at=now() where id=o.id;
  end if;
  return public.billing_order_public(o);
 end if;
 if p_action='review' then
  update public.billing_orders set fulfillment=case when fulfillment='GRANTED' then fulfillment else 'REVIEW' end,
  status=case when financial_state='PAID' then 'PAID' else 'REVIEW' end,review_reason='PROVIDER_IDENTITY_CONFLICT',lease_until=null,lease_id=null,updated_at=now() where id=o.id returning * into o;
  return public.billing_order_public(o);
 end if;
 if p_action='attach' then
  if (p_data->>'orderCode')::bigint<>o.order_code or (p_data->>'amount')::int<>(o.price_snapshot->>'amount')::int
   or p_data->>'currency'<>'VND' or p_data->>'description'<>o.description
   or (o.payment_link_id is not null and o.payment_link_id<>p_data->>'paymentLinkId') then raise exception 'PROVIDER_IDENTITY_CONFLICT'; end if;
  update public.billing_orders set payment_link_id=p_data->>'paymentLinkId',checkout_url=p_data->>'checkoutUrl',
   status=case when status in ('CREATED','CREATE_UNCERTAIN') then 'PENDING' else status end,updated_at=now() where id=o.id returning * into o;
  return public.billing_order_public(o);
 end if;
 if p_action<>'settle' then raise exception 'VALIDATION_ERROR'; end if;
 -- PAID/GRANTED can never be reversed by a delayed PENDING/CANCELLED response.
 if o.financial_state='PAID' and o.fulfillment='GRANTED' then return public.billing_order_public(o); end if;
 link:=p_data->>'id';
 if (p_data->>'orderCode')::bigint<>o.order_code or (p_data->>'amount')::int<>(o.price_snapshot->>'amount')::int or length(coalesce(link,''))=0 then reason:='PROVIDER_IDENTITY_CONFLICT';
 elsif o.payment_link_id is not null and o.payment_link_id<>link then reason:='PROVIDER_IDENTITY_CONFLICT';
 elsif o.payment_link_id is null and not exists(select 1 from public.billing_webhook_inbox where channel=o.channel and order_code=o.order_code and payment_link_id=link and description=o.description and currency='VND') then reason:='UNBOUND_PROVIDER_LINK'; end if;
 if reason is null then
  for t in select value from jsonb_array_elements(p_data->'transactions') loop
   ref:=t->>'reference'; tx_time:=(t->>'transactionDateTime')::timestamptz;
   if length(coalesce(ref,'')) not between 1 and 200 or (t->>'amount')::bigint not between 1 and 2147483647 or tx_time>now()+interval '5 minutes' or tx_time<o.created_at-interval '5 minutes' then reason:='TRANSACTION_INVALID'; exit; end if;
   select * into previous from public.billing_transactions where channel=o.channel and reference=ref;
   if found and (previous.order_id<>o.id or previous.amount<>(t->>'amount')::int) then reason:='TRANSACTION_REPLAY'; exit; end if;
   insert into public.billing_transactions(channel,reference,order_id,amount,paid_at) values(o.channel,ref,o.id,(t->>'amount')::int,tx_time) on conflict do nothing;
   -- Recheck under concurrent unique-reference conflict across workspaces.
   select * into previous from public.billing_transactions where channel=o.channel and reference=ref;
   if previous.order_id<>o.id or previous.amount<>(t->>'amount')::int then reason:='TRANSACTION_REPLAY'; exit; end if;
   total:=total+(t->>'amount')::int; paidtime:=greatest(paidtime,tx_time);
  end loop;
  if total<>(p_data->>'amountPaid')::bigint or total>(o.price_snapshot->>'amount')::bigint then reason:='AMOUNT_REVIEW'; end if;
 end if;
 if reason is not null then
  update public.billing_orders set status=case when o.financial_state='PAID' or (p_data->>'status'='PAID' and reason='AMOUNT_REVIEW') then 'PAID' else 'REVIEW' end,
   financial_state=case when o.financial_state='PAID' or (p_data->>'status'='PAID' and reason='AMOUNT_REVIEW') then 'PAID' else 'REVIEW' end,
   amount_paid=case when reason='AMOUNT_REVIEW' then greatest(amount_paid,(p_data->>'amountPaid')::int) else amount_paid end,
   fulfillment='REVIEW',review_reason=reason,lease_id=null,lease_until=null,updated_at=now() where id=o.id returning * into o;
  return public.billing_order_public(o);
 end if;
 if p_data->>'status'='PAID' and total=(o.price_snapshot->>'amount')::int and (p_data->>'amountRemaining')::int=0 then
  if paidtime is null or paidtime>o.expires_at then reason:='LATE_PAYMENT';
  elsif not exists(select 1 from public.users u join public.workspace_members m on m.user_id=u.id join public.workspaces w on w.id=m.workspace_id
   where u.id=o.actor_id and u.status='ACTIVE' and m.workspace_id=o.workspace_id and m.role='owner' and w.archived_at is null) then reason:='ACTOR_NO_LONGER_ELIGIBLE';
  elsif exists(select 1 from public.workspace_entitlements where workspace_id=o.workspace_id and source='legacy_manual') then reason:='MANUAL_PLAN_REQUIRES_REVIEW'; end if;
  if reason is null then
   select greatest(now(),coalesce(max(expires_at),now())) into start_at from public.billing_grants where workspace_id=o.workspace_id;
   insert into public.billing_grants(order_id,workspace_id,plan,product_limit,starts_at,expires_at,price_snapshot)
    values(o.id,o.workspace_id,o.price_snapshot->>'plan',(o.price_snapshot->>'productLimit')::int,start_at,
    ((start_at at time zone 'Asia/Ho_Chi_Minh')+make_interval(months=>(o.price_snapshot->>'months')::int)) at time zone 'Asia/Ho_Chi_Minh',o.price_snapshot) on conflict(order_id) do nothing;
   update public.workspace_entitlements set source='billing' where workspace_id=o.workspace_id;
   perform public.billing_refresh_internal(o.workspace_id);
  end if;
  update public.billing_orders set payment_link_id=link,status='PAID',financial_state='PAID',fulfillment=case when reason is null then 'GRANTED' else 'REVIEW' end,
   review_reason=reason,amount_paid=total,paid_at=paidtime,lease_id=null,lease_until=null,updated_at=now() where id=o.id returning * into o;
 else
  if o.financial_state<>'PAID' then
   update public.billing_orders set payment_link_id=link,amount_paid=greatest(amount_paid,total),
    financial_state=case when total>0 then 'PARTIAL' else 'UNPAID' end,
    status=case when total>0 then 'UNDERPAID' when p_data->>'status' in ('CANCELLED','EXPIRED') then p_data->>'status' else 'PENDING' end,
    lease_id=null,lease_until=null,next_check_at=now()+interval '30 seconds',updated_at=now() where id=o.id returning * into o;
  end if;
 end if;
 return public.billing_order_public(o);
end; $$;

create function public.billing_product_quota() returns trigger language plpgsql security definer set search_path='' as $$
declare e jsonb; n integer;
begin
 if new.archived_at is not null then return new; end if;
 if TG_OP='UPDATE' and old.archived_at is null and old.workspace_id=new.workspace_id then return new; end if;
 e:=public.billing_refresh_internal(new.workspace_id);
 if e->>'productLimit' is not null then
  select count(*) into n from public.products where workspace_id=new.workspace_id and archived_at is null;
  if n>=(e->>'productLimit')::int then raise exception 'PLAN_LIMIT_REACHED'; end if;
 end if;
 return new;
end; $$;
create trigger products_billing_quota before insert or update of archived_at,workspace_id on public.products for each row execute function public.billing_product_quota();

-- Serialize operation and billing settlement before inventory row locks.
alter function public.apply_operation(uuid,uuid,text,jsonb,uuid) rename to apply_operation_before_billing;
revoke execute on function public.apply_operation_before_billing(uuid,uuid,text,jsonb,uuid) from homemind_app;
create function public.apply_operation(p_workspace uuid,p_key uuid,p_operation text,p_payload jsonb,p_turn uuid default null) returns jsonb
 language plpgsql security definer set search_path='' as $$
begin
 if not public.is_workspace_member(p_workspace) then raise exception 'FORBIDDEN'; end if;
 perform public.billing_refresh_internal(p_workspace);
 return public.apply_operation_before_billing(p_workspace,p_key,p_operation,p_payload,p_turn);
end; $$;

do $$ declare t text; begin
 foreach t in array array['billing_prices','billing_identity','billing_orders','billing_webhook_inbox','billing_transactions','billing_grants'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,homemind_app',t);
 end loop;
end $$;
grant select on public.billing_prices to homemind_app;
create policy billing_catalog on public.billing_prices for select to homemind_app using(active);
revoke all on sequence public.billing_order_sequence from public,homemind_app;
revoke execute on function public.billing_immutable(),public.billing_owner(uuid),public.billing_refresh_internal(uuid),public.billing_order_public(public.billing_orders),public.billing_prepare(uuid,text,uuid,text,integer,text),public.billing_read(uuid,uuid,integer),public.billing_system(text,uuid,jsonb),public.billing_effective(uuid),public.billing_product_quota(),public.apply_operation(uuid,uuid,text,jsonb,uuid) from public;
grant execute on function public.billing_prepare(uuid,text,uuid,text,integer,text),public.billing_read(uuid,uuid,integer),public.billing_system(text,uuid,jsonb),public.billing_effective(uuid),public.apply_operation(uuid,uuid,text,jsonb,uuid) to homemind_app;
commit;
