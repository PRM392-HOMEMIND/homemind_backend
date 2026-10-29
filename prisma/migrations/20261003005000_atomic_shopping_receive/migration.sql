-- Additive fix. Previously applied migration checksums and receipts are retained.
begin;
alter function public.apply_operation(uuid,uuid,text,jsonb,uuid) rename to apply_operation_before_receive;
revoke execute on function public.apply_operation_before_receive(uuid,uuid,text,jsonb,uuid) from public,homemind_app;
create function public.apply_operation(p_workspace uuid,p_key uuid,p_operation text,p_payload jsonb,p_turn uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 previous public.idempotency_operations%rowtype;
 item public.shopping_items%rowtype;
 payload_hash text;
 added jsonb;
 result jsonb;
 inventory_key uuid;
 bought_key uuid;
begin
 if p_operation<>'shopping.receive' then
  return public.apply_operation_before_receive(p_workspace,p_key,p_operation,p_payload,p_turn);
 end if;
 if public.current_user_id() is null or not public.is_workspace_member(p_workspace) then raise exception 'FORBIDDEN'; end if;
 if p_key is null or p_turn is not null or jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'VALIDATION_ERROR'; end if;
 -- Same lock order as quota/settlement/ordinary operations, before item/product.
 perform 1 from public.workspaces where id=p_workspace and archived_at is null for update;
 if not found then raise exception 'FORBIDDEN'; end if;
 payload_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_operation||'::'||p_payload::text,'UTF8')),'hex');
 select * into previous from public.idempotency_operations where workspace_id=p_workspace and idempotency_key=p_key for update;
 if found then
  -- Old split receives cannot be distinguished reliably from a manual add.
  -- Never repeat that increment or silently attach an unrelated old receipt.
  if previous.operation='inventory.add' then raise exception 'RECEIVE_REQUIRES_REVIEW'; end if;
  if previous.user_id<>public.current_user_id() or previous.operation<>p_operation or previous.payload_hash<>payload_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  if previous.result_json is not null then return previous.result_json; end if;
 else
  insert into public.idempotency_operations(workspace_id,idempotency_key,user_id,operation,payload_hash)
   values(p_workspace,p_key,public.current_user_id(),p_operation,payload_hash);
 end if;
 select * into item from public.shopping_items where id=(p_payload->>'itemId')::uuid and workspace_id=p_workspace for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 if item.status not in ('needed','bought') then raise exception 'VALIDATION_ERROR'; end if;
 result:=jsonb_build_object('ok',true,'created',jsonb_build_object('productIds','[]'::jsonb,'lotIds','[]'::jsonb,'transactionIds','[]'::jsonb,'shoppingItemIds',jsonb_build_array(item.id)));
 if item.status='needed' then
  perform public.billing_refresh_internal(p_workspace);
  inventory_key:=pg_catalog.md5(p_key::text||':atomic-receive-inventory')::uuid;
  bought_key:=pg_catalog.md5(p_key::text||':atomic-receive-bought')::uuid;
  added:=public.apply_operation_before_receive(p_workspace,inventory_key,'inventory.add',jsonb_build_object(
   'productName',coalesce(nullif(trim(p_payload->>'productName'),''),item.name),
   'quantity',p_payload->'quantity','unit',trim(p_payload->>'unit'),
   'category',p_payload->'category','expiryDate',p_payload->'expiryDate','productCandidateId',item.linked_product_id),null);
  perform public.apply_operation_before_receive(p_workspace,bought_key,'shopping.patch',jsonb_build_object('itemId',item.id,'status','bought'),null);
  result:=jsonb_build_object('ok',true,'created',(added->'created')||jsonb_build_object('shoppingItemIds',jsonb_build_array(item.id)));
 end if;
 update public.idempotency_operations set result_json=result where workspace_id=p_workspace and idempotency_key=p_key;
 return result;
end $$;
revoke execute on function public.apply_operation(uuid,uuid,text,jsonb,uuid) from public;
grant execute on function public.apply_operation(uuid,uuid,text,jsonb,uuid) to homemind_app;
commit;
