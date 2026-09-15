/**
 * Transactional email for in-app notifications.
 *
 * Uses Resend's REST API directly (no SDK dependency). The public entry
 * points are `sendNotificationEmail` and `sendInviteEmail` — callers never
 * hit Resend directly, so swapping providers (Postmark, SES) is a one-file
 * change.
 *
 * Environment:
 *   RESEND_API_KEY   — required. If missing, sendNotificationEmail is a no-op
 *                      (returns {skipped:true}) so local/CI runs without
 *                      credentials don't fail writes.
 *   EMAIL_FROM       — e.g. "PACE PDM <notifications@pacepdm.com>". Required
 *                      when RESEND_API_KEY is set.
 *   APP_URL          — e.g. "https://app.pacepdm.com". Used to build absolute
 *                      links in email bodies. Falls back to a relative link.
 */

import { getServiceClient } from "@/lib/db";
import { renderInviteEmail, renderNotificationEmail, type EmailType } from "./templates";

export type EmailPrefs = Record<EmailType, boolean>;

export const DEFAULT_EMAIL_PREFS: EmailPrefs = {
  approval: true,
  transition: true,
  checkout: true,
  eco: true,
  system: false,
};

interface SendNotificationEmailParams {
  notificationId: string;
  tenantId: string;
  userId: string;
  type: EmailType;
  title: string;
  message: string;
  link?: string | null;
}

interface SendResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  providerId?: string;
}

export async function sendNotificationEmail(
  params: SendNotificationEmailParams
): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, skipped: true, reason: "no-api-key" };

  const db = getServiceClient();

  const { data: user } = await db
    .from("tenant_users")
    .select("email, fullName, emailPrefs, isActive")
    .eq("id", params.userId)
    .maybeSingle();

  if (!user) return { ok: false, skipped: true, reason: "user-not-found" };
  if (!user.isActive) return { ok: false, skipped: true, reason: "user-inactive" };

  const prefs: EmailPrefs = {
    ...DEFAULT_EMAIL_PREFS,
    ...((user.emailPrefs as Partial<EmailPrefs>) || {}),
  };
  if (!prefs[params.type]) {
    return { ok: false, skipped: true, reason: "user-opt-out" };
  }

  const { data: tenant } = await db
    .from("tenants")
    .select("name, settings")
    .eq("id", params.tenantId)
    .maybeSingle();

  const tenantSettings = (tenant?.settings as Record<string, unknown>) || {};
  if (tenantSettings.emailNotifications === false) {
    return { ok: false, skipped: true, reason: "tenant-opt-out" };
  }

  const from = process.env.EMAIL_FROM;
  if (!from) {
    return { ok: false, skipped: true, reason: "no-from-address" };
  }

  const replyTo =
    (typeof tenantSettings.emailReplyTo === "string" && tenantSettings.emailReplyTo) || undefined;

  const appUrl = process.env.APP_URL || "";
  const absoluteLink = params.link
    ? params.link.startsWith("http")
      ? params.link
      : `${appUrl}${params.link}`
    : undefined;

  const { subject, html, text } = renderNotificationEmail({
    type: params.type,
    title: params.title,
    message: params.message,
    link: absoluteLink,
    tenantName: tenant?.name || "PACE PDM",
    recipientName: user.fullName,
  });

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [user.email],
        subject,
        html,
        text,
        reply_to: replyTo,
        tags: [
          { name: "type", value: params.type },
          { name: "tenant", value: params.tenantId },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = `resend ${res.status}: ${body.slice(0, 200)}`;
      // These three write-backs record what happened to the send; the send
      // itself has already succeeded or failed and the return value below is
      // the authority on that. So a failed write-back is logged, never
      // returned — but it is what makes `emailError` trustworthy, and a
      // delivery column that is quietly sometimes-blank is worse than one
      // that is always blank.
      const { error: writeBackError } = await db
        .from("notifications")
        .update({ emailError: err })
        .eq("id", params.notificationId);
      if (writeBackError) {
        console.warn(
          `[email] could not record the send failure on ${params.notificationId}:`,
          writeBackError.message
        );
      }
      return { ok: false, reason: err };
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string };
    const { error: sentError } = await db
      .from("notifications")
      .update({ emailSentAt: new Date().toISOString(), emailError: null })
      .eq("id", params.notificationId);
    if (sentError) {
      console.warn(
        `[email] sent, but could not stamp emailSentAt on ${params.notificationId}:`,
        sentError.message
      );
    }
    return { ok: true, providerId: data.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const { error: writeBackError } = await db
      .from("notifications")
      .update({ emailError: `fetch: ${msg.slice(0, 200)}` })
      .eq("id", params.notificationId);
    if (writeBackError) {
      console.warn(
        `[email] could not record the send failure on ${params.notificationId}:`,
        writeBackError.message
      );
    }
    return { ok: false, reason: msg };
  }
}

/**
 * Whether the app can send email itself. A caller with a fallback checks this
 * first: users/invite hands the invitation to Supabase's mailer instead.
 */
export function appEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

interface SendInviteEmailParams {
  to: string;
  recipientName: string;
  inviterName: string;
  tenantId: string;
  tenantName: string;
  /** Absolute URL of the app page that verifies the invite token. */
  link: string;
  replyTo?: string;
}

/**
 * Send a workspace invitation.
 *
 * Unlike sendNotificationEmail this ignores notification preferences — the
 * recipient has no account to hold any yet, and an invitation that quietly
 * does not arrive is the one email the flow cannot work without. It also
 * writes nothing back, so the caller decides what a failed send means.
 */
export async function sendInviteEmail(params: SendInviteEmailParams): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, skipped: true, reason: "no-api-key" };
  const from = process.env.EMAIL_FROM;
  if (!from) return { ok: false, skipped: true, reason: "no-from-address" };

  const { subject, html, text } = renderInviteEmail({
    tenantName: params.tenantName,
    inviterName: params.inviterName,
    recipientName: params.recipientName,
    link: params.link,
  });

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [params.to],
        subject,
        html,
        text,
        reply_to: params.replyTo,
        tags: [
          { name: "type", value: "invite" },
          { name: "tenant", value: params.tenantId },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, reason: `resend ${res.status}: ${body.slice(0, 200)}` };
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, providerId: data.id };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
