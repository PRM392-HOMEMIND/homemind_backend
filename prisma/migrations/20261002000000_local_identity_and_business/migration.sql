-- Canonical local PostgreSQL schema. Owned by homemind_migrator, never the runtime role.
create table public.users (
 id uuid primary key default gen_random_uuid(), email text unique, phone text unique,
 password_hash text not null, status text not null default 'ACTIVE' check(status in ('ACTIVE','DISABLED','DELETED')),
 email_verified_at timestamptz, phone_verified_at timestamptz,
 password_changed_at timestamptz not null default now(), created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(), deleted_at timestamptz,
 constraint users_identifier_required check(email is not null or phone is not null),
 constraint users_email_normalized check(email is null or (email=lower(trim(email)) and length(email) between 3 and 254)),
 constraint users_phone_e164 check(phone is null or phone ~ '^\+[1-9][0-9]{6,14}$')
);
create table public.refresh_sessions (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users(id) on delete cascade,
 family_id uuid not null, token_hash text not null unique, expires_at timestamptz not null, revoked_at timestamptz,
 replaced_by_session_id uuid unique references public.refresh_sessions(id), user_agent text, ip text, created_at timestamptz not null default now()
);
create index refresh_sessions_user_id_family_id_idx on public.refresh_sessions(user_id,family_id);
create table public.password_reset_tokens (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users(id) on delete cascade,
 token_hash text not null unique, expires_at timestamptz not null, used_at timestamptz, created_at timestamptz not null default now()
);
create index password_reset_tokens_user_id_idx on public.password_reset_tokens(user_id);
create function public.current_user_id() returns uuid language sql stable set search_path='' as $$
 select nullif(current_setting('app.user_id',true),'')::uuid;
$$;

create table public.profiles (
  id uuid primary key references public.users(id) on delete cascade,
  display_name text not null check (length(trim(display_name)) between 1 and 120),
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  archived_at timestamptz,
  type text not null default 'household' check (type in ('household','store')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  role text not null check (role in ('owner','member')),
  created_at timestamptz not null default now(),
  unique(workspace_id,user_id)
);
create index workspace_members_user_idx on public.workspace_members(user_id);
create table public.notification_preferences (
  user_id uuid primary key references public.users(id) on delete cascade,
  fresh_days_before int not null default 5 check (fresh_days_before between 0 and 365),
  dry_days_before int not null default 30 check (dry_days_before between 0 and 365),
  push_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);
create table public.workspace_entitlements (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free','personal','family','micro_pos')),
  product_limit int default 30 check (product_limit is null or product_limit > 0),
  updated_at timestamptz not null default now()
);
create table public.products (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 160),
  name_normalized text not null,
  category text,
  default_unit text,
  status text not null default 'in_stock' check (status in ('in_stock','out')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique(workspace_id,id)
);
create unique index products_active_name_idx on public.products(workspace_id,name_normalized) where archived_at is null;
create index products_workspace_status_idx on public.products(workspace_id,status);
create table public.inventory_lots (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null,
  quantity numeric(12,3) not null check (quantity >= 0),
  unit text not null,
  expiry_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id,id),
  foreign key(workspace_id,product_id) references public.products(workspace_id,id)
);
create index inventory_lots_expiry_idx on public.inventory_lots(workspace_id,expiry_date) where quantity > 0;
create table public.assistant_turns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.users(id),
  raw_input text not null,
  corrected_input text,
  kind text not null check (kind in ('read_result','write_draft','write_committed','clarify','unknown','cancelled')),
  tools_json jsonb not null default '[]'::jsonb,
  data_json jsonb,
  draft_json jsonb,
  message text,
  status text not null check (status in ('completed','pending_confirmation','committed','cancelled','failed')),
  processing_time_ms int,
  dictionary_version text not null default '1.1.0',
  error_code text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  committed_at timestamptz,
  unique(workspace_id,id),
  foreign key(workspace_id,user_id) references public.workspace_members(workspace_id,user_id)
);
create index assistant_turns_workspace_created_idx on public.assistant_turns(workspace_id,created_at desc);
create table public.inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  product_id uuid not null,
  lot_id uuid,
  action text not null check (action in ('receive','consume','adjust','discard')),
  quantity_delta numeric(12,3) not null check (quantity_delta <> 0),
  source text not null check (source in ('manual','voice','assistant','repurchase')),
  assistant_turn_id uuid,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  foreign key(workspace_id,product_id) references public.products(workspace_id,id),
  foreign key(workspace_id,lot_id) references public.inventory_lots(workspace_id,id),
  foreign key(workspace_id,assistant_turn_id) references public.assistant_turns(workspace_id,id)
);
create index inventory_tx_workspace_created_idx on public.inventory_transactions(workspace_id,created_at desc);
create table public.shopping_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 160),
  quantity numeric(12,3) check (quantity is null or quantity > 0),
  unit text,
  status text not null default 'needed' check (status in ('needed','bought','skipped')),
  source text not null default 'manual' check (source in ('manual','voice','assistant','repurchase')),
  linked_product_id uuid,
  assistant_turn_id uuid,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id,id),
  foreign key(workspace_id,linked_product_id) references public.products(workspace_id,id),
  foreign key(workspace_id,assistant_turn_id) references public.assistant_turns(workspace_id,id)
);
create index shopping_items_workspace_status_idx on public.shopping_items(workspace_id,status);
create table public.idempotency_operations (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  idempotency_key uuid not null,
  user_id uuid not null references public.users(id),
  operation text not null,
  payload_hash text not null,
  result_json jsonb,
  created_at timestamptz not null default now(),
  primary key(workspace_id,idempotency_key)
);

