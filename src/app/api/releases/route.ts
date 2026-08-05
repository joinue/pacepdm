import { withTenant } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { z, ilikeContains } from "@/lib/validation";
import type { ReleaseManifest } from "@/lib/releases";

/**
 * GET /api/releases
 *
 * The release list. Releases have existed since migration 033 and were
 * reachable from exactly one place — the ECO detail panel — so the
 * packaged output of a change order could only be found by whoever
 * remembered which ECO produced it. Sourcing does not remember that.
 *
 * Returns headers only. The manifest is a jsonb blob that grows with the
 * size of the change, and a list of fifty of them would be megabytes of
 * payload to render three counts per row — so the counts are computed
 * server-side and the manifest itself is dropped. The detail route
 * (`/api/releases/[releaseId]`) is what serves the full thing.
 */

const QuerySchema = z.object({
  /** Free-text match against release name and ECO number. */
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

interface ReleaseListRow {
  id: string;
  name: string;
  ecoId: string;
  ecoNumber: string;
  releasedAt: string;
  note: string | null;
  releasedBy: { fullName: string | null } | null;
  partCount: number;
  fileCount: number;
  bomCount: number;
}

export const GET = withTenant(
  { permission: PERMISSIONS.FILE_VIEW, query: QuerySchema },
  async ({ db, query }) => {
    let select = db
      .from("releases")
      .select(
        `id, name, ecoId, ecoNumber, releasedAt, note, manifest,
         releasedBy:tenant_users!releases_releasedById_fkey(fullName)`
      )
      .order("releasedAt", { ascending: false })
      .range(query.offset, query.offset + query.limit - 1);

    if (query.q) {
      // `or` takes a raw PostgREST filter string, so an interpolated term is
      // parsed as syntax. This originally stripped `,()` on the reasoning
      // that none appear in a release name — quoting is better, and it is
      // what every other search does now. See ilikeContains.
      const term = ilikeContains(query.q);
      select = select.or(`name.ilike.${term},ecoNumber.ilike.${term}`);
    }

    const { data, error } = await select;
    if (error) throw new Error(error.message);

    const rows: ReleaseListRow[] = ((data ?? []) as Record<string, unknown>[]).map((r) => {
      const manifest = (r.manifest ?? {}) as Partial<ReleaseManifest>;
      return {
        id: r.id as string,
        name: (r.name as string) ?? "",
        ecoId: r.ecoId as string,
        ecoNumber: (r.ecoNumber as string) ?? "",
        releasedAt: r.releasedAt as string,
        note: (r.note as string | null) ?? null,
        releasedBy: (r.releasedBy as unknown as { fullName: string | null } | null) ?? null,
        partCount: manifest.parts?.length ?? 0,
        fileCount: manifest.files?.length ?? 0,
        bomCount: manifest.boms?.length ?? 0,
      };
    });

    return rows;
  }
);
