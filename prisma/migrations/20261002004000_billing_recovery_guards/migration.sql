begin;

-- Preserve the applied billing migration and narrow access to its implementation.
alter function public.billing_system(text,uuid,jsonb) rename to billing_system_v1;
revoke execute on function public.billing_system_v1(text,uuid,jsonb) from public,homemind_app;
create function public.billing_system(p_action text,p_id uuid,p_data jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare o public.billing_orders; r jsonb; ws uuid;
begin
 if p_action='expire_absent' then
  select workspace_id into ws from public.billing_orders where id=p_id and channel=p_data->>'channel';
  if ws is null then return null; end if;
  perform 1 from public.workspaces where id=ws for update;
  select * into o from public.billing_orders where id=p_id for update;
  if o.lease_id::text=p_data->>'leaseId' and o.expires_at<=now()
   and o.payment_link_id is null and o.financial_state='UNPAID' and o.amount_paid=0
   and o.status in ('CREATED','CREATE_UNCERTAIN') then
   update public.billing_orders set status='EXPIRED',lease_id=null,lease_until=null,updated_at=now()
    where id=o.id returning * into o;
  end if;
  return public.billing_order_public(o);
 end if;
 r:=public.billing_system_v1(p_action,p_id,p_data);
 if p_action='settle' and p_data->>'status' in ('CANCELLED','EXPIRED') and r->>'financialState'='PARTIAL' then
  update public.billing_orders set status='REVIEW',fulfillment='REVIEW',review_reason='PARTIAL_PAYMENT_TERMINAL',updated_at=now()
   where id=p_id returning * into o;
  return public.billing_order_public(o);
 end if;
 return r;
end; $$;
revoke execute on function public.billing_system(text,uuid,jsonb) from public;
grant execute on function public.billing_system(text,uuid,jsonb) to homemind_app;

-- A quarantined financial outcome must be reviewed before another charge is offered.
create function public.billing_review_guard() returns trigger
 language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.workspaces where id=new.workspace_id for update;
 if exists(select 1 from public.billing_orders where workspace_id=new.workspace_id and fulfillment='REVIEW') then
  raise exception 'PAYMENT_REQUIRES_REVIEW';
 end if;
 return new;
end; $$;
revoke execute on function public.billing_review_guard() from public,homemind_app;
create trigger billing_orders_review_guard before insert on public.billing_orders
 for each row execute function public.billing_review_guard();
commit;
