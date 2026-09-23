-- PACE PDM Migration 065: comments on change-log posts
--
-- A post is a notice, and stays one: it approves nothing and gates nothing.
-- What sales could not do was ask "does this affect the order we have in
-- flight?" anywhere except by replying to the notification email — which
-- put the answer in one inbox, where the next person with the same question
-- cannot find it. A thread under the post keeps the question and the answer
-- with the change.
--
-- ── The table ───────────────────────────────────────────────────────────
--
-- `change_log_comments` — one row per reply. Marked on edit (`editedAt`)
-- and soft-deleted (`deletedAt`) like the post above it, for the same
-- reason: people argue from this feed. Anyone with a session can reply,
-- because sales holds a read-only role and the thread is for them.
--
-- A reply notifies the post's author and everyone already in the thread —
-- the people talking, not the workspace. The post told everyone; a reply
-- that told everyone again is the email chain this replaces. @mentions go
-- through comment_mentions as they do on approval and check-in comments.
--
-- ── RLS ─────────────────────────────────────────────────────────────────
--
-- Deny-all: reached only through server code with the service role
-- (docs/decisions/rls-new-tables.md). Added to scripts/rls-probe.mjs.
--
-- Idempotent. Not verified against the live database.

CREATE TABLE IF NOT EXISTS "change_log_comments" (
  "id" text PRIMARY KEY,
  "tenantId" text NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "postId" text NOT NULL REFERENCES "change_log_posts"("id") ON DELETE CASCADE,
  "authorId" text REFERENCES "tenant_users"("id") ON DELETE SET NULL,
  "body" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "editedAt" timestamptz,
  "deletedAt" timestamptz
);

-- The thread under a post, oldest first, as the feed loads it.
CREATE INDEX IF NOT EXISTS "change_log_comments_thread_idx"
  ON "change_log_comments" ("postId", "createdAt")
  WHERE "deletedAt" IS NULL;

ALTER TABLE "change_log_comments" ENABLE ROW LEVEL SECURITY;

-- Realtime, so an open feed shows a reply without a refresh.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'change_log_comments'
     )
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE "change_log_comments";
  END IF;
END $$;

-- ── Verification ────────────────────────────────────────────────────────
--
--   select relname, relrowsecurity from pg_class where relname = 'change_log_comments';
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' and tablename = 'change_log_comments';
