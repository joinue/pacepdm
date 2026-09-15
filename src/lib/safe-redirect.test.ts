import { describe, it, expect } from "vitest";
import { safeNextPath } from "./safe-redirect";

/**
 * `next` arrives in email links, so anyone can write one. The paths the app
 * itself sends — `/onboarding`, `/reset-password`, `/accept-invite` — must
 * pass through untouched, and nothing that leaves the app may.
 */
describe("safeNextPath", () => {
  it.each(["/onboarding", "/reset-password", "/accept-invite", "/vault?fileId=abc#versions"])(
    "keeps the app's own path %s",
    (path) => {
      expect(safeNextPath(path)).toBe(path);
    }
  );

  it.each([
    ["an absolute URL", "https://evil.example/login"],
    ["a protocol-relative URL", "//evil.example/login"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a bare host", "evil.example"],
    ["userinfo that swaps the host when appended to an origin", "@evil.example"],
  ])("refuses %s", (_label, next) => {
    expect(safeNextPath(next)).toBe("/");
  });

  it.each([["/\evil.example"], ["/\/evil.example"], ["/%2F/evil.example"], ["/..//evil.example"]])(
    "never lets %s leave the app, however a browser would read it",
    (next) => {
      const result = safeNextPath(next);
      expect(result).not.toContain("\\");
      expect(result.startsWith("//")).toBe(false);
      // Both ways the result is used: appended to the origin, and resolved.
      expect(new URL(result, "https://app.example").origin).toBe("https://app.example");
      expect(new URL(`https://app.example${result}`).origin).toBe("https://app.example");
    }
  );

  it("falls back to / when there is no next", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath("")).toBe("/");
  });
});
