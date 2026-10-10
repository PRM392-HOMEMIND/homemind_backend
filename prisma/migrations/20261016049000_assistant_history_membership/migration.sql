begin;

-- A turn records its historical actor, not an obligation to remain a member.
-- Keep the independent workspace/user foreign keys and retain all turn rows.
-- Membership remains enforced by turns_owner RLS and the existing guarded,
-- quota-fenced create/confirm/cancel functions; no runtime grants change.
alter table public.assistant_turns
  drop constraint assistant_turns_workspace_id_user_id_fkey;

commit;
