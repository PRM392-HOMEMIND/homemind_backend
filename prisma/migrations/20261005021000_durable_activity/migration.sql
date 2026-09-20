begin;
create table public.notification_outbox (
 id uuid primary key default gen_random_uuid(), event_key text not null check(length(event_key)<=240),
 recipient_id uuid not null references public.users(id) on delete cascade,
 workspace_id uuid references public.workspaces(id) on delete cascade, financial boolean not null default false,
 kind text not null check(length(kind)<=80), title text not null check(length(title) between 1 and 120),
 summary text not null check(length(summary)<=240), detail text not null check(length(detail)<=2000),
 target_type text not null check(target_type in ('home','profile','security','inventory','shopping','billing','notification')),
 target_id text check(length(target_id)<=160), occurred_at timestamptz not null,
 delivered_at timestamptz, available_at timestamptz not null default now(), attempts int not null default 0,
 unique(event_key,recipient_id)
);
create index notification_outbox_due on public.notification_outbox(available_at,id) where delivered_at is null and attempts<8;
create index notification_outbox_recipient on public.notification_outbox(recipient_id);
create index notification_outbox_workspace on public.notification_outbox(workspace_id);
create table public.in_app_notifications (
 id uuid primary key references public.notification_outbox(id) on delete cascade,
 recipient_id uuid not null references public.users(id) on delete cascade,
 workspace_id uuid references public.workspaces(id) on delete cascade, financial boolean not null,
 event_key text not null, kind text not null, title text not null check(length(title)<=120),
 summary text not null check(length(summary)<=240), detail text not null check(length(detail)<=2000),
 target_type text not null, target_id text, occurred_at timestamptz not null, received_at timestamptz not null default now(),
 read_at timestamptz, unique(event_key,recipient_id)
);
create index notification_recipient_recent on public.in_app_notifications(recipient_id,received_at desc,id desc);
create index notification_recipient_unread on public.in_app_notifications(recipient_id,received_at desc,id desc) where read_at is null;
create function public.notification_visible(p_recipient uuid,p_workspace uuid,p_financial boolean) returns boolean
 language sql stable security definer set search_path='' as $$
 select p_recipient=public.current_user_id() and exists(select 1 from public.users where id=p_recipient and status='ACTIVE')
 and (p_workspace is null or exists(select 1 from public.workspace_members m join public.workspaces w on w.id=m.workspace_id
  where m.workspace_id=p_workspace and m.user_id=p_recipient and w.archived_at is null and (not p_financial or m.role='owner'))); $$;
alter table public.notification_outbox enable row level security;
alter table public.in_app_notifications enable row level security;
create policy notification_personal on public.in_app_notifications using(public.notification_visible(recipient_id,workspace_id,financial))
 with check(public.notification_visible(recipient_id,workspace_id,financial));
revoke all on public.notification_outbox,public.in_app_notifications from public,homemind_app;
grant select on public.in_app_notifications to homemind_app;
grant update(read_at) on public.in_app_notifications to homemind_app;
revoke all on function public.notification_visible(uuid,uuid,boolean) from public;
grant execute on function public.notification_visible(uuid,uuid,boolean) to homemind_app;

create function public.notification_enqueue(p_key text,p_user uuid,p_workspace uuid,p_financial boolean,p_kind text,
 p_title text,p_summary text,p_detail text,p_target text,p_target_id text,p_occurred timestamptz) returns void
 language sql security definer set search_path='' as $$
 insert into public.notification_outbox(event_key,recipient_id,workspace_id,financial,kind,title,summary,detail,target_type,target_id,occurred_at)
 values(p_key,p_user,p_workspace,p_financial,p_kind,left(p_title,120),left(p_summary,240),left(p_detail,2000),p_target,p_target_id,p_occurred)
 on conflict(event_key,recipient_id) do nothing; $$;
revoke all on function public.notification_enqueue(text,uuid,uuid,boolean,text,text,text,text,text,text,timestamptz) from public,homemind_app;

