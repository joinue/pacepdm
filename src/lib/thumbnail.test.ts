import { describe, it, expect, beforeAll } from "vitest";
import { constants as zlibConstants, deflateSync, type ZlibOptions } from "node:zlib";
import CFB from "cfb";
import sharp from "sharp";
import {
  isSolidWorksFile,
  extractThumbnail,
  extractSolidWorksThumbnailWithReport,
} from "./thumbnail";

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
  // Run the way the deployed function does: with pdf.js unable to load its
  // worker from a path. The build's file tracer never copied
  // pdf.worker.mjs into the Vercel function, because pdf.js imports it by a
  // path computed at runtime, so every PDF thumbnail failed in production
  // while passing here, where node_modules is whole. Pointing workerSrc at
  // nothing reproduces that. It has to happen before the first render in
  // this file: pdf.js caches the worker it loads.
  beforeAll(async () => {
    const { GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    GlobalWorkerOptions.workerSrc = "./not-deployed/pdf.worker.mjs";
  });

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

// ─── SOLIDWORKS: modern (non-OLE) container ───────────────────────────────
//
// Files from SolidWorks 2015+ aren't OLE compound documents, so the extractor
// scans the raw bytes for images and for zlib streams that inflate to one.
// These build that shape synthetically: noise, with the container's magic
// up front and a preview dropped in somewhere in the middle.

const MB = 1024 * 1024;

/** Deterministic noise (xorshift32), so a failure reproduces exactly. */
function noise(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  const words = new Uint32Array(out.buffer, 0, length >>> 2);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < words.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    words[i] = x;
  }
  return out;
}

function modernSolidWorksFile(
  size: number,
  embeds: { offset: number; bytes: Uint8Array }[],
  seed = 1
): ArrayBuffer {
  const file = noise(size, seed);
  file.set([0xc5, 0x5c, 0xef, 0x65], 0);
  for (const { offset, bytes } of embeds) file.set(bytes, offset);
  return file.buffer;
}

