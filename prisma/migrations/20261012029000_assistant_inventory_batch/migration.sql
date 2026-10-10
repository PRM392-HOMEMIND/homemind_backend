-- Additive: một câu trợ lý có thể thêm nhiều món vào kho trong một lần xác nhận.
-- Các migration trước giữ nguyên; wrapper này chỉ xử lý assistant.confirm của inventory.add
-- có arguments.items, mọi trường hợp khác chuyển nguyên cho chuỗi apply_operation cũ.
begin;
alter function public.apply_operation(uuid,uuid,text,jsonb,uuid) rename to apply_operation_before_batch;
revoke all on function public.apply_operation_before_batch(uuid,uuid,text,jsonb,uuid) from public,homemind_app;
create function public.apply_operation(p_workspace uuid,p_key uuid,p_operation text,p_payload jsonb,p_turn uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_hash text:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_operation||':'||coalesce(p_turn::text,'')||':'||p_payload::text,'UTF8')),'hex');
 v_previous public.idempotency_operations%rowtype;
 v_turn public.assistant_turns%rowtype;
 v_items jsonb;
 v_item jsonb;
 v_index int:=0;
 v_child jsonb;
 v_created jsonb:='{"productIds":[],"lotIds":[],"transactionIds":[],"shoppingItemIds":[]}'::jsonb;
 v_result jsonb;
 v_key text;
begin
 if p_operation is distinct from 'assistant.confirm'
  or jsonb_typeof(p_payload->'tools') is distinct from 'array'
  or jsonb_array_length(p_payload->'tools')<>1
  or p_payload->'tools'->0->>'toolId' is distinct from 'inventory.add'
  or not (p_payload->'tools'->0->'arguments' ? 'items') then
  return public.apply_operation_before_batch(p_workspace,p_key,p_operation,p_payload,p_turn);
 end if;

 if public.current_user_id() is null or not public.is_workspace_member(p_workspace) then raise exception 'FORBIDDEN'; end if;
 if p_key is null or p_turn is null then raise exception 'VALIDATION_ERROR'; end if;
 insert into public.idempotency_operations(workspace_id,idempotency_key,user_id,operation,payload_hash)
  values(p_workspace,p_key,public.current_user_id(),p_operation,v_hash) on conflict do nothing;
 select * into v_previous from public.idempotency_operations where workspace_id=p_workspace and idempotency_key=p_key for update;
 if v_previous.user_id<>public.current_user_id() or v_previous.operation<>p_operation or v_previous.payload_hash<>v_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
 if v_previous.result_json is not null then return v_previous.result_json; end if;

 select * into v_turn from public.assistant_turns where id=p_turn and workspace_id=p_workspace and user_id=public.current_user_id() for update;
 if not found or v_turn.status<>'pending_confirmation' or v_turn.expires_at<=now() then raise exception 'STALE_TURN'; end if;
 if v_turn.tools_json->0->>'toolId' is distinct from 'inventory.add' or jsonb_typeof(v_turn.tools_json->0->'arguments'->'items') is distinct from 'array' then raise exception 'VALIDATION_ERROR'; end if;
 v_items:=p_payload->'tools'->0->'arguments'->'items';
 -- Người dùng có thể bỏ bớt món khi xem bản nháp nhưng không được thêm món mới.
 if jsonb_typeof(v_items)<>'array' or jsonb_array_length(v_items) not between 1 and 20
  or jsonb_array_length(v_items)>jsonb_array_length(v_turn.tools_json->0->'arguments'->'items') then raise exception 'VALIDATION_ERROR'; end if;

 perform set_config('app.activity_operation',p_operation,true); perform set_config('app.activity_changed','0',true);
 for v_item in select value from jsonb_array_elements(v_items) loop
  if jsonb_typeof(v_item)<>'object' then raise exception 'VALIDATION_ERROR'; end if;
  v_key:=pg_catalog.md5(p_key::text||':item:'||v_index::text);
  v_child:=public.apply_operation_before_activity(p_workspace,(substr(v_key,1,8)||'-'||substr(v_key,9,4)||'-'||substr(v_key,13,4)||'-'||substr(v_key,17,4)||'-'||substr(v_key,21,12))::uuid,
   'inventory.add',v_item-'confidence'-'warnings'-'name',null);
  v_created:=jsonb_set(v_created,'{productIds}',(v_created->'productIds')||(v_child->'created'->'productIds'));
  v_created:=jsonb_set(v_created,'{lotIds}',(v_created->'lotIds')||(v_child->'created'->'lotIds'));
  v_created:=jsonb_set(v_created,'{transactionIds}',(v_created->'transactionIds')||(v_child->'created'->'transactionIds'));
  v_index:=v_index+1;
 end loop;
 update public.assistant_turns set status='committed',kind='write_committed',committed_at=now() where id=p_turn;
 v_result:=jsonb_build_object('schemaVersion','1.0','turnId',p_turn,'kind','write_committed','ok',true,'created',v_created,'message','Đã lưu thay đổi.');
 update public.idempotency_operations set result_json=v_result where workspace_id=p_workspace and idempotency_key=p_key;
 if current_setting('app.activity_changed',true)='1' then
  perform public.notification_enqueue('operation:v1:'||p_workspace||':'||p_key,public.current_user_id(),p_workspace,false,
   p_operation,'Đã thêm vào kho','Thao tác của bạn đã được lưu.','Mở dữ liệu liên quan để xem kết quả hiện tại.','inventory',
   v_created->'productIds'->>0,clock_timestamp());
 end if;
 perform set_config('app.activity_operation','',true);
 return v_result;
end; $$;
revoke all on function public.apply_operation(uuid,uuid,text,jsonb,uuid) from public;
grant execute on function public.apply_operation(uuid,uuid,text,jsonb,uuid) to homemind_app;
commit;
