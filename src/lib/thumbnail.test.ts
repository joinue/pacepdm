import { describe, it, expect } from "vitest";
import { isSolidWorksFile, extractThumbnail } from "./thumbnail";

describe("isSolidWorksFile", () => {
  it("detects .sldprt files", () => {
    expect(isSolidWorksFile("bracket.sldprt")).toBe(true);
  });

  it("detects .sldasm files", () => {
    expect(isSolidWorksFile("assembly.sldasm")).toBe(true);
  });

  it("detects .slddrw files", () => {
    expect(isSolidWorksFile("drawing.slddrw")).toBe(true);
  });

  it("is case-insensitive on extension", () => {
    expect(isSolidWorksFile("Part.SLDPRT")).toBe(true);
    expect(isSolidWorksFile("ASSEMBLY.SldAsm")).toBe(true);
  });

  it("rejects non-SolidWorks files", () => {
    expect(isSolidWorksFile("model.step")).toBe(false);
    expect(isSolidWorksFile("drawing.dwg")).toBe(false);
    expect(isSolidWorksFile("readme.pdf")).toBe(false);
    expect(isSolidWorksFile("image.png")).toBe(false);
  });

  it("matches bare extension name (no dot) since pop() returns the whole string", () => {
    // "sldprt".split(".").pop() === "sldprt" which IS in the list
    expect(isSolidWorksFile("sldprt")).toBe(true);
  });

  it("rejects files with unrelated extension", () => {
    expect(isSolidWorksFile("noext")).toBe(false);
  });

  it("handles files with multiple dots", () => {
    expect(isSolidWorksFile("rev.2.bracket.sldprt")).toBe(true);
  });

  it("handles empty string", () => {
    expect(isSolidWorksFile("")).toBe(false);
  });
});

// ─── extractThumbnail dispatcher ──────────────────────────────────────────

describe("extractThumbnail — dispatcher", () => {
  it("returns null for unsupported formats (e.g. STEP)", async () => {
    const junk = new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer;
    const result = await extractThumbnail(junk, "mystery.step");
    expect(result).toBeNull();
  });
});

// ─── PDF path ─────────────────────────────────────────────────────────────
//
// Minimal PDF 1.0 — a single page, 300x144pt, "Hello World" in Helvetica.
// A well-known canonical example used to verify PDF readers can parse the
// basic object/xref structure. Fits in ~450 bytes.

const MINIMAL_PDF = `%PDF-1.0
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 18 Tf 20 50 Td (Hello World) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000053 00000 n
0000000091 00000 n
0000000173 00000 n
0000000231 00000 n
trailer<</Size 6/Root 1 0 R>>
startxref
284
%%EOF`;

function pdfBuffer(): ArrayBuffer {
  const bytes = new TextEncoder().encode(MINIMAL_PDF);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// PNG file signature: 89 50 4E 47 0D 0A 1A 0A
function isPng(data: Uint8Array): boolean {
  return (
    data.length > 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  );
}

describe("extractThumbnail — PDF", () => {
  // Exercises the actual pdfjs-dist + @napi-rs/canvas pipeline. Slower
  // than the rest of the suite (~1s cold) but worth the coverage — this
  // path has a lot of dynamic-import + native-binding surface area that
  // unit-level mocks wouldn't exercise.
  it("rasterizes the first page of a minimal PDF to PNG bytes", async () => {
    const result = await extractThumbnail(pdfBuffer(), "sample.pdf");

    expect(result).not.toBeNull();
    expect(result!.mimeType).toBe("image/png");
    expect(result!.ext).toBe("png");
    expect(isPng(result!.data)).toBe(true);
    // Sanity: a 400px-bounded white-background PNG should be at least
    // a few hundred bytes (PNG headers + minimal IDAT).
    expect(result!.data.length).toBeGreaterThan(200);
  }, 10_000);
});
