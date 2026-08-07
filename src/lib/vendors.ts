import { v4 as uuid } from "uuid";
import type { ScopedDb } from "@/lib/tenant-db";

/**
 * Canonicalize a vendor name so "Digi-Key", "digi-key" and "Digi  Key " all
 * resolve to the same vendor.
 *
 * The unique index behind this (`vendors_tenantId_name_key`, migration 009) is
 * an **exact match** on `name`, so normalization has to happen here or the
 * database will happily hold three rows for one vendor. Every insert and every
 * lookup goes through this function.
 */
export function normalizeVendorName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Resolves vendor names to vendor ids for a bulk import, creating the ones
 * that do not exist yet.
 *
 * A per-row `select`-then-`insert` would be two round trips per part against a
 * table with a few dozen rows in it. This loads the tenant's vendors once and
 * answers from memory, falling back to a write only for a genuinely new name.
 *
 * `created` counts the vendors this resolver brought into existence, so the
 * caller can tell the user that an import added them rather than leaving the
 * new rows to be discovered later.
 */
export function createVendorResolver(db: ScopedDb) {
  /** Lowercased canonical name → vendor id. */
  const byName = new Map<string, string>();
  let loaded = false;
  let created = 0;

  async function load() {
    // Scoped client → already filtered to the caller's tenant.
    const { data, error } = await db.from("vendors").select("id, name");
    if (error) throw new Error(error.message);
    for (const v of data ?? []) {
      byName.set(normalizeVendorName(v.name as string).toLowerCase(), v.id as string);
    }
    loaded = true;
  }

  return {
    /**
     * The vendor id for `rawName`, creating the vendor if this tenant has no
     * such name. Returns null for a name that is empty once normalized.
     */
    async resolve(rawName: string, now: string): Promise<string | null> {
      const name = normalizeVendorName(rawName);
      if (!name) return null;

      if (!loaded) await load();

      const key = name.toLowerCase();
      const known = byName.get(key);
      if (known) return known;

      const { data, error } = await db
        .from("vendors")
        .insert({ id: uuid(), name, createdAt: now, updatedAt: now })
        .select("id")
        .single();

      if (error) {
        // Another writer got there between the load and this insert. The
        // unique index is exact-match, so 23505 means this exact name now
        // exists — read it back rather than failing the row.
        //
        // Deliberately `.eq()` and not `.ilike()`: a vendor name may contain
        // `%` or `_`, which ilike would read as wildcards and match the wrong
        // row. Only an exact collision can raise 23505 in the first place.
        if (error.code === "23505") {
          const { data: raced } = await db
            .from("vendors")
            .select("id")
            .eq("name", name)
            .maybeSingle();
          if (raced) {
            byName.set(key, raced.id as string);
            return raced.id as string;
          }
        }
        throw new Error(error.message);
      }

      byName.set(key, data.id as string);
      created++;
      return data.id as string;
    },

    /** How many vendors this resolver created. */
    get created() {
      return created;
    },
  };
}
