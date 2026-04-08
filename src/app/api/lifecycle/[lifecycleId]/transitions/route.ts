import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { getCurrentTenantUser } from "@/lib/auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ lifecycleId: string }> }
) {
  try {
    await getCurrentTenantUser();
    const { lifecycleId } = await params;
    const { searchParams } = new URL(request.url);
    const fromState = searchParams.get("fromState");

    if (!fromState) {
      return NextResponse.json({ error: "fromState is required" }, { status: 400 });
    }

    const db = getServiceClient();

    // Get the state ID for the current state name
    const { data: stateRow } = await db
      .from("lifecycle_states")
      .select("id")
      .eq("lifecycleId", lifecycleId)
      .eq("name", fromState)
      .single();

    if (!stateRow) {
      return NextResponse.json([]);
    }

    const { data: transitions } = await db
      .from("lifecycle_transitions")
      .select("id, name, toState:lifecycle_states!lifecycle_transitions_toStateId_fkey(name)")
      .eq("lifecycleId", lifecycleId)
      .eq("fromStateId", stateRow.id);

    return NextResponse.json(transitions || []);
  } catch {
    return NextResponse.json({ error: "Failed to fetch transitions" }, { status: 500 });
  }
}
