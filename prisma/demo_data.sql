-- Dữ liệu demo có thể chạy lặp lại cho hai tài khoản HomeMind.
-- Không xóa dữ liệu người dùng đã tạo; các bản ghi demo dùng UUID cố định.
do $demo$
declare
  personal_workspace uuid;
  store_workspace uuid;
begin
  select workspace_id into personal_workspace
  from public.workspace_members
  where user_id = '11111111-1111-4111-8111-111111111111'
  order by created_at
  limit 1;

  select workspace_id into store_workspace
  from public.workspace_members
  where user_id = '22222222-2222-4222-8222-222222222222'
  order by created_at
  limit 1;

  if personal_workspace is null or store_workspace is null then
    raise exception 'Chưa có workspace demo. Hãy chạy npm run db:demo:seed trước.';
  end if;

  insert into public.products (
    workspace_id, name, name_normalized, category, default_unit, status
  )
  select personal_workspace, v.name, v.name_normalized, v.category, v.unit, v.status
  from (values
    ('Sữa chua Vinamilk', 'sữa chua vinamilk', 'Sữa & bơ', 'hộp', 'in_stock'),
    ('Sữa tươi TH True Milk', 'sữa tươi th true milk', 'Sữa & bơ', 'hộp', 'in_stock'),
    ('Trứng gà', 'trứng gà', 'Thực phẩm', 'quả', 'out'),
    ('Thịt heo ba rọi', 'thịt heo ba rọi', 'Thịt & cá', 'kg', 'in_stock'),
    ('Cá hồi phi lê', 'cá hồi phi lê', 'Thịt & cá', 'kg', 'in_stock'),
    ('Rau cải xanh', 'rau cải xanh', 'Rau củ', 'bó', 'in_stock'),
    ('Cà chua', 'cà chua', 'Rau củ', 'kg', 'in_stock'),
    ('Gạo ST25', 'gạo st25', 'Lương thực', 'kg', 'in_stock'),
    ('Nước mắm Nam Ngư', 'nước mắm nam ngư', 'Gia vị', 'chai', 'in_stock'),
    ('Dầu ăn Simply', 'dầu ăn simply', 'Gia vị', 'chai', 'in_stock'),
    ('Mì Hảo Hảo tôm chua cay', 'mì hảo hảo tôm chua cay', 'Mì & đồ khô', 'gói', 'in_stock'),
    ('Bột giặt OMO', 'bột giặt omo', 'Gia dụng', 'túi', 'in_stock'),
    ('Nước rửa chén Sunlight', 'nước rửa chén sunlight', 'Gia dụng', 'chai', 'in_stock'),
    ('Giấy vệ sinh Pulppy', 'giấy vệ sinh pulppy', 'Gia dụng', 'cuộn', 'in_stock'),
    ('Kem đánh răng P/S', 'kem đánh răng p/s', 'Chăm sóc cá nhân', 'tuýp', 'in_stock'),
    ('Cà phê Trung Nguyên', 'cà phê trung nguyên', 'Đồ uống', 'gói', 'in_stock'),
    ('Phô mai Con Bò Cười', 'phô mai con bò cười', 'Sữa & bơ', 'miếng', 'in_stock'),
    ('Bánh mì sandwich', 'bánh mì sandwich', 'Bánh kẹo', 'gói', 'out')
  ) as v(name, name_normalized, category, unit, status)
  on conflict (workspace_id, name_normalized) where archived_at is null
  do nothing;

  insert into public.products (
    workspace_id, name, name_normalized, category, default_unit, status
  )
  select store_workspace, v.name, v.name_normalized, v.category, v.unit, v.status
  from (values
    ('Nước mắm Nam Ngư 500ml', 'nước mắm nam ngư 500ml', 'Gia vị', 'chai', 'in_stock'),
    ('Dầu ăn Tường An 1L', 'dầu ăn tường an 1l', 'Gia vị', 'chai', 'in_stock'),
    ('Đường Biên Hòa 1kg', 'đường biên hòa 1kg', 'Gia vị', 'gói', 'in_stock'),
    ('Muối i-ốt 500g', 'muối i-ốt 500g', 'Gia vị', 'gói', 'out'),
    ('Bột ngọt Ajinomoto 400g', 'bột ngọt ajinomoto 400g', 'Gia vị', 'gói', 'in_stock'),
    ('Gạo ST25 túi 5kg', 'gạo st25 túi 5kg', 'Gạo & ngũ cốc', 'túi', 'in_stock'),
    ('Mì Hảo Hảo tôm chua cay', 'mì hảo hảo tôm chua cay', 'Mì & đồ khô', 'gói', 'in_stock'),
    ('Mì Omachi sườn hầm ngũ quả', 'mì omachi sườn hầm ngũ quả', 'Mì & đồ khô', 'gói', 'in_stock'),
    ('Coca-Cola lon 320ml', 'coca-cola lon 320ml', 'Nước giải khát', 'lon', 'in_stock'),
    ('Pepsi lon 320ml', 'pepsi lon 320ml', 'Nước giải khát', 'lon', 'in_stock'),
    ('Nước suối Aquafina 500ml', 'nước suối aquafina 500ml', 'Nước giải khát', 'chai', 'in_stock'),
    ('Sữa tươi Vinamilk 220ml', 'sữa tươi vinamilk 220ml', 'Sữa & bơ', 'hộp', 'in_stock'),
    ('Sữa đặc Ông Thọ 380g', 'sữa đặc ông thọ 380g', 'Sữa & bơ', 'lon', 'in_stock'),
    ('Bánh Oreo vani 133g', 'bánh oreo vani 133g', 'Bánh kẹo', 'gói', 'in_stock'),
    ('Snack Oishi tôm cay', 'snack oishi tôm cay', 'Bánh kẹo', 'gói', 'in_stock'),
    ('Xúc xích tiệt trùng CP', 'xúc xích tiệt trùng cp', 'Thực phẩm', 'gói', 'in_stock'),
    ('Trứng gà hộp 10 quả', 'trứng gà hộp 10 quả', 'Thực phẩm', 'hộp', 'in_stock'),
    ('Nước rửa chén Sunlight 750g', 'nước rửa chén sunlight 750g', 'Hóa phẩm', 'chai', 'in_stock'),
    ('Bột giặt OMO 800g', 'bột giặt omo 800g', 'Hóa phẩm', 'túi', 'in_stock'),
    ('Dầu gội Clear 630g', 'dầu gội clear 630g', 'Chăm sóc cá nhân', 'chai', 'in_stock'),
    ('Kem đánh răng P/S 180g', 'kem đánh răng p/s 180g', 'Chăm sóc cá nhân', 'tuýp', 'in_stock'),
    ('Giấy vệ sinh Pulppy 10 cuộn', 'giấy vệ sinh pulppy 10 cuộn', 'Gia dụng', 'lốc', 'in_stock'),
    ('Pin Con Thỏ AA vỉ 4 viên', 'pin con thỏ aa vỉ 4 viên', 'Gia dụng', 'vỉ', 'in_stock'),
    ('Khẩu trang y tế hộp 50 cái', 'khẩu trang y tế hộp 50 cái', 'Gia dụng', 'hộp', 'in_stock'),
    ('Cà phê G7 hộp 21 gói', 'cà phê g7 hộp 21 gói', 'Đồ uống', 'hộp', 'in_stock'),
    ('Trà xanh C2 chai 455ml', 'trà xanh c2 chai 455ml', 'Nước giải khát', 'chai', 'in_stock'),
    ('Bia Saigon Lager lon 330ml', 'bia saigon lager lon 330ml', 'Nước giải khát', 'lon', 'in_stock'),
    ('Nước tương Chinsu 500ml', 'nước tương chinsu 500ml', 'Gia vị', 'chai', 'in_stock'),
    ('Tương ớt Chinsu 250g', 'tương ớt chinsu 250g', 'Gia vị', 'chai', 'in_stock'),
    ('Bánh mì sandwich Kinh Đô', 'bánh mì sandwich kinh đô', 'Bánh kẹo', 'gói', 'out')
  ) as v(name, name_normalized, category, unit, status)
  on conflict (workspace_id, name_normalized) where archived_at is null
  do nothing;

  insert into public.inventory_lots (
    id, workspace_id, product_id, quantity, unit, expiry_date
  )
  select
    v.id::uuid,
    personal_workspace,
    p.id,
    v.quantity,
    v.unit,
    case when v.expiry_days is null then null else current_date + v.expiry_days end
  from (values
    ('a2000000-0000-4000-8000-000000000001', 'sữa chua vinamilk', 6.0, 'hộp', 4),
    ('a2000000-0000-4000-8000-000000000002', 'sữa tươi th true milk', 4.0, 'hộp', 8),
    ('a2000000-0000-4000-8000-000000000004', 'thịt heo ba rọi', 1.2, 'kg', 2),
    ('a2000000-0000-4000-8000-000000000005', 'cá hồi phi lê', 0.6, 'kg', 1),
    ('a2000000-0000-4000-8000-000000000006', 'rau cải xanh', 2.0, 'bó', 3),
    ('a2000000-0000-4000-8000-000000000007', 'cà chua', 1.5, 'kg', 5),
    ('a2000000-0000-4000-8000-000000000008', 'gạo st25', 8.0, 'kg', 180),
    ('a2000000-0000-4000-8000-000000000009', 'nước mắm nam ngư', 2.0, 'chai', 240),
    ('a2000000-0000-4000-8000-000000000010', 'dầu ăn simply', 1.0, 'chai', 120),
    ('a2000000-0000-4000-8000-000000000011', 'mì hảo hảo tôm chua cay', 12.0, 'gói', 200),
    ('a2000000-0000-4000-8000-000000000012', 'bột giặt omo', 1.0, 'túi', null),
    ('a2000000-0000-4000-8000-000000000013', 'nước rửa chén sunlight', 2.0, 'chai', null),
    ('a2000000-0000-4000-8000-000000000014', 'giấy vệ sinh pulppy', 8.0, 'cuộn', null),
    ('a2000000-0000-4000-8000-000000000015', 'kem đánh răng p/s', 2.0, 'tuýp', 365),
    ('a2000000-0000-4000-8000-000000000016', 'cà phê trung nguyên', 1.0, 'gói', 90),
    ('a2000000-0000-4000-8000-000000000017', 'phô mai con bò cười', 5.0, 'miếng', -1)
  ) as v(id, name_normalized, quantity, unit, expiry_days)
  join public.products p
    on p.workspace_id = personal_workspace
    and p.name_normalized = v.name_normalized
    and p.archived_at is null
  on conflict (id) do nothing;

  insert into public.inventory_lots (
    id, workspace_id, product_id, quantity, unit, expiry_date
  )
  select
    v.id::uuid,
    store_workspace,
    p.id,
    v.quantity,
    v.unit,
    case when v.expiry_days is null then null else current_date + v.expiry_days end
  from (values
    ('b2000000-0000-4000-8000-000000000001', 'nước mắm nam ngư 500ml', 24.0, 'chai', 300),
    ('b2000000-0000-4000-8000-000000000002', 'dầu ăn tường an 1l', 18.0, 'chai', 240),
    ('b2000000-0000-4000-8000-000000000003', 'đường biên hòa 1kg', 30.0, 'gói', 365),
    ('b2000000-0000-4000-8000-000000000005', 'bột ngọt ajinomoto 400g', 16.0, 'gói', 300),
    ('b2000000-0000-4000-8000-000000000006', 'gạo st25 túi 5kg', 12.0, 'túi', 240),
    ('b2000000-0000-4000-8000-000000000007', 'mì hảo hảo tôm chua cay', 80.0, 'gói', 120),
    ('b2000000-0000-4000-8000-000000000008', 'mì omachi sườn hầm ngũ quả', 42.0, 'gói', 90),
    ('b2000000-0000-4000-8000-000000000009', 'coca-cola lon 320ml', 48.0, 'lon', 180),
    ('b2000000-0000-4000-8000-000000000010', 'pepsi lon 320ml', 36.0, 'lon', 180),
    ('b2000000-0000-4000-8000-000000000011', 'nước suối aquafina 500ml', 72.0, 'chai', 365),
    ('b2000000-0000-4000-8000-000000000012', 'sữa tươi vinamilk 220ml', 20.0, 'hộp', 4),
    ('b2000000-0000-4000-8000-000000000013', 'sữa đặc ông thọ 380g', 15.0, 'lon', 150),
    ('b2000000-0000-4000-8000-000000000014', 'bánh oreo vani 133g', 22.0, 'gói', 30),
    ('b2000000-0000-4000-8000-000000000015', 'snack oishi tôm cay', 35.0, 'gói', 15),
    ('b2000000-0000-4000-8000-000000000016', 'xúc xích tiệt trùng cp', 9.0, 'gói', 2),
    ('b2000000-0000-4000-8000-000000000017', 'trứng gà hộp 10 quả', 8.0, 'hộp', 7),
    ('b2000000-0000-4000-8000-000000000018', 'nước rửa chén sunlight 750g', 14.0, 'chai', null),
    ('b2000000-0000-4000-8000-000000000019', 'bột giặt omo 800g', 11.0, 'túi', null),
    ('b2000000-0000-4000-8000-000000000020', 'dầu gội clear 630g', 7.0, 'chai', null),
    ('b2000000-0000-4000-8000-000000000021', 'kem đánh răng p/s 180g', 13.0, 'tuýp', 500),
    ('b2000000-0000-4000-8000-000000000022', 'giấy vệ sinh pulppy 10 cuộn', 10.0, 'lốc', null),
    ('b2000000-0000-4000-8000-000000000023', 'pin con thỏ aa vỉ 4 viên', 18.0, 'vỉ', null),
    ('b2000000-0000-4000-8000-000000000024', 'khẩu trang y tế hộp 50 cái', 6.0, 'hộp', 730),
    ('b2000000-0000-4000-8000-000000000025', 'cà phê g7 hộp 21 gói', 17.0, 'hộp', 210),
    ('b2000000-0000-4000-8000-000000000026', 'trà xanh c2 chai 455ml', 28.0, 'chai', 60),
    ('b2000000-0000-4000-8000-000000000027', 'bia saigon lager lon 330ml', 48.0, 'lon', 180),
    ('b2000000-0000-4000-8000-000000000028', 'nước tương chinsu 500ml', 12.0, 'chai', 240),
    ('b2000000-0000-4000-8000-000000000029', 'tương ớt chinsu 250g', 10.0, 'chai', -3)
  ) as v(id, name_normalized, quantity, unit, expiry_days)
  join public.products p
    on p.workspace_id = store_workspace
    and p.name_normalized = v.name_normalized
    and p.archived_at is null
  on conflict (id) do nothing;

  insert into public.inventory_transactions (
    id, workspace_id, product_id, lot_id, action, quantity_delta, source, created_by
  )
  select
    ('a3' || substr(l.id::text, 3))::uuid,
    personal_workspace,
    l.product_id,
    l.id,
    'receive',
    l.quantity,
    'manual',
    '11111111-1111-4111-8111-111111111111'::uuid
  from public.inventory_lots l
  where l.workspace_id = personal_workspace
    and l.id::text like 'a2000000-%' and l.quantity > 0
  on conflict (id) do nothing;

  insert into public.inventory_transactions (
    id, workspace_id, product_id, lot_id, action, quantity_delta, source, created_by
  )
  select
    ('b3' || substr(l.id::text, 3))::uuid,
    store_workspace,
    l.product_id,
    l.id,
    'receive',
    l.quantity,
    'manual',
    '22222222-2222-4222-8222-222222222222'::uuid
  from public.inventory_lots l
  where l.workspace_id = store_workspace
    and l.id::text like 'b2000000-%' and l.quantity > 0
  on conflict (id) do nothing;

  insert into public.shopping_items (
    id, workspace_id, name, quantity, unit, status, source, linked_product_id, created_by
  )
  select v.id::uuid, personal_workspace, v.name, v.quantity, v.unit, 'needed',
    'repurchase', p.id, '11111111-1111-4111-8111-111111111111'::uuid
  from (values
    ('a4000000-0000-4000-8000-000000000001', 'Trứng gà', 'trứng gà', 10.0, 'quả'),
    ('a4000000-0000-4000-8000-000000000002', 'Bánh mì sandwich', 'bánh mì sandwich', 2.0, 'gói'),
    ('a4000000-0000-4000-8000-000000000003', 'Chuối', null, 1.0, 'nải'),
    ('a4000000-0000-4000-8000-000000000004', 'Nước suối', null, 1.0, 'thùng'),
    ('a4000000-0000-4000-8000-000000000005', 'Khăn giấy', null, 3.0, 'hộp')
  ) as v(id, name, name_normalized, quantity, unit)
  left join public.products p
    on p.workspace_id = personal_workspace
    and p.name_normalized = v.name_normalized
    and p.archived_at is null
  on conflict (id) do nothing;

  insert into public.shopping_items (
    id, workspace_id, name, quantity, unit, status, source, linked_product_id, created_by
  )
  select v.id::uuid, store_workspace, v.name, v.quantity, v.unit, 'needed',
    'repurchase', p.id, '22222222-2222-4222-8222-222222222222'::uuid
  from (values
    ('b4000000-0000-4000-8000-000000000001', 'Muối i-ốt 500g', 'muối i-ốt 500g', 20.0, 'gói'),
    ('b4000000-0000-4000-8000-000000000002', 'Bánh mì sandwich Kinh Đô', 'bánh mì sandwich kinh đô', 15.0, 'gói'),
    ('b4000000-0000-4000-8000-000000000003', 'Sữa chua Vinamilk lốc 4', null, 12.0, 'lốc'),
    ('b4000000-0000-4000-8000-000000000004', 'Nước ngọt 7Up lon', null, 24.0, 'lon'),
    ('b4000000-0000-4000-8000-000000000005', 'Túi rác tự hủy', null, 10.0, 'cuộn')
  ) as v(id, name, name_normalized, quantity, unit)
  left join public.products p
    on p.workspace_id = store_workspace
    and p.name_normalized = v.name_normalized
    and p.archived_at is null
  on conflict (id) do nothing;
end
$demo$;