create function public.notification_profile_event() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' then
  perform public.notification_enqueue('welcome:v1:'||new.id,new.id,null,false,'account.welcome','Chào mừng đến HomeMind',
   'Tài khoản của bạn đã sẵn sàng.','Bạn có thể quản lý đồ dùng, danh sách mua và hồ sơ trong HomeMind.','home',null,new.created_at);
 elsif (new.display_name,new.phone,new.address,new.language) is distinct from (old.display_name,old.phone,old.address,old.language) then
  perform public.notification_enqueue('profile:v1:'||new.id||':'||pg_current_xact_id(),new.id,null,false,'profile.updated',
   'Hồ sơ đã cập nhật','Thay đổi hồ sơ của bạn đã được lưu.','Mở Hồ sơ để xem thông tin hiện tại.','profile',null,clock_timestamp());
 end if;
 return new;
end $$;
create trigger notification_profile_event after insert or update on public.profiles for each row execute function public.notification_profile_event();
create function public.notification_security_event() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (new.password_hash,new.email,new.phone,new.status) is distinct from (old.password_hash,old.email,old.phone,old.status) then
  perform public.notification_enqueue('security:v1:'||new.id||':'||pg_current_xact_id(),new.id,null,false,'account.security',
   'Bảo mật tài khoản đã cập nhật','Một thay đổi bảo mật đã được xác nhận.','Mở Bảo mật tài khoản để xem thông tin hiện tại.','security',null,clock_timestamp());
 end if; return new;
end $$;
create trigger notification_security_event after update on public.users for each row execute function public.notification_security_event();
create function public.notification_session_event() returns trigger language plpgsql security definer set search_path='' as $$
declare action text:=current_setting('app.auth_action',true); key text;
begin
 if tg_op='INSERT' and action='login' then
  perform public.notification_enqueue('login:v1:'||new.id,new.user_id,null,false,'account.login','Đăng nhập thành công',
   'Một phiên đăng nhập mới đã được mở.','Nếu không phải bạn, hãy kiểm tra Bảo mật tài khoản.','security',null,new.created_at);
 elsif tg_op='UPDATE' and old.revoked_at is null and new.revoked_at is not null and action in ('logout','logout_all') then
  key:=case when action='logout' then new.id::text else new.user_id||':'||pg_current_xact_id() end;
  perform public.notification_enqueue(action||':v1:'||key,new.user_id,null,false,'account.'||action,'Đã đăng xuất',
   'Yêu cầu đăng xuất của bạn đã được xác nhận.','Phiên đã đăng xuất không còn được dùng để truy cập tài khoản.','security',null,new.revoked_at);
 end if; return new;
end $$;
create trigger notification_session_event after insert or update on public.refresh_sessions for each row execute function public.notification_session_event();

-- Observe actual value changes within the existing operation, including atomic
-- receive children. One outer receipt produces one event, never one per SQL row.
create function public.notification_mutation_changed() returns trigger language plpgsql set search_path='' as $$
begin
 if nullif(current_setting('app.activity_operation',true),'') is not null and
  (tg_op<>'UPDATE' or (to_jsonb(new)-'updated_at') is distinct from (to_jsonb(old)-'updated_at')) then
  perform set_config('app.activity_changed','1',true);
 end if;
 return coalesce(new,old);
