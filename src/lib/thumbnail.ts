import CFB from "cfb";
import sharp from "sharp";
import { inflateSync } from "fflate";

// ─── Public dispatcher ────────────────────────────────────────────────────
//
// `extractThumbnail` is the single entry point that file-upload paths should
// call. It dispatches by file extension:
//
//   SOLIDWORKS files (sldprt/sldasm/slddrw)
//     → CFB-based extraction of the embedded preview (legacy path,
//       unchanged from when this lib was SolidWorks-only)
//
//   Image files (png/jpg/jpeg/webp/gif/bmp)
//     → sharp resize to a 400px-bounded PNG. The original file is the
//       source of truth; this is just a thumbnail-sized representation
//       so the file list can show a preview without downloading the
//       full image. Falls back to null if sharp can't decode the input.
//
//   Anything else (PDF, STEP, STL, DXF, DWG, IGES, ...)
//     → returns null. These need a CAD kernel or PDF rasterizer that
//       isn't installed in this environment. The dispatcher returning
//       null is the documented extension point: when one of those
//       formats becomes a priority, add a branch here.

const SW_EXTENSIONS = ["sldprt", "sldasm", "slddrw"];
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const PDF_EXTENSIONS = ["pdf"];

const THUMBNAIL_MAX_DIMENSION = 400;

export interface ThumbnailResult {
  data: Uint8Array;
  mimeType: string;
  /** File extension to use when uploading to storage (jpg/png). */
  ext: string;
}

export function isSolidWorksFile(filename: string): boolean {
  return SW_EXTENSIONS.includes(extOf(filename));
}

function extOf(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() || "";
}

/**
 * Generate a thumbnail for `filename` from its raw bytes. Returns null when
 * the file type is unsupported or extraction fails — callers should treat
 * a null result as "no thumbnail" and continue, since thumbnails are a
 * UI nicety, not a correctness requirement.
 *
 * Synchronous-but-async: this runs inline in upload routes today. Large
 * files (multi-hundred MB SolidWorks assemblies) can stretch upload latency
 * by a few seconds. If that becomes a problem, move the call into a
 * background queue — the dispatcher itself doesn't need to change.
 */
export async function extractThumbnail(
  buffer: ArrayBuffer,
  filename: string
): Promise<ThumbnailResult | null> {
  const ext = extOf(filename);

  if (SW_EXTENSIONS.includes(ext)) {
    // Use the reporting variant so failures in the upload / backfill path
    // surface a specific reason in the server logs instead of a silent
    // null. Lets us distinguish "native binding missing" from "file has
    // no embedded raster preview" without attaching a debugger.
    const { thumbnail, report } = await extractSolidWorksThumbnailWithReport(buffer);
    if (!thumbnail) {
      console.warn(
        `[thumbnail] SolidWorks extraction returned null for ${filename}: ${report.reason || "(no reason)"} ` +
        `— streams inspected: ${report.streams.length}`
      );
      return null;
    }
    return {
      data: thumbnail.data,
      mimeType: thumbnail.mimeType,
      ext: thumbnail.mimeType === "image/jpeg" ? "jpg" : "png",
    };
  }

  if (IMAGE_EXTENSIONS.includes(ext)) {
    return generateImageThumbnail(buffer);
  }

  if (PDF_EXTENSIONS.includes(ext)) {
    return generatePdfThumbnail(buffer);
  }

  // Unsupported format. Extension point: add new branches here for
  // STL (offscreen 3D render), STEP (OpenCASCADE), DXF (line-art raster), etc.
  return null;
}

