/**
 * Debug CLI for the thumbnail extractor.
 *
 * Usage:
 *   npx tsx scripts/debug-thumbnail.ts path/to/file.sldprt
 *   npx tsx scripts/debug-thumbnail.ts path/to/drawing.slddrw --out preview.png
 *
 * Runs the production extractor against a local file and prints a full
 * diagnostic report — every CFB stream the extractor inspected, what
 * magic bytes each one starts with, what content type was detected, and
 * which one (if any) was picked as the thumbnail. When extraction
 * succeeds, optionally writes the resulting PNG to disk so you can
 * eyeball it.
 *
 * This is the tool to reach for when a real SolidWorks file in the
 * vault isn't getting a thumbnail. Run it on the file locally and
 * paste the output back so the extractor can be tuned for the actual
 * shape of the data instead of guesses.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  extractSolidWorksThumbnailWithReport,
  extractThumbnail,
} from "../src/lib/thumbnail";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const inputArg = args.find((a) => !a.startsWith("--")) ?? "";
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 ? args[outIdx + 1] : null;

  if (!inputArg) {
    printUsage();
    process.exit(1);
  }

  const filePath = resolve(inputArg);
  const filename = filePath.split(/[\\/]/).pop() || "file";
  const ext = filename.split(".").pop()?.toLowerCase() || "";

  console.log(`\nFile: ${filePath}`);
  console.log(`Name: ${filename}`);
  console.log(`Ext:  ${ext}\n`);

  const buffer = readFileSync(filePath);
  // Convert Node Buffer to ArrayBuffer for the extractor.
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;

  // For SolidWorks files, run the report-producing path so we get the
  // full stream-by-stream breakdown. For everything else, run the
  // generic dispatcher and report success/failure only.
  const isSw = ["sldprt", "sldasm", "slddrw"].includes(ext);

  if (isSw) {
    const { thumbnail, report } = await extractSolidWorksThumbnailWithReport(
      arrayBuffer
    );

    console.log(`CFB streams found: ${report.streams.length}`);
    console.log("─".repeat(78));

    if (report.streams.length === 0) {
      console.log("(none)");
    } else {
      // Sort by size descending so the largest streams (most likely to be
      // the preview) appear first.
      const sorted = [...report.streams].sort((a, b) => b.size - a.size);
      console.log(
        "  " +
          padRight("name", 38) +
          padLeft("size", 10) +
          "  " +
          padRight("magic", 25) +
          "detected"
      );
      console.log("─".repeat(78));
      for (const s of sorted) {
        const marker = report.picked && s.name === report.picked.name ? " *" : "  ";
        console.log(
          marker +
            padRight(truncate(s.name, 38), 38) +
            padLeft(s.size.toString(), 10) +
            "  " +
            padRight(s.magicHex, 25) +
            s.detected
        );
      }
    }

    console.log("─".repeat(78));
    if (report.picked) {
      console.log(
        `\nPicked: ${report.picked.name} (${report.picked.size}b, ${report.picked.detected})`
      );
    } else {
      console.log("\nPicked: (none)");
    }
    if (report.reason) {
      console.log(`Reason: ${report.reason}`);
    }
    console.log(`Thumbnail produced: ${thumbnail ? "YES" : "NO"}`);

    if (thumbnail && outPath) {
      writeFileSync(outPath, thumbnail.data);
      console.log(`Wrote ${thumbnail.data.length}b to ${outPath}`);
    } else if (thumbnail && !outPath) {
      console.log(`(Pass --out preview.png to save the thumbnail)`);
    }
  } else {
    // Non-SolidWorks: run the generic dispatcher.
    const result = await extractThumbnail(arrayBuffer, filename);
    if (result) {
      console.log(
        `Thumbnail produced: YES (${result.mimeType}, ${result.data.length}b)`
      );
      if (outPath) {
        writeFileSync(outPath, result.data);
        console.log(`Wrote ${result.data.length}b to ${outPath}`);
      } else {
        console.log("(Pass --out preview.png to save the thumbnail)");
      }
    } else {
      console.log("Thumbnail produced: NO");
      console.log(
        "The extractor returned null. This format is either unsupported " +
          "or has no embedded preview the extractor recognises."
      );
    }
  }
}

function printUsage() {
  console.log("Usage: npx tsx scripts/debug-thumbnail.ts <file> [--out preview.png]");
  console.log("");
  console.log("Runs the thumbnail extractor against a local file and prints a");
  console.log("full diagnostic report. Use this to debug SolidWorks (or any");
  console.log("other) files where the vault isn't showing a thumbnail.");
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function padLeft(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

main().catch((err) => {
  console.error("debug-thumbnail failed:", err);
  process.exit(1);
});