end $$;
create trigger activity_product after insert or update or delete on public.products for each row execute function public.notification_mutation_changed();
create trigger activity_lot after insert or update or delete on public.inventory_lots for each row execute function public.notification_mutation_changed();
create trigger activity_shopping after insert or update or delete on public.shopping_items for each row execute function public.notification_mutation_changed();
alter function public.apply_operation(uuid,uuid,text,jsonb,uuid) rename to apply_operation_before_activity;
revoke all on function public.apply_operation_before_activity(uuid,uuid,text,jsonb,uuid) from public,homemind_app;
create function public.apply_operation(p_workspace uuid,p_key uuid,p_operation text,p_payload jsonb,p_turn uuid default null) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare result jsonb; target text; target_id text; title text;
begin
 perform set_config('app.activity_operation',p_operation,true); perform set_config('app.activity_changed','0',true);
 result:=public.apply_operation_before_activity(p_workspace,p_key,p_operation,p_payload,p_turn);
 if current_setting('app.activity_changed',true)='1' then
  target_id:=coalesce(result->'created'->'productIds'->>0,p_payload->>'productId');
  if target_id is not null then target:='inventory';
  else target:='shopping';target_id:=coalesce(result->'created'->'shoppingItemIds'->>0,p_payload->>'itemId');end if;
  if target_id is null then target:='home';end if;
  title:=case p_operation when 'shopping.receive' then 'Đã nhận hàng' when 'shopping.add' then 'Đã thêm món cần mua'
   when 'shopping.patch' then 'Danh sách mua đã cập nhật' when 'inventory.add' then 'Đã thêm vào kho'
   when 'inventory.patch' then 'Sản phẩm đã cập nhật' when 'inventory.mark_out' then 'Đã cập nhật tồn kho'
   else 'Đã xác nhận thao tác trợ lý' end;
  perform public.notification_enqueue('operation:v1:'||p_workspace||':'||p_key,public.current_user_id(),p_workspace,false,
   p_operation,title,'Thao tác của bạn đã được lưu.','Mở dữ liệu liên quan để xem kết quả hiện tại.',target,
   target_id,clock_timestamp());
 end if;
 perform set_config('app.activity_operation','',true); return result;
end $$;
revoke all on function public.apply_operation(uuid,uuid,text,jsonb,uuid) from public;
grant execute on function public.apply_operation(uuid,uuid,text,jsonb,uuid) to homemind_app;

create function public.notification_billing_event() returns trigger language plpgsql security definer set search_path='' as $$
declare state text; title text; occurred timestamptz;
begin
 if tg_op='INSERT' then state:='created'; title:='Đã tạo đơn thanh toán'; occurred:=new.created_at;
 elsif new.financial_state='PAID' and new.fulfillment='GRANTED' and (old.financial_state,old.fulfillment) is distinct from ('PAID','GRANTED') then
  state:='activated'; title:='Thanh toán đã xác minh và gói đã kích hoạt'; occurred:=coalesce(new.paid_at,clock_timestamp());
 elsif new.financial_state='PAID' and new.fulfillment='REVIEW' and (old.financial_state,old.fulfillment) is distinct from ('PAID','REVIEW') then
  state:='review'; title:='Thanh toán đang chờ kiểm tra'; occurred:=coalesce(new.paid_at,clock_timestamp());
 elsif new.status='CANCELLED' and old.status<>'CANCELLED' then state:='cancelled'; title:='Đơn thanh toán đã hủy'; occurred:=new.cancelled_at;
 elsif new.status='EXPIRED' and old.status<>'EXPIRED' then state:='expired'; title:='Đơn thanh toán đã hết hạn'; occurred:=clock_timestamp();
 else return new; end if;
 perform public.notification_enqueue('billing:v1:'||new.id||':'||state,new.actor_id,new.workspace_id,true,'billing.'||state,
  title,'Mở thanh toán để xem trạng thái đã được máy chủ xác nhận.','Thông báo này không thay thế trạng thái gói và lịch sử thanh toán.',
  'billing',new.id::text,occurred);
 return new;
