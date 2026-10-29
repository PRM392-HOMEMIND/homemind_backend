begin;
-- Preserve the Family expiry fence when an older API uses the established SQL entrypoints.
-- Reconcile BEFORE workspace/quota locks; provider calls never run in these transactions.
alter function public.billing_effective(uuid) rename to billing_effective_before_lifecycle_fence;
revoke all on function public.billing_effective_before_lifecycle_fence(uuid) from public,homemind_app;
create function public.billing_effective(p_workspace uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.family_reconcile_current();
 return public.billing_effective_before_lifecycle_fence(p_workspace);
end $$;
revoke all on function public.billing_effective(uuid) from public;
grant execute on function public.billing_effective(uuid) to homemind_app;
alter function public.assistant_quota_get(uuid) rename to assistant_quota_get_before_lifecycle_fence;
revoke all on function public.assistant_quota_get_before_lifecycle_fence(uuid) from public,homemind_app;
create function public.assistant_quota_get(p_workspace uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.family_reconcile_current();
 return public.assistant_quota_get_before_lifecycle_fence(p_workspace);
end $$;
revoke all on function public.assistant_quota_get(uuid) from public;
grant execute on function public.assistant_quota_get(uuid) to homemind_app;
alter function public.assistant_quota_admit_at(uuid,uuid,text,timestamptz) rename to assistant_quota_admit_at_before_lifecycle_fence;
revoke all on function public.assistant_quota_admit_at_before_lifecycle_fence(uuid,uuid,text,timestamptz) from public,homemind_app;
create function public.assistant_quota_admit_at(p_workspace uuid,p_request uuid,p_hash text,p_now timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.family_reconcile_current();
 return public.assistant_quota_admit_at_before_lifecycle_fence(p_workspace,p_request,p_hash,p_now);
end $$;
revoke all on function public.assistant_quota_admit_at(uuid,uuid,text,timestamptz) from public;
alter function public.apply_operation(uuid,uuid,text,jsonb,uuid) rename to apply_operation_before_lifecycle_fence;
revoke all on function public.apply_operation_before_lifecycle_fence(uuid,uuid,text,jsonb,uuid) from public,homemind_app;
create function public.apply_operation(p_workspace uuid,p_key uuid,p_operation text,p_payload jsonb,p_turn uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.family_reconcile_current();
 return public.apply_operation_before_lifecycle_fence(p_workspace,p_key,p_operation,p_payload,p_turn);
end $$;
revoke all on function public.apply_operation(uuid,uuid,text,jsonb,uuid) from public;
grant execute on function public.apply_operation(uuid,uuid,text,jsonb,uuid) to homemind_app;
commit;
