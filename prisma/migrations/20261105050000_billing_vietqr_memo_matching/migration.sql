-- Support flexible VietQR bank transfer narratives in PayOS settlements.
-- Banking switches (Napas / Casso / ACSP) append transaction codes and bank prefixes/suffixes
-- around the requested memo token (e.g. "Qanixg4482 CASSO13103 4 ... HM2BA49B7- Ma GD ACSP ...").
begin;

create or replace function public.billing_memo_matches(p_requested text,p_canonical text) returns boolean
 language sql immutable set search_path='' as $$
 select coalesce(
  length(p_canonical) between 1 and 200 and length(p_requested) > 0 and (
   p_canonical = p_requested or
   p_canonical ~* ('(^|[^A-Za-z0-9])' || p_requested || '([^A-Za-z0-9]|$)')
  ), false); $$;
revoke all on function public.billing_memo_matches(text,text) from public,homemind_app;

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
 if o.financial_state='PAID' and o.fulfillment='GRANTED' then return public.billing_order_public(o); end if;
 link:=p_data->>'id';
 if (p_data->>'orderCode')::bigint<>o.order_code or (p_data->>'amount')::int<>(o.price_snapshot->>'amount')::int or length(coalesce(link,''))=0 then reason:='PROVIDER_IDENTITY_CONFLICT';
 elsif o.payment_link_id is not null and o.payment_link_id<>link then reason:='PROVIDER_IDENTITY_CONFLICT';
 elsif o.payment_link_id is null and not exists(select 1 from public.billing_webhook_inbox where channel=o.channel and order_code=o.order_code and payment_link_id=link and public.billing_memo_matches(o.description,description) and currency='VND') then reason:='UNBOUND_PROVIDER_LINK'; end if;
 if reason is null and jsonb_array_length(p_data->'transactions')>0 then
  canonical_memo:=coalesce(o.provider_description,p_data->'transactions'->0->>'description');
  for t in select value from jsonb_array_elements(p_data->'transactions') loop
   if not public.billing_memo_matches(o.description,t->>'description') then reason:='PROVIDER_IDENTITY_CONFLICT'; exit; end if;
   ref:=t->>'reference'; tx_time:=(t->>'transactionDateTime')::timestamptz;
   if length(coalesce(ref,'')) not between 1 and 200 or (t->>'amount')::bigint not between 1 and 2147483647 or tx_time>p_now+interval '5 minutes' or tx_time<o.created_at-interval '5 minutes' then reason:='TRANSACTION_INVALID'; exit; end if;
   select * into previous from public.billing_transactions where channel=o.channel and reference=ref;
   if found and (previous.order_id<>o.id or previous.amount<>(t->>'amount')::int) then reason:='TRANSACTION_REPLAY'; exit; end if;
   insert into public.billing_transactions(channel,reference,order_id,amount,paid_at) values(o.channel,ref,o.id,(t->>'amount')::int,tx_time) on conflict do nothing;
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
    if exists(select 1 from public.billing_grants where workspace_id=o.workspace_id and reward_id is null and starts_at>paidtime and starts_at<=p_now) then reason:='STALE_PAYMENT_REQUIRES_REVIEW'; end if;
    if reason is null then
     insert into public.billing_grants(order_id,workspace_id,plan,product_limit,starts_at,expires_at,price_snapshot)
      values(o.id,o.workspace_id,o.price_snapshot->>'plan',(o.price_snapshot->>'productLimit')::int,paidtime,
       paidtime+make_interval(secs=>(o.price_snapshot->>'durationSeconds')::int),o.price_snapshot) on conflict(order_id) do nothing returning * into g;
     update public.billing_grants set effective_until=paidtime,superseded_at=paidtime,superseded_by=g.id
      where workspace_id=o.workspace_id and id<>g.id and starts_at<=paidtime and coalesce(effective_until,expires_at)>paidtime;
    end if;
   else
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
revoke all on function public.billing_system_verified_at(text,uuid,jsonb,timestamptz) from public,homemind_app;

commit;
