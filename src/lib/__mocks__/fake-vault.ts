/**
 * A fake Supabase project for zip tests: tables that behave like PostgREST and
 * a `vault` storage bucket whose signed links a stubbed `fetch` can serve.
 *
 * Behaves like the real thing where the zip code has been wrong before:
 *
 *   - filters are honoured, so a missing tenant or folder filter shows up as
 *     rows that should not be there;
 *   - every response is capped at `maxRows` (1,000 by default) whether or not
 *     `.range()` was asked for, so an unpaged read silently loses rows exactly
 *     as it does in production;
 *   - every `.in()` records how many values it carried.
 *
 * Install the fetch with `vi.stubGlobal("fetch", vault.fetch)`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;
type Body = Uint8Array | (() => ReadableStream<Uint8Array>);

export interface FakeVault {
  tables: Record<string, Row[]>;
  /** Stored objects by storage key. A function supplies a fresh body per fetch. */
  blobs: Map<string, Body>;
  /** Keys storage refuses to sign, as it does for an object that is gone. */
  unsignable: Set<string>;
  /** Content-Length to advertise instead of the real one. */
  declaredLengths: Map<string, number>;
  /** Tables read, in order. */
  reads: string[];
  /** Size of every `.in()` filter, in order. */
  inSizes: number[];
  /** Keys passed to each createSignedUrls call. */
  signBatches: string[][];
  /** Storage keys fetched, in order. */
  fetched: string[];
  client: SupabaseClient;
  fetch: typeof fetch;
}

const STORAGE_ORIGIN = "https://storage.test";

function likeToRegExp(pattern: string): RegExp {
  const body = [...pattern]
    .map((ch) => (ch === "%" ? ".*" : ch === "_" ? "." : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`, "s");
}

export function createFakeVault(options: { maxRows?: number } = {}): FakeVault {
  const maxRows = options.maxRows ?? 1000;
  const vault = {
    tables: {} as Record<string, Row[]>,
    blobs: new Map<string, Body>(),
    unsignable: new Set<string>(),
    declaredLengths: new Map<string, number>(),
    reads: [] as string[],
    inSizes: [] as number[],
    signBatches: [] as string[][],
    fetched: [] as string[],
  };

  function query(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let orderBy: string | null = null;
    let range: [number, number] = [0, Number.MAX_SAFE_INTEGER];

    const rows = () => {
      vault.reads.push(table);
      const matched = (vault.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (orderBy) {
        const col = orderBy;
        matched.sort((a, b) => String(a[col]).localeCompare(String(b[col])));
      }
      const [from, to] = range;
      return matched.slice(from, Math.min(to, from + maxRows - 1) + 1);
    };

    const api: Record<string, unknown> = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return api;
      },
      in: (col: string, vals: unknown[]) => {
        vault.inSizes.push(vals.length);
        const set = new Set(vals);
        filters.push((r) => set.has(r[col]));
        return api;
      },
      is: (col: string, val: null) => {
        filters.push((r) => (r[col] ?? null) === val);
        return api;
      },
      like: (col: string, pattern: string) => {
        const re = likeToRegExp(pattern);
        filters.push((r) => re.test(String(r[col])));
        return api;
      },
      order: (col: string) => {
        orderBy = col;
        return api;
      },
      range: (from: number, to: number) => {
        range = [from, to];
        return api;
      },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
    };
    return api;
  }

  const signedUrl = (key: string) => `${STORAGE_ORIGIN}/${encodeURIComponent(key)}`;

  const bucket = {
    createSignedUrls: async (paths: string[]) => {
      vault.signBatches.push([...paths]);
      return {
        data: paths.map((path) =>
          vault.unsignable.has(path)
            ? { path, error: "Object not found", signedUrl: null }
            : { path, error: null, signedUrl: signedUrl(path) }
        ),
        error: null,
      };
    },
    createSignedUrl: async (path: string) =>
      vault.unsignable.has(path)
        ? { data: null, error: { message: "Object not found" } }
        : { data: { signedUrl: signedUrl(path) }, error: null },
  };

  const fakeFetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : "url" in input ? input.url : input);
    const key = decodeURIComponent(url.pathname.slice(1));
    vault.fetched.push(key);
    const blob = vault.blobs.get(key);
    if (!blob) return new Response("not found", { status: 404 });
    const headers = new Headers();
    const declared = vault.declaredLengths.get(key);
    if (declared !== undefined) headers.set("content-length", String(declared));
    else if (blob instanceof Uint8Array) headers.set("content-length", String(blob.length));
    const body = blob instanceof Uint8Array ? blob.slice() : blob();
    return new Response(body, { headers });
  }) as typeof fetch;

  return {
    ...vault,
    client: {
      from: (table: string) => query(table),
      storage: { from: () => bucket },
      rpc: async () => ({ data: null, error: null }),
    } as unknown as SupabaseClient,
    fetch: fakeFetch,
  };
}

/** Read a whole stream into one buffer. */
export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
