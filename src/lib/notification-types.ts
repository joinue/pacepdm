/**
 * The one list of notification types, and what each one means to a person.
 *
 * Client-safe: plain data, no server imports. The type union, the email
 * default, the profile checkbox, the badge on the bell, the tab on the
 * notifications page and the count buckets all read from here. They used to
 * each keep their own copy, and every copy was one type behind: "leadtime"
 * shipped with no tab, no badge colour, a count bucket that added to NaN, and
 * a preferences schema that stripped it on save.
 *
 * Adding a type: one entry below, and the CHECK constraint on
 * `notifications.type` in a migration (migration-061 is the shape).
 */

export const NOTIFICATION_TYPES = [
  "approval",
  "transition",
  "checkout",
  "eco",
  "mention",
  "changelog",
  "leadtime",
  "system",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type BadgeTone = "info" | "purple" | "orange" | "warning" | "success" | "muted";

export interface NotificationTypeInfo {
  /** Short label for a tab or a badge. */
  label: string;
  /** What the person is opting into, on the profile page. */
  hint: string;
  /** Whether it goes out by email until the person says otherwise. */
  emailDefault: boolean;
  tone: BadgeTone;
}

export const NOTIFICATION_TYPE_INFO: Record<NotificationType, NotificationTypeInfo> = {
  approval: {
    label: "Approvals",
    hint: "You're asked to approve, or a request you made is decided",
    emailDefault: true,
    tone: "purple",
  },
  eco: {
    label: "ECOs",
    hint: "An ECO you're involved in changes state, or one is implemented",
    emailDefault: true,
    tone: "orange",
  },
  mention: {
    label: "Mentions",
    hint: "Someone @mentions you in a comment",
    emailDefault: true,
    tone: "success",
  },
  changelog: {
    label: "Change log",
    hint: "Engineering posts a change the team should know about",
    emailDefault: true,
    tone: "info",
  },
  leadtime: {
    label: "Lead times",
    hint: "Someone changes the lead time quoted for a machine",
    emailDefault: true,
    tone: "warning",
  },
  transition: {
    label: "File lifecycle",
    hint: "A file you own changes state, or a file is released or made obsolete",
    emailDefault: true,
    tone: "info",
  },
  checkout: {
    label: "Checkouts",
    hint: "An admin checks in or cancels a checkout you hold",
    emailDefault: true,
    tone: "warning",
  },
  system: {
    label: "System notices",
    hint: "Low-priority announcements from this workspace",
    emailDefault: false,
    tone: "muted",
  },
};

export type EmailPrefs = Record<NotificationType, boolean>;

export const DEFAULT_EMAIL_PREFS: EmailPrefs = Object.fromEntries(
  NOTIFICATION_TYPES.map((t) => [t, NOTIFICATION_TYPE_INFO[t].emailDefault])
) as EmailPrefs;

/** A zeroed count per type, for the buckets the client and the counts route keep. */
export function zeroByType(): Record<NotificationType, number> {
  return Object.fromEntries(NOTIFICATION_TYPES.map((t) => [t, 0])) as Record<
    NotificationType,
    number
  >;
}

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === "string" && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/**
 * The sidebar item a notification belongs to, by where its link points.
 * Coarser than the type: a BOM status change is type=transition with a
 * /boms link, a file release is type=transition with a /vault link.
 */
export const NOTIFICATION_CATEGORIES = [
  "vault",
  "boms",
  "ecos",
  "parts",
  "vendors",
  "leadTimes",
  "changeLog",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

const CATEGORY_BY_PREFIX: Array<[string, NotificationCategory]> = [
  ["/vault", "vault"],
  ["/boms", "boms"],
  ["/ecos", "ecos"],
  ["/parts", "parts"],
  ["/vendors", "vendors"],
  ["/lead-times", "leadTimes"],
  ["/change-log", "changeLog"],
];

export function categoryOfLink(link: string | null | undefined): NotificationCategory | null {
  if (!link) return null;
  for (const [prefix, category] of CATEGORY_BY_PREFIX) {
    if (link.startsWith(prefix)) return category;
  }
  return null;
}

export function zeroByCategory(): Record<NotificationCategory, number> {
  return Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, 0])) as Record<
    NotificationCategory,
    number
  >;
}
