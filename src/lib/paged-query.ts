/**
 * Reading more rows than PostgREST returns in one response.
 *
 * PostgREST caps every response (1,000 rows by default, and a project can set
 * it lower). A plain `.select()` past that returns the first page and no error,
 * so the vault listing, zip builder and BOM reads quietly lost rows once a
 * tenant had enough of them. And `.in("id", ids)` puts every id in the URL,
 * which the gateway refuses somewhere past a few hundred UUIDs — also as an
 * error nobody checked.
 *
 * Callers must order the query by something unique (append `id` as a
 * tiebreaker), or rows can repeat or vanish between pages.
 */

type PageResult<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/** How many ids go into one `.in()` filter. Well under the URL limit. */
export const IN_FILTER_CHUNK = 100;

const REQUEST_PAGE = 1000;

/**
 * Every row a query matches, fetched a page at a time.
 *
 * `page(from, to)` must apply `.range(from, to)` to a freshly built, ordered
 * query. Stops on an empty page rather than a short one: a project configured
 * with a lower max-rows returns short pages that are not the last.
 */
export async function selectAll<T>(
  page: (from: number, to: number) => PageResult<T>
): Promise<T[]> {
  const rows: T[] = [];
  for (;;) {
    const { data, error } = await page(rows.length, rows.length + REQUEST_PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return rows;
    rows.push(...data);
  }
}

/**
 * Every row matching an `.in()` over `ids`, split into URL-safe chunks and
 * paged within each chunk.
 *
 * `page(chunk, from, to)` builds the query for one chunk of ids.
 */
export async function selectAllIn<T>(
  ids: readonly string[],
  page: (chunk: string[], from: number, to: number) => PageResult<T>
): Promise<T[]> {
  const unique = [...new Set(ids)];
  const rows: T[] = [];
  for (let i = 0; i < unique.length; i += IN_FILTER_CHUNK) {
    const slice = unique.slice(i, i + IN_FILTER_CHUNK);
    rows.push(...(await selectAll((from, to) => page(slice, from, to))));
  }
  return rows;
}
