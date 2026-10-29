-- Owner decision: initialize historical blank contacts even without edit history.
-- Existing contacts and explicit clears recorded from this release are preserved.
begin;
alter table public.profiles
 add column contact_phone_explicitly_cleared boolean not null default false,
 add column contact_phone_origin text not null default 'legacy_unknown',
 add column contact_phone_initialized_at timestamptz;

create function public.profile_contact_backfill(p_apply boolean default false) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare eligible integer; changed integer:=0; preserved integer; cleared integer;
begin
 -- Private maintenance boundary, never granted to the application role.
 select count(*) into eligible from public.profiles p join public.users u on u.id=p.id
  where nullif(trim(p.phone),'') is null and not p.contact_phone_explicitly_cleared
  and u.phone ~ '^\+[1-9][0-9]{7,14}$';
 select count(*) into preserved from public.profiles where nullif(trim(phone),'') is not null;
 select count(*) into cleared from public.profiles where contact_phone_explicitly_cleared;
 if p_apply then
  perform set_config('app.profile_contact_backfill','1',true);
  update public.profiles p set phone=u.phone,contact_phone_origin='historical_backfill',
    contact_phone_initialized_at=clock_timestamp(),updated_at=clock_timestamp()
   from public.users u where u.id=p.id and nullif(trim(p.phone),'') is null
   and not p.contact_phone_explicitly_cleared and u.phone ~ '^\+[1-9][0-9]{7,14}$';
  get diagnostics changed=row_count;
  perform set_config('app.profile_contact_backfill','',true);
 end if;
 return jsonb_build_object('eligible',eligible,'changed',changed,
  'existingContactsPreserved',preserved,'explicitClearsPreserved',cleared,
  'mode',case when p_apply then 'APPLY' else 'DRY_RUN' end);
end; $$;
revoke all on function public.profile_contact_backfill(boolean) from public,homemind_app;

-- This one-time migration is preceded by the trusted deployment backup.
select public.profile_contact_backfill(true);

create function public.profile_contact_edit_marker() returns trigger
 language plpgsql set search_path='' as $$
begin
 if current_setting('app.profile_contact_backfill',true) is distinct from '1' then
  new.contact_phone_explicitly_cleared:=TG_OP='UPDATE' and nullif(trim(new.phone),'') is null;
  new.contact_phone_origin:=case when TG_OP='INSERT' then 'registration' else 'user_edit' end;
  new.contact_phone_initialized_at:=clock_timestamp();
 end if;
 return new;
end; $$;
revoke all on function public.profile_contact_edit_marker() from public;
create trigger profile_contact_insert_marker before insert on public.profiles
 for each row execute function public.profile_contact_edit_marker();
create trigger profile_contact_update_marker before update of phone on public.profiles
 for each row execute function public.profile_contact_edit_marker();
commit;
