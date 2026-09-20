begin;

-- A claim/lookup failure is not proof that a provider create was attempted.
-- Keep that provenance outside the immutable order terms and behind the same
-- trusted billing boundary. Existing orders are not retroactively marked.
create table public.billing_create_intents (
 order_id uuid primary key references public.billing_orders(id) on delete cascade,
 started_at timestamptz not null default now()
);
alter table public.billing_create_intents enable row level security;
revoke all on public.billing_create_intents from public,homemind_app;

alter function public.billing_system(text,uuid,jsonb) rename to billing_system_v2;
revoke execute on function public.billing_system_v2(text,uuid,jsonb) from public,homemind_app;
create function public.billing_system(p_action text,p_id uuid,p_data jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare o public.billing_orders; ws uuid; r jsonb; started timestamptz; created timestamptz;
begin
 if p_action='claim' then
  r:=public.billing_system_v2(p_action,p_id,p_data);
  if r is null then return null; end if;
  return r||jsonb_build_object('create_attempted',exists(
   select 1 from public.billing_create_intents where order_id=(r->>'id')::uuid));
 end if;
 if p_action in ('begin_create','recover_create') then
  select workspace_id into ws from public.billing_orders where id=p_id and channel=p_data->>'channel';
  if ws is null then raise exception 'NOT_FOUND'; end if;
  perform 1 from public.workspaces where id=ws for update;
  select * into o from public.billing_orders where id=p_id for update;
  if o.lease_id::text is distinct from p_data->>'leaseId' or o.lease_until is null or o.lease_until<=now()
   or o.payment_link_id is not null or o.financial_state<>'UNPAID' or o.amount_paid<>0
   or o.status not in ('CREATED','CREATE_UNCERTAIN') or o.expires_at<=now() then
   raise exception 'PROVIDER_IDENTITY_CONFLICT';
  end if;
  if p_action='begin_create' then
   insert into public.billing_create_intents(order_id) values(o.id) on conflict do nothing;
   return jsonb_build_object('allowed',true);
  end if;
  select started_at into started from public.billing_create_intents where order_id=o.id;
  begin created:=(p_data->>'createdAt')::timestamptz;
  exception when others then raise exception 'PROVIDER_IDENTITY_CONFLICT'; end;
  if started is null or created is null or created<started-interval '5 minutes' or created>now()+interval '5 minutes'
   or coalesce(p_data->>'id','')!~'^[a-f0-9]{32}$'
   or (p_data->>'orderCode')::bigint is distinct from o.order_code
   or (p_data->>'amount')::int is distinct from (o.price_snapshot->>'amount')::int
   or p_data->>'status' is distinct from 'PENDING' or (p_data->>'amountPaid')::int is distinct from 0
   or (p_data->>'amountRemaining')::int is distinct from (o.price_snapshot->>'amount')::int
   or p_data->'transactions' is distinct from '[]'::jsonb then
   raise exception 'PROVIDER_IDENTITY_CONFLICT';
  end if;
  -- Recovery only restores an unpaid checkout. It cannot establish payment or
  -- grant access; the unchanged signed settlement boundary does that separately.
  return public.billing_system_v2('attach',o.id,jsonb_build_object(
   'channel',o.channel,'orderCode',o.order_code,'amount',o.price_snapshot->'amount',
   'description',o.description,'currency','VND','paymentLinkId',p_data->>'id',
   'checkoutUrl','https://pay.payos.vn/web/'||(p_data->>'id')));
 end if;
 return public.billing_system_v2(p_action,p_id,p_data);
end; $$;
revoke execute on function public.billing_system(text,uuid,jsonb) from public;
grant execute on function public.billing_system(text,uuid,jsonb) to homemind_app;
commit;
