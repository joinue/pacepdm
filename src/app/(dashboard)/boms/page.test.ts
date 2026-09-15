import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `/boms?bomId=<id>` was linked from global search and the search page, and
 * this page ignored the parameter — so those links opened the BOM list. The
 * links now go to `/boms/<id>`; the query form redirects there so a link
 * already stored or bookmarked still lands on the BOM.
 */

const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  })
);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("./boms-view", () => ({ BomsView: () => null }));

import BomsListPage from "./page";

const render = (query: Record<string, string>) =>
  BomsListPage({ searchParams: Promise.resolve(query) });

beforeEach(() => {
  redirect.mockClear();
});

describe("/boms", () => {
  it("sends ?bomId= to the BOM's own page", async () => {
    await expect(render({ bomId: "bom-3" })).rejects.toMatchObject({ url: "/boms/bom-3" });
  });

  it("shows the list with no selection otherwise", async () => {
    const page = await render({});
    expect(redirect).not.toHaveBeenCalled();
    expect(page.props).toEqual({ selectedBomId: null });
  });
});
