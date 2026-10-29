begin;
-- An invoker projection: identical nullable/unit semantics, without elevated reads.
create function public.inventory_quantity_summary(p_workspace uuid,p_product uuid) returns jsonb
language sql stable set search_path='' as $$
 with units as (
  select nullif(btrim(unit),'') unit,
   coalesce(sum(quantity) filter(where quantity_known),0) known,
   count(*) filter(where not quantity_known) unknown
  from public.inventory_lots where workspace_id=p_workspace and product_id=p_product and quantity>0
  group by nullif(btrim(unit),'')
 ), total as (select count(*) n,coalesce(sum(unknown),0) unknown,coalesce(sum(known),0) known from units)
 select jsonb_build_object('quantity',case when n=0 then '0' when n=1 and unknown=0 then known::text else null end,
  'unit',case when n=1 then (select unit from units) else null end,
  'quantityState',case when n=0 then 'empty' when n>1 then 'incompatible_units' when unknown>0 and known>0 then 'mixed' when unknown>0 then 'unknown' else 'known' end,
  'quantityBreakdown',coalesce((select jsonb_agg(jsonb_build_object('unit',unit,'knownQuantity',known::text,'unknownLots',unknown) order by unit nulls first) from units),'[]'::jsonb)) from total;
$$;
revoke all on function public.inventory_quantity_summary(uuid,uuid) from public;
grant execute on function public.inventory_quantity_summary(uuid,uuid) to homemind_app;

-- Validate unconstrained numeric BEFORE any cast to numeric(12,3), including nested batches.
create function public.validate_operation_quantities(p_payload jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare k text; v jsonb; n numeric;
begin
 if jsonb_typeof(p_payload)='object' then
  for k,v in select key,value from jsonb_each(p_payload) loop
   if k in ('quantity','remainingQuantity') and v<>'null'::jsonb then
    if jsonb_typeof(v)<>'number' then raise exception 'QUANTITY_INVALID'; end if;
    n:=(v#>>'{}')::numeric;
    if n>999999999.999 or n<(case when k='remainingQuantity' then 0 else 0.001 end) or n<>trunc(n,3) then raise exception 'QUANTITY_INVALID'; end if;
   elsif jsonb_typeof(v) in ('array','object') then perform public.validate_operation_quantities(v); end if;
  end loop;
 elsif jsonb_typeof(p_payload)='array' then
  for v in select value from jsonb_array_elements(p_payload) loop perform public.validate_operation_quantities(v); end loop;
 end if;
end $$;
revoke all on function public.validate_operation_quantities(jsonb) from public,homemind_app;
alter function public.apply_operation(uuid,uuid,text,jsonb,uuid) rename to apply_operation_before_quantity_contract;
revoke all on function public.apply_operation_before_quantity_contract(uuid,uuid,text,jsonb,uuid) from public,homemind_app;
create function public.apply_operation(p_workspace uuid,p_key uuid,p_operation text,p_payload jsonb,p_turn uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform 1 from public.workspaces where id=p_workspace for update;
 if not public.is_workspace_member(p_workspace) then raise exception 'FORBIDDEN'; end if;
 perform public.validate_operation_quantities(p_payload);
 result:=public.apply_operation_before_quantity_contract(p_workspace,p_key,p_operation,p_payload,p_turn);
 -- A contribution may not overflow the supported total in its own unit either.
 if exists(select 1 from public.inventory_lots where workspace_id=p_workspace and quantity_known
  and (product_id in(select value::uuid from jsonb_array_elements_text(result->'created'->'productIds'))
   or product_id=nullif(p_payload->>'productId','')::uuid)
  group by product_id,unit having sum(quantity)>999999999.999) then raise exception 'QUANTITY_INVALID'; end if;
 return result;
end $$;
revoke all on function public.apply_operation(uuid,uuid,text,jsonb,uuid) from public;
grant execute on function public.apply_operation(uuid,uuid,text,jsonb,uuid) to homemind_app;
commit;
