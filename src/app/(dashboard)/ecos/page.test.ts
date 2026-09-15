import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `/ecos?ecoId=<id>` was linked from global search, the search page,
 * where-used, the file panel and the BOM revision history, and this page
 * ignored the parameter — so every one of those links opened the ECO list.
 * The links now go to `/ecos/<id>`; the query form redirects there so a link
 * already stored or bookmarked still lands on the ECO.
 */

const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  })
);
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("./ecos-view", () => ({ EcosView: () => null }));

import EcosListPage from "./page";

const render = (query: Record<string, string | string[]>) =>
  EcosListPage({ searchParams: Promise.resolve(query) });

beforeEach(() => {
  redirect.mockClear();
});

describe("/ecos", () => {
  it("sends ?ecoId= to the ECO's own page", async () => {
    await expect(render({ ecoId: "eco-7" })).rejects.toMatchObject({ url: "/ecos/eco-7" });
  });

  it("escapes the id rather than building a path from it", async () => {
    await expect(render({ ecoId: "../admin" })).rejects.toMatchObject({
      url: "/ecos/..%2Fadmin",
    });
  });

  it("shows the list with no selection otherwise", async () => {
    const page = await render({});
    expect(redirect).not.toHaveBeenCalled();
    expect(page.props).toEqual({ selectedEcoId: null });
  });

  it("ignores a repeated parameter", async () => {
    await render({ ecoId: ["a", "b"] });
    expect(redirect).not.toHaveBeenCalled();
  });
});
