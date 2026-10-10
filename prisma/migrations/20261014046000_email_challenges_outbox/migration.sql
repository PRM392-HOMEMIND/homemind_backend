begin;
-- Additive auth state. Existing missing emails are not invented or marked verified.
create function public.auth_email_session_fence() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.users where id=new.user_id and status='ACTIVE' and email is not null and email_verified_at is not null) then
  raise exception 'EMAIL_VERIFICATION_REQUIRED';
 end if;return new;
end $$;
create trigger auth_email_session_fence before insert on public.refresh_sessions for each row execute function public.auth_email_session_fence();
revoke all on function public.auth_email_session_fence() from public,homemind_app;
-- Unverified legacy users recover through a password-proven restricted flow.
update public.refresh_sessions s set revoked_at=clock_timestamp() from public.users u where u.id=s.user_id and s.revoked_at is null and (u.email is null or u.email_verified_at is null);
create table public.auth_email_challenges (
 id uuid primary key, capability_hash text not null, purpose text not null, request_id uuid not null,last_resend_request uuid,request_hash text not null,
 email text not null, user_id uuid references public.users(id) on delete cascade,
 binding text not null, generation int not null default 1, payload jsonb not null default '{}',
 state text not null default 'queued' check(state in('queued','submitting','accepted','unknown','failed','verified','consumed','expired','locked')),
 code_hash text, issued_at timestamptz, expires_at timestamptz, resend_at timestamptz not null default now(),
 delivery_state text, report_checked_at timestamptz,error_code text,
 attempts int not null default 0, message_id text, created_at timestamptz not null default now(),
 ticket_hash text, ticket_expires_at timestamptz, fingerprint text not null,
 constraint challenge_purpose check(purpose in('REGISTER','RESET','CHANGE_PASSWORD','VERIFY_EMAIL','LEGACY_EMAIL','CHANGE_EMAIL_OLD','CHANGE_EMAIL_NEW')),
 constraint challenge_email check(email=lower(btrim(email)) and length(email)<=254)
);
create unique index challenge_open_binding on public.auth_email_challenges(binding) where state in('queued','submitting','accepted','unknown','verified');
create index challenge_due on public.auth_email_challenges(created_at,id) where state='queued';
create unique index challenge_request_id on public.auth_email_challenges(binding,request_id);
create table public.auth_email_limits(key text not null, occurred_at timestamptz not null default now(), kind text not null);
create index auth_email_limit_recent on public.auth_email_limits(key,kind,occurred_at);
create table public.auth_legacy_email_proofs(id uuid primary key,user_id uuid not null references public.users(id) on delete cascade,
 proof_hash text not null,fingerprint text not null,expires_at timestamptz not null,used_at timestamptz);
