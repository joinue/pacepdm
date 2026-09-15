import CFB from "cfb";
import sharp from "sharp";
import { constants as zlibConstants, inflateSync, type ZlibOptions } from "node:zlib";

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
async function generatePdfThumbnail(buffer: ArrayBuffer): Promise<ThumbnailResult | null> {
  try {
    // Dynamic imports keep these modules out of the client bundle. Next
    // 16 traces dynamic imports during build and moves them to a
    // server-only chunk, so the ~15 MB pdf.js payload never ships to
    // browsers. The legacy build is Node-friendly and works without a
    // worker setup.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    await providePdfWorker();
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
      const pngBuffer = (
        canvasAndContext.canvas as unknown as {
          toBuffer: (mime: "image/png") => Buffer;
        }
      ).toBuffer("image/png");

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
 * Hand pdf.js its worker module, rather than letting it import one by path.
 *
 * Node has no Worker, so pdf.js runs its worker in-process ("fake worker")
 * and loads it with `import(GlobalWorkerOptions.workerSrc)` — a path computed
 * at runtime, defaulting to "./pdf.worker.mjs". The build's file tracer cannot
 * follow a computed import, so `pdf.worker.mjs` was never copied into the
 * Vercel function, and every PDF thumbnail failed there with "Setting up fake
 * worker failed: Cannot find module …/pdf.worker.mjs" — while working locally,
 * where node_modules is whole.
 *
 * pdf.js looks for `globalThis.pdfjsWorker` before importing anything, and a
 * literal import specifier is one the tracer can see, so this fixes both the
 * missing file and the lookup. Idempotent: the module is cached after the
 * first call.
 */
async function providePdfWorker(): Promise<void> {
  const g = globalThis as { pdfjsWorker?: unknown };
  if (g.pdfjsWorker) return;
  g.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
}

/**
 * Resize an arbitrary raster image to a 400px-bounded PNG. Used for the
 * file-list thumbnail of uploaded image files — much smaller to serve than
 * the full original (a 5 MB drawing JPEG becomes a ~30 KB PNG).
 */
async function generateImageThumbnail(buffer: ArrayBuffer): Promise<ThumbnailResult | null> {
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
  return data[40] === 0x20 && data[41] === 0x45 && data[42] === 0x4d && data[43] === 0x46;
}

// (toPng helper removed — convertCandidate now validates via sharp inline
// and returns null on any decode failure, rather than silently returning
// the unconverted bytes as a thumbnail.)

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
export async function extractSolidWorksThumbnailWithReport(buffer: ArrayBuffer): Promise<{
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
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0;

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
    const content = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayLike<number>);
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
  // always the largest image in the file. Walk from biggest down,
  // taking the first one that decodes as a real image (see
  // pickFirstDecodableCandidate for why we don't just trust magic bytes).
  candidates.sort((a, b) => b.size - a.size);
  const { winner, converted, rejected } = await pickFirstDecodableCandidate(candidates);
  if (!converted || !winner) {
    report.reason =
      `All ${candidates.length} image candidates failed to decode through sharp. ` +
      `Rejected: ${formatRejected(rejected)}.`;
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

/**
 * Convert a recognized image candidate to a thumbnail-ready blob, or
 * return null if the bytes don't actually decode as a real image.
 *
 * Magic-byte detection is enough to identify a CANDIDATE, but the
 * modern-SolidWorks path inflates zlib at every plausible offset and
 * scans raw bytes — both routinely produce blobs that *start* with
 * PNG/JPEG signatures but aren't valid streams (truncated, corrupt,
 * or coincidental matches inside compressed/encrypted regions). The
 * old code returned those bytes unverified, which is how broken
 * thumbnails got persisted: the file row had a thumbnailKey, the UI
 * trusted it, and the user saw a broken-img icon they couldn't replace.
 *
 * sharp.metadata() decodes the header and throws on invalid input —
 * cheap enough to run on every candidate. sharp.png().toBuffer() does
 * a full decode-and-re-encode for BMP/DIB, where we need the output
 * to be PNG anyway.
 */
async function convertCandidate(
  content: Uint8Array,
  detected: CfbStreamInfo["detected"]
): Promise<{ data: Uint8Array; mimeType: string } | null> {
  // A view, not a copy: raw-scan candidates are slices of the whole upload,
  // and Buffer.from(Uint8Array) would duplicate each one per attempt.
  const input = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  try {
    if (detected === "png" || detected === "jpeg") {
      await sharp(input).metadata();
      return {
        data: content,
        mimeType: detected === "png" ? "image/png" : "image/jpeg",
      };
    }
    if (detected === "bmp") {
      const pngBuffer = await sharp(input).png().toBuffer();
      return { data: new Uint8Array(pngBuffer), mimeType: "image/png" };
    }
    if (detected === "dib") {
      const bmp = dibToBmp(content);
      const pngBuffer = await sharp(Buffer.from(bmp)).png().toBuffer();
      return { data: new Uint8Array(pngBuffer), mimeType: "image/png" };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Walk candidates from largest to smallest, returning the first one that
 * actually decodes. The previous behavior — try only the largest and give
 * up if it fails — let a single false-positive blob (a zlib inflate that
 * happened to start with `89 50 4e 47` but wasn't a real PNG) shadow a
 * smaller-but-valid embedded preview lower in the same file.
 */
async function pickFirstDecodableCandidate<
  C extends {
    name: string;
    size: number;
    detected: CfbStreamInfo["detected"];
    content: Uint8Array;
  },
>(
  candidates: C[]
): Promise<{
  winner: C | null;
  converted: { data: Uint8Array; mimeType: string } | null;
  rejected: { name: string; size: number; detected: string }[];
}> {
  const rejected: { name: string; size: number; detected: string }[] = [];
  for (const c of candidates) {
    const converted = await convertCandidate(c.content, c.detected);
    if (converted) return { winner: c, converted, rejected };
    rejected.push({ name: c.name, size: c.size, detected: c.detected });
  }
  return { winner: null, converted: null, rejected };
}

function formatRejected(rejected: { name: string; size: number; detected: string }[]): string {
  const shown = rejected
    .slice(0, 5)
    .map((r) => `${r.name} (${r.size}b ${r.detected})`)
    .join(", ");
  return rejected.length > 5 ? `${shown}, +${rejected.length - 5} more` : shown;
}

// ─── Raw-byte + zlib scanning for non-CFB SolidWorks formats ──────────────
//
// Modern SolidWorks (~2015+) saves files in a proprietary binary container
// that is NOT an OLE Compound Document. CFB.read throws on them. Instead
// of giving up, we scan the raw bytes for image signatures at any offset,
// then also look for zlib-compressed sections whose content starts with an
// image. Between the two, we'll find a raster preview if one is embedded
// anywhere in the file — no matter what the container structure looks
// like. If the file genuinely has no preview (the "Save tessellation
// data" option was off when the file was saved), nothing pure-JS can do
// will produce a thumbnail — that data simply isn't in the file.
//
// Both passes are linear in the file size and every expensive step is
// capped. The zlib pass used to hand the whole rest of the file to a raw
// DEFLATE decoder at every `78 xx` pair: it could not decode a zlib stream
// at all (the two-byte header is not DEFLATE), and it took two minutes and
// 1.6 GB to scan 100 MB of noise, synchronously, on a shared instance.

const MB = 1024 * 1024;

/**
 * Nothing larger than this is an embedded preview. SOLIDWORKS previews are
 * tens to hundreds of KB; the cap is generous, and exists so that a false
 * signature or a decompression bomb can't hand sharp or zlib most of a file.
 */
const MAX_PREVIEW_BYTES = 32 * MB;

/**
 * Raw signature matches examined per image format before the pass gives up.
 * A three-byte JPEG start turns up by chance about once per 16 MB of
 * compressed data; a real file has a handful.
 */
const MAX_SIGNATURE_HITS = 1024;

/** Image-bearing zlib streams kept as candidates before the pass gives up. */
const MAX_ZLIB_CANDIDATES = 256;

/**
 * Native inflate calls one scan may make. Each costs ~40µs even when zlib
 * rejects the data on its first byte (mostly building the Error it throws).
 * Random-looking (compressed) data leaves about one plausible offset per
 * 8 KB after `couldStartZlibStream`, so this covers ~400 MB of real file.
 */
const ZLIB_MAX_ATTEMPTS = 50_000;

/**
 * Bytes zlib may produce, plus compressed bytes walked by full inflates,
 * across one scan. Bounds CPU on crafted input, and caps the memory held by
 * candidates, since everything kept was charged here.
 */
const ZLIB_WORK_BUDGET_BYTES = 256 * MB;

/** Output needed to classify a stream: `detectImageType` reads 44 bytes for EMF. */
const ZLIB_PROBE_OUTPUT_BYTES = 44;

/**
 * Compressed input handed to the probe, growing ×4 per retry. Stored and
 * fixed-Huffman blocks yield 44 bytes from the first window; a dynamic
 * block's code tables can take a few hundred bytes before the first literal.
 * Starting small keeps a highly compressible stream from inflating a
 * megabyte just to be classified.
 */
const ZLIB_PROBE_FIRST_WINDOW = 64;
const ZLIB_PROBE_MAX_WINDOW = 4096;

/** Two header bytes plus a dynamic block's header fields and code-length codes. */
const ZLIB_MIN_STREAM_BYTES = 12;

/**
 * Compressed input handed to a full inflate. DEFLATE expands incompressible
 * data by a fraction of a percent (stored blocks cost 5 bytes per 64 KB), so
 * any stream whose output fits MAX_PREVIEW_BYTES fits in this window.
 */
const ZLIB_MAX_STREAM_INPUT = MAX_PREVIEW_BYTES + MB;

interface ImageCandidate {
  name: string;
  size: number;
  detected: CfbStreamInfo["detected"];
  content: Uint8Array;
}

async function scanRawBytesForImage(
  bytes: Uint8Array,
  report: ExtractionReport
): Promise<{
  thumbnail: { data: Uint8Array; mimeType: string } | null;
  report: ExtractionReport;
}> {
  const candidates: ImageCandidate[] = [];
  const limits: string[] = [];

  // Pass 1: uncompressed images sitting directly in the file.
  for (const format of RAW_IMAGE_FORMATS) {
    const limit = collectRawImageCandidates(bytes, format, candidates, report);
    if (limit) limits.push(limit);
  }

  // Pass 2: zlib streams whose inflated content starts with an image. The
  // new SolidWorks container stores most of its data zlib-compressed; the
  // preview, if present, may live inside one of those streams.
  const zlibLimit = collectZlibCandidates(bytes, candidates, report);
  if (zlibLimit) limits.push(zlibLimit);

  const limitNote = limits.length > 0 ? ` Scan stopped early: ${limits.join("; ")}.` : "";

  if (candidates.length === 0) {
    const hasEmf = report.streams.some((s) => s.detected === "emf");
    report.reason =
      (hasEmf
        ? "Only EMF (vector metafile) previews found — pure-JS rasterization isn't supported."
        : "No raster image found in the raw bytes or in any of the inflated zlib streams. " +
          'This file likely has no embedded preview at all — SolidWorks\' "Save preview picture" ' +
          "option was off when it was saved. The only fix is to upload a thumbnail manually or " +
          "re-save the file in SolidWorks with that option enabled.") + limitNote;
    return { thumbnail: null, report };
  }

  // Walk candidates largest-first, taking the first one that actually
  // decodes. The raw-byte / zlib-scan strategy produces a high rate of
  // false positives (random binary that happens to start with image
  // magic bytes), so iterating past the largest is mandatory here.
  candidates.sort((a, b) => b.size - a.size);
  const { winner, converted, rejected } = await pickFirstDecodableCandidate(candidates);
  if (!converted || !winner) {
    report.reason =
      `All ${candidates.length} image candidates failed to decode through sharp. ` +
      `Rejected: ${formatRejected(rejected)}.` +
      limitNote;
    return { thumbnail: null, report };
  }

  report.picked = {
    name: winner.name,
    size: winner.size,
    detected: winner.detected,
  };
  return { thumbnail: converted, report };
}

interface RawImageFormat {
  detected: "png" | "jpeg";
  signature: Buffer;
  endMarker: Buffer;
  /** Where, relative to the signature, the end-marker search begins. */
  endSearchOffset: number;
}

const RAW_IMAGE_FORMATS: RawImageFormat[] = [
  // PNG: 89 50 4E 47 0D 0A 1A 0A. We look for the IEND chunk (its type and
  // fixed CRC) to find the end of the stream, rather than guessing a length.
  {
    detected: "png",
    signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    endMarker: Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
    endSearchOffset: 0,
  },
  // JPEG: FF D8 FF ... FF D9. We don't validate the whole JFIF structure,
  // but we do require the end marker to bound the stream.
  {
    detected: "jpeg",
    signature: Buffer.from([0xff, 0xd8, 0xff]),
    endMarker: Buffer.from([0xff, 0xd9]),
    endSearchOffset: 2,
  },
];

/**
 * Add every raw `format` image in `bytes` to `candidates`. Returns a note
 * when the signature cap cut the pass short, otherwise null.
 *
 * Each signature pairs with the first end marker after it. Searching afresh
 * from every signature is quadratic when many signatures share one distant
 * end marker (or none), so the last marker found is reused while it still
 * lies ahead: every stretch of the file is searched once.
 */
function collectRawImageCandidates(
  bytes: Uint8Array,
  format: RawImageFormat,
  candidates: ImageCandidate[],
  report: ExtractionReport
): string | null {
  const haystack = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let hits = 0;
  let end = -1;
  for (
    let start = haystack.indexOf(format.signature);
    start !== -1;
    start = haystack.indexOf(format.signature, start + 1)
  ) {
    if (++hits > MAX_SIGNATURE_HITS) {
      return `found more than ${MAX_SIGNATURE_HITS} raw ${format.detected} signatures, the next at byte ${start}`;
    }
    const searchFrom = start + format.endSearchOffset;
    if (end < searchFrom) {
      end = haystack.indexOf(format.endMarker, searchFrom);
      // No end marker after this signature means none after any later one.
      if (end === -1) break;
    }
    const content = bytes.subarray(start, end + format.endMarker.length);
    if (content.length < 100 || content.length > MAX_PREVIEW_BYTES) continue;
    const name = `raw@${start}`;
    candidates.push({ name, size: content.length, detected: format.detected, content });
    report.streams.push({
      name,
      size: content.length,
      magicHex: hexBytes(content, 8),
      detected: format.detected,
    });
  }
  return null;
}

/**
 * Add every zlib stream in `bytes` that inflates to an image to
 * `candidates`. Returns a note when a limit cut the pass short, otherwise
 * null.
 *
 * Per plausible offset: a cheap header check in JS, then a probe that
 * inflates only the first few dozen bytes, and a full inflate — capped at
 * MAX_PREVIEW_BYTES — only when those bytes are an image signature. A stream
 * that inflates fully is skipped past, since nothing else can start inside
 * it. Node's zlib does the decoding: it reads a zlib stream (header and
 * Adler-32 trailer included), stops at the stream's end regardless of what
 * follows, rejects corrupt data within a few bytes, and can be told to stop
 * at an output size.
 */
function collectZlibCandidates(
  bytes: Uint8Array,
  candidates: ImageCandidate[],
  report: ExtractionReport
): string | null {
  let attempts = 0;
  let work = 0;
  let kept = 0;

  for (let off = 0; off + ZLIB_MIN_STREAM_BYTES <= bytes.length; off++) {
    if (!couldStartZlibStream(bytes, off)) continue;

    if (attempts >= ZLIB_MAX_ATTEMPTS) {
      return `reached the ${ZLIB_MAX_ATTEMPTS}-attempt zlib limit at byte ${off}`;
    }
    if (work >= ZLIB_WORK_BUDGET_BYTES) {
      return `spent the ${ZLIB_WORK_BUDGET_BYTES / MB} MB zlib work budget by byte ${off}`;
    }
    const probe = probeZlibStream(bytes, off);
    attempts += probe.attempts;
    work += probe.outputBytes;
    if (!probe.prefix) continue;

    const detected = detectImageType(probe.prefix);
    if (detected === "unknown") continue;

    if (kept >= MAX_ZLIB_CANDIDATES) {
      return `found more than ${MAX_ZLIB_CANDIDATES} zlib image streams, the next at byte ${off}`;
    }
    // Charge the worst case up front, so a stream that fails part-way
    // through can't overrun the budget.
    const worstCase = Math.min(bytes.length - off, ZLIB_MAX_STREAM_INPUT) + MAX_PREVIEW_BYTES;
    if (work + worstCase > ZLIB_WORK_BUDGET_BYTES) {
      return `spent the ${ZLIB_WORK_BUDGET_BYTES / MB} MB zlib work budget by byte ${off}`;
    }
    attempts++;
    let stream: { output: Uint8Array; consumed: number };
    try {
      stream = inflateCounted(bytes.subarray(off, off + ZLIB_MAX_STREAM_INPUT), {
        maxOutputLength: MAX_PREVIEW_BYTES,
      });
    } catch {
      // Corrupt past the probe, truncated, or larger than any preview.
      work += worstCase;
      continue;
    }
    work += stream.consumed + stream.output.length;
    const name = `zlib@${off}`;
    off += stream.consumed - 1;

    const content = stream.output;
    if (content.length < 100) continue;
    report.streams.push({
      name,
      size: content.length,
      magicHex: hexBytes(content, 8),
      detected,
    });
    if (detected === "emf") continue;
    candidates.push({ name, size: content.length, detected, content });
    kept++;
  }
  return null;
}

/**
 * Inflate just enough of the stream at `off` to classify it. `prefix` is
 * null when zlib rejects the data or the stream ends too soon to hold an
 * image signature.
 */
function probeZlibStream(
  bytes: Uint8Array,
  off: number
): { prefix: Uint8Array | null; attempts: number; outputBytes: number } {
  let attempts = 0;
  let outputBytes = 0;
  for (let window = ZLIB_PROBE_FIRST_WINDOW; ; window *= 4) {
    const input = bytes.subarray(off, off + window);
    attempts++;
    let result: { output: Uint8Array; consumed: number };
    try {
      // Z_SYNC_FLUSH returns what the truncated input decodes to instead of
      // throwing "unexpected end of file". Corrupt data still throws.
      result = inflateCounted(input, { finishFlush: zlibConstants.Z_SYNC_FLUSH });
    } catch {
      return { prefix: null, attempts, outputBytes };
    }
    outputBytes += result.output.length;
    if (result.output.length >= ZLIB_PROBE_OUTPUT_BYTES) {
      return { prefix: result.output, attempts, outputBytes };
    }
    const streamEnded = result.consumed < input.length;
    const sawEverything = input.length < window || window >= ZLIB_PROBE_MAX_WINDOW;
    if (streamEnded || sawEverything) return { prefix: null, attempts, outputBytes };
  }
}

/**
 * `zlib.inflateSync` plus how many input bytes the stream occupied, which
 * is less than the input when the stream ends before it does. `info: true`
 * is the documented way to get the engine back; @types/node doesn't model
 * the changed return type.
 */
function inflateCounted(
  input: Uint8Array,
  options: ZlibOptions
): { output: Uint8Array; consumed: number } {
  const { buffer, engine } = inflateSync(input, { ...options, info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return {
    output: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
    consumed: engine.bytesWritten,
  };
}

/**
 * Whether a zlib stream could begin at `off`, from the bytes zlib checks
 * before it produces any output. Each test mirrors a check zlib itself
 * makes, so this rejects nothing zlib would decode; it exists because
 * compressed data is full of offsets that pass the two-byte header check
 * (about one in 2 KB) and a native call per offset is the scan's main cost.
 */
function couldStartZlibStream(bytes: Uint8Array, off: number): boolean {
  if (off + ZLIB_MIN_STREAM_BYTES > bytes.length) return false;

  // RFC 1950 header: CM = 8 (deflate), CINFO ≤ 7 (window ≤ 32K), FCHECK
  // makes CMF·256 + FLG a multiple of 31, and no preset dictionary (FDICT),
  // which we would have no way to supply.
  const cmf = bytes[off];
  const flg = bytes[off + 1];
  if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7) return false;
  if (((cmf << 8) | flg) % 31 !== 0 || flg & 0x20) return false;

  // RFC 1951 first block header: BFINAL (1 bit), then BTYPE (2 bits).
  const block = (off + 2) * 8;
  const blockType = readBits(bytes, block + 1, 2);

  if (blockType === 0) {
    // Stored: LEN then its one's complement NLEN, from the next whole byte.
    const len = bytes[off + 3] | (bytes[off + 4] << 8);
    const nlen = bytes[off + 5] | (bytes[off + 6] << 8);
    return len === (~nlen & 0xffff);
  }
  if (blockType === 1) return true; // fixed Huffman: nothing cheap left to check
  if (blockType === 3) return false; // reserved

  // Dynamic Huffman. zlib refuses more than 286 literal/length or 30
  // distance codes, and a code-length code that is not a complete prefix
  // code (over-subscribed or incomplete).
  const literalCodes = readBits(bytes, block + 3, 5) + 257;
  const distanceCodes = readBits(bytes, block + 8, 5) + 1;
  const codeLengthCodes = readBits(bytes, block + 13, 4) + 4;
  if (literalCodes > 286 || distanceCodes > 30) return false;
  const lengthCounts = [0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < codeLengthCodes; i++) {
    lengthCounts[readBits(bytes, block + 17 + i * 3, 3)]++;
  }
  let unused = 1;
  for (let length = 1; length <= 7; length++) {
    unused = unused * 2 - lengthCounts[length];
    if (unused < 0) return false;
  }
  return unused === 0;
}

/** `count` bits starting at bit `bitPos`, least-significant bit first (RFC 1951 order). */
function readBits(bytes: Uint8Array, bitPos: number, count: number): number {
  let value = 0;
  for (let i = 0; i < count; i++) {
    const at = bitPos + i;
    value |= ((bytes[at >> 3] >> (at & 7)) & 1) << i;
  }
  return value;
}
