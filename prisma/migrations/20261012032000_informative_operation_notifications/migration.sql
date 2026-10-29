-- Additive: thông báo của thao tác ghi nêu rõ món nào, bao nhiêu, thay vì "Thao tác của bạn đã được lưu."
-- Wrapper ngoài cùng chạy chuỗi apply_operation cũ rồi viết lại phần tóm tắt của đúng sự kiện vừa được
-- đưa vào hàng đợi, trong cùng giao dịch và chỉ khi nó chưa được chuyển đi.
begin;

create function public.notification_qty_text(p_qty jsonb,p_unit jsonb) returns text
language sql immutable set search_path='' as $$
 select nullif(concat_ws(' ',
  case when jsonb_typeof(p_qty)='number' then trim_scale((p_qty #>> '{}')::numeric)::text end,
  nullif(trim(p_unit #>> '{}'),'')),'')
$$;

create function public.notification_join(p_items text[]) returns text
language sql immutable set search_path='' as $$
 select case when coalesce(array_length(p_items,1),0)=0 then null
  when array_length(p_items,1)<=5 then array_to_string(p_items,', ')
  else array_to_string(p_items[1:5],', ')||' và '||(array_length(p_items,1)-5)||' món khác' end
$$;

create function public.notification_operation_text(p_workspace uuid,p_operation text,p_payload jsonb) returns text
language plpgsql security definer set search_path='' as $$
declare
 v_tool text:=p_operation;
 v_args jsonb:=p_payload;
 v_names text[]:='{}';
 v_e jsonb;
 v_name text;
 v_qty text;
begin
 if p_operation='assistant.confirm' then
  v_tool:=p_payload->'tools'->0->>'toolId';
  v_args:=p_payload->'tools'->0->'arguments';
 end if;
 if v_args is null or jsonb_typeof(v_args)<>'object' then return null; end if;

 if v_tool='inventory.add' then
  for v_e in select value from jsonb_array_elements(case when jsonb_typeof(v_args->'items')='array' then v_args->'items' else jsonb_build_array(v_args) end) loop
   v_name:=nullif(trim(v_e->>'productName'),'');
   if v_name is not null then
    v_names:=v_names||concat_ws(' ',public.notification_qty_text(v_e->'quantity',v_e->'unit'),v_name);
   end if;
  end loop;
  return case when array_length(v_names,1) is null then null else 'Đã thêm vào kho: '||public.notification_join(v_names)||'.' end;

 elsif v_tool='inventory.mark_out' then
  v_name:=coalesce(nullif(trim(v_args->>'productName'),''),
   (select p.name from public.products p where p.id=nullif(v_args->>'productId','')::uuid and p.workspace_id=p_workspace));
  if v_name is null then return null; end if;
  v_qty:=public.notification_qty_text(v_args->'quantity',null);
  return case when v_qty is null then 'Đã đánh dấu hết '||v_name||'.' else 'Đã trừ '||v_qty||' '||v_name||'.' end;

 elsif v_tool='shopping.add' then
  for v_e in select value from jsonb_array_elements(case when jsonb_typeof(v_args->'items')='array' then v_args->'items' else jsonb_build_array(v_args) end) loop
   v_name:=nullif(trim(v_e->>'name'),'');
   if v_name is not null then
    v_names:=v_names||concat_ws(' ',public.notification_qty_text(v_e->'quantity',v_e->'unit'),v_name);
   end if;
  end loop;
  return case when array_length(v_names,1) is null then null else 'Đã thêm vào danh sách cần mua: '||public.notification_join(v_names)||'.' end;

 elsif v_tool='shopping.skip' then
  for v_e in select value from jsonb_array_elements(case when jsonb_typeof(v_args->'items')='array' then v_args->'items' else '[]'::jsonb end) loop
   v_name:=nullif(trim(v_e->>'name'),'');
   if v_name is not null then v_names:=v_names||v_name; end if;
  end loop;
  return case when array_length(v_names,1) is null then null else 'Đã bỏ qua: '||public.notification_join(v_names)||'.' end;

 elsif v_tool='shopping.patch' then
  v_name:=(select s.name from public.shopping_items s where s.id=nullif(v_args->>'itemId','')::uuid and s.workspace_id=p_workspace);
  if v_name is null then return null; end if;
  return case v_args->>'status'
   when 'skipped' then 'Đã bỏ qua '||v_name||'.'
   when 'bought' then 'Đã đánh dấu đã mua '||v_name||'.'
   when 'needed' then 'Đã đưa '||v_name||' về danh sách cần mua.'
   else 'Đã cập nhật '||v_name||'.' end;

 elsif v_tool='shopping.receive' then
  v_name:=coalesce(nullif(trim(v_args->>'productName'),''),
   (select s.name from public.shopping_items s where s.id=nullif(v_args->>'itemId','')::uuid and s.workspace_id=p_workspace));
  if v_name is null then return null; end if;
  return 'Đã nhận '||concat_ws(' ',public.notification_qty_text(v_args->'quantity',v_args->'unit'),v_name)||' vào kho.';
 end if;
 return null;
exception when others then
 -- Không bao giờ để việc dựng nội dung thông báo làm hỏng thao tác chính; giữ nội dung mặc định.
 return null;
end; $$;
revoke all on function public.notification_operation_text(uuid,text,jsonb) from public,homemind_app;
revoke all on function public.notification_qty_text(jsonb,jsonb) from public,homemind_app;
revoke all on function public.notification_join(text[]) from public,homemind_app;

alter function public.apply_operation(uuid,uuid,text,jsonb,uuid) rename to apply_operation_before_text;
revoke all on function public.apply_operation_before_text(uuid,uuid,text,jsonb,uuid) from public,homemind_app;
create function public.apply_operation(p_workspace uuid,p_key uuid,p_operation text,p_payload jsonb,p_turn uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_result jsonb;
 v_text text;
begin
 v_result:=public.apply_operation_before_text(p_workspace,p_key,p_operation,p_payload,p_turn);
 v_text:=public.notification_operation_text(p_workspace,p_operation,p_payload);
 if v_text is not null then
  update public.notification_outbox set summary=left(v_text,240)
   where event_key='operation:v1:'||p_workspace||':'||p_key and delivered_at is null;
 end if;
 return v_result;
end; $$;
revoke all on function public.apply_operation(uuid,uuid,text,jsonb,uuid) from public;
grant execute on function public.apply_operation(uuid,uuid,text,jsonb,uuid) to homemind_app;
commit;
