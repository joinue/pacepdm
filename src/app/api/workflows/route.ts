import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser, hasPermission, PERMISSIONS } from "@/lib/auth";
import { v4 as uuid } from "uuid";
import { logAudit } from "@/lib/audit";
import { z, parseBody, nonEmptyString, optionalString } from "@/lib/validation";

const CreateWorkflowSchema = z.object({
  name: nonEmptyString,
  description: optionalString,
});

export async function GET() {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const db = getServiceClient();

    const { data: workflows } = await db
      .from("approval_workflows")
      .select("*, steps:approval_workflow_steps(*, group:approval_groups!approval_workflow_steps_groupId_fkey(id, name)), assignments:approval_workflow_assignments(*)")
      .eq("tenantId", tenantUser.tenantId)
      .order("name");

    // Sort steps by stepOrder
    const sorted = (workflows || []).map((w) => ({
      ...w,
      steps: ((w.steps || []) as { stepOrder: number }[]).sort((a, b) => a.stepOrder - b.stepOrder),
    }));

    return NextResponse.json(sorted);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch workflows";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const permissions = tenantUser.role.permissions as string[];
    if (!hasPermission(permissions, PERMISSIONS.ADMIN_SETTINGS)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const parsed = await parseBody(request, CreateWorkflowSchema);
    if (!parsed.ok) return parsed.response;
    const { name, description } = parsed.data;

    const db = getServiceClient();
    const now = new Date().toISOString();

    const { data: workflow, error } = await db.from("approval_workflows").insert({
      id: uuid(),
      tenantId: tenantUser.tenantId,
      name,
      description: description ?? null,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    }).select().single();

    if (error) {
      if (error.code === "23505") return NextResponse.json({ error: "A workflow with this name already exists" }, { status: 409 });
      throw error;
    }

    await logAudit({
      tenantId: tenantUser.tenantId, userId: tenantUser.id,
      action: "workflow.create", entityType: "workflow",
      entityId: workflow.id, details: { name },
    });

    return NextResponse.json(workflow);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create workflow";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
