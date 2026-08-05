// Parser for the QuickBooks-derived multi-BOM build list.
//
// PACE's build lists come out of QuickBooks as one CSV describing MANY BOMs,
// with the assembly hierarchy expressed by NAME REFERENCE rather than by
// indentation. `NANO-1000S` lists `NANO-1000S Casting-Components` as a line,
// and that name appears later in the same file as its own `BOM` block. That
// maps directly onto `boms` + `bom_items.linkedBomId`.
//
// The format has three traps, none of them guessable from the header row:
//
//   1. `BOM` rows do not follow the header. The header describes `Item`
//      rows only. On a `BOM` row, column 1 is the part number and column 2
//      is the description:
//
//        Flag,Description,Type,Part,Quantity,UOM,...          <- header
//        BOM,N1S-A-SA,NANO-1000/2000S Spindle Assembly,TRUE,1 <- NOT that
//        Item,Add N1S-002,Raw Good,N1S-002,2,ea,...           <- is that
//
//   2. The first `Item` of every BOM is `Create <X>` with Type
//      `Finished Good`. That row is the BOM's own output, not a component.
//      Treat it as a component and every BOM contains itself.
//
//   3. `Description` on an item row is an action label ("Add N1S-002"),
//      not a description. It is discarded; the real descriptions for
//      sub-assemblies come from their own `BOM` row, and leaf parts have
//      none in this file at all.
//
// Everything here is pure so it can be tested against the real archive file
// without a database. The route (`POST /api/boms/import`) owns persistence.

import { parseCsv } from "./csv";

/** Column positions on an `Item` row, which does follow the header. */
const ITEM_COL = {
  flag: 0,
  description: 1,
  type: 2,
  part: 3,
  quantity: 4,
  uom: 5,
  optionGroup: 9,
  optionPrompt: 10,
} as const;

/** Column positions on a `BOM` row, which does not. */
const BOM_COL = {
  flag: 0,
  partNumber: 1,
  description: 2,
} as const;

export interface ParsedBomItem {
  /** Part number of the component. Revision suffix already stripped. */
  partNumber: string;
  /** Revision parsed off the part number ("R2"), or null when unsuffixed. */
  revision: string | null;
  /** Part number exactly as it appeared in the file, for error reporting. */
  sourcePartNumber: string;
  quantity: number;
  unit: string;
  /** Configure-to-order group ("Voltage"), or null for always-included lines. */
  optionGroup: string | null;
  optionPrompt: string | null;
  /** 1-based position within its BOM, used for itemNumber and sortOrder. */
  position: number;
  /** Line number in the source file, so errors point somewhere real. */
  sourceLine: number;
}

export interface ParsedBom {
  partNumber: string;
  revision: string | null;
  sourcePartNumber: string;
  description: string | null;
  items: ParsedBomItem[];
  sourceLine: number;
}

export interface ParsedBomFile {
  boms: ParsedBom[];
  /** Rows that could not be used, with a reason. Never throws on bad rows. */
  problems: { line: number; message: string }[];
}

/**
 * Split a trailing `-R<n>` revision off a part number.
 *
 *   N1S-M-001-R2  → { partNumber: "N1S-M-001", revision: "R2" }
 *   N1S-P-004     → { partNumber: "N1S-P-004", revision: null }
 *
 * Deliberately strict about the shape. `PS-24V-LRS75-24` ends in `-24` and
 * `POW-E-STOP-1CR` ends in `-1CR`; neither is a revision and neither
 * matches. The risk that remains is a part legitimately ending in `-R<n>`
 * that is not a revision — unknowable from the file, and `sourcePartNumber`
 * is retained so such a case is traceable after the fact.
 */
export function splitRevision(raw: string): { partNumber: string; revision: string | null } {
  const match = raw.match(/^(.+)-R(\d+)$/);
  if (!match) return { partNumber: raw, revision: null };
  return { partNumber: match[1], revision: `R${match[2]}` };
}

function isBlankRow(row: string[]): boolean {
  return row.every((cell) => cell.trim() === "");
}

/**
 * Parse a build-list CSV into BOMs and their items.
 *
 * Never throws on malformed content: unusable rows land in `problems` with a
 * line number so a 400-row file with three bad rows still imports the other
 * 397. That mirrors `POST /api/parts/import`, and for the same reason —
 * it is how people actually fix dirty data.
 */
