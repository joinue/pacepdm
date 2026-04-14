-- PACE PDM Migration 026: Missing foreign key on ecos.createdById
--
-- The `ecos` table was created in migration-001 without a foreign key
-- constraint on `createdById`, even though the parallel columns on
-- `boms`, `files`, and `parts` all have one. The absence has been
-- harmless at the data layer (the inserts happen through the API which
-- always supplies a valid tenant_users.id) but it breaks PostgREST's
-- relationship resolution.
--
-- Both the list and single-ECO endpoints use the embed hint
--
--     createdBy:tenant_users!ecos_createdById_fkey(fullName, email)
--
-- PostgREST resolves that hint by looking up the named constraint. With
-- no such constraint present, the join fails, `.single()` returns null,
-- and the single-ECO route falls through to a 404 even though the row
-- exists. The user's first symptom was "I create an ECO and the detail
-- page immediately says 'this ECO no longer exists'" — this is why.
--
-- Per project convention, run in the Supabase SQL Editor. The DO block
-- makes the constraint creation idempotent and defends against any
-- orphan rows that would otherwise block the ALTER.

DO $$
BEGIN
  -- Skip if the constraint already exists (re-running this migration).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ecos_createdById_fkey'
      AND conrelid = 'public.ecos'::regclass
  ) THEN
    -- Guard: surface orphan rows loudly instead of silently failing
    -- the ALTER. If this raises, inspect the offending rows and decide
    -- whether to clean them up or point them at a valid user.
    IF EXISTS (
      SELECT 1 FROM "ecos" e
      LEFT JOIN "tenant_users" tu ON tu.id = e."createdById"
      WHERE tu.id IS NULL
    ) THEN
      RAISE EXCEPTION 'ecos.createdById has orphan rows that do not reference any tenant_users row; clean those up before re-running this migration';
    END IF;

    ALTER TABLE "ecos"
      ADD CONSTRAINT "ecos_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "tenant_users"("id");
  END IF;
END $$;
