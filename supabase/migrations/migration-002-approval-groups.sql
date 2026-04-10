-- PACE PDM Migration 002: Approval Groups & Workflow Approvals
-- Run this in Supabase SQL Editor

-- Approval Groups (e.g., "ME Approvers", "Quality Review", "Release Authority")
CREATE TABLE "approval_groups" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "approval_groups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_groups_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "approval_groups_tenantId_name_key" ON "approval_groups"("tenantId", "name");

-- Members of approval groups
CREATE TABLE "approval_group_members" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "approval_group_members_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "approval_groups"("id") ON DELETE CASCADE,
    CONSTRAINT "approval_group_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "tenant_users"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "approval_group_members_groupId_userId_key" ON "approval_group_members"("groupId", "userId");

-- Approval requirements for lifecycle transitions (which groups must approve)
CREATE TABLE "transition_approval_rules" (
    "id" TEXT NOT NULL,
    "transitionId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "transition_approval_rules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "transition_approval_rules_transitionId_fkey" FOREIGN KEY ("transitionId") REFERENCES "lifecycle_transitions"("id") ON DELETE CASCADE,
    CONSTRAINT "transition_approval_rules_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "approval_groups"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "transition_approval_rules_transitionId_groupId_key" ON "transition_approval_rules"("transitionId", "groupId");

-- Approval requests (created when a file transition or ECO needs approval)
CREATE TABLE "approval_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "transitionId" TEXT,
    "requestedById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
    CONSTRAINT "approval_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "tenant_users"("id")
);

CREATE INDEX "approval_requests_tenantId_status_idx" ON "approval_requests"("tenantId", "status");

-- Individual approval decisions within a request
CREATE TABLE "approval_decisions" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "deciderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "comment" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "approval_decisions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "approval_decisions_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "approval_requests"("id") ON DELETE CASCADE,
    CONSTRAINT "approval_decisions_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "approval_groups"("id"),
    CONSTRAINT "approval_decisions_deciderId_fkey" FOREIGN KEY ("deciderId") REFERENCES "tenant_users"("id")
);

CREATE UNIQUE INDEX "approval_decisions_requestId_groupId_key" ON "approval_decisions"("requestId", "groupId");

-- Add approval group requirements to ECOs
ALTER TABLE "ecos" ADD COLUMN IF NOT EXISTS "approvalRequestId" TEXT;
ALTER TABLE "ecos" ADD CONSTRAINT "ecos_approvalRequestId_fkey" FOREIGN KEY ("approvalRequestId") REFERENCES "approval_requests"("id") ON DELETE SET NULL;