export function parseBuildList(input: string): ParsedBomFile {
  const grid = parseCsv(input);
  const problems: { line: number; message: string }[] = [];
  const boms: ParsedBom[] = [];
  let current: ParsedBom | null = null;

  // Row 0 is the header. Line numbers below are 1-based to match what a
  // spreadsheet shows the person who has to fix the file.
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r];
    const line = r + 1;
    if (isBlankRow(row)) continue;

    const flag = (row[ITEM_COL.flag] ?? "").trim().toUpperCase();

    if (flag === "BOM") {
      const source = (row[BOM_COL.partNumber] ?? "").trim();
      if (!source) {
        problems.push({ line, message: "BOM row has no part number" });
        current = null;
        continue;
      }
      const { partNumber, revision } = splitRevision(source);
      const description = (row[BOM_COL.description] ?? "").trim();
      current = {
        partNumber,
        revision,
        sourcePartNumber: source,
        // A BOM whose description merely repeats its own name carries no
        // information — most of this file is that. Normalise to null so
        // the UI shows nothing rather than a stuttering duplicate.
        description: description && description !== source ? description : null,
        items: [],
        sourceLine: line,
      };
      boms.push(current);
      continue;
    }

    if (flag !== "ITEM") {
      problems.push({ line, message: `Unrecognised row type "${flag || "(empty)"}"` });
      continue;
    }

    if (!current) {
      problems.push({ line, message: "Item row appears before any BOM row" });
      continue;
    }

    // Trap 2: the BOM's own output row, not a component.
    if ((row[ITEM_COL.type] ?? "").trim().toLowerCase() === "finished good") continue;

    const source = (row[ITEM_COL.part] ?? "").trim();
    if (!source) {
      problems.push({ line, message: "Item row has no part number" });
      continue;
    }

    const quantityRaw = (row[ITEM_COL.quantity] ?? "").trim();
    const quantity = Number(quantityRaw);
    // Fractional quantities are legitimate here — HOSE-25-32MM is 0.05 ea
    // (a length cut from stock) — so only non-numeric and non-positive
    // values are rejected.
    if (!Number.isFinite(quantity) || quantity <= 0) {
      problems.push({
        line,
        message: `${source}: quantity "${quantityRaw}" is not a positive number`,
      });
      continue;
    }

    const { partNumber, revision } = splitRevision(source);
    const optionGroup = (row[ITEM_COL.optionGroup] ?? "").trim();
    const optionPrompt = (row[ITEM_COL.optionPrompt] ?? "").trim();

    current.items.push({
      partNumber,
      revision,
      sourcePartNumber: source,
      quantity,
      unit: (row[ITEM_COL.uom] ?? "").trim() || "EA",
      optionGroup: optionGroup || null,
      optionPrompt: optionPrompt || null,
      position: current.items.length + 1,
      sourceLine: line,
    });
  }

  return { boms, problems };
}

/**
 * Every distinct part in the file — components and the BOMs themselves —
 * keyed by the revision-stripped part number.
 *
 * `isSubAssembly` is true when a part number also heads a BOM block, which
 * is how the hierarchy is expressed. Those become `SUB_ASSEMBLY` parts and
 * their BOM lines get a `linkedBomId`.
 *
 * `revision` takes the highest `-R<n>` seen for a part number. A file can
 * legitimately reference the same part at one revision in several BOMs; if
 * it ever references two different revisions, the higher one wins and the
 * caller can spot it because `revisionsSeen` holds more than one entry.
 */
export interface PartSummary {
  partNumber: string;
  revision: string | null;
  revisionsSeen: string[];
  description: string | null;
  isSubAssembly: boolean;
}

/**
 * Punctuation- and case-insensitive key for a part number, used only to spot
 * near-miss references. `NANO1000S Casting-Components` and
 * `NANO-1000S Casting-Components` collapse to the same key.
 *
 * Exported because the same rule has to hold in two places: the importer,
 * which catches a typo as the file lands, and `GET /api/boms`, which catches
 * one already sitting in the database. Two implementations of "nearly the
 * same name" would eventually disagree.
 */
export function looseKey(partNumber: string): string {
  return partNumber.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

const loosely = looseKey;

export interface NearMissLink {
  /** The BOM containing the suspect line. */
  bomPartNumber: string;
  /** The part number as written on the line. */
  itemPartNumber: string;
  /** The BOM name it almost certainly meant. */
  probableBom: string;
  sourceLine: number;
}

/**
 * Lines that reference something *almost* named like one of the file's BOMs.
 *
 * A sub-assembly link is made by exact name match, so a single typo silently
 * demotes an assembly to a leaf part: the line creates a phantom part, and
 * the BOM it should have pointed at is left orphaned at the top level. That
 * is not hypothetical — the NANO-1000S build list has exactly one instance
 * (`NANO1000S Casting-Components`, missing the hyphen), and without this
 * check the import reproduces the mistake faithfully and invisibly.
 *
 * Deliberately conservative: only punctuation, whitespace and case are
 * ignored. Edit-distance matching would flag genuinely distinct part numbers
 * in a scheme where `N1S-P-005` and `N1S-P-006` are different parts.
 */
export function findNearMissLinks(parsed: ParsedBomFile): NearMissLink[] {
  const bomByLooseKey = new Map<string, string>();
  for (const bom of parsed.boms) bomByLooseKey.set(loosely(bom.partNumber), bom.partNumber);
  const exactNames = new Set(parsed.boms.map((b) => b.partNumber));

  const out: NearMissLink[] = [];
  for (const bom of parsed.boms) {
    for (const item of bom.items) {
      if (exactNames.has(item.partNumber)) continue; // links correctly
      const probable = bomByLooseKey.get(loosely(item.partNumber));
      if (!probable || probable === item.partNumber) continue;
      out.push({
        bomPartNumber: bom.partNumber,
        itemPartNumber: item.sourcePartNumber,
        probableBom: probable,
        sourceLine: item.sourceLine,
      });
    }
  }
  return out;
}

export function collectParts(parsed: ParsedBomFile): Map<string, PartSummary> {
  const bomNumbers = new Set(parsed.boms.map((b) => b.partNumber));
  const parts = new Map<string, PartSummary>();

  const note = (partNumber: string, revision: string | null, description: string | null) => {
    const existing = parts.get(partNumber);
    if (!existing) {
      parts.set(partNumber, {
        partNumber,
        revision,
        revisionsSeen: revision ? [revision] : [],
        description,
        isSubAssembly: bomNumbers.has(partNumber),
      });
      return;
    }
    if (revision && !existing.revisionsSeen.includes(revision)) {
      existing.revisionsSeen.push(revision);
      // Highest revision wins. Compare numerically so R10 beats R9.
      const rank = (r: string) => Number(r.slice(1));
      if (!existing.revision || rank(revision) > rank(existing.revision)) {
        existing.revision = revision;
      }
    }
    if (!existing.description && description) existing.description = description;
  };

  for (const bom of parsed.boms) {
    note(bom.partNumber, bom.revision, bom.description);
    for (const item of bom.items) note(item.partNumber, item.revision, null);
  }

  return parts;
}
