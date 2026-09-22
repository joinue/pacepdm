-- PACE PDM Migration 060: the change log
--
-- Engineering changes something and sales hears about it from a customer.
-- That is the problem this table exists for: a feed engineers post to in
-- plain words, that sales reads, with a PDF attached when there is one.
--
-- It is deliberately NOT the ECO process. A post approves nothing, gates
-- nothing, and holds nothing up — the moment it can, it becomes a second
-- change record that disagrees with the first. What it does is tell people.
-- When ECOs are routine here, "post to the change log" becomes a checkbox on
-- a release, filled in from the ECO, and this table stays exactly as it is;
-- what changes is who types the post.
--
-- ── The three tables ────────────────────────────────────────────────────
--
-- `change_log_posts`   — the post. `body` is plain text, one paragraph or a
--                        list; `category` sorts the feed at a glance.
--                        `editedAt` is set on an edit and shown, because
--                        people argue from this feed; `deletedAt` hides a
--                        post without destroying what was said.
--                        The optional `partId` / `fileId` / `ecoId` /
--                        `releaseId` point a post at the record it is about,
--                        which is what later lets a release fill one in.
-- `change_log_reads`   — who has seen it. The read receipt is the
--                        accountability both sides are missing: engineering
--                        can see it landed, sales can show they were told.
-- `change_log_files`   — attachments, in the vault bucket under a
--                        `change-log/` prefix. Deliberately not rows in
--                        `files`: these are snapshots of what was sent, not
--                        controlled documents, and mixing them into the
--                        library the ECO process depends on is how an
--                        uncontrolled PDF ends up in a release package.
--
-- ── Notifications ───────────────────────────────────────────────────────
--
-- A 'changelog' notification type, added to the CHECK that migration 028
-- created and 058 last widened. Its own type so a person can keep change-log
-- email while muting something else, and so the bell can colour it.
--
-- ── RLS ─────────────────────────────────────────────────────────────────
--
-- Deny-all on all three: reached only through server code with the service
-- role (docs/decisions/rls-new-tables.md). Add them to scripts/rls-probe.mjs.
--
-- Idempotent. Not verified against the live database.

-- ── 1. Posts ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "change_log_posts" (
  "id" text PRIMARY KEY,
  "tenantId" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "body" text NOT NULL,
  "category" text NOT NULL DEFAULT 'GENERAL',
  "authorId" text REFERENCES "tenant_users"("id") ON DELETE SET NULL,
  "partId" text REFERENCES "parts"("id") ON DELETE SET NULL,
  "fileId" text REFERENCES "files"("id") ON DELETE SET NULL,
  "ecoId" text REFERENCES "ecos"("id") ON DELETE SET NULL,
  "releaseId" text REFERENCES "releases"("id") ON DELETE SET NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "editedAt" timestamptz,
  "deletedAt" timestamptz
);

-- What the feed does on every load: this tenant's posts, newest first.
CREATE INDEX IF NOT EXISTS "change_log_posts_feed_idx"
  ON "change_log_posts" ("tenantId", "createdAt" DESC)
  WHERE "deletedAt" IS NULL;

-- The categories the feed filters by. A CHECK rather than free text: the
-- filter buttons and the colours are written against these five, and a typo
-- in an emitter would make a post unreachable by filter.
DO $$ BEGIN
  ALTER TABLE "change_log_posts" DROP CONSTRAINT IF EXISTS "change_log_posts_category_check";
  ALTER TABLE "change_log_posts"
    ADD CONSTRAINT "change_log_posts_category_check"
    CHECK ("category" IN ('GENERAL','DESIGN','LEAD_TIME','PRICING','DOCUMENTATION'));
END $$;

-- ── 2. Read receipts ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "change_log_reads" (
  "postId" text NOT NULL REFERENCES "change_log_posts"("id") ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "tenant_users"("id") ON DELETE CASCADE,
  "tenantId" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "readAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("postId", "userId")
);

-- ── 3. Attachments ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "change_log_files" (
  "id" text PRIMARY KEY,
  "tenantId" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "postId" text NOT NULL REFERENCES "change_log_posts"("id") ON DELETE CASCADE,
  "storageKey" text NOT NULL,
  "fileName" text NOT NULL,
  "contentType" text,
  "sizeBytes" bigint,
  "uploadedById" text REFERENCES "tenant_users"("id") ON DELETE SET NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "change_log_files_post_idx"
  ON "change_log_files" ("postId");

-- ── 4. RLS ──────────────────────────────────────────────────────────────

ALTER TABLE "change_log_posts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "change_log_reads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "change_log_files" ENABLE ROW LEVEL SECURITY;

-- ── 5. The notification type ────────────────────────────────────────────

ALTER TABLE "notifications"
  DROP CONSTRAINT IF EXISTS "notifications_type_check";

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_type_check"
  CHECK ("type" IN ('approval','transition','checkout','eco','system','leadtime','changelog'));

-- ── 6. Realtime, so an open feed shows a new post ───────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'change_log_posts'
     )
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE "change_log_posts";
  END IF;
END $$;

-- ── Verification ────────────────────────────────────────────────────────
--
--   select count(*) from "change_log_posts";
--   select pg_get_constraintdef(oid) from pg_constraint
--    where conname in ('notifications_type_check', 'change_log_posts_category_check');
--   select relname, relrowsecurity from pg_class
--    where relname like 'change_log%';
