-- Additive: giá mua và nơi cất (đều tùy chọn) cho từng lô nhập kho, tổng chi tiêu theo tháng,
-- và thông báo nêu số tiền đã chi cùng các món chưa có giá. Cột mới cho phép NULL, không có default,
-- nên không ghi lại bảng; mã cũ bỏ qua hai cột này nên rollback API vẫn an toàn.
-- Giá là TỔNG tiền (VND, số nguyên) của lô lúc nhập; một lô = một lần mua nên chi tiêu tháng = tổng giá
-- các lô tạo trong tháng (giờ Việt Nam), kể cả lô đã dùng hết.
begin;

alter table public.inventory_lots
 add column price_vnd bigint check (price_vnd is null or price_vnd between 0 and 100000000000),
 add column storage_location text check (storage_location is null or char_length(storage_location) between 1 and 60);
create index inventory_lots_workspace_created_idx on public.inventory_lots(workspace_id,created_at desc);

-- Giá: null/vắng = không đặt; số nguyên 0..1e11. Nơi cất: chuỗi 1..60 ký tự sau khi trim, rỗng = không đặt.
create function public.spending_price(p_value jsonb) returns bigint
language plpgsql immutable set search_path='' as $$
declare v numeric;
begin
 if p_value is null or jsonb_typeof(p_value)='null' then return null; end if;
 if jsonb_typeof(p_value)<>'number' then raise exception 'VALIDATION_ERROR'; end if;
 v:=(p_value #>> '{}')::numeric;
 if v<>trunc(v) or v<0 or v>100000000000 then raise exception 'VALIDATION_ERROR'; end if;
 return v::bigint;
end $$;

create function public.spending_location(p_value jsonb) returns text
language plpgsql immutable set search_path='' as $$
declare v text;
begin
 if p_value is null or jsonb_typeof(p_value)='null' then return null; end if;
 if jsonb_typeof(p_value)<>'string' then raise exception 'VALIDATION_ERROR'; end if;
 v:=nullif(btrim(p_value #>> '{}'),'');
 if v is not null and char_length(v)>60 then raise exception 'VALIDATION_ERROR'; end if;
 return v;
end $$;

create function public.format_vnd(p_amount bigint) returns text
language sql immutable set search_path='' as $$
 select pg_catalog.replace(pg_catalog.to_char(coalesce(p_amount,0),'FM999,999,999,999,999'),',','.')||' ₫'
$$;

-- Một lần quét chỉ mục (workspace_id, created_at) cho tháng này và tháng trước; trả NULL nếu không phải thành viên.
create function public.spending_summary(p_workspace uuid,p_month date) returns jsonb
language sql stable set search_path='' as $$
 with b as (
  select (pg_catalog.date_trunc('month',p_month::timestamp) at time zone 'Asia/Ho_Chi_Minh') as s,
         ((pg_catalog.date_trunc('month',p_month::timestamp)+interval '1 month') at time zone 'Asia/Ho_Chi_Minh') as e,
         ((pg_catalog.date_trunc('month',p_month::timestamp)-interval '1 month') at time zone 'Asia/Ho_Chi_Minh') as ps),
 w as (
  select l.id,l.product_id,l.price_vnd,l.storage_location,l.created_at,(l.created_at>=b.s) as is_cur
  from public.inventory_lots l cross join b
  where l.workspace_id=p_workspace and l.created_at>=b.ps and l.created_at<b.e),
 cur as (
  select w.id,w.product_id,w.price_vnd,w.storage_location,w.created_at,p.name,p.category
  from w left join public.products p on p.id=w.product_id where w.is_cur)
 select jsonb_build_object(
  'month',pg_catalog.to_char(p_month,'YYYY-MM'),
  'totalVnd',coalesce((select sum(price_vnd) from cur),0)::bigint,
  'pricedCount',(select count(*) from cur where price_vnd is not null),
  'unpricedCount',(select count(*) from cur where price_vnd is null),
  'previousTotalVnd',coalesce((select sum(price_vnd) from w where not is_cur),0)::bigint,
  'byCategory',coalesce((select jsonb_agg(jsonb_build_object('category',c,'totalVnd',t) order by t desc,c)
    from (select category as c,sum(price_vnd)::bigint as t from cur where price_vnd is not null group by category order by 2 desc,1 limit 5) x),'[]'::jsonb),
  'unpriced',coalesce((select jsonb_agg(jsonb_build_object('lotId',id,'productId',product_id,'name',name,
      'purchasedAt',created_at,'storageLocation',storage_location) order by created_at desc,id)
    from (select * from cur where price_vnd is null order by created_at desc,id limit 30) u),'[]'::jsonb))
 where public.is_workspace_member(p_workspace)
$$;
revoke all on function public.spending_summary(uuid,date) from public;
grant execute on function public.spending_summary(uuid,date) to homemind_app;

-- Sửa giá/nơi cất của một lô sau khi đã nhập. p_patch chỉ chứa khóa cần đổi; giá trị null xóa trường đó.
-- Đặt giá trị tuyệt đối nên gửi lại bao nhiêu lần cũng cho cùng kết quả (không cần khóa idempotency).
create function public.set_lot_details(p_workspace uuid,p_lot uuid,p_patch jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_lot public.inventory_lots%rowtype;
begin
 if public.current_user_id() is null or not public.is_workspace_member(p_workspace) then raise exception 'FORBIDDEN'; end if;
 if p_lot is null or jsonb_typeof(p_patch) is distinct from 'object' or not (p_patch ?| array['priceVnd','storageLocation']) then raise exception 'VALIDATION_ERROR'; end if;
 select * into v_lot from public.inventory_lots where id=p_lot and workspace_id=p_workspace for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 update public.inventory_lots set
  price_vnd=case when p_patch ? 'priceVnd' then public.spending_price(p_patch->'priceVnd') else price_vnd end,
  storage_location=case when p_patch ? 'storageLocation' then public.spending_location(p_patch->'storageLocation') else storage_location end,
  updated_at=now()
 where id=p_lot returning * into v_lot;
 return jsonb_build_object('ok',true,'lotId',v_lot.id,'priceVnd',v_lot.price_vnd,'storageLocation',v_lot.storage_location);
end $$;
revoke all on function public.set_lot_details(uuid,uuid,jsonb) from public;
grant execute on function public.set_lot_details(uuid,uuid,jsonb) to homemind_app;
revoke all on function public.spending_price(jsonb),public.spending_location(jsonb),public.format_vnd(bigint) from public,homemind_app;

-- Wrapper ngoài cùng. Chạy chuỗi apply_operation cũ; nếu thao tác vừa tạo lô (inventory.add, shopping.receive,
-- xác nhận nhập kho qua trợ lý, kể cả nhiều món) thì ghi giá/nơi cất kèm theo payload vào đúng các lô đó,
-- trong cùng giao dịch, chỉ ở lần ghi đầu tiên của một idempotencyKey (retry không ghi đè chỉnh sửa về sau).
-- Lô thứ i của kết quả ứng với món thứ i của payload (mỗi món tạo đúng một lô, theo thứ tự).
alter function public.apply_operation(uuid,uuid,text,jsonb,uuid) rename to apply_operation_before_spending;
revoke all on function public.apply_operation_before_spending(uuid,uuid,text,jsonb,uuid) from public,homemind_app;
create function public.apply_operation(p_workspace uuid,p_key uuid,p_operation text,p_payload jsonb,p_turn uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_args jsonb:=p_payload;
 v_first boolean;
 v_result jsonb;
 v_lots jsonb;
 v_e jsonb;
 v_i int:=0;
 v_price bigint;
 v_loc text;
 v_priced boolean:=false;
 v_summary jsonb;
 v_total bigint;
 v_unpriced int;
 v_label text;
 v_head text;
 v_names text[];
begin
 if p_operation='assistant.confirm' then
  if jsonb_typeof(p_payload->'tools') is distinct from 'array' or jsonb_array_length(p_payload->'tools')<>1
   or p_payload->'tools'->0->>'toolId' is distinct from 'inventory.add' then
   return public.apply_operation_before_spending(p_workspace,p_key,p_operation,p_payload,p_turn);
  end if;
  v_args:=p_payload->'tools'->0->'arguments';
 elsif p_operation not in ('inventory.add','shopping.receive') then
  return public.apply_operation_before_spending(p_workspace,p_key,p_operation,p_payload,p_turn);
 end if;
 if jsonb_typeof(v_args) is distinct from 'object' then
  return public.apply_operation_before_spending(p_workspace,p_key,p_operation,p_payload,p_turn);
 end if;

 v_first:=not exists(select 1 from public.idempotency_operations
  where workspace_id=p_workspace and idempotency_key=p_key and result_json is not null);
 v_result:=public.apply_operation_before_spending(p_workspace,p_key,p_operation,p_payload,p_turn);
 if not v_first or coalesce((v_result->>'ok')::boolean,false) is not true then return v_result; end if;
 v_lots:=coalesce(v_result->'created'->'lotIds','[]'::jsonb);
 if jsonb_typeof(v_lots)<>'array' or jsonb_array_length(v_lots)=0 then return v_result; end if;

 for v_e in select value from jsonb_array_elements(case when jsonb_typeof(v_args->'items')='array' then v_args->'items' else jsonb_build_array(v_args) end) loop
  exit when v_i>=jsonb_array_length(v_lots);
  v_price:=public.spending_price(v_e->'priceVnd');
  v_loc:=public.spending_location(v_e->'storageLocation');
  if v_price is not null or v_loc is not null then
   update public.inventory_lots set price_vnd=coalesce(v_price,price_vnd),storage_location=coalesce(v_loc,storage_location)
    where id=(v_lots->>v_i)::uuid and workspace_id=p_workspace;
   v_priced:=v_priced or v_price is not null;
  end if;
  v_i:=v_i+1;
 end loop;

 -- Nêu tổng chi tiêu tháng và các món chưa có giá ngay trong thông báo của thao tác này (chưa chuyển đi).
 -- Chỉ khi người dùng đang dùng tính năng giá (đã có khoản chi trong tháng), để không nhắc phiền người chưa nhập giá.
 begin
  v_summary:=public.spending_summary(p_workspace,(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_total:=(v_summary->>'totalVnd')::bigint;
  v_unpriced:=(v_summary->>'unpricedCount')::int;
  if v_total>0 or v_priced then
   v_label:='tháng '||pg_catalog.to_char((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh'),'FMMM');
   v_head:='Chi tiêu '||v_label||': '||public.format_vnd(v_total);
   select coalesce(array_agg(distinct x->>'name'),'{}') into v_names from jsonb_array_elements(v_summary->'unpriced') x where x->>'name' is not null;
   update public.notification_outbox set
    summary=left(summary||' '||v_head||case when v_unpriced>0 then ' · '||v_unpriced||' lần mua chưa có giá' else '' end||'.',240),
    detail=left(v_head||'.'||case when v_unpriced>0
      then ' Chưa tính '||v_unpriced||' lần mua chưa có giá: '||coalesce(public.notification_join(v_names),'')||'. Mở Trang chủ > Chi tiêu để nhập giá cho chính xác hơn.'
      else ' Tất cả các lần mua trong tháng đều đã có giá.' end,2000)
   where event_key='operation:v1:'||p_workspace||':'||p_key and recipient_id=public.current_user_id() and delivered_at is null;
  end if;
 exception when others then
  -- Việc dựng thông báo không bao giờ làm hỏng thao tác chính.
  null;
 end;
 return v_result;
end; $$;
revoke all on function public.apply_operation(uuid,uuid,text,jsonb,uuid) from public;
grant execute on function public.apply_operation(uuid,uuid,text,jsonb,uuid) to homemind_app;
commit;
