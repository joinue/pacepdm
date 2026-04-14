/**
 * Plain HTML + text templates for transactional notification emails.
 *
 * Intentionally dependency-free: one render function, one shared layout,
 * per-type subject/lede. When we want richer templates (branding, images)
 * we can swap the body for React Email without touching callers.
 */

export type EmailType = "approval" | "transition" | "checkout" | "eco" | "system";

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
};

const CTA_LABEL: Record<EmailType, string> = {
  approval: "Review approval",
  transition: "Open in vault",
  checkout: "Open checkout",
  eco: "Open ECO",
  system: "Open",
};

export function renderNotificationEmail(p: RenderParams): Rendered {
  const subject = `[${p.tenantName}] ${SUBJECT_PREFIX[p.type]}: ${p.title}`;

  const escape = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

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