/** A real, decodable PNG. Uncompressed IDAT so deflate has something to do. */
async function previewPng(): Promise<Uint8Array> {
  const png = await sharp({
    create: { width: 96, height: 64, channels: 3, background: { r: 40, g: 90, b: 200 } },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  return new Uint8Array(png);
}

describe("extractSolidWorksThumbnailWithReport — modern container", () => {
  let png: Uint8Array;
  beforeAll(async () => {
    png = await previewPng();
  });

  // Every DEFLATE block type, plus a header other than the usual 0x78: the
  // scan's cheap pre-check reads each of these differently, so each needs
  // to be shown to reach zlib.
  const encodings: { label: string; options: ZlibOptions; cmf: number; blockType: number }[] = [
    { label: "dynamic Huffman", options: {}, cmf: 0x78, blockType: 2 },
    {
      label: "fixed Huffman",
      options: { strategy: zlibConstants.Z_FIXED },
      cmf: 0x78,
      blockType: 1,
    },
    { label: "stored", options: { level: 0 }, cmf: 0x78, blockType: 0 },
    { label: "a 512-byte window", options: { windowBits: 9 }, cmf: 0x18, blockType: 2 },
  ];

  it.each(encodings)(
    "finds a zlib-compressed PNG ($label) embedded mid-file",
    async ({ options, cmf, blockType }) => {
      const stream = deflateSync(png, options);
      // Guard the fixture: it must actually be the encoding it claims.
      expect(stream[0]).toBe(cmf);
      expect((stream[2] >> 1) & 3).toBe(blockType);

      const offset = 150_001;
      const file = modernSolidWorksFile(400_000, [{ offset, bytes: stream }]);
      const { thumbnail, report } = await extractSolidWorksThumbnailWithReport(file);

      // Assert on the stream, not only the pick: a stored block holds the
      // PNG verbatim, so the raw-bytes pass finds that one too.
      expect(report.streams).toContainEqual({
        name: `zlib@${offset}`,
        size: png.length,
        magicHex: "89 50 4e 47 0d 0a 1a 0a",
        detected: "png",
      });
      expect(report.picked?.size).toBe(png.length);
      expect(thumbnail?.mimeType).toBe("image/png");
      expect(Buffer.from(thumbnail!.data).equals(Buffer.from(png))).toBe(true);
    }
  );

  it("skips a stream that inflates past any plausible preview, and finds the one after it", async () => {
    // A PNG signature followed by 40 MB of zeros: ~40 KB compressed.
    const bomb = deflateSync(Buffer.concat([png.subarray(0, 8), Buffer.alloc(40 * MB)]));
    const stream = deflateSync(png);
    const bombOffset = 10_000;
    const pngOffset = bombOffset + bomb.length + 10_000;
    const file = modernSolidWorksFile(pngOffset + stream.length + 10_000, [
      { offset: bombOffset, bytes: bomb },
      { offset: pngOffset, bytes: stream },
    ]);

    const { thumbnail, report } = await extractSolidWorksThumbnailWithReport(file);

    expect(report.picked?.name).toBe(`zlib@${pngOffset}`);
    expect(thumbnail).not.toBeNull();
    expect(report.streams.map((s) => s.name)).not.toContain(`zlib@${bombOffset}`);
  }, 20_000);

  it("stops once the zlib work budget is spent", async () => {
    // Each copy looks like a PNG and runs the inflater to its output cap.
    const bomb = deflateSync(Buffer.concat([png.subarray(0, 8), Buffer.alloc(40 * MB)]));
    const embeds = Array.from({ length: 10 }, (_, i) => ({
      offset: 100 + i * (bomb.length + 100),
      bytes: bomb,
    }));
    const file = modernSolidWorksFile(100 + 10 * (bomb.length + 100), embeds);

    const { thumbnail, report } = await extractSolidWorksThumbnailWithReport(file);

    expect(thumbnail).toBeNull();
    expect(report.reason).toMatch(/Scan stopped early: spent the \d+ MB zlib work budget/);
  }, 20_000);

  it("stops collecting after a bounded number of zlib image streams", async () => {
    // Hundreds of tiny streams that each inflate to a (bogus) bitmap header.
    const dib = new Uint8Array(200);
    dib.set([40, 0, 0, 0]);
    const stream = deflateSync(dib);
    const embeds = Array.from({ length: 1000 }, (_, i) => ({
      offset: 100 + i * (stream.length + 10),
      bytes: stream,
    }));
    const file = modernSolidWorksFile(100 + 1000 * (stream.length + 10), embeds);

    const { thumbnail, report } = await extractSolidWorksThumbnailWithReport(file);

    expect(thumbnail).toBeNull();
    expect(report.streams.length).toBeLessThan(1000);
    expect(report.reason).toMatch(/Scan stopped early: found more than \d+ zlib image streams/);
  });

  it("scans 50 MB with no preview in bounded time", async () => {
    const file = modernSolidWorksFile(50 * MB, [], 7);

    const started = performance.now();
    const { thumbnail, report } = await extractSolidWorksThumbnailWithReport(file);
    const seconds = (performance.now() - started) / 1000;

    expect(thumbnail).toBeNull();
    expect(report.reason).toBeTruthy();
    // Well under a second on a laptop; the old scan took ~50 s and 800 MB.
    // The bound is loose so a loaded CI runner can't flake it.
    expect(seconds).toBeLessThan(15);
  }, 60_000);

  it("stays linear when many image signatures share one distant end marker", async () => {
    // JPEG starts through the first half and PNG signatures through the
    // second, each closed only by a single end marker at the very end.
    // Searching for the end afresh from every start is quadratic here.
    const size = 4 * MB;
    const file = new Uint8Array(size);
    file.set([0xc5, 0x5c, 0xef, 0x65], 0);
    const jpegStart = [0xff, 0xd8, 0xff];
    const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 4; i + 3 <= size / 2; i += 3) file.set(jpegStart, i);
    for (let i = size / 2; i + 8 <= size - 16; i += 8) file.set(pngSignature, i);
    file.set([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82, 0xff, 0xd9], size - 10);

    const started = performance.now();
    const { thumbnail, report } = await extractSolidWorksThumbnailWithReport(file.buffer);
    const seconds = (performance.now() - started) / 1000;

    expect(thumbnail).toBeNull();
    expect(report.reason).toContain("Scan stopped early");
    expect(seconds).toBeLessThan(15);
  }, 60_000);
});

describe("extractSolidWorksThumbnailWithReport — OLE compound document", () => {
  it("picks the embedded PNG stream", async () => {
    const png = await previewPng();
    const container = CFB.utils.cfb_new();
    CFB.utils.cfb_add(container, "/PreviewPNG", png);
    CFB.utils.cfb_add(container, "/Contents", noise(4096, 3));
    const bytes = new Uint8Array(CFB.write(container, { type: "array" }) as ArrayLike<number>);

    const { thumbnail, report } = await extractSolidWorksThumbnailWithReport(bytes.buffer);

    expect(report.picked).toEqual({ name: "PreviewPNG", size: png.length, detected: "png" });
    expect(thumbnail?.mimeType).toBe("image/png");
    expect(Buffer.from(thumbnail!.data).equals(Buffer.from(png))).toBe(true);
  });
});