create or replace function public.is_workspace_member(p_workspace uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.workspace_members m where m.workspace_id=p_workspace and m.user_id=public.current_user_id() and exists(select 1 from public.workspaces w where w.id=p_workspace and w.archived_at is null) and exists(select 1 from public.users u where u.id=m.user_id and u.status='ACTIVE'));
$$;
revoke all on function public.is_workspace_member(uuid) from public;
grant execute on function public.is_workspace_member(uuid) to homemind_app;

do $$ declare t text; begin
  foreach t in array array['profiles','workspaces','workspace_members','notification_preferences','workspace_entitlements','products','inventory_lots','inventory_transactions','shopping_items','assistant_turns','idempotency_operations'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,homemind_app',t);
  end loop;
end $$;
grant select on public.profiles,public.workspaces,public.workspace_members,public.notification_preferences,public.workspace_entitlements,public.products,public.inventory_lots,public.inventory_transactions,public.shopping_items,public.assistant_turns to homemind_app;
create policy profiles_own on public.profiles for select to homemind_app using(id=public.current_user_id());
create policy preferences_own on public.notification_preferences for select to homemind_app using(user_id=public.current_user_id());
create policy members_own on public.workspace_members for select to homemind_app using(user_id=public.current_user_id());
create policy workspaces_member on public.workspaces for select to homemind_app using(public.is_workspace_member(id));
create policy entitlements_member on public.workspace_entitlements for select to homemind_app using(public.is_workspace_member(workspace_id));
create policy products_member on public.products for select to homemind_app using(public.is_workspace_member(workspace_id));
create policy lots_member on public.inventory_lots for select to homemind_app using(public.is_workspace_member(workspace_id));
create policy transactions_member on public.inventory_transactions for select to homemind_app using(public.is_workspace_member(workspace_id));
create policy shopping_member on public.shopping_items for select to homemind_app using(public.is_workspace_member(workspace_id));
create policy turns_owner on public.assistant_turns for select to homemind_app using(user_id=public.current_user_id() and public.is_workspace_member(workspace_id));

create or replace function public.create_assistant_turn(p_workspace uuid,p_raw text,p_corrected text,p_kind text,p_tools jsonb,p_data jsonb,p_draft jsonb,p_message text,p_ms int)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if public.current_user_id() is null or not public.is_workspace_member(p_workspace) then raise exception 'FORBIDDEN'; end if;
  if length(trim(p_raw)) not between 1 and 2000 or p_kind not in ('read_result','write_draft','clarify','unknown') or jsonb_typeof(p_tools)<>'array' then raise exception 'VALIDATION_ERROR'; end if;
  insert into public.assistant_turns(workspace_id,user_id,raw_input,corrected_input,kind,tools_json,data_json,draft_json,message,status,processing_time_ms,expires_at)
  values(p_workspace,public.current_user_id(),p_raw,p_corrected,p_kind,p_tools,p_data,p_draft,p_message,case when p_kind='write_draft' then 'pending_confirmation' else 'completed' end,p_ms,case when p_kind='write_draft' then now()+interval '15 minutes' end)
  returning id into v_id;
  return v_id;
end; $$;
revoke all on function public.create_assistant_turn(uuid,text,text,text,jsonb,jsonb,jsonb,text,int) from public;
grant execute on function public.create_assistant_turn(uuid,text,text,text,jsonb,jsonb,jsonb,text,int) to homemind_app;

create or replace function public.cancel_assistant_turn(p_turn uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count int;
begin
  update public.assistant_turns set status='cancelled',kind='cancelled' where id=p_turn and user_id=public.current_user_id() and status='pending_confirmation' and public.is_workspace_member(workspace_id);
  get diagnostics v_count = row_count;
  return v_count=1;
end; $$;
revoke all on function public.cancel_assistant_turn(uuid) from public;
grant execute on function public.cancel_assistant_turn(uuid) to homemind_app;

create or replace function public.apply_operation(p_workspace uuid,p_key uuid,p_operation text,p_payload jsonb,p_turn uuid default null)
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
    if v_action not in ('inventory.add','inventory.mark_out','shopping.add') or v_action<>v_turn.tools_json->0->>'toolId' then raise exception 'VALIDATION_ERROR'; end if;
    v_args := p_payload->'tools'->0->'arguments';
    if jsonb_typeof(v_args)<>'object' then raise exception 'VALIDATION_ERROR'; end if;
    -- Only editable fields may differ; server validates all resulting values again below.
    if v_action='inventory.mark_out' and v_args->>'productId' is distinct from v_turn.tools_json->0->'arguments'->>'productId' then raise exception 'VALIDATION_ERROR'; end if;
    v_source := 'voice';
  elsif p_turn is not null then
    raise exception 'VALIDATION_ERROR';
  end if;

  if v_action='inventory.add' then
    v_name := trim(v_args->>'productName'); v_unit := trim(v_args->>'unit');
    if coalesce(length(v_name),0) not between 1 and 160 or coalesce(length(v_unit),0) not between 1 and 40 or (v_args->>'quantity') is null then raise exception 'VALIDATION_ERROR'; end if;
    v_qty := (v_args->>'quantity')::numeric;
    if v_qty<=0 or v_qty>999999999 then raise exception 'VALIDATION_ERROR'; end if;
    if v_args->>'expiryDate' is not null then perform (v_args->>'expiryDate')::date; end if;
    if v_args->>'productCandidateId' is not null then
      v_product := (v_args->>'productCandidateId')::uuid;
      perform 1 from public.products where workspace_id=p_workspace and id=v_product and archived_at is null and default_unit=v_unit for update;
      if not found then raise exception 'VALIDATION_ERROR'; end if;
    else
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace::text || ':' || lower(v_name),0));
      select id into v_product from public.products where workspace_id=p_workspace and name_normalized=lower(v_name) and archived_at is null for update;
      if v_product is null then
        insert into public.products(workspace_id,name,name_normalized,category,default_unit) values(p_workspace,v_name,lower(v_name),nullif(trim(v_args->>'category'),''),v_unit) returning id into v_product;
      else
        perform 1 from public.products where id=v_product and default_unit=v_unit;
        if not found then raise exception 'VALIDATION_ERROR'; end if;
        update public.products set status='in_stock',updated_at=now() where id=v_product;
      end if;
    end if;
    insert into public.inventory_lots(workspace_id,product_id,quantity,unit,expiry_date) values(p_workspace,v_product,v_qty,v_unit,(v_args->>'expiryDate')::date) returning id into v_lot;
    insert into public.inventory_transactions(workspace_id,product_id,lot_id,action,quantity_delta,source,assistant_turn_id,created_by)
      values(p_workspace,v_product,v_lot,'receive',v_qty,v_source,p_turn,public.current_user_id()) returning id into v_tx;
    update public.products set status='in_stock',updated_at=now() where id=v_product;
    v_created := jsonb_build_object('productIds',jsonb_build_array(v_product),'lotIds',jsonb_build_array(v_lot),'transactionIds',jsonb_build_array(v_tx),'shoppingItemIds','[]'::jsonb);

  elsif v_action='inventory.mark_out' then
    v_product := (v_args->>'productId')::uuid;
    perform 1 from public.products where id=v_product and workspace_id=p_workspace and archived_at is null for update;
    if not found then raise exception 'NOT_FOUND'; end if;
    select coalesce(sum(quantity),0) into v_remaining from public.inventory_lots where workspace_id=p_workspace and product_id=v_product and quantity>0;
    if v_remaining=0 then raise exception 'VALIDATION_ERROR'; end if;
    if v_args->>'quantity' is not null then
      v_qty := (v_args->>'quantity')::numeric;
      if v_qty<=0 or v_qty>v_remaining then raise exception 'VALIDATION_ERROR'; end if;
      v_remaining := v_qty;
    end if;
    for v_lot_row in select id,quantity from public.inventory_lots where workspace_id=p_workspace and product_id=v_product and quantity>0 order by expiry_date asc nulls last,created_at,id for update loop
      exit when v_remaining<=0;
      v_taken := least(v_remaining,v_lot_row.quantity);
      update public.inventory_lots set quantity=quantity-v_taken,updated_at=now() where id=v_lot_row.id;
      insert into public.inventory_transactions(workspace_id,product_id,lot_id,action,quantity_delta,source,assistant_turn_id,created_by)
        values(p_workspace,v_product,v_lot_row.id,'consume',-v_taken,v_source,p_turn,public.current_user_id()) returning id into v_tx;
      v_created := jsonb_set(v_created,'{transactionIds}',(v_created->'transactionIds') || jsonb_build_array(v_tx));
      v_remaining := v_remaining-v_taken;
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
revoke all on function public.apply_operation(uuid,uuid,text,jsonb,uuid) from public;
grant execute on function public.apply_operation(uuid,uuid,text,jsonb,uuid) to homemind_app;

