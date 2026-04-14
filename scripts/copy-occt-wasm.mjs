// Copy occt-import-js's WASM binary from node_modules into public/occt/
// so the browser can fetch it at /occt/occt-import-js.wasm. The CAD
// viewer uses occt-import-js's `locateFile` hook to point at that URL.
//
// Why a script rather than committing the WASM to git: the file is
// ~5 MB and changes only when we bump the occt-import-js version —
// keeping it out of history is cleaner. This script runs automatically
// after `npm install` via the "postinstall" hook in package.json, so
// developers don't need to remember to copy it.
//
// Safe to re-run. Skips copying when the source file is missing
// (e.g. in an environment that installed with --no-optional).

import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const src = join(repoRoot, "node_modules", "occt-import-js", "dist", "occt-import-js.wasm");
const destDir = join(repoRoot, "public", "occt");
const dest = join(destDir, "occt-import-js.wasm");

if (!existsSync(src)) {
  // Non-fatal — CI may install without optional WASM packages, and
  // shipping without the file just degrades STEP support to a
  // download-only fallback (see cad-viewer.tsx).
  console.warn(`[copy-occt-wasm] ${src} not found; skipping`);
  process.exit(0);
}

if (!existsSync(destDir)) {
  mkdirSync(destDir, { recursive: true });
}

copyFileSync(src, dest);
console.info(`[copy-occt-wasm] copied ${src} -> ${dest}`);
