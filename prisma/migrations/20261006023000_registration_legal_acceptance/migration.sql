-- Additive evidence only. Existing users retain NULL timestamps, not an
-- invented backfill/version. Closure and financial records are unchanged.
ALTER TABLE public.users
  ADD COLUMN terms_accepted_at timestamptz,
  ADD COLUMN privacy_accepted_at timestamptz,
  ADD CONSTRAINT users_legal_acceptance_pair
    CHECK ((terms_accepted_at IS NULL) = (privacy_accepted_at IS NULL));
