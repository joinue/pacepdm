import { describe, it, expect } from "vitest";
import {
  FILE_CATEGORIES,
  CATEGORY_LABELS,
  EXTENSION_CATEGORY,
  categoryForExtension,
  categoryForFilename,
  categoryLabel,
  isViewableIn3D,
  isCategoryPlausible,
  normalizeExtension,
} from "./file-categories";

describe("categoryForExtension", () => {
  it("classifies a SolidWorks drawing sheet as a 2D drawing, not a 3D model", () => {
    // The bug this module exists to prevent: .slddrw is produced by 3D CAD but
    // is a drawing sheet. It was stored as MODEL_3D in production, which made
    // the UI promise a 3D view the viewer can never deliver.
    expect(categoryForExtension("slddrw")).toBe("DRAWING_2D");
  });

  it("classifies a STEP file as a 3D model, not OTHER", () => {
    // Also wrong in production: the one genuinely viewable 3D file in the
    // vault was categorised OTHER.
    expect(categoryForExtension("step")).toBe("MODEL_3D");
    expect(categoryForExtension("stp")).toBe("MODEL_3D");
  });

  it("separates parts from assemblies", () => {
    expect(categoryForExtension("sldprt")).toBe("PART");
    expect(categoryForExtension("sldasm")).toBe("ASSEMBLY");
  });

  it("is case-insensitive and tolerates a leading dot or a full filename", () => {
    expect(categoryForExtension("SLDPRT")).toBe("PART");
    expect(categoryForExtension(".SldPrt")).toBe("PART");
    expect(categoryForExtension("Bracket-R2.SLDPRT")).toBe("PART");
  });

  it("returns null for an extension it has no opinion about", () => {
    expect(categoryForExtension("xyz")).toBeNull();
    expect(categoryForExtension("")).toBeNull();
  });
});

describe("categoryForFilename", () => {
  it("falls back to OTHER rather than null", () => {
    expect(categoryForFilename("notes.xyz")).toBe("OTHER");
  });

  it("handles filenames containing dots", () => {
    expect(categoryForFilename("FEMTO Post Cylinder Spacer New-R1.SLDPRT")).toBe("PART");
    expect(categoryForFilename("v1.2.3-housing.step")).toBe("MODEL_3D");
  });

  it("handles a filename with no extension", () => {
    expect(categoryForFilename("README")).toBe("OTHER");
  });
});

describe("labels", () => {
  it("has a label for every category", () => {
    for (const c of FILE_CATEGORIES) {
      expect(CATEGORY_LABELS[c], `no label for ${c}`).toBeTruthy();
    }
  });

  it("maps every derived category to a real category", () => {
    for (const [ext, category] of Object.entries(EXTENSION_CATEGORY)) {
      expect(FILE_CATEGORIES, `${ext} → ${category}`).toContain(category);
    }
  });

  it("falls back to the raw value for a category it does not know", () => {
    expect(categoryLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });

  it("treats a missing category as Other", () => {
    expect(categoryLabel(null)).toBe("Other");
    expect(categoryLabel(undefined)).toBe("Other");
  });
});

describe("isViewableIn3D", () => {
  it("accepts the neutral exchange formats the viewer supports", () => {
    for (const ext of ["stl", "obj", "step", "stp", "iges", "igs"]) {
      expect(isViewableIn3D(ext), ext).toBe(true);
    }
  });

  it("rejects native SolidWorks formats", () => {
    // Not a gap to be closed: OpenCascade cannot read proprietary OLE compound
    // documents. If this ever flips to true, the viewer will throw at runtime.
    for (const ext of ["sldprt", "sldasm", "slddrw"]) {
      expect(isViewableIn3D(ext), ext).toBe(false);
    }
  });

  it("does not confuse category with viewability", () => {
    // A .sldprt is genuinely a PART — real 3D geometry — that we still cannot
    // render. The two questions are independent.
    expect(categoryForExtension("sldprt")).toBe("PART");
    expect(isViewableIn3D("sldprt")).toBe(false);
  });
});

describe("isCategoryPlausible", () => {
  it("rejects a drawing sheet stored as a 3D model", () => {
    expect(isCategoryPlausible("slddrw", "MODEL_3D")).toBe(false);
  });

  it("rejects a neutral 3D format stored as a 2D drawing", () => {
    expect(isCategoryPlausible("step", "DRAWING_2D")).toBe(false);
  });

  it("accepts the derived category", () => {
    expect(isCategoryPlausible("step", "MODEL_3D")).toBe(true);
    expect(isCategoryPlausible("slddrw", "DRAWING_2D")).toBe(true);
  });

  it("rejects native CAD stored as MODEL_3D", () => {
    // MODEL_3D means a neutral exchange format. A .sldprt holds 3D geometry
    // but is a PART; calling it MODEL_3D is what left two identical .sldprt
    // files with different categories in production.
    expect(isCategoryPlausible("sldprt", "MODEL_3D")).toBe(false);
    expect(isCategoryPlausible("sldasm", "MODEL_3D")).toBe(false);
    expect(isCategoryPlausible("pdf", "MODEL_3D")).toBe(false);
  });

  it("still accepts MODEL_3D for the neutral formats it describes", () => {
    expect(isCategoryPlausible("step", "MODEL_3D")).toBe(true);
    expect(isCategoryPlausible("stl", "MODEL_3D")).toBe(true);
  });

  it("leaves judgement calls to the uploader", () => {
    // A PDF may be a document, a released drawing, or a spec sheet. Only the
    // person uploading it knows, so we do not second-guess.
    expect(isCategoryPlausible("pdf", "DRAWING")).toBe(true);
    expect(isCategoryPlausible("pdf", "DOCUMENT")).toBe(true);
    // A "part" file can hold a multibody assembly.
    expect(isCategoryPlausible("sldprt", "ASSEMBLY")).toBe(true);
  });

  it("has no opinion about unknown extensions", () => {
    expect(isCategoryPlausible("xyz", "MODEL_3D")).toBe(true);
  });
});

describe("normalizeExtension", () => {
  it("lowercases and strips everything before the last dot", () => {
    expect(normalizeExtension("Bracket.R2.STEP")).toBe("step");
    expect(normalizeExtension("  .PDF ")).toBe("pdf");
  });
});
