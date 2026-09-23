// The change log: what engineering changed, in words sales can read.
//
// Engineering changes something, quotes and literature do not, and the first
// anyone in sales hears is a customer question. A post is a notice — it
// approves nothing and holds nothing up — which is exactly what keeps it from
// turning into a second, disagreeing change record beside the ECO.
//
// Shared here because the feed, the composer and the notification all have to
// agree on what a category is and how a post reads.

/** What a post is about. Sorts the feed at a glance; matches the CHECK in migration 060. */
export const CHANGE_LOG_CATEGORIES = [
  { value: "DESIGN", label: "Design change", hint: "A part, drawing or assembly changed" },
  { value: "LEAD_TIME", label: "Lead time", hint: "Something is quicker or slower than it was" },
  { value: "PRICING", label: "Pricing", hint: "Cost or price has moved" },
  { value: "DOCUMENTATION", label: "Documentation", hint: "A manual, spec sheet or drawing" },
  { value: "GENERAL", label: "General", hint: "Anything else the team should know" },
] as const;

export type ChangeLogCategory = (typeof CHANGE_LOG_CATEGORIES)[number]["value"];

export const DEFAULT_CATEGORY: ChangeLogCategory = "GENERAL";

export function isChangeLogCategory(value: string): value is ChangeLogCategory {
  return CHANGE_LOG_CATEGORIES.some((c) => c.value === value);
}

export function categoryLabel(value: string): string {
  return CHANGE_LOG_CATEGORIES.find((c) => c.value === value)?.label ?? value;
}

/** A post's own length limit. Long enough for a real explanation, short of an essay. */
export const POST_MAX_LENGTH = 5000;

/** A reply is a clarification, not a second post. */
export const COMMENT_MAX_LENGTH = 2000;

/**
 * The columns a reply is read with, wherever it is read: the feed, the
 * reply route and the edit route all return the same shape.
 */
export const COMMENT_COLUMNS =
  "id, postId, body, createdAt, editedAt, authorId, " +
  "author:tenant_users!change_log_comments_authorId_fkey(fullName)";

/**
 * What can be attached — the things people actually send about a change —
 * keyed by extension, with the content type it is stored under.
 *
 * Keyed by extension because the browser's type is not reliable: Windows
 * reports a .csv as `application/vnd.ms-excel` wherever Excel is installed,
 * and an old .xls or .doc often arrives with no type at all.
 */
export const ATTACHMENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  txt: "text/plain",
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
};

/** The file input's `accept` list, from the same table the route checks. */
export const ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_TYPES)
  .map((ext) => `.${ext}`)
  .join(",");

/** The content type a file is stored under, or null when it cannot be attached. */
export function attachmentContentType(fileName: string): string | null {
  const extension = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
  return ATTACHMENT_TYPES[extension] ?? null;
}

/** 25 MB. A drawing set or a spec sheet fits; a CAD archive belongs in the vault. */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** A post carries what explains the change; more than this is a vault folder. */
export const ATTACHMENTS_PER_POST = 5;

/**
 * A post as the lines it holds.
 *
 * People write a change as a short paragraph or as a list of reasons, and the
 * feed renders both. Leading bullets are stripped so a typed "-" does not
 * render beside the one the list already draws.
 */
export function postLines(body: string | null | undefined): string[] {
  return (body ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((line) => line.length > 0);
}

/** True when the body reads as a list rather than a paragraph. */
export function readsAsList(body: string | null | undefined): boolean {
  return postLines(body).length > 1;
}

/** The object key an attachment is stored under, inside the vault bucket. */
export function attachmentKey(tenantId: string, postId: string, id: string, fileName: string) {
  // The name is kept for the download, not the key: Ø, °, [ and ] in a real
  // drawing name are what broke storage keys built from names before.
  const extension = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "bin";
  const safeExtension = /^[a-z0-9]{1,8}$/.test(extension) ? extension : "bin";
  return `change-log/${tenantId}/${postId}/${id}.${safeExtension}`;
}
