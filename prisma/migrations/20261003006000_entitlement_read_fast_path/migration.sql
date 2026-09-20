-- Unchanged reads must not serialize behind writes. Mutations and actual
-- entitlement transitions retain billing_refresh_internal's lock/recheck.
create or replace function public.billing_effective(p_workspace uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare e public.workspace_entitlements%rowtype; g public.billing_grants%rowtype;
begin
 if not public.is_workspace_member(p_workspace) then raise exception 'FORBIDDEN'; end if;
 select * into e from public.workspace_entitlements where workspace_id=p_workspace;
 if e.source='billing' then
  select * into g from public.billing_grants where workspace_id=p_workspace
   and starts_at<=now() and expires_at>now() order by starts_at desc,id limit 1;
  if e.plan is distinct from coalesce(g.plan,'free')
   or e.product_limit is distinct from (case when g.id is null then 30 else g.product_limit end) then
   return public.billing_refresh_internal(p_workspace);
  end if;
 end if;
 return jsonb_build_object('plan',coalesce(e.plan,'free'),
  'productLimit',case when e.workspace_id is null then 30 else e.product_limit end,
  'source',coalesce(e.source,'free'),'changed',false);
end; $$;