create table public.notification_reads (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  notification_key text not null check (length(notification_key) between 1 and 300),
  read_at timestamptz not null default now(),
  primary key (workspace_id, user_id, notification_key),
  foreign key (workspace_id, user_id)
    references public.workspace_members(workspace_id, user_id) on delete cascade
);

create index notification_reads_user_idx
  on public.notification_reads(user_id, read_at desc);

alter table public.notification_reads enable row level security;
revoke all on public.notification_reads from public, homemind_app;
grant select, insert, update on public.notification_reads to homemind_app;

create policy notification_reads_own_select
  on public.notification_reads for select to homemind_app
  using (user_id = public.current_user_id() and public.is_workspace_member(workspace_id));

create policy notification_reads_own_insert
  on public.notification_reads for insert to homemind_app
  with check (user_id = public.current_user_id() and public.is_workspace_member(workspace_id));

create policy notification_reads_own_update
  on public.notification_reads for update to homemind_app
  using (user_id = public.current_user_id() and public.is_workspace_member(workspace_id))
  with check (user_id = public.current_user_id() and public.is_workspace_member(workspace_id));

-- Cho người dùng tự cập nhật địa chỉ và ngôn ngữ giao diện. Chỉ thêm cột, không đổi dữ liệu cũ.
alter table public.profiles
  add column if not exists address text,
  add column if not exists language text not null default 'vi';

