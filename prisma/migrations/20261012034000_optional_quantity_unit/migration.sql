-- Additive: chỉ TÊN sản phẩm là bắt buộc khi nhập kho. Số lượng, đơn vị, hạn dùng, giá, nơi cất đều tùy chọn.
-- * inventory_lots.unit cho phép NULL (đơn vị nằm ở sản phẩm, mặc định NULL).
-- * Lô không nói số lượng vẫn là "có hàng": quantity=1 chỉ là dấu hiệu tồn tại, quantity_known=false,
--   nên mọi điều kiện quantity>0 sẵn có (còn hàng, hạn dùng, nhắc hết hạn) giữ nguyên. API trả quantity=null.
-- * Sản phẩm chưa có đơn vị sẽ nhận đơn vị từ lần nhập đầu tiên có đơn vị; đơn vị đã có thì vẫn không được đổi.
-- * Trừ kho: lô không rõ số lượng bị trừ hết khi "hết hàng", hoặc nhận phần còn thiếu sau khi các lô có số lượng đã hết.
-- * Thêm hành động inventory.set_expiry: đặt hạn cho một phần hàng ĐÃ có (tách lô, giữ ngày nhập và chia giá theo tỉ lệ),
--   không cộng tồn kho, để câu "trong 5 gói có 2 gói hạn 20/10" không bị nhập thành 7 gói.
-- Chỉ viết lại thân hàm gốc (đã được các wrapper sau bọc), giữ nguyên chữ ký, quyền và toàn bộ wrapper phía trên.
begin;
alter table public.inventory_lots alter column unit drop not null;
alter table public.inventory_lots add column quantity_known boolean not null default true;
create or replace function public.apply_operation_before_billing(p_workspace uuid,p_key uuid,p_operation text,p_payload jsonb,p_turn uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_hash text := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_operation || ':' || coalesce(p_turn::text,'') || ':' || p_payload::text,'UTF8')),'hex');
  v_previous public.idempotency_operations%rowtype;
  v_turn public.assistant_turns%rowtype;
  v_action text := p_operation;
  v_args jsonb := p_payload;
  v_product uuid;
  v_lot uuid;
  v_tx uuid;
  v_item uuid;
  v_name text;
  v_unit text;
  v_qty numeric(12,3);
  v_remaining numeric(12,3);
  v_taken numeric(12,3);
  v_source text := 'manual';
  v_created jsonb := '{"productIds":[],"lotIds":[],"transactionIds":[],"shoppingItemIds":[]}'::jsonb;
  v_result jsonb;
  v_element jsonb;
  v_lot_row record;
  v_known boolean := true;
  v_lot_unit text;
  v_unknown int;
  v_known_total numeric(12,3);
  v_full boolean := true;
  v_date date;
  v_split_price bigint;
