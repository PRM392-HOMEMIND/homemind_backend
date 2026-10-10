begin;
-- Error recovery must commit the materialized expiry that a rejected operation
-- rolled back. Keep normal reads pure to avoid personal/shared-pool lock inversion.
create function public.billing_recover_effective(p_workspace uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.family_reconcile_current();
 if not public.is_workspace_member(p_workspace) then raise exception 'FORBIDDEN';end if;
 return public.billing_refresh_at(p_workspace,clock_timestamp());
end $$;
revoke all on function public.billing_recover_effective(uuid) from public;
grant execute on function public.billing_recover_effective(uuid) to homemind_app;
commit;
