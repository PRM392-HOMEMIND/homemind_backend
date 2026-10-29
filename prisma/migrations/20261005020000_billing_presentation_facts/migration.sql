begin;
-- Additive facts; legacy terminal records keep an unknown timestamp.
alter table public.billing_orders add column cancelled_at timestamptz,
 add column cancellation_time_source text check(cancellation_time_source in ('PROVIDER_CONFIRMED','SERVER_CONFIRMED'));
create function public.billing_cancel_fact() returns trigger language plpgsql set search_path='' as $$
declare candidate timestamptz;
begin
 if old.cancelled_at is not null then
  new.cancelled_at:=old.cancelled_at; new.cancellation_time_source:=old.cancellation_time_source;
 elsif new.status='CANCELLED' and old.status<>'CANCELLED' then
  begin candidate:=nullif(current_setting('app.provider_cancelled_at',true),'')::timestamptz;
  exception when others then candidate:=null; end;
  if candidate>=new.created_at and candidate<=clock_timestamp()+interval '5 minutes' then
   new.cancelled_at:=candidate; new.cancellation_time_source:='PROVIDER_CONFIRMED';
  else new.cancelled_at:=clock_timestamp(); new.cancellation_time_source:='SERVER_CONFIRMED'; end if;
 else new.cancelled_at:=old.cancelled_at; new.cancellation_time_source:=old.cancellation_time_source;
 end if;
 return new;
end $$;
create trigger billing_cancel_fact before update on public.billing_orders for each row execute function public.billing_cancel_fact();
-- Keep the original terms/link/memo/paid protections. Only the two new
-- lifecycle facts join its existing allowlist; the fact trigger preserves them.
create or replace function public.billing_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if TG_TABLE_NAME='billing_prices' then
  if (to_jsonb(new)-'active') is distinct from (to_jsonb(old)-'active') then raise exception 'PRICE_VERSION_IMMUTABLE'; end if;
 else
  if (to_jsonb(new)-array['payment_link_id','checkout_url','status','financial_state','fulfillment','review_reason','amount_paid','paid_at','updated_at','lease_id','lease_until','next_check_at','attempts','expires_at','qr_code','bank_bin','bank_account','bank_name','provider_description','cancelled_at','cancellation_time_source'])
   is distinct from (to_jsonb(old)-array['payment_link_id','checkout_url','status','financial_state','fulfillment','review_reason','amount_paid','paid_at','updated_at','lease_id','lease_until','next_check_at','attempts','expires_at','qr_code','bank_bin','bank_account','bank_name','provider_description','cancelled_at','cancellation_time_source']) then raise exception 'ORDER_TERMS_IMMUTABLE'; end if;
  if old.provider_description is not null and new.provider_description is distinct from old.provider_description then raise exception 'PROVIDER_MEMO_IMMUTABLE'; end if;
  if new.provider_description is not null and not public.billing_memo_matches(new.description,new.provider_description) then raise exception 'PROVIDER_IDENTITY_CONFLICT'; end if;
  if old.financial_state='PAID' and new.financial_state<>'PAID' then raise exception 'PAID_STATE_IMMUTABLE'; end if;
  if old.payment_link_id is not null and new.payment_link_id is distinct from old.payment_link_id then raise exception 'PROVIDER_LINK_IMMUTABLE'; end if;
 end if;
 return new;
end $$;
alter function public.billing_order_public(public.billing_orders) rename to billing_order_public_before_facts;
create function public.billing_order_public(o public.billing_orders) returns jsonb language sql volatile set search_path='' as $$
 select public.billing_order_public_before_facts(o)||jsonb_build_object('cancelledAt',o.cancelled_at,
 'cancellationTimeSource',o.cancellation_time_source,'serverNow',clock_timestamp()); $$;
alter function public.billing_system(text,uuid,jsonb) rename to billing_system_before_facts;
revoke all on function public.billing_system_before_facts(text,uuid,jsonb) from public,homemind_app;
create function public.billing_system(p_action text,p_id uuid,p_data jsonb) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 -- Only the existing verified settlement can actually transition the row. The
 -- trigger consumes this fact after identity/totals checks in the trusted core.
 perform set_config('app.provider_cancelled_at',case when p_action='settle' and p_data->>'status'='CANCELLED'
  then coalesce(p_data->>'canceledAt','') else '' end,true);
 result:=public.billing_system_before_facts(p_action,p_id,p_data);
 perform set_config('app.provider_cancelled_at','',true);
 return result;
end $$;
revoke all on function public.billing_system(text,uuid,jsonb),public.billing_cancel_fact(),public.billing_order_public(public.billing_orders) from public;
grant execute on function public.billing_system(text,uuid,jsonb) to homemind_app;
-- Free access is lifetime. No quota, grant, deadline or old order is rewritten.
alter function public.billing_effective(uuid) rename to billing_effective_before_access;
revoke all on function public.billing_effective_before_access(uuid) from public,homemind_app;
create function public.billing_effective(p_workspace uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare e jsonb;
begin
 e:=public.billing_effective_before_access(p_workspace);
 return e||jsonb_build_object('accessLifetime',e->>'plan'='free');
end $$;
revoke all on function public.billing_effective(uuid) from public;
grant execute on function public.billing_effective(uuid) to homemind_app;
commit;
