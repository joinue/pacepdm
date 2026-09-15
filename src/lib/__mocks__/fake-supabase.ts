/**
 * An in-memory stand-in for the Supabase client, for tests of flows whose
 * correctness depends on what the database and storage actually do.
 *
 * A mock that answers every query on a table with the same canned result
 * cannot tell "this file" from "any file", never refuses a duplicate, and never
 * loses a race — which is how the case-sensitive invite lookup and the
 * never-linked QuickBooks vendors both passed their tests. This one filters
 * rows, pages ranges the way PostgREST does, enforces the unique indexes the
 * vault relies on, and keeps storage objects with their sizes.
 *
 * Deliberately small: the query methods the vault routes use, not the whole
 * PostgREST surface.
 */

type Row = Record<string, unknown>;
type DbError = { code?: string; message: string };

/** Unique indexes, per table, as the columns that must not repeat. */
const UNIQUE: Record<string, { columns: string[]; where?: (row: Row) => boolean }[]> = {
  files: [
    { columns: ["id"] },
    // files_tenantId_folderId_name_key, partial on live rows (migration 042).
    { columns: ["tenantId", "folderId", "name"], where: (r) => (r.deletedAt ?? null) === null },
  ],
  file_versions: [{ columns: ["id"] }, { columns: ["fileId", "version"] }],
};

export interface FakeObject {
  size: number;
  contentType?: string;
}