end $$;
create trigger notification_billing_event after insert or update on public.billing_orders for each row execute function public.notification_billing_event();
create function public.notification_quota_event() returns trigger language plpgsql security definer set search_path='' as $$
declare member record; state text; title text;
begin
 if tg_op='INSERT' and exists(select 1 from public.assistant_quota_periods where workspace_id=new.workspace_id and id<>new.id and starts_at<new.starts_at) then
  state:='renewed'; title:='Kỳ lượt trợ lý mới đã bắt đầu';
 elsif tg_op='UPDATE' and new.used>=new.usage_limit and old.used<old.usage_limit then state:='exhausted'; title:='Đã dùng hết lượt trợ lý trong kỳ';
 else return new; end if;
 for member in select user_id from public.workspace_members where workspace_id=new.workspace_id and role='owner' loop
  perform public.notification_enqueue('quota:v1:'||new.id||':'||state,member.user_id,new.workspace_id,false,'quota.'||state,
   title,'Mở Hồ sơ để xem lượt dùng và thời gian làm mới.','Lượt trợ lý dùng chung trong không gian. Gói Miễn phí không hết hạn.',
   'profile',null,case when state='renewed' then new.starts_at else clock_timestamp() end);
 end loop; return new;
end $$;
create trigger notification_quota_event after insert or update on public.assistant_quota_periods for each row execute function public.notification_quota_event();