/**
 * Rasterize the first page of a PDF to a 400px-bounded PNG thumbnail.
 *
 * Uses `pdfjs-dist` (Mozilla pdf.js) for parsing + rendering and
 * `@napi-rs/canvas` as the canvas backend. Both are pulled in via
 * dynamic import so Next.js only includes them in the server bundle
 * for routes that actually call this function — the client never sees
 * them.
 *
 * Why this stack vs. alternatives:
 *   - `sharp` (libvips) can rasterize PDFs *only if* libvips was built
 *     with poppler support. The sharp npm package isn't, and adding
 *     poppler means shipping a native binary. Ruled out.
 *   - `pdf-lib` can only extract existing embedded thumbnails, not
 *     render pages from scratch. Ruled out.
 *   - An external conversion service (CloudConvert etc.) handles every
 *     format but costs per render and adds an uptime dependency. Reserved
 *     for the long tail (DWG, STEP) if it ever becomes a priority.
 *
 * Known limitations:
 *   - Font rendering may be imperfect since we're not loading system
 *     fonts. Acceptable for a thumbnail — fuzzy text is fine at 400px.
 *   - Very complex PDFs (scanned images, heavy vector graphics) take
 *     longer; a 5-page engineering drawing typically renders in 200-600ms.
 *   - Runs synchronously inside the upload/check-in route, adding that
 *     latency to the request. Move to a background job if it becomes a UX
 *     problem; the dispatcher itself doesn't need to change.
 */
async function generatePdfThumbnail(
  buffer: ArrayBuffer
): Promise<ThumbnailResult | null> {
  try {
    // Dynamic imports keep these modules out of the client bundle. Next
    // 16 traces dynamic imports during build and moves them to a
    // server-only chunk, so the ~15 MB pdf.js payload never ships to
    // browsers. The legacy build is Node-friendly and works without a
    // worker setup.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const { createCanvas } = await import("@napi-rs/canvas");

    // pdf.js creates canvases internally for each render pass. The
    // factory tells it how — the default (`DOMCanvasFactory`) assumes a
    // browser, so we supply a Node-backed one using @napi-rs/canvas.
    //
    // In pdfjs-dist 5.x, `CanvasFactory` is a class passed to
    // `getDocument` (pdf.js instantiates it internally with `new`), NOT
    // a render-time option as in earlier majors. We define the class
    // inline so `createCanvas` is closed over without a module-level
    // variable, keeping the rest of the file free of top-level
    // native-binding imports.
    class NodeCanvasFactory {
      create(width: number, height: number) {
        const canvas = createCanvas(width, height);
        return { canvas, context: canvas.getContext("2d") };
      }
      reset(
        canvasAndContext: { canvas: { width: number; height: number } },
        width: number,
        height: number
      ) {
        canvasAndContext.canvas.width = width;
        canvasAndContext.canvas.height = height;
      }
      destroy(canvasAndContext: {
        canvas: { width: number; height: number } | null;
        context: unknown;
      }) {
        if (canvasAndContext.canvas) {
          canvasAndContext.canvas.width = 0;
          canvasAndContext.canvas.height = 0;
        }
        canvasAndContext.canvas = null;
        canvasAndContext.context = null;
      }
    }

    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      // No DOM means no @font-face; stick with the built-in fallback.
      disableFontFace: true,
      // We're not loading system fonts in this environment.
      useSystemFonts: false,
      // Suppress pdf.js's noisy "Indexing:..." progress logs in server logs.
      verbosity: 0,
      // Node-backed canvas factory class for all internal canvas allocations.
      CanvasFactory: NodeCanvasFactory,
    }).promise;

    // Keep an instance around for the explicit output-canvas allocation
    // below. pdf.js uses its own instance internally (via the class we
    // passed above); this one is just ours.
    const canvasFactory = new NodeCanvasFactory();

    try {
      const page = await doc.getPage(1);

      // Compute a scale that bounds the long edge at THUMBNAIL_MAX_DIMENSION.
      // PDF pages can be any aspect ratio (landscape engineering drawings,
      // portrait datasheets) so scaling uniformly is the safest default.
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = THUMBNAIL_MAX_DIMENSION / Math.max(baseViewport.width, baseViewport.height);
      const viewport = page.getViewport({ scale });

      // Allocate our own output canvas for the final render. pdf.js will
      // still use the factory above for any internal scratch canvases.
      const canvasAndContext = canvasFactory.create(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height)
      );

      // Fill with white so transparent PDFs (yes, they exist) don't come
      // out as a black square in the file list.
      const ctx = canvasAndContext.context as unknown as {
        fillStyle: string;
        fillRect: (x: number, y: number, w: number, h: number) => void;
      };
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, viewport.width, viewport.height);

      // pdfjs-dist 5.x requires a `canvas` field on RenderParameters
      // (earlier majors only needed canvasContext). @napi-rs/canvas's
      // Canvas isn't structurally HTMLCanvasElement, so we double-cast
      // through unknown — at runtime pdf.js reads width/height and uses
      // the context we provide, both of which @napi-rs/canvas satisfies.
      await page.render({
        canvas: canvasAndContext.canvas as unknown as HTMLCanvasElement,
        canvasContext: canvasAndContext.context as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;

      // @napi-rs/canvas returns a Buffer with image/png encoding.
      const pngBuffer = (canvasAndContext.canvas as unknown as {
        toBuffer: (mime: "image/png") => Buffer;
      }).toBuffer("image/png");

      return {
        data: new Uint8Array(pngBuffer),
        mimeType: "image/png",
        ext: "png",
      };
    } finally {
      // Always release pdf.js resources, even if render() threw.
      await doc.destroy();
    }
  } catch (err) {
    console.error("PDF thumbnail generation failed:", err);
    return null;
  }
}

