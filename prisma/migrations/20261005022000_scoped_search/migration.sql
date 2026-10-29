begin;
create extension if not exists unaccent;
create extension if not exists pg_trgm;
-- STABLE, not a false immutable wrapper over a mutable dictionary. Only
-- persisted values are indexed; updates recompute them with the same function.
create function public.search_normalize(value text) returns text language sql stable set search_path='' as $$
 select lower(replace(public.unaccent(normalize(coalesce(value,''),NFC)),'đ','d')); $$;
create table public.search_documents (
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 kind text not null check(kind in ('inventory','shopping','profile','billing','notification')),
 entity_id text not null check(length(entity_id)<=160), recipient_id uuid references public.users(id) on delete cascade,
 financial boolean not null default false, title text not null check(length(title)<=160),
 summary text not null check(length(summary)<=240), normalized text not null, normalized_title text not null,
 created_at timestamptz not null default now(), primary key(workspace_id,kind,entity_id)
);
create index search_scope on public.search_documents(workspace_id,kind,entity_id);
create index search_entity_lookup on public.search_documents(kind,entity_id);
create index search_recipient on public.search_documents(recipient_id);
create index search_prefix on public.search_documents(workspace_id,normalized text_pattern_ops);
create index search_trigram on public.search_documents using gin(normalized public.gin_trgm_ops);
alter table public.search_documents enable row level security;
create policy search_authorized on public.search_documents using(
 exists(select 1 from public.users where id=public.current_user_id() and status='ACTIVE')
 and workspace_id in(select m.workspace_id from public.workspace_members m join public.workspaces w on w.id=m.workspace_id
   where m.user_id=public.current_user_id() and w.archived_at is null)
 and (not financial or workspace_id in(select m.workspace_id from public.workspace_members m
   where m.user_id=public.current_user_id() and m.role='owner'))
 and (recipient_id is null or recipient_id=public.current_user_id()));
revoke all on public.search_documents from public,homemind_app;
grant select on public.search_documents to homemind_app;
revoke all on function public.search_normalize(text) from public;
grant execute on function public.search_normalize(text) to homemind_app;
-- Read-only catalog projection reuses the accepted billing eligibility engine.
create function public.search_available_plans(ws uuid) returns table(id text,plan text)
 language sql stable security definer set search_path='' as $$
 select p.id,p.plan from public.billing_prices p join public.workspaces w on w.id=ws
 where public.notification_visible(public.current_user_id(),ws,true) and p.active and p.workspace_type=w.type
 and public.billing_purchase_reason(ws,p.plan,clock_timestamp()) is null order by p.id limit 10; $$;
revoke all on function public.search_available_plans(uuid) from public;
grant execute on function public.search_available_plans(uuid) to homemind_app;
create function public.search_put(ws uuid,kind text,id text,recipient uuid,financial boolean,title text,summary text,created timestamptz) returns void
 language sql security definer set search_path='' as $$
 insert into public.search_documents(workspace_id,kind,entity_id,recipient_id,financial,title,summary,normalized,created_at,normalized_title)
 values(ws,kind,id,recipient,financial,left(title,160),left(summary,240),public.search_normalize(title||' '||summary),created,public.search_normalize(title))
 on conflict(workspace_id,kind,entity_id) do update set title=excluded.title,summary=excluded.summary,normalized=excluded.normalized,normalized_title=excluded.normalized_title; $$;
