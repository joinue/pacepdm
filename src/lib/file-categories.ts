/**
 * File categories: the vocabulary, the labels, and how a file's extension maps
 * to one.
 *
 * Everything about categorising a file lives here, because it was previously in
 * five places that had already drifted:
 *
 *   - the extension → category map lived inside src/app/api/files/route.ts,
 *     where the client could not reach it, so the upload dialog could not show
 *     the user what auto-detect was going to choose
 *   - the label map ("MODEL_3D" → "3D Model") was copy-pasted into
 *     file-detail-panel (twice), upload-file-dialog (twice), vault-file-list,
 *     and parts-types
 *   - the list of formats the 3D viewer can actually open was stated
 *     independently in cad-viewer.tsx and the preview route
 *
 * The drift showed up in real data: a .SLDDRW (a 2D drawing) stored as
 * MODEL_3D, and a .STEP (an actual 3D model) stored as OTHER.
 */

export const FILE_CATEGORIES = [
  "PART",
  "ASSEMBLY",
  "DRAWING",
  "DRAWING_2D",
  "MODEL_3D",
  "DOCUMENT",
  "SIMULATION",
  "FIRMWARE",
  "SOFTWARE",
  "PURCHASED",
  "OTHER",
] as const;

export type FileCategory = (typeof FILE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<FileCategory, string> = {
  PART: "Part",
  ASSEMBLY: "Assembly",
  DRAWING: "Drawing PDF",
  DRAWING_2D: "2D Drawing",
  MODEL_3D: "3D Model",
  DOCUMENT: "Document",
  SIMULATION: "Simulation",
  FIRMWARE: "Firmware",
  SOFTWARE: "Software",
  PURCHASED: "Purchased Part",
  OTHER: "Other",
};

/**
 * Extension → category. This is what "Auto-detect from extension" resolves to
 * when the uploader does not choose one.
 *
 * The distinction that matters most here: a **part/assembly** is a native CAD
 * document, a **DRAWING_2D** is a drawing sheet, and **MODEL_3D** is a neutral
 * exchange format that carries geometry. `.slddrw` is a drawing sheet even
 * though it is produced by 3D CAD, which is exactly the case that was being
 * mislabelled.
 */
export const EXTENSION_CATEGORY: Record<string, FileCategory> = {
  // SolidWorks native
  sldprt: "PART",
  sldasm: "ASSEMBLY",
  slddrw: "DRAWING_2D",
  // Other native CAD
  ipt: "PART",
  iam: "ASSEMBLY",
  idw: "DRAWING_2D",
  prt: "PART",
  asm: "ASSEMBLY",
  catpart: "PART",
  catproduct: "ASSEMBLY",
  f3d: "PART",
  // 2D drawings
  dxf: "DRAWING_2D",
  dwg: "DRAWING_2D",
  // Neutral 3D exchange formats
  step: "MODEL_3D",
  stp: "MODEL_3D",
  iges: "MODEL_3D",
  igs: "MODEL_3D",
  stl: "MODEL_3D",
  obj: "MODEL_3D",
  "3mf": "MODEL_3D",
  x_t: "MODEL_3D",
  x_b: "MODEL_3D",
  sat: "MODEL_3D",
  jt: "MODEL_3D",
  // Documents
  pdf: "DOCUMENT",
  doc: "DOCUMENT",
  docx: "DOCUMENT",
  xls: "DOCUMENT",
  xlsx: "DOCUMENT",
  csv: "DOCUMENT",
  txt: "DOCUMENT",
  md: "DOCUMENT",
};

/**
 * Formats the in-browser 3D viewer can actually open.
 *
 * Native CAD (`.sldprt`, `.slddrw`, …) is deliberately absent and cannot be
 * added: those are proprietary OLE compound documents, and occt-import-js is a
 * build of OpenCascade, which reads neutral formats only. A SolidWorks file
 * gets its embedded 2D preview bitmap extracted instead (see lib/thumbnail.ts).
 *
 * Note this is independent of category: a `.sldprt` is genuinely a PART, and a
 * PART is genuinely 3D geometry — we just cannot render it. Do not conflate
 * "what this file is" with "what we can show".
 */
export const VIEWABLE_3D_EXTENSIONS = ["stl", "obj", "step", "stp", "iges", "igs"] as const;

export function normalizeExtension(input: string): string {
  const last = input.toLowerCase().trim().split(".").pop() ?? "";
  return last;
}

/** The category implied by a file extension, or null when we have no opinion. */
export function categoryForExtension(extension: string): FileCategory | null {
  return EXTENSION_CATEGORY[normalizeExtension(extension)] ?? null;
}

/** The category implied by a filename. Falls back to OTHER for unknown types. */
export function categoryForFilename(filename: string): FileCategory {
  return categoryForExtension(filename) ?? "OTHER";
}

export function categoryLabel(category: string | null | undefined): string {
  if (!category) return CATEGORY_LABELS.OTHER;
  return CATEGORY_LABELS[category as FileCategory] ?? category;
}

/** True when the 3D viewer can open this extension. */
export function isViewableIn3D(extension: string): boolean {
  return (VIEWABLE_3D_EXTENSIONS as readonly string[]).includes(normalizeExtension(extension));
}

/**
 * Whether a stored category is defensible for a given extension.
 *
 * Used by the backfill and by the upload dialog's warning. This is deliberately
 * permissive: a `.pdf` may legitimately be a DOCUMENT, a DRAWING, or a
 * SPECIFICATION depending on what it contains, and only the uploader knows. It
 * returns false only for combinations that cannot be right — a drawing sheet
 * stored as a 3D model, a neutral 3D format stored as a 2D drawing.
 */
export function isCategoryPlausible(extension: string, category: string): boolean {
  const ext = normalizeExtension(extension);
  const derived = EXTENSION_CATEGORY[ext];
  if (!derived) return true; // no opinion about unknown extensions
  if (derived === category) return true;

  // MODEL_3D means specifically a *neutral exchange format* carrying geometry
  // — STEP, IGES, STL, and friends. A native CAD document is a PART, an
  // ASSEMBLY, or a DRAWING_2D, never a MODEL_3D, even though a .sldprt plainly
  // contains 3D geometry. Keeping the distinction is what makes the label
  // useful: MODEL_3D is the set you can hand to someone who does not own
  // SolidWorks. Two .sldprt files, one PART and one MODEL_3D, is exactly the
  // inconsistency this rule removes.
  if (category === "MODEL_3D" && derived !== "MODEL_3D") return false;

  // A drawing sheet is never a 3D model, and a neutral 3D format is never a
  // drawing sheet.
  if (derived === "MODEL_3D" && category === "DRAWING_2D") return false;

  // Parts and assemblies are interchangeable enough in practice (a "part" file
  // can hold a multibody assembly), and everything else is a judgement call the
  // uploader is entitled to make.
  return true;
}
