import { NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getApiTenantUser } from "@/lib/auth";

export async function GET() {
  try {
    const tenantUser = await getApiTenantUser();
    if (!tenantUser) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const db = getServiceClient();

    // Get all lifecycles for tenant
    const { data: lifecycles } = await db
      .from("lifecycles")
      .select("id, name")
      .eq("tenantId", tenantUser.tenantId);

    if (!lifecycles || lifecycles.length === 0) {
      return NextResponse.json([]);
    }

    const lifecycleIds = lifecycles.map((l) => l.id);
    const lifecycleMap = Object.fromEntries(lifecycles.map((l) => [l.id, l.name]));

    // Get all transitions with state names
    const { data: transitions } = await db
      .from("lifecycle_transitions")
      .select(`
        id, name, lifecycleId, requiresApproval,
        fromState:lifecycle_states!lifecycle_transitions_fromStateId_fkey(name),
        toState:lifecycle_states!lifecycle_transitions_toStateId_fkey(name)
      `)
      .in("lifecycleId", lifecycleIds)
      .order("name");

    const result = (transitions || []).map((t) => ({
      id: t.id,
      name: t.name,
      lifecycleName: lifecycleMap[t.lifecycleId] || "Unknown",
      fromState: (Array.isArray(t.fromState) ? t.fromState[0]?.name : (t.fromState as { name: string })?.name) || "?",
      toState: (Array.isArray(t.toState) ? t.toState[0]?.name : (t.toState as { name: string })?.name) || "?",
      requiresApproval: t.requiresApproval,
    }));

    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "Failed to fetch transitions" }, { status: 500 });
  }
}