create function public.search_source_changed() returns trigger language plpgsql security definer set search_path='' as $$
declare m record; ws uuid; v_kind text; id text;
begin
 v_kind:=case tg_table_name when 'products' then 'inventory' when 'shopping_items' then 'shopping' when 'billing_orders' then 'billing'
  when 'profiles' then 'profile' when 'workspaces' then 'profile' else 'notification' end;
 if tg_op='DELETE' then
  delete from public.search_documents where search_documents.kind=v_kind and entity_id=old.id::text; return old;
 end if;
 if tg_table_name='products' then
  if new.archived_at is not null then delete from public.search_documents where workspace_id=new.workspace_id and kind='inventory' and entity_id=new.id::text;
  else perform public.search_put(new.workspace_id,v_kind,new.id::text,null,false,new.name,concat_ws(' · ',new.category,new.default_unit,new.status),new.created_at); end if;
 elsif tg_table_name='shopping_items' then
  perform public.search_put(new.workspace_id,v_kind,new.id::text,null,false,new.name,concat_ws(' · ',new.unit,new.status),new.created_at);
 elsif tg_table_name='billing_orders' then
  perform public.search_put(new.workspace_id,v_kind,new.id::text,null,true,new.price_snapshot->>'plan',
   concat_ws(' · ',new.order_code,new.status,to_char(new.created_at at time zone 'Asia/Ho_Chi_Minh','DD/MM/YYYY')),new.created_at);
 elsif tg_table_name='profiles' then
  for m in select workspace_id from public.workspace_members where user_id=new.id loop
   perform public.search_put(m.workspace_id,v_kind,new.id::text,new.id,false,new.display_name,'Hồ sơ · Profile',new.created_at);
  end loop;
 elsif tg_table_name='workspaces' then
  if new.archived_at is null then perform public.search_put(new.id,v_kind,new.id::text,null,false,new.name,'Không gian · Workspace',new.created_at);
  else delete from public.search_documents where workspace_id=new.id; end if;
 elsif tg_table_name='in_app_notifications' and new.workspace_id is not null then
  perform public.search_put(new.workspace_id,v_kind,new.id::text,new.recipient_id,new.financial,new.title,new.summary,new.received_at);
 elsif tg_table_name='in_app_notifications' then
  for m in select workspace_id from public.workspace_members where user_id=new.recipient_id loop
   perform public.search_put(m.workspace_id,v_kind,new.id::text,new.recipient_id,new.financial,new.title,new.summary,new.received_at);
  end loop;
 end if;
 if tg_table_name='in_app_notifications' then
  update public.search_documents set normalized=public.search_normalize(new.title||' '||new.summary||' '||new.detail)
   where kind='notification' and entity_id=new.id::text and recipient_id=new.recipient_id;
 end if;
 return new;
end $$;
create trigger search_products after insert or update or delete on public.products for each row execute function public.search_source_changed();
create trigger search_shopping after insert or update or delete on public.shopping_items for each row execute function public.search_source_changed();
create trigger search_billing after insert or update or delete on public.billing_orders for each row execute function public.search_source_changed();
create trigger search_profile after update or delete on public.profiles for each row execute function public.search_source_changed();
create trigger search_workspace after insert or update on public.workspaces for each row execute function public.search_source_changed();
create trigger search_notifications after insert or delete on public.in_app_notifications for each row execute function public.search_source_changed();
-- Membership insertion indexes the existing own profile; role/membership RLS is
-- evaluated live on every request, including rows produced before revocation.
create function public.search_member_added() returns trigger language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype;
begin
 select * into p from public.profiles where id=new.user_id;
 if found then perform public.search_put(new.workspace_id,'profile',p.id::text,p.id,false,p.display_name,'Hồ sơ · Profile',p.created_at); end if;
 return new;
end $$;
create trigger search_member_added after insert on public.workspace_members for each row execute function public.search_member_added();
-- One controlled initial backfill, no new activity events/history fabrication.
insert into public.search_documents(workspace_id,kind,entity_id,title,summary,normalized,created_at,normalized_title)
 select workspace_id,'inventory',id::text,name,concat_ws(' · ',category,default_unit,status),
 public.search_normalize(concat_ws(' ',name,category,default_unit,status)),created_at,public.search_normalize(name) from public.products where archived_at is null;
insert into public.search_documents(workspace_id,kind,entity_id,title,summary,normalized,created_at,normalized_title)
 select workspace_id,'shopping',id::text,name,concat_ws(' · ',unit,status),public.search_normalize(concat_ws(' ',name,unit,status)),created_at,public.search_normalize(name) from public.shopping_items;
insert into public.search_documents(workspace_id,kind,entity_id,financial,title,summary,normalized,created_at,normalized_title)
 select workspace_id,'billing',id::text,true,price_snapshot->>'plan',concat_ws(' · ',order_code,status,to_char(created_at at time zone 'Asia/Ho_Chi_Minh','DD/MM/YYYY')),
 public.search_normalize(concat_ws(' ',price_snapshot->>'plan',order_code,status,to_char(created_at at time zone 'Asia/Ho_Chi_Minh','DD/MM/YYYY'))),created_at,public.search_normalize(price_snapshot->>'plan') from public.billing_orders;
insert into public.search_documents(workspace_id,kind,entity_id,recipient_id,title,summary,normalized,created_at,normalized_title)
 select m.workspace_id,'profile',p.id::text,p.id,p.display_name,'Hồ sơ · Profile',public.search_normalize(p.display_name||' Hồ sơ Profile'),p.created_at,public.search_normalize(p.display_name)
 from public.profiles p join public.workspace_members m on m.user_id=p.id;
insert into public.search_documents(workspace_id,kind,entity_id,title,summary,normalized,created_at,normalized_title)
 select id,'profile',id::text,name,'Không gian · Workspace',public.search_normalize(name||' Không gian Workspace'),created_at,public.search_normalize(name) from public.workspaces where archived_at is null;
revoke all on function public.search_put(uuid,text,text,uuid,boolean,text,text,timestamptz),public.search_source_changed(),public.search_member_added() from public,homemind_app;
commit;
