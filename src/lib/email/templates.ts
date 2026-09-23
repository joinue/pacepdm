/**
 * Plain HTML + text templates for transactional notification emails.
 *
 * Intentionally dependency-free: one render function, one shared layout,
 * per-type subject/lede. When we want richer templates (branding, images)
 * we can swap the body for React Email without touching callers.
 */

import type { NotificationType } from "@/lib/notification-types";

// Every notification type can go out as an email; the list lives with the
// rest of what a type means, in notification-types.ts.
export type EmailType = NotificationType;

interface RenderParams {
  type: EmailType;
  title: string;
  message: string;
  link?: string;
  tenantName: string;
  recipientName: string;
}

interface Rendered {
  subject: string;
  html: string;
  text: string;
}

const SUBJECT_PREFIX: Record<EmailType, string> = {
  approval: "Approval needed",
  transition: "File update",
  checkout: "Checkout update",
  eco: "ECO update",
  system: "Notice",
  mention: "You were mentioned",
  leadtime: "Lead time update",
  changelog: "Change log",
};

const CTA_LABEL: Record<EmailType, string> = {
  approval: "Review approval",
  transition: "Open in vault",
  checkout: "Open checkout",
  eco: "Open ECO",
  system: "Open",
  mention: "Open the comment",
  leadtime: "Open lead times",
  changelog: "Open the change log",
};

export function renderNotificationEmail(p: RenderParams): Rendered {
  const subject = `[${p.tenantName}] ${SUBJECT_PREFIX[p.type]}: ${p.title}`;

  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const ctaHtml = p.link
    ? `<p style="margin:24px 0"><a href="${escape(p.link)}" style="display:inline-block;background:#111827;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:500">${CTA_LABEL[p.type]}</a></p>`
    : "";

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:32px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e5e7eb">
<tr><td style="padding:28px 32px 8px 32px">
<p style="margin:0;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.04em">${escape(p.tenantName)} &middot; ${escape(SUBJECT_PREFIX[p.type])}</p>
<h1 style="margin:8px 0 0 0;font-size:20px;color:#111827">${escape(p.title)}</h1>
</td></tr>
<tr><td style="padding:8px 32px 24px 32px;font-size:14px;color:#374151;line-height:1.55">
<p style="margin:0 0 12px 0">Hi ${escape(p.recipientName.split(" ")[0] || p.recipientName)},</p>
<p style="margin:0">${escape(p.message)}</p>
${ctaHtml}
<p style="margin:24px 0 0 0;font-size:12px;color:#6b7280">You're receiving this because you have email notifications enabled in ${escape(p.tenantName)}. Manage preferences in your profile.</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    `${p.tenantName} — ${SUBJECT_PREFIX[p.type]}`,
    "",
    p.title,
    "",
    `Hi ${p.recipientName.split(" ")[0] || p.recipientName},`,
    "",
    p.message,
    "",
    p.link ? `${CTA_LABEL[p.type]}: ${p.link}` : "",
    "",
    "— Manage email preferences in your profile.",
  ]
    .filter(Boolean)
    .join("\n");

  return { subject, html, text };
}

