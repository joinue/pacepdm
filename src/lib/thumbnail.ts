import CFB from "cfb";
import sharp from "sharp";

const SW_EXTENSIONS = ["sldprt", "sldasm", "slddrw"];

export function isSolidWorksFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  return SW_EXTENSIONS.includes(ext);
}

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
 * Extract the embedded preview image from a SOLIDWORKS file.
 * SOLIDWORKS files are OLE Compound Documents (CFB) that contain
 * a preview bitmap/PNG at a known path inside the compound file.
 */
export async function extractSolidWorksThumbnail(
  buffer: ArrayBuffer
): Promise<{ data: Uint8Array; mimeType: string } | null> {
  try {
    const cfb = CFB.read(new Uint8Array(buffer), { type: "array" });

    // SOLIDWORKS stores preview images at these paths inside the OLE container
    const previewPaths = [
      "/PreviewPNG",
      "/Preview PNG",
      "/PreviewBMP",
      "/!Preview",
      "/Thumbnails/thumbnail.png",
    ];

    for (const path of previewPaths) {
      const entry = CFB.find(cfb, path);
      if (entry && entry.content && entry.content.length > 100) {
        const result = await identifyAndConvert(new Uint8Array(entry.content));
        if (result) return result;
      }
    }

    // Also try to find any entry with "preview" or "thumbnail" in the name
    for (const entry of cfb.FileIndex) {
      const name = (entry.name || "").toLowerCase();
      if (
        (name.includes("preview") || name.includes("thumbnail")) &&
        entry.content &&
        entry.content.length > 100
      ) {
        const result = await identifyAndConvert(new Uint8Array(entry.content));
        if (result) return result;
      }
    }

    return null;
  } catch (error) {
    console.error("Failed to extract SOLIDWORKS thumbnail:", error);
    return null;
  }
}

/**
 * Identify the image format from raw bytes and convert to a browser-friendly format.
 */
async function identifyAndConvert(
  content: Uint8Array
): Promise<{ data: Uint8Array; mimeType: string } | null> {
  // PNG (magic: 89 50 4E 47)
  if (
    content[0] === 0x89 &&
    content[1] === 0x50 &&
    content[2] === 0x4e &&
    content[3] === 0x47
  ) {
    return { data: content, mimeType: "image/png" };
  }

  // JPEG (magic: FF D8)
  if (content[0] === 0xff && content[1] === 0xd8) {
    return { data: content, mimeType: "image/jpeg" };
  }

  // BMP with file header (magic: 42 4D = "BM")
  if (content[0] === 0x42 && content[1] === 0x4d) {
    return toPng(content, "image/bmp");
  }

  // Raw DIB (headerless bitmap) — common in SLDDRW files
  if (isRawDib(content)) {
    const bmp = dibToBmp(content);
    return toPng(bmp, "image/bmp");
  }

  // EMF (Enhanced Metafile) — common in SLDDRW files
  // sharp cannot handle EMF directly, but we can try via raw processing
  if (isEmf(content)) {
    // EMF is not directly convertible without a full renderer.
    // Skip — the file-level fallback paths may find a raster preview instead.
    return null;
  }

  // Unknown format — try letting sharp handle it (supports many formats)
  try {
    const pngBuffer = await sharp(Buffer.from(content)).png().toBuffer();
    if (pngBuffer.length > 0) {
      return { data: new Uint8Array(pngBuffer), mimeType: "image/png" };
    }
  } catch {
    // sharp can't handle it
  }

  return null;
}
