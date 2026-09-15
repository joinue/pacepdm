import { describe, it, expect } from "vitest";
import {
  dirtyFields,
  discardChanges,
  markSaved,
  mergeRefresh,
  propertiesFromFile,
  type FileProperties,
  type PropertiesForm,
} from "./file-properties-draft";

const server = (overrides: Partial<FileProperties> = {}): FileProperties => ({
  partNumber: "PN-1",
  description: "Bracket",
  category: "CAD",
  metadata: { material: "AL6061" },
  ...overrides,
});

function editing(draft: Partial<FileProperties>, base = server()): PropertiesForm {
  return {
    fileId: "f1",
    baseline: base,
    draft: { ...base, ...draft, metadata: { ...base.metadata, ...draft.metadata } },
    changedElsewhere: false,
  };
}

describe("propertiesFromFile", () => {
  it("turns nulls into empty inputs and metadata rows into a map", () => {
    expect(
      propertiesFromFile({
        partNumber: null,
        description: null,
        category: "CAD",
        metadata: [{ fieldId: "material", value: "AL6061" }],
      })
    ).toEqual({
      partNumber: "",
      description: "",
      category: "CAD",
      metadata: { material: "AL6061" },
    });
  });
});

describe("mergeRefresh", () => {
  it("takes the server's values on first load", () => {
    const form = mergeRefresh(null, "f1", server());
    expect(form.draft).toEqual(server());
    expect(dirtyFields(form)).toEqual([]);
  });

  it("keeps what the user is typing and updates everything else — the reported bug", () => {
    const form = mergeRefresh(
      editing({ description: "Bracket, bent" }),
      "f1",
      server({ partNumber: "PN-2", category: "DRAWING" })
    );
    expect(form.draft.description).toBe("Bracket, bent");
    expect(form.draft.partNumber).toBe("PN-2");
    expect(form.draft.category).toBe("DRAWING");
    expect(dirtyFields(form)).toEqual(["description"]);
    expect(form.changedElsewhere).toBe(false);
  });

  it("keeps an edited custom property, and takes a new one the server added", () => {
    const form = mergeRefresh(
      editing({ metadata: { material: "SS304" } }),
      "f1",
      server({ metadata: { material: "AL6061", finish: "Anodised" } })
    );
    expect(form.draft.metadata).toEqual({ material: "SS304", finish: "Anodised" });
    expect(dirtyFields(form)).toEqual(["metadata.material"]);
  });

  it("flags a field the server changed underneath the user's edit, and keeps the edit", () => {
    const form = mergeRefresh(
      editing({ description: "Mine" }),
      "f1",
      server({ description: "Theirs" })
    );
    expect(form.draft.description).toBe("Mine");
    expect(form.changedElsewhere).toBe(true);
  });

  it("does not flag a server change that matches what the user typed", () => {
    const form = mergeRefresh(
      editing({ description: "Same" }),
      "f1",
      server({ description: "Same" })
    );
    expect(form.changedElsewhere).toBe(false);
    expect(dirtyFields(form)).toEqual([]);
  });

  it("keeps the flag across later refreshes while the edit is still unsaved", () => {
    const flagged = mergeRefresh(
      editing({ description: "Mine" }),
      "f1",
      server({ description: "Theirs" })
    );
    const later = mergeRefresh(flagged, "f1", server({ description: "Theirs" }));
    expect(later.changedElsewhere).toBe(true);
  });

  it("starts over for a different file rather than carrying edits across", () => {
    const form = mergeRefresh(
      editing({ description: "Mine" }),
      "f2",
      server({ description: "Other file" })
    );
    expect(form.fileId).toBe("f2");
    expect(form.draft.description).toBe("Other file");
    expect(dirtyFields(form)).toEqual([]);
  });
});

describe("dirtyFields", () => {
  it("is clean again when a value is typed back to what the server has", () => {
    expect(dirtyFields(editing({ description: "Bracket" }))).toEqual([]);
  });

  it("treats a missing custom property and an empty one as the same", () => {
    const form = editing({ metadata: { finish: "" } });
    expect(dirtyFields(form)).toEqual([]);
  });
});

describe("markSaved", () => {
  it("makes what was sent the baseline, leaving later typing dirty", () => {
    const sent = editing({ description: "Saved text" }).draft;
    const typedSince = editing({ description: "Saved text, and more" });
    const form = markSaved(typedSince, sent);
    expect(dirtyFields(form)).toEqual(["description"]);
    expect(dirtyFields(markSaved(editing({ description: "Saved text" }), sent))).toEqual([]);
  });
});

describe("discardChanges", () => {
  it("shows the server's values and clears the flag", () => {
    const flagged = mergeRefresh(
      editing({ description: "Mine" }),
      "f1",
      server({ description: "Theirs" })
    );
    const form = discardChanges(flagged);
    expect(form.draft.description).toBe("Theirs");
    expect(form.changedElsewhere).toBe(false);
    expect(dirtyFields(form)).toEqual([]);
  });
});