interface RenderInviteParams {
  tenantName: string;
  inviterName: string;
  recipientName: string;
  /** Absolute URL of the app page that verifies the invite token. */
  link: string;
  /**
   * The recipient already had a PACE PDM account, so they were added rather
   * than invited: they can sign in with the password they have, and the link
   * is there in case they do not remember it — or never set one.
   */
  existingAccount?: boolean;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * One email around a single call to action. Every account email — the
 * invitation, the sign-up confirmation — is this layout with different words,
 * so a change to the chrome lands in all of them.
 */
function renderActionEmail(p: {
  subject: string;
  kicker: string;
  heading: string;
  firstName: string;
  lede: string;
  cta: string;
  link: string;
  footer: string;
}): Rendered {
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:32px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;border:1px solid #e5e7eb">
<tr><td style="padding:28px 32px 8px 32px">
<p style="margin:0;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:0.04em">${escapeHtml(p.kicker)}</p>
<h1 style="margin:8px 0 0 0;font-size:20px;color:#111827">${escapeHtml(p.heading)}</h1>
</td></tr>
<tr><td style="padding:8px 32px 24px 32px;font-size:14px;color:#374151;line-height:1.55">
<p style="margin:0 0 12px 0">Hi ${escapeHtml(p.firstName)},</p>
<p style="margin:0">${escapeHtml(p.lede)}</p>
<p style="margin:24px 0"><a href="${escapeHtml(p.link)}" style="display:inline-block;background:#111827;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:500">${escapeHtml(p.cta)}</a></p>
<p style="margin:24px 0 0 0;font-size:12px;color:#6b7280">${escapeHtml(p.footer)}</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const text = [
    p.kicker,
    "",
    `Hi ${p.firstName},`,
    "",
    p.lede,
    "",
    `${p.cta}: ${p.link}`,
    "",
    p.footer,
  ].join("\n");

  return { subject: p.subject, html, text };
}

const firstNameOf = (name: string) => name.split(" ")[0] || name;

/**
 * The invitation a teammate receives. Sent by the app rather than by
 * Supabase's mailer, so the link is the one the app built — see
 * src/lib/invitations.ts for why that matters.
 */
export function renderInviteEmail(p: RenderInviteParams): Rendered {
  const firstName = firstNameOf(p.recipientName);

  if (p.existingAccount) {
    return renderActionEmail({
      subject: `${p.inviterName} added you to ${p.tenantName} on PACE PDM`,
      kicker: `${p.tenantName} · Invitation`,
      heading: `You've been added to ${p.tenantName}`,
      firstName,
      lede: `${p.inviterName} has added you to ${p.tenantName} on PACE PDM. You already have a PACE PDM account, so you can sign in with your existing password. If you don't remember it, or never set one, use the link below to choose a password and sign in.`,
      cta: "Set a password and sign in",
      link: p.link,
      footer:
        "The link works once and expires. If it has expired, sign in with your password, or use “Forgot password?” on the sign-in page. If you weren't expecting this, you can ignore this email.",
    });
  }

  return renderActionEmail({
    subject: `${p.inviterName} invited you to ${p.tenantName} on PACE PDM`,
    kicker: `${p.tenantName} · Invitation`,
    heading: `You're invited to ${p.tenantName}`,
    firstName,
    lede: `${p.inviterName} has invited you to join ${p.tenantName} on PACE PDM. Accept the invitation to set your password and sign in.`,
    cta: "Accept invitation",
    link: p.link,
    footer:
      "The link works once and expires. If it has expired, ask the person who invited you to resend the invitation from their Users page. If you weren't expecting this, you can ignore this email.",
  });
}

interface RenderSignupConfirmationParams {
  recipientName: string;
  /** Absolute URL of the app page that verifies the sign-up token. */
  link: string;
}

/**
 * The email confirmation for a new workspace's creator. Sent by the app for
 * the same reason as the invitation: Supabase's own confirmation link only
 * completed in the browser that started the sign-up, and was consumed by
 * corporate link scanners before the person ever clicked it.
 */
export function renderSignupConfirmationEmail(p: RenderSignupConfirmationParams): Rendered {
  return renderActionEmail({
    subject: "Confirm your email to set up your PACE PDM workspace",
    kicker: "PACE PDM · Confirm your email",
    heading: "Confirm your email address",
    firstName: firstNameOf(p.recipientName),
    lede: "Thanks for signing up for PACE PDM. Confirm your email address to finish setting up your workspace. You can open this link on any device.",
    cta: "Confirm email",
    link: p.link,
    footer:
      "The link works once and expires. If it has expired, sign in and you will be offered a new one. If you didn't sign up for PACE PDM, you can ignore this email.",
  });
}
