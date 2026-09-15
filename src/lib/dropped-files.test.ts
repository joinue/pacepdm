import { describe, it, expect } from "vitest";
import { collectEntries, isJunkFile } from "./dropped-files";

/**
 * A desktop drop used to upload only its first file, and a dropped folder
 * failed. Directories arrive as entries that have to be walked, and a reader
 * hands them out in batches (100 at a time in Chrome) until it returns none.
 */

type Entry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void) => void;
  createReader?: () => { readEntries: (ok: (entries: Entry[]) => void) => void };
};

function fileEntry(name: string): Entry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok) => ok(new File(["x"], name)),
  };
}

/** A directory whose reader returns its children in batches of `batch`. */
function dirEntry(name: string, children: Entry[], batch = 100): Entry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let offset = 0;
      return {
        readEntries: (ok) => {
          const next = children.slice(offset, offset + batch);
          offset += batch;
          ok(next);
        },
      };
    },
  };
}

describe("collectEntries", () => {
  it("walks nested folders and keeps each file's path", async () => {
    const dropped = await collectEntries([
      fileEntry("readme.pdf"),
      dirEntry("Bracket Assy", [
        fileEntry("Bracket.SLDASM"),
        dirEntry("Parts", [fileEntry("Plate.SLDPRT"), fileEntry("Pin.SLDPRT")]),
      ]),
    ]);

    expect(dropped.map((d) => [...d.dir, d.file.name].join("/"))).toEqual([
      "readme.pdf",
      "Bracket Assy/Bracket.SLDASM",
      "Bracket Assy/Parts/Plate.SLDPRT",
      "Bracket Assy/Parts/Pin.SLDPRT",
    ]);
  });

  it("reads every batch of a large folder, not just the first", async () => {
    const children = Array.from({ length: 250 }, (_, i) => fileEntry(`part-${i}.SLDPRT`));
    const dropped = await collectEntries([dirEntry("Library", children, 100)]);
    expect(dropped).toHaveLength(250);
  });

  it("leaves out OS metadata and CAD lock files", async () => {
    const dropped = await collectEntries([
      dirEntry("Job", [
        fileEntry(".DS_Store"),
        fileEntry("Thumbs.db"),
        fileEntry("~$Bracket.SLDPRT"),
        fileEntry("Bracket.SLDPRT"),
      ]),
    ]);
    expect(dropped.map((d) => d.file.name)).toEqual(["Bracket.SLDPRT"]);
  });
});

describe("isJunkFile", () => {
  it("keeps ordinary names that merely contain a tilde or dot", () => {
    expect(isJunkFile("bracket~v2.pdf")).toBe(false);
    expect(isJunkFile(".gitkeep")).toBe(false);
  });
});
