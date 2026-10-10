begin;
-- Migrate only unambiguous existing household sharing. Never silently pick an owner/group.
do $$
declare ws record;effective jsonb;grant_row public.billing_grants%rowtype;
begin
 if exists(select 1 from public.workspace_members m join public.workspaces w on w.id=m.workspace_id
  where w.type='household' and w.archived_at is null and not exists(select 1 from public.family_groups g where g.workspace_id=w.id)
  and exists(select 1 from public.workspace_members r where r.workspace_id=w.id and r.role='member')
  group by w.id having count(*) filter(where m.role='owner')<>1 or count(*) filter(where m.role='member')>5) then
  raise exception 'AMBIGUOUS_LEGACY_FAMILY_MEMBERSHIP_REQUIRES_OPERATOR_REVIEW';
 end if;
 if exists(select 1 from public.workspace_members m join public.workspaces w on w.id=m.workspace_id
  where w.type='household' and w.archived_at is null and
   (exists(select 1 from public.family_groups g where g.workspace_id=w.id and g.sharing_enabled)
    or exists(select 1 from public.workspace_members r where r.workspace_id=w.id and r.role='member'))
  group by m.user_id having count(distinct w.id)>1) then
  raise exception 'AMBIGUOUS_LEGACY_FAMILY_MEMBERSHIP_REQUIRES_OPERATOR_REVIEW';
 end if;
 for ws in select w.id,w.created_at,m.user_id from public.workspaces w join public.workspace_members m on m.workspace_id=w.id and m.role='owner'
  where w.type='household' and w.archived_at is null and not exists(select 1 from public.family_groups g where g.workspace_id=w.id)
  and exists(select 1 from public.workspace_members r where r.workspace_id=w.id and r.role='member') order by w.id loop
  effective:=public.family_effective_at(ws.id,statement_timestamp());
  select * into grant_row from public.billing_grants g where g.workspace_id=ws.id and g.plan='family'
   and g.starts_at<=statement_timestamp() and coalesce(g.effective_until,g.expires_at)>statement_timestamp() and public.family_grant_allowed(g)
   order by starts_at desc,id limit 1;
  insert into public.family_groups(workspace_id,owner_id,created_at,eligibility_source,eligibility_grant_id,eligibility_until)
   values(ws.id,ws.user_id,ws.created_at,effective->>'source',grant_row.id,coalesce(grant_row.effective_until,grant_row.expires_at));
  insert into public.family_accounts(user_id,workspace_id,role) select user_id,workspace_id,role from public.workspace_members where workspace_id=ws.id;
  insert into public.family_memberships(workspace_id,user_id,joined_at) select workspace_id,user_id,created_at from public.workspace_members where workspace_id=ws.id and role='member';
  if not public.family_eligible(ws.id) then perform public.family_end(ws.id,'access_expired',public.family_access_end(ws.id,clock_timestamp()));end if;
 end loop;
end $$;

-- An in-app target exposes only the invitation addressed to this account (or created by it).
create function public.family_invitation_detail(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 select jsonb_build_object('id',i.id,'workspaceId',i.workspace_id,'workspaceName',w.name,'inviterName',p.display_name,'inviteeName',ip.display_name,
  'state',case when i.state='PENDING' and not public.family_eligible(i.workspace_id) then 'INVALIDATED' when i.state='PENDING' and i.expires_at<=statement_timestamp() then 'EXPIRED' else i.state end,
  'createdAt',i.created_at,'expiresAt',i.expires_at,'respondedAt',i.responded_at,'declineCount',coalesce(f.declines,0),'blockedUntil',f.blocked_until,
  'isRecipient',i.invitee_id=public.current_user_id()) into result
 from public.family_invitations i join public.workspaces w on w.id=i.workspace_id join public.profiles p on p.id=i.inviter_id join public.profiles ip on ip.id=i.invitee_id
 left join public.family_refusals f on f.inviter_id=i.inviter_id and f.invitee_id=i.invitee_id
 where i.id=p_id and public.current_user_id() in(i.inviter_id,i.invitee_id)
 and exists(select 1 from public.users where id=public.current_user_id() and status='ACTIVE');
 if result is null then raise exception 'INVITATION_NOT_FOUND';end if;
 return result;
end $$;
revoke all on function public.family_invitation_detail(uuid) from public;
grant execute on function public.family_invitation_detail(uuid) to homemind_app;

-- Short, bounded lifecycle work using the existing in-app worker. No external delivery.
create function public.family_scan_due() returns integer language plpgsql security definer set search_path='' as $$
declare r record;counted integer:=0;t timestamptz:=clock_timestamp();
begin
 perform public.family_lock();
 for r in select g.workspace_id from public.family_groups g where g.sharing_enabled and not public.family_eligible(g.workspace_id) order by g.workspace_id limit 10 loop
  perform public.family_end(r.workspace_id,'access_expired',public.family_access_end(r.workspace_id,t));counted:=counted+1;
 end loop;
 for r in update public.family_invitations set state='EXPIRED',responded_at=t where id in(
  select id from public.family_invitations where state='PENDING' and expires_at<=t order by expires_at,id limit 50 for update skip locked) returning * loop
  perform public.family_notice('expired:'||r.id,r.invitee_id,'family.invitation_expired','Lời mời gia đình đã hết hạn',r.id,t);
  perform public.family_notice('expired:'||r.id,r.inviter_id,'family.invitation_expired','Lời mời gia đình đã hết hạn',r.id,t);counted:=counted+1;
 end loop;
 return counted;
end $$;
revoke all on function public.family_scan_due() from public;
grant execute on function public.family_scan_due() to homemind_app;
create index family_expiration_due on public.family_invitations(expires_at,id) where state='PENDING';
create or replace function public.family_notice(p_key text,p_user uuid,p_kind text,p_title text,p_target uuid,p_now timestamptz) returns void language sql security definer set search_path='' as $$
 select public.notification_enqueue('family:v1:'||p_key,p_user,null,false,p_kind,p_title,p_title,
 'Thông báo gia đình. Quyền truy cập được kiểm tra lại khi mở; lịch sử riêng không được chuyển vào nhóm.',case when p_target is null then 'family' else 'family_invitation' end,p_target::text,p_now);
$$;
commit;
