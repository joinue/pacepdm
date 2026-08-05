import { describe, it, expect } from "vitest";
import { buildPartPackage, partZipFilename } from "./part-package";

/**
 * The lifecycle filter is the safety-critical part of a part share: it is
 * what stops a supplier quoting from someone's work in progress. These tests
 * pin the two behaviours that must never regress silently — the default
 * withholds unreleased files, and the opt-in flags rather than hides them.
 *
 * Mocked at the Supabase client boundary. The mock honours `.eq()` filters,
 * because a mock that ignores them makes a missing tenant filter untestable
 * (see the note in docs/plans/codebase-hardening.md).
 */

const TENANT = "tenant-1";

interface Row {
  [key: string]: unknown;
}

function makeDb(tables: Record<string, Row[]>) {
  function query(table: string) {
    let rows = [...(tables[table] ?? [])];
    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        rows = rows.filter((r) => r[col] === val);
        return api;
      },
      is: (col: string, val: null) => {
        rows = rows.filter((r) => (r[col] ?? null) === val);
        return api;
      },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        resolve({ data: rows, error: null }),
    };
    return api;
  }
  return {
    from: (table: string) => query(table),
    storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) },
  } as never;
}

const PART = {
  id: "part-1",
  tenantId: TENANT,
  partNumber: "N1S-M-001",
  name: "Housing",
  description: null,
  revision: "R2",
  lifecycleState: "WIP",
  category: "MANUFACTURED",
  material: "6061",
  unit: "EA",
  weight: null,
  weightUnit: "kg",
  deletedAt: null,
};

function fixture() {
  return {
    parts: [PART],
    part_files: [
      {
        partId: "part-1",
        role: "DRAWING",
        isPrimary: true,
        file: {
          id: "file-released",
          name: "DWG-001.pdf",
          fileType: "pdf",
          currentVersion: 3,
          revision: "B",
          lifecycleState: "Released",
          tenantId: TENANT,
          deletedAt: null,
        },
      },
      {
        partId: "part-1",
        role: "MODEL_3D",
        isPrimary: false,
        file: {
          id: "file-wip",
          name: "MODEL-001.step",
          fileType: "step",
          currentVersion: 1,
          revision: "A",
          lifecycleState: "WIP",
          tenantId: TENANT,
          deletedAt: null,
        },
      },
    ],
    file_versions: [
      { fileId: "file-released", version: 3, storageKey: "vault/dwg-001.pdf" },
      { fileId: "file-wip", version: 1, storageKey: "vault/model-001.step" },
    ],
    boms: [],
  };
}

describe("buildPartPackage lifecycle filter", () => {
  it("withholds unreleased files by default", async () => {
    const pkg = await buildPartPackage(makeDb(fixture()), TENANT, "part-1");
    expect(pkg).not.toBeNull();
    expect(pkg!.files.map((f) => f.fileName)).toEqual(["DWG-001.pdf"]);
    expect(pkg!.filesWithheld).toBe(1);
    expect(pkg!.preliminaryCount).toBe(0);
    expect(pkg!.includesWip).toBe(false);
  });

  it("includes unreleased files when opted in, flagged rather than hidden", async () => {
    const pkg = await buildPartPackage(makeDb(fixture()), TENANT, "part-1", {
      includeWip: true,
    });
    expect(pkg!.files).toHaveLength(2);
    expect(pkg!.filesWithheld).toBe(0);
    expect(pkg!.preliminaryCount).toBe(1);

    const wip = pkg!.files.find((f) => f.fileName === "MODEL-001.step");
    expect(wip!.isPreliminary).toBe(true);
    const released = pkg!.files.find((f) => f.fileName === "DWG-001.pdf");
    expect(released!.isPreliminary).toBe(false);
  });

  it("sorts released documents ahead of preliminary ones", async () => {
    // A recipient who reads only the top of the list must be reading the
    // approved work — even though the WIP file here is not the primary.
    const fx = fixture();
    fx.part_files[0].isPrimary = false;
    fx.part_files[1].isPrimary = true;
    const pkg = await buildPartPackage(makeDb(fx), TENANT, "part-1", { includeWip: true });
    expect(pkg!.files[0].isPreliminary).toBe(false);
    expect(pkg!.files[1].isPreliminary).toBe(true);
  });

  it("does not leak a file belonging to another tenant through the link row", async () => {
    const fx = fixture();
    (fx.part_files[0].file as Record<string, unknown>).tenantId = "tenant-2";
    const pkg = await buildPartPackage(makeDb(fx), TENANT, "part-1", { includeWip: true });
    expect(pkg!.files.map((f) => f.fileId)).toEqual(["file-wip"]);
  });

  it("returns null for a part in another tenant", async () => {
    const pkg = await buildPartPackage(makeDb(fixture()), "tenant-2", "part-1");
    expect(pkg).toBeNull();
  });

  it("skips a file whose current version row is missing without calling it withheld", async () => {
    const fx = fixture();
    fx.file_versions = fx.file_versions.filter((v) => v.fileId !== "file-released");
    const pkg = await buildPartPackage(makeDb(fx), TENANT, "part-1");
    expect(pkg!.files).toHaveLength(0);
    // The released file is broken, not suppressed — reporting it as withheld
    // would tell the sender to go release something that already is.
    expect(pkg!.filesWithheld).toBe(1);
  });
});

describe("partZipFilename", () => {
  it("is filesystem-safe and carries the revision", async () => {
    const pkg = await buildPartPackage(makeDb(fixture()), TENANT, "part-1");
    expect(partZipFilename(pkg!)).toBe("N1S-M-001-R2.zip");
  });

  it("strips characters Windows refuses", () => {
    const pkg = { partNumber: "A/B:C*D", revision: "R1" } as never;
    expect(partZipFilename(pkg)).toBe("A_B_C_D-R1.zip");
  });
});
