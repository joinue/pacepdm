import type { ScopedDb } from "@/lib/tenant-db";
import { selectAll } from "@/lib/paged-query";

/**
 * Only `from` is used, so both the scoped client and the raw service client
 * (in routes not yet converted) fit. Tenant filters are applied explicitly.
 */
type Db = Pick<ScopedDb, "from">;

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
  const prefix =
    typeof s.partNumberPrefix === "string"
      ? s.partNumberPrefix
      : DEFAULT_PART_NUMBER_SETTINGS.prefix;
  const padding =
    typeof s.partNumberPadding === "number" && s.partNumberPadding > 0 && s.partNumberPadding <= 12
      ? Math.floor(s.partNumberPadding)
      : DEFAULT_PART_NUMBER_SETTINGS.padding;
  return { mode, prefix, padding };
}

export function formatPartNumber(seq: number, settings: PartNumberSettings): string {
  return `${settings.prefix}${String(seq).padStart(settings.padding, "0")}`;
}

/** `tenants.partNumberSequence` is an INTEGER; the counter can never pass this. */
const MAX_SEQUENCE = 2147483647;

/**
 * The sequence number `partNumber` would have been minted from under these
 * settings, or null when `formatPartNumber` could never produce it.
 *
 * Exact, because only an exact match can collide on the unique index:
 * `PRT-00042` is sequence 42, while `PRT-42`, `prt-00042` and `PRT-00042-A`
 * are numbers the counter will never hand out and so never collide with.
 */
export function sequenceFromPartNumber(
  partNumber: string,
  settings: PartNumberSettings
): number | null {
  if (!partNumber.startsWith(settings.prefix)) return null;
  const digits = partNumber.slice(settings.prefix.length);
  if (!/^\d+$/.test(digits)) return null;
  const seq = Number(digits);
  if (!Number.isSafeInteger(seq) || seq > MAX_SEQUENCE) return null;
  return formatPartNumber(seq, settings) === partNumber ? seq : null;
}

// Compare-and-swap loop that hands out a unique partNumberSequence to each
// caller. Two concurrent allocators can both read seq=5, but only one will
// successfully update from 5→6 because the WHERE clause includes the prior
// value. The loser sees zero rows returned and retries with the fresh seq.
export async function nextPartNumberSequence(db: Db, tenantId: string): Promise<number> {
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

/**
 * Raise the tenant's counter to at least `atLeast`. Never lowers it.
 *
 * The same compare-and-swap as `nextPartNumberSequence`, so it cannot undo an
 * allocation that lands between the read and the write: if another caller
 * moved the counter, the update matches no row and the loop re-reads — and
 * stops as soon as the counter is already high enough.
 */
export async function advancePartNumberSequence(
  db: Db,
  tenantId: string,
  atLeast: number
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const { data: current, error: readError } = await db
      .from("tenants")
      .select("partNumberSequence")
      .eq("id", tenantId)
      .single();
    if (readError || !current) throw new Error("Failed to read tenant sequence");

    const prev = (current.partNumberSequence as number | null) ?? 0;
    if (prev >= atLeast) return;

    const { data: updated, error: updateError } = await db
      .from("tenants")
      .update({ partNumberSequence: atLeast })
      .eq("id", tenantId)
      .eq("partNumberSequence", prev)
      .select("partNumberSequence");
    if (updateError) throw updateError;
    if (updated && updated.length === 1) return;
  }
  throw new Error("Failed to advance part number sequence after 20 attempts");
}

/** Escape a literal for a Postgres regular expression. */
function escapeRegex(literal: string): string {
  return literal.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}

/**
 * The highest sequence number any existing part already occupies under these
 * settings — including parts in the trash, which still own their number on
 * `parts_tenantId_partNumber_key`. 0 when none does.
 *
 * Two reads, both filtered in the database to numbers the format can produce:
 *
 *   - exactly `padding` digits, where text order is numeric order, so the
 *     first row descending is the answer;
 *   - more digits than that with no leading zero — a counter that outgrew its
 *     padding, or an import that did. Any of these is higher than every
 *     padded number. Normally there are none, so they are read in full rather
 *     than sorted by length, which PostgREST cannot do.
 */
export async function highestTakenSequence(
  db: Db,
  tenantId: string,
  settings: PartNumberSettings
): Promise<number> {
  const prefix = escapeRegex(settings.prefix);
  const { padding } = settings;

  const longer = await selectAll<{ partNumber: string }>((from, to) =>
    db
      .from("parts")
      .select("id, partNumber")
      .eq("tenantId", tenantId)
      .filter("partNumber", "match", `^${prefix}[1-9][0-9]{${padding},}$`)
      .order("id")
      .range(from, to)
  );
  const longest = longer
    .map((p) => sequenceFromPartNumber(p.partNumber, settings))
    .reduce<number>((max, seq) => Math.max(max, seq ?? 0), 0);
  if (longest > 0) return longest;

  const { data, error } = await db
    .from("parts")
    .select("partNumber")
    .eq("tenantId", tenantId)
    .filter("partNumber", "match", `^${prefix}[0-9]{${padding}}$`)
    .order("partNumber", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const top = (data as Array<{ partNumber: string }> | null)?.[0];
  return top ? (sequenceFromPartNumber(top.partNumber, settings) ?? 0) : 0;
}

/**
 * Make sure the counter is past every number in `partNumbers` that it could
 * otherwise mint later. Called after parts land with numbers that did not
 * come from the counter — typed by hand, or imported.
 */
export async function advanceSequencePastNumbers(
  db: Db,
  tenantId: string,
  settings: PartNumberSettings,
  partNumbers: Iterable<string>
): Promise<void> {
  let highest = 0;
  for (const pn of partNumbers) {
    highest = Math.max(highest, sequenceFromPartNumber(pn, settings) ?? 0);
  }
  if (highest > 0) await advancePartNumberSequence(db, tenantId, highest);
}