/**
 * Resize an arbitrary raster image to a 400px-bounded PNG. Used for the
 * file-list thumbnail of uploaded image files — much smaller to serve than
 * the full original (a 5 MB drawing JPEG becomes a ~30 KB PNG).
 */
async function generateImageThumbnail(
  buffer: ArrayBuffer
): Promise<ThumbnailResult | null> {
  try {
    const png = await sharp(Buffer.from(buffer))
      .resize(THUMBNAIL_MAX_DIMENSION, THUMBNAIL_MAX_DIMENSION, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
    return { data: new Uint8Array(png), mimeType: "image/png", ext: "png" };
  } catch (err) {
    console.error("Image thumbnail generation failed:", err);
    return null;
  }
}

// ─── SOLIDWORKS extraction (existing path, unchanged behavior) ────────────

/**
 * Prepend a 14-byte BMP file header to a raw DIB (device-independent bitmap).
 * SolidWorks sometimes stores previews as headerless DIBs.
 */
function dibToBmp(dib: Uint8Array): Uint8Array {
  const fileSize = 14 + dib.length;
  // The pixel data offset = 14 (file header) + BITMAPINFOHEADER size (first 4 bytes of DIB as little-endian uint32)
  const headerSize = dib[0] | (dib[1] << 8) | (dib[2] << 16) | (dib[3] << 24);
  // Determine if there's a color table — for now just use header + 14
  const pixelOffset = 14 + headerSize;

  const bmp = new Uint8Array(fileSize);
  const view = new DataView(bmp.buffer);

  // BMP file header (14 bytes)
  bmp[0] = 0x42; // 'B'
  bmp[1] = 0x4d; // 'M'
  view.setUint32(2, fileSize, true);
  view.setUint16(6, 0, true); // reserved
  view.setUint16(8, 0, true); // reserved
  view.setUint32(10, pixelOffset, true);

  // Copy DIB data after the file header
  bmp.set(dib, 14);
  return bmp;
}

/**
 * Check if data is a raw DIB (starts with BITMAPINFOHEADER: size = 40, 108, or 124).
 */
function isRawDib(data: Uint8Array): boolean {
  if (data.length < 40) return false;
  const headerSize = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
  return headerSize === 40 || headerSize === 108 || headerSize === 124;
}

/**
 * Check if data is an EMF (Enhanced Metafile).
 * EMF starts with a header record whose type is 0x00000001.
 */
function isEmf(data: Uint8Array): boolean {
  if (data.length < 44) return false;
  // EMF signature " EMF" at offset 40
  return (
    data[40] === 0x20 &&
    data[41] === 0x45 &&
    data[42] === 0x4d &&
    data[43] === 0x46
  );
}

/**
 * Convert image data to PNG using sharp, handling BMP, EMF-free formats, etc.
 */
async function toPng(data: Uint8Array, mimeType: string): Promise<{ data: Uint8Array; mimeType: string }> {
  try {
    const pngBuffer = await sharp(Buffer.from(data)).png().toBuffer();
    return { data: new Uint8Array(pngBuffer), mimeType: "image/png" };
  } catch {
    // If sharp can't handle it, return original
    return { data, mimeType };
  }
}

/**
 * Diagnostic information about a single CFB stream that the extractor
 * looked at. Surfaced via `extractSolidWorksThumbnailWithReport` so the
 * debug CLI / endpoint can show exactly what's inside a problem file
 * without you having to ship me the SLDPRT.
 */
export interface CfbStreamInfo {
  name: string;
  size: number;
  /** First 8 bytes as hex (helps spot magic numbers like PNG/JPEG/BMP). */
  magicHex: string;
  /** What the extractor identified the content as, if anything. */
  detected: "png" | "jpeg" | "bmp" | "dib" | "emf" | "unknown";
}

export interface ExtractionReport {
  streams: CfbStreamInfo[];
  /** The stream we picked, if any. */
  picked: { name: string; size: number; detected: string } | null;
  /** Why nothing was picked, when picked is null. */
  reason: string | null;
}

/**
 * Extract the embedded preview image from a SOLIDWORKS file.
 *
 * SOLIDWORKS (and other CAD apps that use OLE Compound Documents) embed
 * a raster preview inside the file at one of several stream paths. The
 * paths vary across SolidWorks versions, file types (sldprt vs slddrw vs
 * sldasm), and even the user's "Save tessellation data" setting. Rather
 * than maintain a hardcoded list of paths and hope it's complete, we
 * scan EVERY stream in the compound document and recognize image content
 * by its magic bytes (PNG/JPEG/BMP/DIB). This catches files where the
 * preview lives at a non-standard path — including the SLDDRW case where
 * the preview entry name varies between SolidWorks releases.
 *
 * Strategy: walk every stream → identify image content by magic bytes
 * → convert to PNG → among all candidates, pick the largest. The largest
 * one is overwhelmingly the actual preview rather than an icon or
 * stamp image.
 *
 * Exported for backwards compatibility — `extractThumbnail` is the
 * preferred entry point for new callers.
 */
export async function extractSolidWorksThumbnail(
  buffer: ArrayBuffer
): Promise<{ data: Uint8Array; mimeType: string } | null> {
  const result = await extractSolidWorksThumbnailWithReport(buffer);
  return result.thumbnail;
}

/**
 * Like `extractSolidWorksThumbnail` but also returns a structured report
 * of every stream the extractor inspected. Used by the debug CLI to
 * diagnose files where extraction returns null.
 */
export async function extractSolidWorksThumbnailWithReport(
  buffer: ArrayBuffer
): Promise<{
  thumbnail: { data: Uint8Array; mimeType: string } | null;
  report: ExtractionReport;
}> {
  const report: ExtractionReport = { streams: [], picked: null, reason: null };
  const bytes = new Uint8Array(buffer);

  // Detect format by file magic. Older SolidWorks files (pre-2015ish)
  // are OLE Compound Documents starting with `d0 cf 11 e0 a1 b1 1a e1`.
  // Newer files use a proprietary binary container starting with
  // `c5 5c ef 65` — these are NOT OLE, and CFB.read will throw on them.
  // When we see the new format we skip straight to raw+zlib scanning
  // instead of trying CFB first and catching the confusing error.
  const isLegacyCfb =
    bytes.length >= 8 &&
    bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;

  if (!isLegacyCfb) {
    return scanRawBytesForImage(bytes, report);
  }

  let cfb;
  try {
    cfb = CFB.read(bytes, { type: "array" });
  } catch (error) {
    report.reason = `CFB.read failed: ${error instanceof Error ? error.message : String(error)}`;
    console.error("Failed to parse SolidWorks file as CFB:", error);
    return { thumbnail: null, report };
  }

  // Walk every stream entry in the compound document. We scan by content,
  // not by name — SolidWorks embeds the preview at different paths across
  // versions and file types, so a name-based whitelist is fragile.
  // Candidates we find get scored and the largest valid raster image wins.
  interface Candidate {
    name: string;
    size: number;
    detected: CfbStreamInfo["detected"];
    content: Uint8Array;
  }
  const candidates: Candidate[] = [];

  for (const entry of cfb.FileIndex) {
    // Skip storages (folders), only look at streams (files)
    if (entry.type !== 2) continue;
    if (!entry.content || entry.content.length < 100) continue;

    // cfb's typings declare `content` as Uint8Array but at runtime older
    // releases hand back a plain number[] for some streams. Normalize.
    const raw = entry.content as unknown;
    const content =
      raw instanceof Uint8Array
        ? raw
        : new Uint8Array(raw as ArrayLike<number>);
    const detected = detectImageType(content);
    const info: CfbStreamInfo = {
      name: entry.name || "(unnamed)",
      size: content.length,
      magicHex: hexBytes(content, 8),
      detected,
    };
    report.streams.push(info);

    if (detected !== "unknown" && detected !== "emf") {
      candidates.push({
        name: info.name,
        size: content.length,
        detected,
        content,
      });
    }
  }

  if (candidates.length === 0) {
    // Nothing recognizable. Note whether we at least found an EMF — that
    // tells the user the file does have a preview, just one we can't
    // rasterize without a metafile renderer.
    const hasEmf = report.streams.some((s) => s.detected === "emf");
    report.reason = hasEmf
      ? "Only EMF (vector metafile) previews found — pure-JS rasterization isn't supported. The file has a preview but it's a metafile we can't render."
      : `No raster image found in ${report.streams.length} streams. The file may not have an embedded preview at all (SolidWorks "Save tessellation data" option may have been off when the file was saved).`;
    return { thumbnail: null, report };
  }

  // Sort candidates by size descending — the actual preview is almost
  // always the largest image in the file.
  candidates.sort((a, b) => b.size - a.size);
  const winner = candidates[0];

  const converted = await convertCandidate(winner.content, winner.detected);
  if (!converted) {
    report.reason = `Largest candidate (${winner.name}, ${winner.size}b, ${winner.detected}) failed to convert to PNG.`;
    return { thumbnail: null, report };
  }

  report.picked = {
    name: winner.name,
    size: winner.size,
    detected: winner.detected,
  };
  return { thumbnail: converted, report };
}

/** Identify content by its magic-byte signature. Cheap and reliable. */
function detectImageType(content: Uint8Array): CfbStreamInfo["detected"] {
  if (content.length < 8) return "unknown";
  // PNG: 89 50 4E 47
  if (content[0] === 0x89 && content[1] === 0x50 && content[2] === 0x4e && content[3] === 0x47) {
    return "png";
  }
  // JPEG: FF D8
  if (content[0] === 0xff && content[1] === 0xd8) {
    return "jpeg";
  }
  // BMP: 42 4D ("BM")
  if (content[0] === 0x42 && content[1] === 0x4d) {
    return "bmp";
  }
  // Raw DIB (headerless bitmap, common in SLDDRW files)
  if (isRawDib(content)) {
    return "dib";
  }
  // EMF (Enhanced Metafile) — we record it for diagnostics but can't
  // rasterize it without a metafile renderer.
  if (isEmf(content)) {
    return "emf";
  }
  return "unknown";
}

/** Format the first N bytes of `content` as hex (e.g., "89 50 4e 47"). */
function hexBytes(content: Uint8Array, n: number): string {
  const out: string[] = [];
  for (let i = 0; i < Math.min(n, content.length); i++) {
    out.push(content[i].toString(16).padStart(2, "0"));
  }
  return out.join(" ");
}

/** Convert a recognized image candidate to a normalized PNG. */
async function convertCandidate(
  content: Uint8Array,
  detected: CfbStreamInfo["detected"]
): Promise<{ data: Uint8Array; mimeType: string } | null> {
  if (detected === "png") return { data: content, mimeType: "image/png" };
  if (detected === "jpeg") return { data: content, mimeType: "image/jpeg" };
  if (detected === "bmp") return toPng(content, "image/bmp");
  if (detected === "dib") {
    const bmp = dibToBmp(content);
    return toPng(bmp, "image/bmp");
  }
  return null;
}

// ─── Raw-byte + zlib scanning for non-CFB SolidWorks formats ──────────────
//
// Modern SolidWorks (~2015+) saves files in a proprietary binary container
// that is NOT an OLE Compound Document. CFB.read throws on them. Instead
// of giving up, we scan the raw bytes for image signatures at any offset,
// then also inflate every zlib-compressed section and scan those for
// images. Between the two, we'll find a raster preview if one is embedded
// anywhere in the file — no matter what the container structure looks
// like. If the file genuinely has no preview (the "Save tessellation
// data" option was off when the file was saved), nothing pure-JS can do
// will produce a thumbnail — that data simply isn't in the file.

async function scanRawBytesForImage(
  bytes: Uint8Array,
  report: ExtractionReport
): Promise<{
  thumbnail: { data: Uint8Array; mimeType: string } | null;
  report: ExtractionReport;
}> {
  interface Candidate {
    name: string;
    size: number;
    detected: CfbStreamInfo["detected"];
    content: Uint8Array;
  }
  const candidates: Candidate[] = [];

  // Pass 1: scan the raw file for uncompressed image content.
  // PNG: 89 50 4E 47 0D 0A 1A 0A. We check the IEND marker to find the
  // end of the stream, rather than guessing at a length.
  for (const start of findAllSequences(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    const end = indexOfSequence(bytes, [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82], start);
    if (end === -1) continue;
    const content = bytes.subarray(start, end + 8);
    if (content.length < 100) continue;
    const name = `raw@${start}`;
    candidates.push({ name, size: content.length, detected: "png", content });
    report.streams.push({
      name,
      size: content.length,
      magicHex: hexBytes(content, 8),
      detected: "png",
    });
  }

  // JPEG: FF D8 FF ... FF D9. We don't validate the whole JFIF structure,
  // but we do require the end marker to bound the stream.
  for (const start of findAllSequences(bytes, [0xff, 0xd8, 0xff])) {
    const end = indexOfSequence(bytes, [0xff, 0xd9], start + 2);
    if (end === -1) continue;
    const content = bytes.subarray(start, end + 2);
    if (content.length < 100) continue;
    const name = `raw@${start}`;
    candidates.push({ name, size: content.length, detected: "jpeg", content });
    report.streams.push({
      name,
      size: content.length,
      magicHex: hexBytes(content, 8),
      detected: "jpeg",
    });
  }

  // Pass 2: inflate every zlib-compressed section we can find and scan
  // the inflated content for images too. The new SolidWorks container
  // stores most of its data zlib-compressed; the preview, if present,
  // may live inside one of those streams.
  const zlibOffsets: number[] = [];
  for (let i = 0; i < bytes.length - 2; i++) {
    const a = bytes[i];
    const b = bytes[i + 1];
    // Common zlib header bytes: 78 9c (default), 78 da (best), 78 01 (fastest), 78 5e.
    if (a === 0x78 && (b === 0x9c || b === 0xda || b === 0x01 || b === 0x5e)) {
      zlibOffsets.push(i);
    }
  }

  for (const off of zlibOffsets) {
    let inflated: Uint8Array;
    try {
      inflated = inflateSync(bytes.subarray(off));
    } catch {
      continue;
    }
    if (inflated.length < 100) continue;
    const detected = detectImageType(inflated);
    report.streams.push({
      name: `zlib@${off}`,
      size: inflated.length,
      magicHex: hexBytes(inflated, 8),
      detected,
    });
    if (detected !== "unknown" && detected !== "emf") {
      candidates.push({
        name: `zlib@${off}`,
        size: inflated.length,
        detected,
        content: inflated,
      });
    }
  }

  if (candidates.length === 0) {
    const hasEmf = report.streams.some((s) => s.detected === "emf");
    report.reason = hasEmf
      ? "Only EMF (vector metafile) previews found — pure-JS rasterization isn't supported."
      : "No raster image found in the raw bytes or in any of the inflated zlib streams. " +
        "This file likely has no embedded preview at all — SolidWorks' \"Save preview picture\" " +
        "option was off when it was saved. The only fix is to upload a thumbnail manually or " +
        "re-save the file in SolidWorks with that option enabled.";
    return { thumbnail: null, report };
  }

  candidates.sort((a, b) => b.size - a.size);
  const winner = candidates[0];
  const converted = await convertCandidate(winner.content, winner.detected);
  if (!converted) {
    report.reason = `Largest candidate (${winner.name}, ${winner.size}b, ${winner.detected}) failed to convert to PNG.`;
    return { thumbnail: null, report };
  }

  report.picked = {
    name: winner.name,
    size: winner.size,
    detected: winner.detected,
  };
  return { thumbnail: converted, report };
}

function findAllSequences(haystack: Uint8Array, needle: number[]): number[] {
  const hits: number[] = [];
  let pos = 0;
  while (pos <= haystack.length - needle.length) {
    const idx = indexOfSequence(haystack, needle, pos);
    if (idx === -1) break;
    hits.push(idx);
    pos = idx + 1;
  }
  return hits;
}

function indexOfSequence(haystack: Uint8Array, needle: number[], from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
