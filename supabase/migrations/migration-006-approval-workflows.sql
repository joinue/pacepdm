-- PACE PDM Migration 006: Approval Workflows Engine
-- Run this in Supabase SQL Editor

-- Named approval workflows (reusable sequences of approval steps)
CREATE TABLE "approval_workflows" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "approval_workflows_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_workflows_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "approval_workflows_tenantId_name_key" ON "approval_workflows"("tenantId", "name");

-- Ordered steps within a workflow
CREATE TABLE "approval_workflow_steps" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "stepOrder" INTEGER NOT NULL DEFAULT 1,
    "approvalMode" TEXT NOT NULL DEFAULT 'ANY',
    "signatureLabel" TEXT NOT NULL DEFAULT 'Approved',
    "deadlineHours" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "approval_workflow_steps_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_workflow_steps_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "approval_workflows"("id") ON DELETE CASCADE,
    CONSTRAINT "approval_workflow_steps_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "approval_groups"("id") ON DELETE CASCADE
);

-- approvalMode: 'ALL' (every member), 'ANY' (first member), 'MAJORITY' (50%+)
-- signatureLabel: e.g., "Design Verified", "Quality Approved", "Released to Production"

CREATE INDEX "approval_workflow_steps_workflowId_idx" ON "approval_workflow_steps"("workflowId");

-- Assign workflows to lifecycle transitions (replaces old transition_approval_rules for new requests)
CREATE TABLE "approval_workflow_assignments" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "transitionId" TEXT,
    "ecoTrigger" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "approval_workflow_assignments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_workflow_assignments_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "approval_workflows"("id") ON DELETE CASCADE,
    CONSTRAINT "approval_workflow_assignments_transitionId_fkey" FOREIGN KEY ("transitionId") REFERENCES "lifecycle_transitions"("id") ON DELETE CASCADE
);

-- ecoTrigger values: 'SUBMITTED', 'IN_REVIEW' or NULL (for file transitions)

CREATE INDEX "approval_workflow_assignments_tenantId_idx" ON "approval_workflow_assignments"("tenantId");
CREATE INDEX "approval_workflow_assignments_transitionId_idx" ON "approval_workflow_assignments"("transitionId");

-- Upgrade approval_requests to support workflows
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "workflowId" TEXT;
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "currentStepOrder" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_workflowId_fkey"
    FOREIGN KEY ("workflowId") REFERENCES "approval_workflows"("id") ON DELETE SET NULL;

-- Upgrade approval_decisions to support workflow steps
ALTER TABLE "approval_decisions" ADD COLUMN IF NOT EXISTS "stepId" TEXT;
ALTER TABLE "approval_decisions" ADD COLUMN IF NOT EXISTS "signatureLabel" TEXT;
ALTER TABLE "approval_decisions" ADD COLUMN IF NOT EXISTS "approvalMode" TEXT DEFAULT 'ANY';
ALTER TABLE "approval_decisions" ADD COLUMN IF NOT EXISTS "deadlineAt" TIMESTAMP(3);
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_stepId_fkey"
    FOREIGN KEY ("stepId") REFERENCES "approval_workflow_steps"("id") ON DELETE SET NULL;

-- Drop the old unique constraint (one decision per group per request)
-- because with workflows we may have the same group in different steps
ALTER TABLE "approval_decisions" DROP CONSTRAINT IF EXISTS "approval_decisions_requestId_groupId_key";

-- Approval history/timeline events
CREATE TABLE "approval_history" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "userId" TEXT,
    "details" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "approval_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_history_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "approval_requests"("id") ON DELETE CASCADE,
    CONSTRAINT "approval_history_userId_fkey" FOREIGN KEY ("userId") REFERENCES "tenant_users"("id") ON DELETE SET NULL
);

-- event values: 'CREATED', 'STEP_ACTIVATED', 'APPROVED', 'REJECTED', 'RECALLED',
--               'REWORK_REQUESTED', 'RESUBMITTED', 'COMPLETED', 'DEADLINE_WARNING'

CREATE INDEX "approval_history_requestId_idx" ON "approval_history"("requestId");

-- Add recall support to approval_requests
-- status can now be: PENDING, APPROVED, REJECTED, RECALLED, REWORK