export function createFakeSupabase(initial: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(initial)) tables[name] = rows.map((r) => ({ ...r }));

  const objects = new Map<string, FakeObject>();
  const signedUploadKeys: string[] = [];
  const removedKeys: string[] = [];
  /** Make the next write of this kind to this table fail with this error. */
  const failNext: { insert: Record<string, DbError>; update: Record<string, DbError> } = {
    insert: {},
    update: {},
  };
  /**
   * Run once, just before the next write of this kind to this table — for
   * making something change between a route loading a row and writing it.
   */
  const beforeNext: { insert: Record<string, () => void>; update: Record<string, () => void> } = {
    insert: {},
    update: {},
  };
  /** Rows per response, like PostgREST's max-rows. */
  let maxRows = 1000;

  function violatesUnique(table: string, candidate: Row): boolean {
    const rows = tables[table] ?? [];
    return (UNIQUE[table] ?? []).some(({ columns, where }) => {
      if (where && !where(candidate)) return false;
      return rows.some(
        (existing) =>
          (!where || where(existing)) && columns.every((c) => existing[c] === candidate[c])
      );
    });
  }

  function from(table: string) {
    let op: "select" | "insert" | "update" | "delete" = "select";
    let values: Row | Row[] | undefined;
    let returning = false;
    let rangeFrom: number | null = null;
    let rangeTo: number | null = null;
    let limit: number | null = null;
    const filters: ((row: Row) => boolean)[] = [];

    const exec = async (): Promise<{ data: unknown; error: DbError | null }> => {
      if (op === "insert" || op === "update") {
        const hook = beforeNext[op][table];
        if (hook) {
          delete beforeNext[op][table];
          hook();
        }
      }
      const rows = (tables[table] ??= []);

      if (op === "insert") {
        const pending = failNext.insert[table];
        if (pending) {
          delete failNext.insert[table];
          return { data: null, error: pending };
        }
        const list = (Array.isArray(values) ? values : [values]) as Row[];
        for (const row of list) {
          if (violatesUnique(table, row)) {
            return {
              data: null,
              error: {
                code: "23505",
                message: `duplicate key value violates unique constraint on ${table}`,
              },
            };
          }
          rows.push({ ...row });
        }
        return { data: returning ? list.map((r) => ({ ...r })) : null, error: null };
      }

      const matched = rows.filter((row) => filters.every((f) => f(row)));

      if (op === "update") {
        const pending = failNext.update[table];
        if (pending) {
          delete failNext.update[table];
          return { data: null, error: pending };
        }
        for (const row of matched) Object.assign(row, values);
        return { data: returning ? matched.map((r) => ({ ...r })) : null, error: null };
      }

      if (op === "delete") {
        tables[table] = rows.filter((row) => !matched.includes(row));
        return { data: null, error: null };
      }

      let out = matched;
      if (rangeFrom !== null && rangeTo !== null) {
        out = out.slice(rangeFrom, Math.min(rangeTo, rangeFrom + maxRows - 1) + 1);
      } else {
        out = out.slice(0, maxRows);
      }
      if (limit !== null) out = out.slice(0, limit);
      return { data: out.map((r) => ({ ...r })), error: null };
    };

    const query = {
      select() {
        if (op !== "select") returning = true;
        return query;
      },
      insert(v: Row | Row[]) {
        op = "insert";
        values = v;
        return query;
      },
      update(v: Row) {
        op = "update";
        values = v;
        return query;
      },
      delete() {
        op = "delete";
        return query;
      },
      eq(column: string, value: unknown) {
        filters.push((r) => r[column] === value);
        return query;
      },
      neq(column: string, value: unknown) {
        filters.push((r) => r[column] !== value);
        return query;
      },
      is(column: string, value: unknown) {
        filters.push((r) => (r[column] ?? null) === value);
        return query;
      },
      in(column: string, list: unknown[]) {
        if (list.length > 200) {
          throw new Error(`.in() with ${list.length} values would exceed the URL limit`);
        }
        filters.push((r) => list.includes(r[column]));
        return query;
      },
      order() {
        return query;
      },
      limit(n: number) {
        limit = n;
        return query;
      },
      range(a: number, b: number) {
        rangeFrom = a;
        rangeTo = b;
        return query;
      },
      async maybeSingle() {
        const res = await exec();
        if (res.error) return res;
        const list = (res.data as Row[] | null) ?? [];
        return { data: list[0] ?? null, error: null };
      },
      async single() {
        const res = await exec();
        if (res.error) return res;
        const list = (res.data as Row[] | null) ?? [];
        return list.length === 1
          ? { data: list[0], error: null }
          : {
              data: null,
              error: { code: "PGRST116", message: `expected 1 row, got ${list.length}` },
            };
      },
      then<T>(
        resolve: (v: { data: unknown; error: DbError | null }) => T,
        reject?: (e: unknown) => T
      ) {
        return exec().then(resolve, reject);
      },
    };
    return query;
  }

  const storage = {
    from: () => ({
      async createSignedUploadUrl(key: string) {
        signedUploadKeys.push(key);
        return {
          data: {
            signedUrl: `https://storage.test/upload/sign/${key}?token=t`,
            token: "t",
            path: key,
          },
          error: null,
        };
      },
      async info(key: string) {
        const object = objects.get(key);
        return object
          ? { data: { size: object.size, contentType: object.contentType }, error: null }
          : { data: null, error: { message: "Object not found" } };
      },
      async remove(keys: string[]) {
        for (const key of keys) {
          objects.delete(key);
          removedKeys.push(key);
        }
        return { data: [], error: null };
      },
      async download(key: string) {
        const object = objects.get(key);
        return object
          ? { data: new Blob([new Uint8Array(object.size)]), error: null }
          : { data: null, error: { message: "Object not found" } };
      },
      async upload(
        key: string,
        data: ArrayBuffer | Uint8Array,
        options?: { contentType?: string }
      ) {
        objects.set(key, { size: data.byteLength, contentType: options?.contentType });
        return { data: { path: key }, error: null };
      },
      async createSignedUrls(keys: string[]) {
        return {
          data: keys.map((path) => ({
            path,
            signedUrl: `https://storage.test/signed/${path}`,
            error: null,
          })),
          error: null,
        };
      },
    }),
  };

  return {
    client: { from, storage },
    tables,
    objects,
    signedUploadKeys,
    removedKeys,
    failNext,
    beforeNext,
    setMaxRows(n: number) {
      maxRows = n;
    },
    rows(table: string): Row[] {
      return tables[table] ?? [];
    },
  };
}

export type FakeSupabase = ReturnType<typeof createFakeSupabase>;