revoke all on public.auth_legacy_email_proofs from public;
grant select,insert,update,delete on public.auth_legacy_email_proofs to homemind_app;
-- A trigger covers only newly materialized notifications. No backfill of historical rows.
create table public.auth_email_security_destinations(event_key text primary key,user_id uuid not null references public.users(id) on delete cascade,email text not null,created_at timestamptz not null default now());
revoke all on public.auth_email_security_destinations from public,homemind_app;
create table public.email_deliveries (
 id uuid primary key default gen_random_uuid(), notification_id uuid references public.in_app_notifications(id) on delete cascade,
 user_id uuid not null references public.users(id) on delete cascade, email text, snapshot jsonb not null default '{}', verified_old_destination boolean not null default false,
 state text not null default 'queued' check(state in('queued','submitting','accepted','delivered','failed','suppressed','unknown','ineligible','unmapped')),
 message_id text unique, attempts int not null default 0, available_at timestamptz not null default now(),
 lease_until timestamptz, error_code text, submitted_at timestamptz, completed_at timestamptz,
 report_checked_at timestamptz, created_at timestamptz not null default now(),unique(notification_id,email)
);
create index email_delivery_due on public.email_deliveries(available_at,id) where state='queued';
create index email_delivery_reports on public.email_deliveries(report_checked_at,id) where state in('accepted','unknown');
create table public.email_suppressions(email text primary key, reason text not null, created_at timestamptz not null default now());
create function public.email_notification_intent() returns trigger language plpgsql security definer set search_path='' as $$
declare context text:=new.detail;inv record;bill record;
begin
 if new.kind not in('account.login','account.logout','account.logout_all') then
  if new.target_type='family_invitation' and new.target_id is not null then
   select w.name,p.display_name,i.state into inv from public.family_invitations i join public.workspaces w on w.id=i.workspace_id
    join public.profiles p on p.id=i.inviter_id where i.id=new.target_id::uuid and new.recipient_id in(i.inviter_id,i.invitee_id);
   if found then context:='Nhóm gia đình: '||inv.name||'. Người mời: '||inv.display_name||'. '||new.title||'. '||
    case when inv.state='PENDING' then 'Lời mời đang chờ bạn phản hồi. Mở Gia đình trong HomeMind để chấp nhận hoặc từ chối. Gia đình có tối đa 5 người thân và dùng chung lượt trợ lý.' else 'Quyền truy cập và trạng thái lời mời đã được cập nhật. Kiểm tra Gia đình trong HomeMind để xem trạng thái hiện tại.' end;end if;
  elsif new.target_type='billing' and new.target_id is not null then
   select price_snapshot,status into bill from public.billing_orders where id=new.target_id::uuid and actor_id=new.recipient_id;
   if found then context:=new.title||'. Gói: '||coalesce(bill.price_snapshot->>'plan','')||'. Số tiền ghi nhận trong đơn: '||coalesce(bill.price_snapshot->>'amount','0')||' VND. '||new.detail;end if;
  end if;
  insert into public.email_deliveries(notification_id,user_id,email,snapshot,verified_old_destination,state)
   select new.id,u.id,u.email,jsonb_build_object('kind',new.kind,'title',new.title,'summary',new.summary,'detail',context,'occurredAt',new.occurred_at),new.kind='account.security' and u.email_verified_at is not null,
    case when current_setting('app.email_delivery_enabled',true)='true' and (u.status='ACTIVE' or new.kind='account.security') and u.email_verified_at is not null and u.email is not null then 'queued' else 'ineligible' end
   from public.users u where u.id=new.recipient_id on conflict(notification_id,email) do nothing;
  insert into public.email_deliveries(notification_id,user_id,email,snapshot,verified_old_destination,state)
   select new.id,new.recipient_id,d.email,jsonb_build_object('kind',new.kind,'title',new.title,'summary',new.summary,'detail',context,'occurredAt',new.occurred_at),true,case when current_setting('app.email_delivery_enabled',true)='true' then 'queued' else 'ineligible' end
   from public.auth_email_security_destinations d where d.event_key=new.event_key and d.user_id=new.recipient_id on conflict(notification_id,email) do nothing;
  delete from public.auth_email_security_destinations where event_key=new.event_key;
 end if;
 return new;
end $$;
create trigger email_notification_intent after insert on public.in_app_notifications for each row execute function public.email_notification_intent();
revoke all on function public.email_notification_intent() from public,homemind_app;
-- These private identity/delivery tables have no public/customer API or RLS access.
revoke all on public.auth_email_challenges,public.auth_email_limits,public.email_deliveries,public.email_suppressions from public;
grant select,insert,update,delete on public.auth_email_challenges,public.auth_email_limits,public.email_deliveries,public.email_suppressions to homemind_app;
-- Describe the exact security event without putting any secret into the notification.
create or replace function public.notification_security_event() returns trigger language plpgsql security definer set search_path='' as $$
declare title text;detail text;
begin
 if (new.password_hash,new.email,new.phone,new.status,new.email_verified_at) is distinct from (old.password_hash,old.email,old.phone,old.status,old.email_verified_at) then
  if new.password_hash is distinct from old.password_hash then title:='Mật khẩu của bạn đã được thay đổi';detail:='Mật khẩu mới đã được xác nhận. Tất cả phiên trước đã bị thu hồi; bạn cần đăng nhập lại. Nếu không phải bạn, yêu cầu đặt lại mật khẩu trong HomeMind.';
  elsif new.email is distinct from old.email then title:='Địa chỉ email đã được thay đổi';detail:='Địa chỉ hiện tại và địa chỉ mới đã được xác minh. Email đăng nhập mới đã được lưu. Các phiên trước đã bị thu hồi.';
  elsif new.email_verified_at is distinct from old.email_verified_at then title:='Email đã được xác minh';detail:='Quá trình xác minh hoàn tất. Bạn có thể sử dụng tài khoản HomeMind.';
  else title:='Bảo mật tài khoản đã cập nhật';detail:='Thay đổi thông tin hoặc trạng thái tài khoản đã được lưu. Kiểm tra Bảo mật tài khoản trong HomeMind nếu bạn không yêu cầu thay đổi này.';end if;
  perform public.notification_enqueue('security:v1:'||new.id||':'||pg_current_xact_id(),new.id,null,false,'account.security',title,title,detail,'security',null,clock_timestamp());
  if new.email is distinct from old.email and old.email_verified_at is not null and old.email is not null and new.email_verified_at is not null then
   insert into public.auth_email_security_destinations(event_key,user_id,email) values('security:v1:'||new.id||':'||pg_current_xact_id(),new.id,old.email) on conflict(event_key) do nothing;
  end if;
 end if; return new;
end $$;
commit;
