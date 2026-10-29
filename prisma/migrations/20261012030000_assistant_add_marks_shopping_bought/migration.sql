-- Additive: khi người dùng xác nhận "đã mua/đã có X" qua trợ lý (inventory.add), món cùng
-- tên đang ở danh sách "cần mua" được chuyển sang "đã mua". Chỉ chạy lần ghi đầu tiên của
-- một idempotencyKey, nên retry không thể đánh dấu nhầm món mới thêm sau đó.
begin;
alter function public.apply_operation(uuid,uuid,text,jsonb,uuid) rename to apply_operation_before_shopping_match;
revoke all on function public.apply_operation_before_shopping_match(uuid,uuid,text,jsonb,uuid) from public,homemind_app;
create function public.apply_operation(p_workspace uuid,p_key uuid,p_operation text,p_payload jsonb,p_turn uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_first boolean;
 v_result jsonb;
 v_product uuid;
begin
 if p_operation is distinct from 'assistant.confirm'
  or jsonb_typeof(p_payload->'tools') is distinct from 'array'
  or jsonb_array_length(p_payload->'tools')<>1
  or p_payload->'tools'->0->>'toolId' is distinct from 'inventory.add' then
  return public.apply_operation_before_shopping_match(p_workspace,p_key,p_operation,p_payload,p_turn);
 end if;
 v_first:=not exists(select 1 from public.idempotency_operations
  where workspace_id=p_workspace and idempotency_key=p_key and result_json is not null);
 v_result:=public.apply_operation_before_shopping_match(p_workspace,p_key,p_operation,p_payload,p_turn);
 if v_first and coalesce((v_result->>'ok')::boolean,false) then
  for v_product in select distinct value::uuid from jsonb_array_elements_text(coalesce(v_result->'created'->'productIds','[]'::jsonb)) loop
   update public.shopping_items s set status='bought',updated_at=now()
    where s.workspace_id=p_workspace and s.status='needed'
     and (s.linked_product_id=v_product
      or lower(trim(s.name))=(select p.name_normalized from public.products p where p.id=v_product and p.workspace_id=p_workspace));
  end loop;
 end if;
 return v_result;
end; $$;
revoke all on function public.apply_operation(uuid,uuid,text,jsonb,uuid) from public;
grant execute on function public.apply_operation(uuid,uuid,text,jsonb,uuid) to homemind_app;
commit;