begin
  if public.current_user_id() is null or not public.is_workspace_member(p_workspace) then raise exception 'FORBIDDEN'; end if;
  if p_key is null or p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'VALIDATION_ERROR'; end if;
  insert into public.idempotency_operations(workspace_id,idempotency_key,user_id,operation,payload_hash)
  values(p_workspace,p_key,public.current_user_id(),p_operation,v_hash) on conflict do nothing;
  select * into v_previous from public.idempotency_operations where workspace_id=p_workspace and idempotency_key=p_key for update;
  if v_previous.user_id<>public.current_user_id() or v_previous.operation<>p_operation or v_previous.payload_hash<>v_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  if v_previous.result_json is not null then return v_previous.result_json; end if;

  if p_operation='assistant.confirm' then
    select * into v_turn from public.assistant_turns where id=p_turn and workspace_id=p_workspace and user_id=public.current_user_id() for update;
    if not found or v_turn.status<>'pending_confirmation' or v_turn.expires_at<=now() then raise exception 'STALE_TURN'; end if;
    if jsonb_typeof(p_payload->'tools')<>'array' or jsonb_array_length(p_payload->'tools')<>1 then raise exception 'VALIDATION_ERROR'; end if;
    v_action := p_payload->'tools'->0->>'toolId';
    if v_action not in ('inventory.add','inventory.mark_out','shopping.add','inventory.set_expiry') or v_action<>v_turn.tools_json->0->>'toolId' then raise exception 'VALIDATION_ERROR'; end if;
    v_args := p_payload->'tools'->0->'arguments';
    if jsonb_typeof(v_args)<>'object' then raise exception 'VALIDATION_ERROR'; end if;
    -- Only editable fields may differ; server validates all resulting values again below.
    if v_action='inventory.mark_out' and v_args->>'productId' is distinct from v_turn.tools_json->0->'arguments'->>'productId' then raise exception 'VALIDATION_ERROR'; end if;
    v_source := 'voice';
  elsif p_turn is not null then
    raise exception 'VALIDATION_ERROR';
  end if;

  if v_action='inventory.add' then
    -- Chỉ tên là bắt buộc. Số lượng và đơn vị có thì lưu, không có thì để trống:
    -- lô không rõ số lượng vẫn được tính là "có hàng" (quantity=1 chỉ là dấu hiệu nội bộ, quantity_known=false).
    v_name := trim(v_args->>'productName'); v_unit := nullif(trim(v_args->>'unit'),'');
    if coalesce(length(v_name),0) not between 1 and 160 or coalesce(length(v_unit),1) not between 1 and 40 then raise exception 'VALIDATION_ERROR'; end if;
    if nullif(trim(v_args->>'quantity'),'') is null then
      v_qty := 1; v_known := false;
    else
      v_qty := (v_args->>'quantity')::numeric;
      if v_qty<=0 or v_qty>999999999 then raise exception 'VALIDATION_ERROR'; end if;
    end if;
    if v_args->>'expiryDate' is not null then perform (v_args->>'expiryDate')::date; end if;
    if v_args->>'productCandidateId' is not null then
      v_product := (v_args->>'productCandidateId')::uuid;
      perform 1 from public.products where workspace_id=p_workspace and id=v_product and archived_at is null for update;
      if not found then raise exception 'VALIDATION_ERROR'; end if;
      select default_unit into v_lot_unit from public.products where id=v_product;
      if v_unit is not null and v_lot_unit is not null and v_lot_unit<>v_unit then raise exception 'VALIDATION_ERROR'; end if;
      if v_unit is not null and v_lot_unit is null then update public.products set default_unit=v_unit where id=v_product; end if;
    else
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace::text || ':' || lower(v_name),0));
      select id,default_unit into v_product,v_lot_unit from public.products where workspace_id=p_workspace and name_normalized=lower(v_name) and archived_at is null for update;
      if v_product is null then
        insert into public.products(workspace_id,name,name_normalized,category,default_unit) values(p_workspace,v_name,lower(v_name),nullif(trim(v_args->>'category'),''),v_unit) returning id into v_product;
      else
        if v_unit is not null and v_lot_unit is not null and v_lot_unit<>v_unit then raise exception 'VALIDATION_ERROR'; end if;
        if v_unit is not null and v_lot_unit is null then update public.products set default_unit=v_unit where id=v_product; end if;
        update public.products set status='in_stock',updated_at=now() where id=v_product;
      end if;
    end if;
    v_lot_unit := coalesce(v_unit,v_lot_unit);
    insert into public.inventory_lots(workspace_id,product_id,quantity,unit,expiry_date,quantity_known) values(p_workspace,v_product,v_qty,v_lot_unit,(v_args->>'expiryDate')::date,v_known) returning id into v_lot;
    insert into public.inventory_transactions(workspace_id,product_id,lot_id,action,quantity_delta,source,assistant_turn_id,created_by)
      values(p_workspace,v_product,v_lot,'receive',v_qty,v_source,p_turn,public.current_user_id()) returning id into v_tx;
    update public.products set status='in_stock',updated_at=now() where id=v_product;
    v_created := jsonb_build_object('productIds',jsonb_build_array(v_product),'lotIds',jsonb_build_array(v_lot),'transactionIds',jsonb_build_array(v_tx),'shoppingItemIds','[]'::jsonb);

  elsif v_action='inventory.mark_out' then
    v_product := (v_args->>'productId')::uuid;
    perform 1 from public.products where id=v_product and workspace_id=p_workspace and archived_at is null for update;
    if not found then raise exception 'NOT_FOUND'; end if;
    select coalesce(sum(quantity) filter (where quantity_known),0),count(*) filter (where not quantity_known) into v_known_total,v_unknown
      from public.inventory_lots where workspace_id=p_workspace and product_id=v_product and quantity>0;
    if v_known_total=0 and v_unknown=0 then raise exception 'VALIDATION_ERROR'; end if;
    v_remaining := v_known_total;
    if v_args->>'quantity' is not null then
      v_qty := (v_args->>'quantity')::numeric;
      -- Lô không rõ số lượng nhận phần còn thiếu: không thể bắt người dùng trừ "quá" một số ta không biết.
      if v_qty<=0 or (v_unknown=0 and v_qty>v_known_total) then raise exception 'VALIDATION_ERROR'; end if;
      v_remaining := v_qty; v_full := false;
    end if;
    for v_lot_row in select id,quantity,quantity_known from public.inventory_lots where workspace_id=p_workspace and product_id=v_product and quantity>0 order by quantity_known desc,expiry_date asc nulls last,created_at,id for update loop
      if v_lot_row.quantity_known then
        continue when v_remaining<=0;
        v_taken := least(v_remaining,v_lot_row.quantity);
        v_remaining := v_remaining-v_taken;
      else
        continue when not v_full and v_remaining<=0;
        v_taken := v_lot_row.quantity;
        if not v_full then v_remaining := 0; end if;
      end if;
      update public.inventory_lots set quantity=quantity-v_taken,updated_at=now() where id=v_lot_row.id;
      insert into public.inventory_transactions(workspace_id,product_id,lot_id,action,quantity_delta,source,assistant_turn_id,created_by)
        values(p_workspace,v_product,v_lot_row.id,'consume',-v_taken,v_source,p_turn,public.current_user_id()) returning id into v_tx;
      v_created := jsonb_set(v_created,'{transactionIds}',(v_created->'transactionIds') || jsonb_build_array(v_tx));
    end loop;
    update public.products set status=case when exists(select 1 from public.inventory_lots where workspace_id=p_workspace and product_id=v_product and quantity>0) then 'in_stock' else 'out' end,updated_at=now() where id=v_product;
    v_created := jsonb_set(v_created,'{productIds}',jsonb_build_array(v_product));
    if coalesce((v_args->>'addToShoppingList')::boolean,false) then
      insert into public.shopping_items(workspace_id,name,source,linked_product_id,assistant_turn_id,created_by)
        select p_workspace,name,'repurchase',v_product,p_turn,public.current_user_id() from public.products where id=v_product returning id into v_item;
      v_created := jsonb_set(v_created,'{shoppingItemIds}',jsonb_build_array(v_item));
    end if;

  elsif v_action='shopping.add' then
    if v_args ? 'items' then
      if jsonb_typeof(v_args->'items')<>'array' or jsonb_array_length(v_args->'items') not between 1 and 20 then raise exception 'VALIDATION_ERROR'; end if;
      for v_element in select value from jsonb_array_elements(v_args->'items') loop
        v_name := trim(v_element->>'name');
        if coalesce(length(v_name),0) not between 1 and 160 then raise exception 'VALIDATION_ERROR'; end if;
        if v_element->>'quantity' is not null and (v_element->>'quantity')::numeric<=0 then raise exception 'VALIDATION_ERROR'; end if;
        insert into public.shopping_items(workspace_id,name,quantity,unit,source,assistant_turn_id,created_by)
          values(p_workspace,v_name,(v_element->>'quantity')::numeric,nullif(trim(v_element->>'unit'),''),v_source,p_turn,public.current_user_id()) returning id into v_item;
        v_created := jsonb_set(v_created,'{shoppingItemIds}',(v_created->'shoppingItemIds') || jsonb_build_array(v_item));
      end loop;
    else
      v_name := trim(v_args->>'name');
      if coalesce(length(v_name),0) not between 1 and 160 then raise exception 'VALIDATION_ERROR'; end if;
      if v_args->>'quantity' is not null and (v_args->>'quantity')::numeric<=0 then raise exception 'VALIDATION_ERROR'; end if;
      insert into public.shopping_items(workspace_id,name,quantity,unit,source,assistant_turn_id,created_by)
        values(p_workspace,v_name,(v_args->>'quantity')::numeric,nullif(trim(v_args->>'unit'),''),v_source,p_turn,public.current_user_id()) returning id into v_item;
      v_created := jsonb_set(v_created,'{shoppingItemIds}',jsonb_build_array(v_item));
    end if;

  elsif v_action='inventory.patch' then
    v_product := (v_args->>'productId')::uuid;
    perform 1 from public.products where id=v_product and workspace_id=p_workspace and archived_at is null for update;
    if not found then raise exception 'NOT_FOUND'; end if;
    if v_args ? 'name' then
      v_name := trim(v_args->>'name'); if coalesce(length(v_name),0) not between 1 and 160 then raise exception 'VALIDATION_ERROR'; end if;
    end if;
    update public.products set name=coalesce(v_name,name),name_normalized=coalesce(lower(v_name),name_normalized),category=case when v_args ? 'category' then nullif(trim(v_args->>'category'),'') else category end,updated_at=now() where id=v_product;
    v_created := jsonb_set(v_created,'{productIds}',jsonb_build_array(v_product));

  elsif v_action='shopping.patch' then
    v_item := (v_args->>'itemId')::uuid;
    perform 1 from public.shopping_items where id=v_item and workspace_id=p_workspace for update;
    if not found then raise exception 'NOT_FOUND'; end if;
    if v_args ? 'status' and v_args->>'status' not in ('needed','bought','skipped') then raise exception 'VALIDATION_ERROR'; end if;
    if v_args ? 'name' and length(trim(v_args->>'name')) not between 1 and 160 then raise exception 'VALIDATION_ERROR'; end if;
    if v_args->>'quantity' is not null and (v_args->>'quantity')::numeric<=0 then raise exception 'VALIDATION_ERROR'; end if;
    update public.shopping_items set name=case when v_args ? 'name' then trim(v_args->>'name') else name end,
      quantity=case when v_args ? 'quantity' then (v_args->>'quantity')::numeric else quantity end,
      unit=case when v_args ? 'unit' then nullif(trim(v_args->>'unit'),'') else unit end,
      status=case when v_args ? 'status' then v_args->>'status' else status end,updated_at=now() where id=v_item;
    v_created := jsonb_set(v_created,'{shoppingItemIds}',jsonb_build_array(v_item));
  elsif v_action='inventory.set_expiry' then
    -- "Trong 5 gói mì có 2 gói hạn 20/10": đặt hạn cho 2 gói ĐÃ có, tách lô nếu chỉ một phần; không cộng thêm tồn kho.
    v_product := (v_args->>'productId')::uuid;
    if v_args->>'expiryDate' is null then raise exception 'VALIDATION_ERROR'; end if;
    v_date := (v_args->>'expiryDate')::date;
    perform 1 from public.products where id=v_product and workspace_id=p_workspace and archived_at is null for update;
    if not found then raise exception 'NOT_FOUND'; end if;
    select coalesce(sum(quantity) filter (where quantity_known),0),count(*) filter (where not quantity_known) into v_known_total,v_unknown
      from public.inventory_lots where workspace_id=p_workspace and product_id=v_product and quantity>0;
    if v_known_total=0 and v_unknown=0 then raise exception 'VALIDATION_ERROR'; end if;
    v_remaining := v_known_total;
    if nullif(trim(v_args->>'quantity'),'') is not null then
      v_qty := (v_args->>'quantity')::numeric;
      if v_qty<=0 or v_qty>v_known_total then raise exception 'VALIDATION_ERROR'; end if;
      v_remaining := v_qty; v_full := false;
    end if;
    -- Lô chưa có hạn trước, rồi tới lô hạn xa: phần "sắp hết hạn" thường là hàng cũ nhất.
    for v_lot_row in select * from public.inventory_lots where workspace_id=p_workspace and product_id=v_product and quantity>0 order by quantity_known desc,expiry_date desc nulls first,created_at,id for update loop
      if not v_lot_row.quantity_known then
        if v_full then update public.inventory_lots set expiry_date=v_date,updated_at=now() where id=v_lot_row.id; end if;
        continue;
      end if;
      continue when v_remaining<=0;
      v_taken := least(v_remaining,v_lot_row.quantity);
      if v_taken=v_lot_row.quantity then
        update public.inventory_lots set expiry_date=v_date,updated_at=now() where id=v_lot_row.id;
      else
        -- Phần tách ra giữ ngày nhập, nơi cất và (tỉ lệ) giá của lô gốc để không bị tính thành một lần mua mới.
        v_split_price := case when v_lot_row.price_vnd is null then null else round(v_lot_row.price_vnd*v_taken/v_lot_row.quantity)::bigint end;
        update public.inventory_lots set quantity=quantity-v_taken,price_vnd=case when v_split_price is null then price_vnd else price_vnd-v_split_price end,updated_at=now() where id=v_lot_row.id;
        insert into public.inventory_lots(workspace_id,product_id,quantity,unit,expiry_date,created_at,price_vnd,storage_location)
          values(p_workspace,v_product,v_taken,v_lot_row.unit,v_date,v_lot_row.created_at,v_split_price,v_lot_row.storage_location) returning id into v_lot;
        insert into public.inventory_transactions(workspace_id,product_id,lot_id,action,quantity_delta,source,assistant_turn_id,created_by)
          values(p_workspace,v_product,v_lot_row.id,'adjust',-v_taken,v_source,p_turn,public.current_user_id());
        insert into public.inventory_transactions(workspace_id,product_id,lot_id,action,quantity_delta,source,assistant_turn_id,created_by)
          values(p_workspace,v_product,v_lot,'adjust',v_taken,v_source,p_turn,public.current_user_id()) returning id into v_tx;
        v_created := jsonb_set(v_created,'{lotIds}',(v_created->'lotIds') || jsonb_build_array(v_lot));
        v_created := jsonb_set(v_created,'{transactionIds}',(v_created->'transactionIds') || jsonb_build_array(v_tx));
      end if;
      v_remaining := v_remaining-v_taken;
    end loop;
    v_created := jsonb_set(v_created,'{productIds}',jsonb_build_array(v_product));

  else
    raise exception 'VALIDATION_ERROR';
  end if;

  if p_operation='assistant.confirm' then
    update public.assistant_turns set status='committed',kind='write_committed',committed_at=now() where id=p_turn;
    v_result := jsonb_build_object('schemaVersion','1.0','turnId',p_turn,'kind','write_committed','ok',true,'created',v_created,'message','Đã lưu thay đổi.');
  else
    v_result := jsonb_build_object('ok',true,'created',v_created);
  end if;
  update public.idempotency_operations set result_json=v_result where workspace_id=p_workspace and idempotency_key=p_key;
  return v_result;
end; $$;
commit;
