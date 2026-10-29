begin;
create function public.spending_page(p_workspace uuid,p_month date,p_scope text,p_limit integer,p_time timestamptz,p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if not public.is_workspace_member(p_workspace) then raise exception 'FORBIDDEN';end if;
 if p_scope not in('personal','workspace') or p_limit not between 1 and 51 or p_month is null then raise exception 'VALIDATION_ERROR';end if;
 with bounds as (
  select date_trunc('month',p_month::timestamp) at time zone 'Asia/Ho_Chi_Minh' s,
   (date_trunc('month',p_month::timestamp)+interval '1 month') at time zone 'Asia/Ho_Chi_Minh' e,
   (date_trunc('month',p_month::timestamp)-interval '1 month') at time zone 'Asia/Ho_Chi_Minh' ps),
 window_lots as materialized (
  select l.*,l.created_at>=b.s is_current from public.inventory_lots l cross join bounds b
  where l.workspace_id=p_workspace and l.created_at>=b.ps and l.created_at<b.e
   and (p_scope='workspace' or l.created_by=public.current_user_id())),
 current_lots as materialized (
  select l.*,p.name,p.category from window_lots l left join public.products p on p.id=l.product_id where is_current),
 purchases as (select purchase_id,bool_and(price_vnd is not null) complete from current_lots group by purchase_id),
 missing as (select * from current_lots where price_vnd is null and (p_time is null or (created_at,id)<(p_time,p_id)) order by created_at desc,id desc limit p_limit)
 select jsonb_build_object('month',to_char(p_month,'YYYY-MM'),'scope',p_scope,
  'totalVnd',coalesce((select sum(price_vnd) from current_lots),0),
  'previousTotalVnd',coalesce((select sum(price_vnd) from window_lots where not is_current),0),
  'purchaseCount',(select count(*) from purchases),'pricedCount',(select count(*) from purchases where complete),
  'unpricedCount',(select count(*) from purchases where not complete),'unpricedLotCount',(select count(*) from current_lots where price_vnd is null),
  'unknownAuthorPurchaseCount',(select count(distinct purchase_id) from current_lots where created_by is null),
  'byCategory',coalesce((select jsonb_agg(jsonb_build_object('category',category,'totalVnd',total) order by total desc,category)
   from (select category,sum(price_vnd) total from current_lots where price_vnd is not null group by category order by total desc,category limit 5) c),'[]'::jsonb),
  'byMember',coalesce((select jsonb_agg(jsonb_build_object('userId',x.created_by,'displayName',p.display_name,'purchaseCount',x.n,'knownTotalVnd',x.total) order by x.total desc,x.created_by)
   from (select created_by,count(distinct purchase_id) n,coalesce(sum(price_vnd),0) total from current_lots group by created_by) x left join public.profiles p on p.id=x.created_by),'[]'::jsonb),
  'unpriced',coalesce((select jsonb_agg(jsonb_build_object('lotId',id,'purchaseId',purchase_id,'productId',product_id,'name',name,
   'createdBy',created_by,'canEdit',public.family_can_edit(p_workspace,created_by),
   'purchasedAt',to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'storageLocation',storage_location) order by created_at desc,id desc) from missing),'[]'::jsonb)) into result;
 return result;
end $$;
revoke all on function public.spending_page(uuid,date,text,integer,timestamptz,uuid) from public;
grant execute on function public.spending_page(uuid,date,text,integer,timestamptz,uuid) to homemind_app;
-- The actor-check helper avoids granting the application role direct access to Family tables.
create function public.family_can_edit(p_workspace uuid,p_author uuid) returns boolean language sql stable security definer set search_path='' as $$
 select public.is_workspace_member(p_workspace) and (coalesce(p_author=public.current_user_id(),false) or not exists(select 1 from public.family_groups where workspace_id=p_workspace));
$$;
revoke all on function public.family_can_edit(uuid,uuid) from public;
grant execute on function public.family_can_edit(uuid,uuid) to homemind_app;
create or replace function public.spending_summary(p_workspace uuid,p_month date) returns jsonb language sql stable set search_path='' as $$
 select public.spending_page(p_workspace,p_month,'workspace',30,null,null);
$$;
commit;
