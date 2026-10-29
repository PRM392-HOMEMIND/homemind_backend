-- Only the operator/migrator can bootstrap this singleton. No email-only
-- request, user DTO or runtime DB write can enrol a reviewer identity.
create table public.auth_reviewer_identity (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null unique references public.users(id) on delete cascade,
  email text not null check (email = 'homemind.test@gmail.com'),
  bootstrapped_at timestamptz not null default clock_timestamp()
);
revoke all on public.auth_reviewer_identity from public, homemind_app;
grant select on public.auth_reviewer_identity to homemind_app;