create table public.notification_due_receipts(kind text not null,source_id uuid not null,primary key(kind,source_id));
revoke all on public.notification_due_receipts from public,homemind_app;
create index activity_grant_due on public.billing_grants((coalesce(effective_until,expires_at)),id) where superseded_at is null;
create index activity_quota_due on public.assistant_quota_periods(expires_at,id);
create index activity_lot_due on public.inventory_lots(expiry_date,id) where quantity>0;
-- No timer per account. Revalidate due facts under the same workspace lock used
-- by purchases/quota; a superseding paid grant suppresses old expiry notices.
create function public.notification_scan_due() returns integer language plpgsql security definer set search_path='' as $$
declare row record; member record; n int:=0; key text; read_time timestamptz; owner_id uuid; was_paid boolean; effective jsonb;
begin
 for row in select g.* from public.billing_grants g where coalesce(g.effective_until,g.expires_at)<=clock_timestamp() and g.superseded_at is null
  and not exists(select 1 from public.notification_due_receipts r where r.kind='grant' and r.source_id=g.id)
  order by coalesce(g.effective_until,g.expires_at),g.id limit 50 loop
  perform 1 from public.workspaces where id=row.workspace_id and archived_at is null for update skip locked;
  if not found then continue; end if;
  if not exists(select 1 from public.billing_grants g where g.workspace_id=row.workspace_id and g.starts_at<=clock_timestamp()
   and coalesce(g.effective_until,g.expires_at)>clock_timestamp()) then
   select source='billing' and plan<>'free' into was_paid from public.workspace_entitlements where workspace_id=row.workspace_id;
   effective:=public.billing_refresh_internal(row.workspace_id);
   if was_paid and effective->>'plan'='free' then
   for member in select user_id from public.workspace_members where workspace_id=row.workspace_id and role='owner' loop
    perform public.notification_enqueue('grant-expired:v1:'||row.id,member.user_id,row.workspace_id,true,'billing.plan_expired',
     'Gói trả phí đã kết thúc','Không gian đã trở về gói Miễn phí.','Dữ liệu và lịch sử được giữ nguyên. Gói Miễn phí có quyền truy cập vĩnh viễn.',
     'billing',row.order_id::text,coalesce(row.effective_until,row.expires_at));
   end loop;
   end if;
  end if;
  insert into public.notification_due_receipts values('grant',row.id) on conflict do nothing; n:=n+1;
 end loop;
 for row in select p.* from public.assistant_quota_periods p where p.expires_at<=clock_timestamp()
  and not exists(select 1 from public.notification_due_receipts r where r.kind='quota' and r.source_id=p.id)
  order by p.expires_at,p.id limit 50 loop
  perform 1 from public.workspaces where id=row.workspace_id and archived_at is null for update skip locked;
  if not found then continue; end if;
  perform public.assistant_period_at(row.workspace_id,clock_timestamp());
  insert into public.notification_due_receipts values('quota',row.id) on conflict do nothing; n:=n+1;
 end loop;
 -- Existing expiry.product.date logical identity is retained; legacy reads are
 -- copied only for those facts, not fabricated account/payment history.
 for row in select l.*,p.name from public.inventory_lots l join public.products p on p.id=l.product_id and p.archived_at is null
  where l.quantity>0 and l.expiry_date<=(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date+7
  and not exists(select 1 from public.notification_due_receipts r where r.kind='lot' and r.source_id=l.id)
  order by l.expiry_date,l.id limit 50 loop
  perform 1 from public.workspaces where id=row.workspace_id and archived_at is null for update skip locked;
  if not found then continue; end if;
  if not exists(select 1 from public.inventory_lots where id=row.id and quantity>0 and expiry_date=row.expiry_date) then continue; end if;
  key:='expiry.'||row.product_id||'.'||row.expiry_date;
  for member in select user_id from public.workspace_members where workspace_id=row.workspace_id and not exists(select 1 from public.notification_outbox o where o.event_key=key and o.recipient_id=user_id) limit 50 loop
   perform public.notification_enqueue(key,member.user_id,row.workspace_id,false,'inventory.expiry',row.name,
    'Hạn sử dụng: '||row.expiry_date,'Mở sản phẩm để xem tồn kho hiện tại.','inventory',row.product_id::text,
    greatest(row.created_at,(row.expiry_date-7)::timestamp at time zone 'Asia/Ho_Chi_Minh'));
  end loop;
  if not exists(select 1 from public.workspace_members m where m.workspace_id=row.workspace_id and not exists(select 1 from public.notification_outbox o where o.event_key=key and o.recipient_id=m.user_id)) then insert into public.notification_due_receipts values('lot',row.id) on conflict do nothing; end if; n:=n+1;
 end loop;
 return n;
end $$;
create function public.notification_deliver() returns integer language plpgsql security definer set search_path='' as $$
declare row public.notification_outbox%rowtype; n int:=0;
begin
 for row in select * from public.notification_outbox where delivered_at is null and attempts<8 and available_at<=clock_timestamp()
  order by available_at,id limit 50 for update skip locked loop
  begin
   insert into public.in_app_notifications(id,event_key,recipient_id,workspace_id,financial,kind,title,summary,detail,target_type,target_id,occurred_at,read_at)
    values(row.id,row.event_key,row.recipient_id,row.workspace_id,row.financial,row.kind,row.title,row.summary,row.detail,row.target_type,row.target_id,row.occurred_at,
    (select read_at from public.notification_reads where user_id=row.recipient_id and workspace_id=row.workspace_id and notification_key=row.event_key))
    on conflict(event_key,recipient_id) do nothing;
   update public.notification_outbox set delivered_at=clock_timestamp() where id=row.id; n:=n+1;
  exception when others then
   update public.notification_outbox set attempts=attempts+1,available_at=clock_timestamp()+make_interval(secs=>least(3600,5*(2^attempts)::int)) where id=row.id;
  end;
 end loop; return n;
end $$;
-- Only bounded worker entrypoints are executable by the runtime. No source
-- event creator, arbitrary clock, recipient or payment mutation is exposed.
revoke all on function public.notification_scan_due(),public.notification_deliver() from public;
grant execute on function public.notification_scan_due(),public.notification_deliver() to homemind_app;
revoke all on function public.notification_profile_event(),public.notification_security_event(),public.notification_session_event(),
 public.notification_billing_event(),public.notification_quota_event(),public.notification_mutation_changed() from public,homemind_app;
create function public.notification_immutable_read() returns trigger language plpgsql set search_path='' as $$
begin
 new.occurred_at:=old.occurred_at; new.received_at:=old.received_at;
 if old.read_at is not null then new.read_at:=old.read_at;
 elsif new.read_at is not null then new.read_at:=clock_timestamp(); end if;
 return new;
end $$;
create trigger notification_immutable_read before update on public.in_app_notifications for each row execute function public.notification_immutable_read();
revoke all on function public.notification_immutable_read() from public,homemind_app;
commit;