alter table public.profiles
  drop constraint if exists profiles_address_len,
  drop constraint if exists profiles_language_check,
  drop constraint if exists profiles_phone_len;
alter table public.profiles
  add constraint profiles_address_len check (address is null or length(trim(address)) <= 300),
  add constraint profiles_language_check check (language in ('vi','en')),
  add constraint profiles_phone_len check (phone is null or length(trim(phone)) <= 20);

-- Ghi nhận yêu cầu nâng cấp gói của người dùng (chưa có cổng thanh toán: đội ngũ liên hệ lại).
-- Chỉ thêm bảng mới; không đổi dữ liệu cũ. Chỉ backend (quyền owner) đọc/ghi, không mở RLS cho client.
create table if not exists public.upgrade_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  plan text not null check (plan in ('personal', 'family', 'micro_pos')),
  source text not null default 'unknown' check (length(source) <= 40),
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id, plan)
);

create index if not exists upgrade_requests_created_idx on public.upgrade_requests (created_at desc);

alter table public.upgrade_requests enable row level security;
-- Không tạo policy nào: role authenticated/anon không truy cập được bảng này.
revoke all on public.upgrade_requests from public, homemind_app;


-- Runtime credentials never own tables, create roles or bypass RLS.
revoke create on schema public from public;
grant usage on schema public to homemind_app;
revoke all on all tables in schema public from public;
grant select,insert,update on public.users,public.refresh_sessions,public.password_reset_tokens to homemind_app;
grant update on public.profiles to homemind_app;
create policy profiles_own_update on public.profiles for update to homemind_app
 using(id=public.current_user_id()) with check(id=public.current_user_id());
