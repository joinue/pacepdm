/**
 * Transactional email for in-app notifications.
 *
 * Uses Resend's REST API directly (no SDK dependency). The public entry
 * point is `sendNotificationEmail` — callers never hit Resend directly,
 * so swapping providers (Postmark, SES) is a one-file change.
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
import { renderNotificationEmail, type EmailType } from "./templates";

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
    (typeof tenantSettings.emailReplyTo === "string" && tenantSettings.emailReplyTo) ||
    undefined;

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
      await db
        .from("notifications")
        .update({ emailError: err })
        .eq("id", params.notificationId);
      return { ok: false, reason: err };
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string };
    await db
      .from("notifications")
      .update({ emailSentAt: new Date().toISOString(), emailError: null })
      .eq("id", params.notificationId);
    return { ok: true, providerId: data.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .from("notifications")
      .update({ emailError: `fetch: ${msg.slice(0, 200)}` })
      .eq("id", params.notificationId);
    return { ok: false, reason: msg };
  }
}
