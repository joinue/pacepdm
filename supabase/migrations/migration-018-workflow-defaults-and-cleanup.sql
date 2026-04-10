-- PACE PDM Migration 018: Default approval workflow + drop legacy rules
--
-- Two related cleanups:
--
-- 1. Seed every tenant with a default approval group + single-step
--    workflow attached to its "Approve & Release" transition, so a fresh
--    tenant can release files immediately without configuring anything.
--    Tenant creation in /api/tenants/route.ts does the same thing for
--    new tenants — this migration backfills existing ones.
--
-- 2. Drop "transition_approval_rules" (the flat, pre-migration-006
--    approval mechanism). It was kept as a fallback in the file
--    transition route, but with workflows now the canonical path —
--    and a default workflow seeded for every tenant — it has no
--    remaining callers.
--
-- Run this in the Supabase SQL Editor. All statements are idempotent.

-- ─── 1. Seed defaults for tenants that don't already have a workflow ───
--
-- A tenant "needs" the default if it has at least one
-- requiresApproval=true transition that has *no* workflow assignment yet.
-- We don't touch tenants that have already configured their own.

DO $$
DECLARE
  v_tenant   RECORD;
  v_lc       RECORD;
  v_trans    RECORD;
  v_admin_id TEXT;
  v_group_id TEXT;
  v_wf_id    TEXT;
  v_step_id  TEXT;
  v_now      TIMESTAMP(3) := CURRENT_TIMESTAMP;
BEGIN
  FOR v_tenant IN SELECT "id" FROM "tenants" LOOP
    -- Find the default lifecycle's "Approve & Release" transition
    -- (or any requiresApproval=true transition if names differ).
    SELECT lt."id" INTO v_trans
      FROM "lifecycle_transitions" lt
      JOIN "lifecycles" l ON l."id" = lt."lifecycleId"
      WHERE l."tenantId" = v_tenant."id"
        AND lt."requiresApproval" = TRUE
      ORDER BY (l."isDefault" = TRUE) DESC, lt."name"
      LIMIT 1;

    IF v_trans IS NULL THEN
      CONTINUE;  -- Tenant has no approval-required transitions; nothing to seed.
    END IF;

    -- Skip if this transition already has a workflow assignment.
    IF EXISTS (
      SELECT 1 FROM "approval_workflow_assignments"
      WHERE "tenantId" = v_tenant."id"
        AND "transitionId" = v_trans."id"
    ) THEN
      CONTINUE;
    END IF;

    -- Find or create the "Approvers" group for this tenant.
    SELECT "id" INTO v_group_id
      FROM "approval_groups"
      WHERE "tenantId" = v_tenant."id" AND "name" = 'Approvers'
      LIMIT 1;

    IF v_group_id IS NULL THEN
      v_group_id := gen_random_uuid()::text;
      INSERT INTO "approval_groups" ("id", "tenantId", "name", "description", "createdAt", "updatedAt")
      VALUES (
        v_group_id,
        v_tenant."id",
        'Approvers',
        'Default approval group. Add members in Admin → Approval Groups.',
        v_now,
        v_now
      );

      -- Seed group members: every active Admin user in this tenant.
      INSERT INTO "approval_group_members" ("id", "groupId", "userId", "createdAt")
      SELECT gen_random_uuid()::text, v_group_id, tu."id", v_now
        FROM "tenant_users" tu
        JOIN "roles" r ON r."id" = tu."roleId"
        WHERE tu."tenantId" = v_tenant."id"
          AND tu."isActive" = TRUE
          AND r."name" = 'Admin';
    END IF;

    -- Find or create the "Standard Release Approval" workflow.
    SELECT "id" INTO v_wf_id
      FROM "approval_workflows"
      WHERE "tenantId" = v_tenant."id" AND "name" = 'Standard Release Approval'
      LIMIT 1;

    IF v_wf_id IS NULL THEN
      v_wf_id := gen_random_uuid()::text;
      INSERT INTO "approval_workflows" ("id", "tenantId", "name", "description", "isActive", "createdAt", "updatedAt")
      VALUES (
        v_wf_id,
        v_tenant."id",
        'Standard Release Approval',
        'Default single-step release approval. Edit in Admin → Workflows.',
        TRUE,
        v_now,
        v_now
      );

      v_step_id := gen_random_uuid()::text;
      INSERT INTO "approval_workflow_steps"
        ("id", "workflowId", "groupId", "stepOrder", "approvalMode", "signatureLabel", "deadlineHours", "createdAt")
      VALUES (
        v_step_id, v_wf_id, v_group_id, 1, 'ANY', 'Released', NULL, v_now
      );
    END IF;

    -- Bind the workflow to the transition.
    INSERT INTO "approval_workflow_assignments"
      ("id", "tenantId", "workflowId", "transitionId", "ecoTrigger", "createdAt")
    VALUES (
      gen_random_uuid()::text,
      v_tenant."id",
      v_wf_id,
      v_trans."id",
      NULL,
      v_now
    );
  END LOOP;
END $$;

-- ─── 2. Drop the legacy mechanism ──────────────────────────────────────
--
-- Code references to this table are removed in the same change set —
-- file/bulk transitions, the approval-groups admin UI, and the
-- /api/transition-rules endpoints all stop touching it.

DROP TABLE IF EXISTS "transition_approval_rules";