grant select,insert on public.upgrade_requests to homemind_app;
create policy upgrade_requests_own_select on public.upgrade_requests for select to homemind_app
 using(user_id=public.current_user_id() and public.is_workspace_member(workspace_id));
create policy upgrade_requests_own_insert on public.upgrade_requests for insert to homemind_app
 with check(user_id=public.current_user_id() and public.is_workspace_member(workspace_id));
revoke all on all functions in schema public from public;
grant execute on function public.current_user_id() to homemind_app;

create function public.provision_home(p_user uuid,p_name text,p_type text default 'household')
returns uuid language plpgsql security definer set search_path='' as $$
declare v_workspace uuid;
begin
 if p_user is distinct from public.current_user_id() or not exists(select 1 from public.users where id=p_user and status='ACTIVE') then raise exception 'FORBIDDEN'; end if;
 if p_type not in ('household','store') or length(trim(p_name)) not between 1 and 120 then raise exception 'VALIDATION_ERROR'; end if;
 insert into public.profiles(id,display_name) values(p_user,trim(p_name)) on conflict do nothing;
 insert into public.notification_preferences(user_id) values(p_user) on conflict do nothing;
 select workspace_id into v_workspace from public.workspace_members where user_id=p_user and role='owner' order by created_at limit 1;
 if v_workspace is null then
   insert into public.workspaces(name,type) values(left(case when p_type='store' then 'C?a h?ng ' else 'Nh? ' end || trim(p_name),120),p_type) returning id into v_workspace;
   insert into public.workspace_members(workspace_id,user_id,role) values(v_workspace,p_user,'owner');
   insert into public.workspace_entitlements(workspace_id) values(v_workspace);
 end if;
 return v_workspace;
end; $$;
revoke all on function public.provision_home(uuid,text,text) from public;
grant execute on function public.provision_home(uuid,text,text) to homemind_app;

-- A sole owner may archive a private workspace. Shared workspaces need an active successor.
create function public.close_account_workspaces(p_user uuid) returns void
language plpgsql security definer set search_path='' as $$
declare w record;
begin
 if p_user is distinct from public.current_user_id() then raise exception 'FORBIDDEN'; end if;
 for w in select workspace_id from public.workspace_members where user_id=p_user and role='owner' order by workspace_id loop
   perform 1 from public.workspaces where id=w.workspace_id for update;
   if not exists(select 1 from public.workspace_members m join public.users u on u.id=m.user_id where m.workspace_id=w.workspace_id and m.role='owner' and m.user_id<>p_user and u.status='ACTIVE') then
     if exists(select 1 from public.workspace_members m join public.users u on u.id=m.user_id where m.workspace_id=w.workspace_id and m.user_id<>p_user and u.status='ACTIVE') then
       raise exception 'OWNER_TRANSFER_REQUIRED';
     end if;
     update public.workspaces set archived_at=now(),updated_at=now() where id=w.workspace_id;
   end if;
 end loop;
end; $$;
revoke all on function public.close_account_workspaces(uuid) from public;
grant execute on function public.close_account_workspaces(uuid) to homemind_app;

grant execute on function public.is_workspace_member(uuid),public.apply_operation(uuid,uuid,text,jsonb,uuid),public.create_assistant_turn(uuid,text,text,text,jsonb,jsonb,jsonb,text,int),public.cancel_assistant_turn(uuid) to homemind_app;
