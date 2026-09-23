import { withTenant, badRequest } from "@/lib/api-route";
import { PERMISSIONS } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { z, nonEmptyString, formatZodError } from "@/lib/validation";

const SETTINGS_KEYS = [
  "maxUploadSizeMb",
  "allowedExtensions",
  "revisionScheme",
  "requireCheckoutComment",
  // The two the email sender reads (src/lib/email/send.ts). `emailReplyTo`
  // was read there but never allow-listed here, and a save replaces the
  // whole settings object — so a value set any other way was wiped on the
  // next visit to this page. `digestFrequency` is gone from the list: it was
  // shown, saved, and read by nothing; every email goes out immediately.
  "emailNotifications",
  "emailReplyTo",
  "autoReleasePrefix",
  "partNumberMode",
  "partNumberPrefix",
  "partNumberPadding",
  // Refuse an approval from the person who raised the request. Off by
  // default — see docs/decisions/self-approval.md for why a hard block is the
  // wrong default for a team this size.
  "blockSelfApproval",
  // "OPEN" (default) or "LOCKED". When LOCKED, `parts.unitCost` is read-only
  // in the app so only a source of cost truth writes it; `estimatedCost` stays
  // open either way. See docs/decisions/erp-ownership.md.
  "costSource",
] as const;

const UpdateSettingsSchema = z.object({
  name: nonEmptyString,
  settings: z.record(z.string(), z.unknown()).optional(),
});

// The sender checks `emailNotifications === false` and passes `emailReplyTo`
// straight to the provider, so each has to be the shape it expects: a real
// boolean, not the string "false", and an address or nothing.
const EmailSettingsSchema = z.object({
  emailNotifications: z.boolean().optional(),
  emailReplyTo: z.string().trim().email().or(z.literal("")).optional(),
});

export const GET = withTenant({}, async ({ db }) => {
  // `tenants` is scoped by its own primary key, so this reads the caller's
  // tenant and no other.
  const { data: tenant } = await db.from("tenants").select("name, settings").maybeSingle();

  return {
    name: tenant?.name ?? "",
    settings: (tenant?.settings as Record<string, unknown> | null) ?? {},
  };
});

export const PUT = withTenant(
  { permission: PERMISSIONS.ADMIN_SETTINGS, body: UpdateSettingsSchema },
  async ({ db, tenantUser, body }) => {
    // Sanitize settings — only allow known keys to prevent setting arbitrary
    // attributes on the tenant row. The schema accepts any record; this
    // additional filter enforces the allow-list.
    const sanitized: Record<string, unknown> = {};
    if (body.settings) {
      for (const key of SETTINGS_KEYS) {
        if (key in body.settings) sanitized[key] = body.settings[key];
      }
      const email = EmailSettingsSchema.safeParse(sanitized);
      if (!email.success) {
        throw badRequest("Check the email settings", formatZodError(email.error));
      }
      // An empty reply-to is "none"; keep the row clean rather than storing "".
      if (email.data.emailReplyTo === "") delete sanitized.emailReplyTo;
      else if (email.data.emailReplyTo) sanitized.emailReplyTo = email.data.emailReplyTo;
    }

    // `blockSelfApproval` lives in here, so a discarded failure means an
    // admin turns on a control, is told it saved, and every approval keeps
    // running without it.
    const { error } = await db.from("tenants").update({
      name: body.name,
      settings: sanitized,
      updatedAt: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);

    await logAudit({
      tenantId: tenantUser.tenantId,
      userId: tenantUser.id,
      action: "settings.update",
      entityType: "tenant",
      entityId: tenantUser.tenantId,
      details: { name: body.name },
    });

    return { success: true };
  }
);
