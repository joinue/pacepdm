import type { SupabaseClient } from "@supabase/supabase-js";

export type PartNumberMode = "AUTO" | "MANUAL";

export interface PartNumberSettings {
  mode: PartNumberMode;
  prefix: string;
  padding: number;
}

export const DEFAULT_PART_NUMBER_SETTINGS: PartNumberSettings = {
  mode: "AUTO",
  prefix: "PRT-",
  padding: 5,
};

export function readPartNumberSettings(raw: unknown): PartNumberSettings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const mode = s.partNumberMode === "MANUAL" ? "MANUAL" : "AUTO";
  const prefix = typeof s.partNumberPrefix === "string" ? s.partNumberPrefix : DEFAULT_PART_NUMBER_SETTINGS.prefix;
  const padding =
    typeof s.partNumberPadding === "number" && s.partNumberPadding > 0 && s.partNumberPadding <= 12
      ? Math.floor(s.partNumberPadding)
      : DEFAULT_PART_NUMBER_SETTINGS.padding;
  return { mode, prefix, padding };
}

export function formatPartNumber(seq: number, settings: PartNumberSettings): string {
  return `${settings.prefix}${String(seq).padStart(settings.padding, "0")}`;
}

// Compare-and-swap loop that hands out a unique partNumberSequence to each
// caller. Two concurrent allocators can both read seq=5, but only one will
// successfully update from 5→6 because the WHERE clause includes the prior
// value. The loser sees zero rows returned and retries with the fresh seq.
export async function nextPartNumberSequence(
  db: SupabaseClient,
  tenantId: string,
): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const { data: current, error: readError } = await db
      .from("tenants")
      .select("partNumberSequence")
      .eq("id", tenantId)
      .single();
    if (readError || !current) throw new Error("Failed to read tenant sequence");

    const prev = (current.partNumberSequence as number | null) ?? 0;
    const next = prev + 1;

    const { data: updated, error: updateError } = await db
      .from("tenants")
      .update({ partNumberSequence: next })
      .eq("id", tenantId)
      .eq("partNumberSequence", prev)
      .select("partNumberSequence");
    if (updateError) throw updateError;
    if (updated && updated.length === 1) return next;
    // CAS lost — another allocator bumped the counter. Retry.
  }
  throw new Error("Failed to allocate part number after 20 attempts");
}
