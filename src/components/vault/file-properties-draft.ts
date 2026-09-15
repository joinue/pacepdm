/**
 * The editable properties in the file detail panel, and what a refresh may do
 * to them.
 *
 * The panel re-reads the file whenever its row or versions change — a
 * teammate's check-out, a lifecycle transition, the CAD viewer saving a
 * thumbnail it just captured. Each re-read used to overwrite Part Number,
 * Description, Category and every custom property with the server's values,
 * so whatever the user was typing vanished mid-word, and a thumbnail capture
 * could do it seconds after the panel opened.
 *
 * The rule now: a refresh updates every field the user has not changed, and
 * leaves the ones they have. A field is changed when its value differs from
 * the last value the server gave it, so typing a value back to what it was
 * makes it clean again. When the server's value for a changed field moves
 * underneath the edit, that is flagged rather than silently resolved either
 * way — the user decides whether to keep typing or reload.
 *
 * Pure, so the rule is tested without rendering the panel.
 */

export interface FileProperties {
  partNumber: string;
  description: string;
  category: string;
  /** Custom property values by field id. A missing key and "" both mean empty. */
  metadata: Record<string, string>;
}

export interface PropertiesForm {
  /** The file these values belong to. A refresh for another file starts over. */
  fileId: string;
  /** The server's values as last read or saved. */
  baseline: FileProperties;
  /** What the inputs show. */
  draft: FileProperties;
  /** The server changed a field the user has also changed, since they started. */
  changedElsewhere: boolean;
}

const SCALAR_FIELDS = ["partNumber", "description", "category"] as const;

export function propertiesFromFile(file: {
  partNumber: string | null;
  description: string | null;
  category: string | null;
  metadata: { fieldId: string; value: string }[];
}): FileProperties {
  const metadata: Record<string, string> = {};
  for (const mv of file.metadata) metadata[mv.fieldId] = mv.value;
  return {
    partNumber: file.partNumber || "",
    description: file.description || "",
    category: file.category || "",
    metadata,
  };
}

/** Every custom property id any of these mention. */
function metadataKeys(...sets: FileProperties[]): string[] {
  return [...new Set(sets.flatMap((s) => Object.keys(s.metadata)))];
}

const metaValue = (p: FileProperties, id: string) => p.metadata[id] ?? "";

/** Names of the fields whose draft differs from the server: `partNumber`, `metadata.<id>`… */
export function dirtyFields(form: PropertiesForm | null): string[] {
  if (!form) return [];
  const dirty: string[] = SCALAR_FIELDS.filter((f) => form.draft[f] !== form.baseline[f]);
  for (const id of metadataKeys(form.draft, form.baseline)) {
    if (metaValue(form.draft, id) !== metaValue(form.baseline, id)) dirty.push(`metadata.${id}`);
  }
  return dirty;
}

/**
 * Apply freshly read server values. Clean fields take them; changed fields
 * keep the user's text.
 */
export function mergeRefresh(
  prev: PropertiesForm | null,
  fileId: string,
  incoming: FileProperties
): PropertiesForm {
  if (!prev || prev.fileId !== fileId) {
    return { fileId, baseline: incoming, draft: incoming, changedElsewhere: false };
  }

  let conflict = false;
  const resolve = (draft: string, baseline: string, server: string) => {
    if (draft === baseline) return server;
    if (server !== baseline && server !== draft) conflict = true;
    return draft;
  };

  const draft: FileProperties = {
    partNumber: resolve(prev.draft.partNumber, prev.baseline.partNumber, incoming.partNumber),
    description: resolve(prev.draft.description, prev.baseline.description, incoming.description),
    category: resolve(prev.draft.category, prev.baseline.category, incoming.category),
    metadata: {},
  };
  for (const id of metadataKeys(prev.draft, prev.baseline, incoming)) {
    draft.metadata[id] = resolve(
      metaValue(prev.draft, id),
      metaValue(prev.baseline, id),
      metaValue(incoming, id)
    );
  }

  const next: PropertiesForm = {
    fileId,
    baseline: incoming,
    draft,
    changedElsewhere: false,
  };
  next.changedElsewhere = (prev.changedElsewhere || conflict) && dirtyFields(next).length > 0;
  return next;
}

/** A save of `sent` succeeded: those values are now the server's. */
export function markSaved(form: PropertiesForm, sent: FileProperties): PropertiesForm {
  return { ...form, baseline: sent, changedElsewhere: false };
}

/** Throw away the user's changes and show the server's values. */
export function discardChanges(form: PropertiesForm): PropertiesForm {
  return { ...form, draft: form.baseline, changedElsewhere: false };
}
