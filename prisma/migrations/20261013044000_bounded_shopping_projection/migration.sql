begin;
-- One authorized set-based projection replaces per-row RLS helper queries on the
-- page and total scans. Table RLS and mutation permissions remain unchanged.
create function public.shopping_page(p_workspace uuid,p_status text,p_query text,p_limit integer,p_time timestamptz,p_id uuid,p_suggestions boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;uid uuid:=public.current_user_id();private_space boolean;
begin
 if not public.is_workspace_member(p_workspace) then raise exception 'FORBIDDEN';end if;
 if p_status is null or p_status not in('needed','bought','skipped') or p_limit is null or p_limit not between 1 and 51
  or p_query is null or length(p_query)>120 or (p_time is null)<>(p_id is null) then raise exception 'VALIDATION_ERROR';end if;
 private_space:=public.family_can_edit(p_workspace,null);
 with page as (
  select id,name,quantity::float8,unit,status,source,created_by as "createdBy",private_space or coalesce(created_by=uid,false) as "canEdit",
   to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"
  from public.shopping_items where workspace_id=p_workspace and status=p_status and strpos(lower(name),lower(p_query))>0
   and (p_time is null or (created_at,id)<(p_time,p_id)) order by created_at desc,id desc limit p_limit),
 suggestions as (
  select p.name,'out' as reason,p.id as "productId" from public.products p
  where p_suggestions and p.workspace_id=p_workspace and p.status='out' and p.archived_at is null
   and not exists(select 1 from public.shopping_items s where s.workspace_id=p_workspace and s.linked_product_id=p.id and s.status='needed')
  order by p.name,p.id limit 50)
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(page)) from page),'[]'::jsonb),
  'total',(select count(*) from public.shopping_items where workspace_id=p_workspace and status=p_status and strpos(lower(name),lower(p_query))>0),
  'suggestions',coalesce((select jsonb_agg(to_jsonb(suggestions)) from suggestions),'[]'::jsonb)) into result;
 return result;
end $$;
revoke all on function public.shopping_page(uuid,text,text,integer,timestamptz,uuid,boolean) from public;
grant execute on function public.shopping_page(uuid,text,text,integer,timestamptz,uuid,boolean) to homemind_app;
commit;
