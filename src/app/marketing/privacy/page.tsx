import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy | PACE PDM",
  robots: { index: true, follow: true },
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <nav className="sticky top-0 z-40 border-b border-white/[0.06] bg-background/70 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 h-14">
          <Link href="/marketing" className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/ppdm-logo-white.png" alt="PACE PDM" className="h-7 w-7" />
            <span className="font-semibold text-sm tracking-tight">PACE PDM</span>
          </Link>
          <Link
            href="/register"
            className="inline-flex h-8 items-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Start free
          </Link>
        </div>
      </nav>

      <article className="max-w-3xl mx-auto px-6 py-16 lg:py-24 prose-sm">
        <h1 className="text-3xl font-bold tracking-tight mb-2">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground mb-10">Last updated: April 15, 2026</p>

        <div className="space-y-8 text-sm text-muted-foreground leading-relaxed [&_h2]:text-foreground [&_h2]:font-semibold [&_h2]:text-base [&_h2]:mb-3 [&_h2]:mt-0 [&_strong]:text-foreground">
          <section>
            <h2>Who we are</h2>
            <p>
              PACE PDM is a product data management platform operated by Joinnovations LLC
              (&quot;Joinnovations,&quot; &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;). This policy
              describes how we collect, use, and protect information when you use
              pacepdm.com and app.pacepdm.com (the &quot;Service&quot;).
            </p>
          </section>

          <section>
            <h2>Information we collect</h2>
            <p><strong>Account information.</strong> When you register, we collect your name, email address, and password. If your organization uses SSO, we receive your identity attributes from your identity provider.</p>
            <p><strong>Content you upload.</strong> Files, parts, BOMs, ECOs, and other product data you store in the Service. You retain full ownership of this content.</p>
            <p><strong>Usage data.</strong> We automatically collect information about how you interact with the Service, including IP addresses, browser type, pages visited, and timestamps. This data is used to operate, maintain, and improve the Service.</p>
            <p><strong>Cookies.</strong> We use essential cookies to manage authentication sessions. We do not use advertising or third-party tracking cookies.</p>
          </section>

          <section>
            <h2>How we use your information</h2>
            <p>We use the information we collect to:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Provide, operate, and maintain the Service</li>
              <li>Authenticate your identity and manage access control</li>
              <li>Send transactional emails (notifications, approval reminders, password resets)</li>
              <li>Monitor for security threats and prevent abuse</li>
              <li>Improve the Service based on aggregated, anonymized usage patterns</li>
            </ul>
            <p>We do not sell your personal information. We do not use your uploaded content for any purpose other than providing the Service to you.</p>
          </section>

          <section>
            <h2>Third-party services</h2>
            <p>We use the following third-party services to operate PACE PDM:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li><strong>Supabase</strong> (database and authentication hosting)</li>
              <li><strong>Vercel</strong> (application hosting and deployment)</li>
            </ul>
            <p>These providers process data on our behalf under their respective privacy policies and security practices. Your uploaded files are stored in Supabase-managed object storage with encryption at rest.</p>
          </section>

          <section>
            <h2>Data retention</h2>
            <p>
              We retain your account information and uploaded content for as long as your account
              is active. If you delete your account, we will remove your personal data within 30 days.
              Some data may persist in encrypted backups for up to 90 days before automatic expiration.
            </p>
          </section>

          <section>
            <h2>Your rights</h2>
            <p>You may request access to, correction of, or deletion of your personal data at any time by contacting us. If you are located in a jurisdiction with applicable data protection laws (including GDPR and CCPA), you have additional rights under those laws.</p>
          </section>

          <section>
            <h2>Security</h2>
            <p>
              We implement industry-standard security measures including encryption in transit (TLS),
              encryption at rest, role-based access control, and audit logging. While no system is
              perfectly secure, we take the protection of your data seriously.
            </p>
          </section>

          <section>
            <h2>Changes to this policy</h2>
            <p>
              We may update this policy from time to time. If we make material changes, we will
              notify active users via email or an in-app notice before the changes take effect.
            </p>
          </section>

          <section>
            <h2>Contact</h2>
            <p>
              For questions about this privacy policy, contact us at{" "}
              <a href="mailto:privacy@pacepdm.com" className="text-primary hover:underline">privacy@pacepdm.com</a>.
            </p>
          </section>
        </div>
      </article>

      {/* Footer */}
      <footer className="border-t border-white/[0.06]">
        <div className="max-w-6xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <span className="text-xs text-muted-foreground/70">
            Built by{" "}
            <a href="https://joinnovations.com" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">Joinnovations</a>
          </span>
          <div className="flex items-center gap-5 text-xs text-muted-foreground/70">
            <Link href="/marketing/privacy" className="text-foreground font-medium">Privacy Policy</Link>
            <Link href="/marketing/terms" className="hover:text-foreground transition-colors">Terms of Use</Link>
            <span>&copy; {new Date().getFullYear()} Joinnovations LLC</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
