-- Initialize contact only when the profile is first provisioned. Existing
-- contacts, including intentionally cleared contacts, are never overwritten.
create or replace function public.provision_home(p_user uuid,p_name text,p_type text default 'household')
returns uuid language plpgsql security definer set search_path='' as $$
declare v_workspace uuid;
begin
 if p_user is distinct from public.current_user_id() or not exists(select 1 from public.users where id=p_user and status='ACTIVE') then raise exception 'FORBIDDEN'; end if;
 if p_type not in ('household','store') or length(trim(p_name)) not between 1 and 120 then raise exception 'VALIDATION_ERROR'; end if;
 insert into public.profiles(id,display_name,phone)
 select p_user,trim(p_name),u.phone from public.users u where u.id=p_user
 on conflict do nothing;
 insert into public.notification_preferences(user_id) values(p_user) on conflict do nothing;
 select workspace_id into v_workspace from public.workspace_members where user_id=p_user and role='owner' order by created_at limit 1;
 if v_workspace is null then
   insert into public.workspaces(name,type) values(left(case when p_type='store' then 'Cửa hàng ' else 'Nhà ' end || trim(p_name),120),p_type) returning id into v_workspace;
   insert into public.workspace_members(workspace_id,user_id,role) values(v_workspace,p_user,'owner');
   insert into public.workspace_entitlements(workspace_id) values(v_workspace);
 end if;
 return v_workspace;
end; $$;
revoke all on function public.provision_home(uuid,text,text) from public;
grant execute on function public.provision_home(uuid,text,text) to homemind_app;
