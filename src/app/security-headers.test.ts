import { describe, it, expect } from "vitest";
import nextConfig from "../../next.config";

/**
 * The app shipped with no security headers at all (AUD-003 SEC-5). These pin
 * the ones that are enforced, so a config edit cannot quietly drop them.
 */
async function headersFor(path: string) {
  const rules = await nextConfig.headers!();
  const matching = rules.filter((r) =>
    new RegExp(`^${r.source.replace(":path*", ".*")}$`).test(path)
  );
  // Later rules win on the same key, as Next applies them.
  const merged = new Map<string, string>();
  for (const rule of matching) for (const h of rule.headers) merged.set(h.key, h.value);
  return merged;
}

describe("security headers", () => {
  it("refuses to be framed, on every route", async () => {
    for (const path of ["/", "/login", "/vault", "/share/abc123", "/api/health"]) {
      const h = await headersFor(path);
      expect(h.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
      expect(h.get("X-Frame-Options")).toBe("DENY");
      expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });

  it("sends no referrer from share pages, whose path carries the token", async () => {
    expect((await headersFor("/share/abc123")).get("Referrer-Policy")).toBe("no-referrer");
    expect((await headersFor("/vault")).get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin"
    );
  });

  it("reports the full policy without enforcing it yet", async () => {
    const h = await headersFor("/vault");
    const policy = h.get("Content-Security-Policy-Report-Only") ?? "";
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("'wasm-unsafe-eval'");
    expect(h.get("Content-Security-Policy")).not.toContain("default-src");
  });
});
