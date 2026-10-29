-- OFF by default. Only the operator can issue a short, bounded fixture lease.
create table public.audit_query_leases (
  user_id uuid primary key references public.users(id) on delete cascade,
  run_id text not null check (run_id ~ '^[a-zA-Z0-9_-]{8,80}$'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  remaining integer not null check (remaining between 0 and 500),
  check (expires_at > created_at and expires_at <= created_at + interval '30 minutes')
);
revoke all on public.audit_query_leases from public,homemind_app;

-- The migrator has NO parameter-setting grants by default. The root operator
-- may temporarily grant only the auto_explain parameters used below, after
-- checking the pinned PG module and scoped session_preload baseline.
create function public.audit_trace_begin(trace_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare lease public.audit_query_leases;
begin
  select * into lease from public.audit_query_leases
    where user_id=public.current_user_id() and expires_at>clock_timestamp() and remaining>0
    for update skip locked;
  if not found then return null; end if;
  if current_setting('auto_explain.log_min_duration',true) is null then
    raise exception 'AUDIT_OBSERVER_NOT_READY';
  end if;
  update public.audit_query_leases set remaining=remaining-1 where user_id=lease.user_id;
  perform set_config('app.audit_trace_id',trace_id::text,true);
  raise log 'HOMEMIND_TRACE_BEGIN % pid=% run=%',trace_id,pg_backend_pid(),lease.run_id;
  perform set_config('auto_explain.log_format','json',true);
  perform set_config('auto_explain.log_analyze','true',true);
  perform set_config('auto_explain.log_timing','false',true);
  perform set_config('auto_explain.log_buffers','true',true);
  perform set_config('auto_explain.log_nested_statements','true',true);
  perform set_config('auto_explain.log_min_duration','0',true);
  return jsonb_build_object('pid',pg_backend_pid(),'transactionId',pg_current_xact_id()::text,'runId',lease.run_id);
end $$;
revoke all on function public.audit_trace_begin(uuid) from public;
grant execute on function public.audit_trace_begin(uuid) to homemind_app;

create function public.audit_trace_end(trace_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  if current_setting('app.audit_trace_id',true) is distinct from trace_id::text then
    raise exception 'AUDIT_TRACE_MISMATCH';
  end if;
  perform set_config('auto_explain.log_min_duration','-1',true);
  raise log 'HOMEMIND_TRACE_END % pid=%',trace_id,pg_backend_pid();
end $$;
revoke all on function public.audit_trace_end(uuid) from public;
grant execute on function public.audit_trace_end(uuid) to homemind_app;
