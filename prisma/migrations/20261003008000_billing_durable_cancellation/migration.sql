begin;

-- Additive, private provenance: old runtime begin_create calls also pass this
-- guard during rollback. An interrupted cancellation cannot authorize a charge.
create table public.billing_cancel_requests (
 order_id uuid primary key references public.billing_orders(id) on delete cascade,
 requested_at timestamptz not null default now()
);
alter table public.billing_cancel_requests enable row level security;
revoke all on public.billing_cancel_requests from public,homemind_app;

alter function public.billing_system(text,uuid,jsonb) rename to billing_system_v3;
revoke execute on function public.billing_system_v3(text,uuid,jsonb) from public,homemind_app;
create function public.billing_system(p_action text,p_id uuid,p_data jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare o public.billing_orders; ws uuid; r jsonb;
begin
 if p_action='claim' then
  r:=public.billing_system_v3(p_action,p_id,p_data);
  if r is null then return null; end if;
  return r||jsonb_build_object('cancel_requested',exists(
   select 1 from public.billing_cancel_requests where order_id=(r->>'id')::uuid));
 end if;
 if p_action in ('request_cancel','begin_create') then
  select workspace_id into ws from public.billing_orders where id=p_id and channel=p_data->>'channel';
  if ws is null then raise exception 'NOT_FOUND'; end if;
  perform 1 from public.workspaces where id=ws for update;
  select * into o from public.billing_orders where id=p_id for update;
  if p_action='begin_create' then
   if exists(select 1 from public.billing_cancel_requests where order_id=o.id) then
    raise exception 'PAYMENT_CANCEL_PENDING';
   end if;
   return public.billing_system_v3(p_action,p_id,p_data);
  end if;
  if o.financial_state<>'UNPAID' or o.amount_paid<>0 then raise exception 'PAYMENT_HAS_FUNDS'; end if;
  if o.status in ('CANCELLED','EXPIRED','REVIEW') then return public.billing_order_public(o); end if;
  insert into public.billing_cancel_requests(order_id) values(o.id) on conflict do nothing;
  -- No durable begin_create means a provider POST was never authorized. Locking
  -- the workspace/order serializes this decision with any pending begin_create.
  if o.payment_link_id is null and not exists(select 1 from public.billing_create_intents where order_id=o.id) then
   update public.billing_orders set status='CANCELLED',checkout_url=null,lease_id=null,lease_until=null,updated_at=now()
    where id=o.id returning * into o;
  end if;
  return public.billing_order_public(o);
 end if;
 return public.billing_system_v3(p_action,p_id,p_data);
end; $$;
revoke execute on function public.billing_system(text,uuid,jsonb) from public;
grant execute on function public.billing_system(text,uuid,jsonb) to homemind_app;
commit;
