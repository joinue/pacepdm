import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy | PACE PDM",
  robots: { index: true, follow: true },
};

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
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
              PACE PDM is a product data management platform operated by Joinue LLC
              (&quot;Joinue,&quot; &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;). This policy
              describes how we collect, use, and protect information when you use
              pacepdm.com and app.pacepdm.com (the &quot;Service&quot;).
            </p>
          </section>

          <section>
            <h2>Information we collect</h2>
            <p><strong>Account information.</strong> When you register, we collect your name, email address, and password. If your organization uses SSO, we receive identity attributes from your identity provider.</p>
            <p><strong>Content you upload.</strong> Files, parts, BOMs, ECOs, and other product data you store in the Service. You retain ownership of this content.</p>
            <p><strong>Usage data.</strong> We automatically collect information about how you interact with the Service, including IP addresses, browser type, pages visited, and timestamps.</p>
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
            <p>We rely on third-party infrastructure providers to operate PACE PDM, including but not limited to:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li><strong>Supabase</strong> for database, authentication, and file storage</li>
              <li><strong>Vercel</strong> for application hosting</li>
            </ul>
            <p>
              These providers process data on our behalf under their own privacy policies and
              security practices. Your data may be stored and processed in data centers located
              in the United States or other jurisdictions where these providers operate. By using
              the Service, you consent to this transfer and processing.
            </p>
          </section>

          <section>
            <h2>Data retention and deletion</h2>
            <p>
              We retain your account information and uploaded content for as long as your account
              is active. If you request account deletion, we will make reasonable efforts to remove
              your personal data in a timely manner. However, some data may persist in backups
              or logs for a limited period and will be deleted in accordance with our standard
              backup rotation schedules.
            </p>
            <p>
              We do not guarantee complete or immediate deletion of all data across all systems
              and backups. Anonymized or aggregated data that cannot be used to identify you may
              be retained indefinitely.
            </p>
          </section>

          <section>
            <h2>Data security</h2>
            <p>
              We use commercially reasonable measures to protect your data, including encryption
              in transit (TLS) and encryption at rest via our infrastructure providers. However,
              no method of electronic storage or transmission is 100% secure. We cannot and do
              not guarantee absolute security of your data.
            </p>
          </section>

          <section>
            <h2>Children&apos;s privacy</h2>
            <p>
              The Service is not directed to individuals under the age of 13. We do not knowingly
              collect personal information from children under 13. If you believe we have
              inadvertently collected such information, please contact us and we will take steps
              to delete it.
            </p>
          </section>

          <section>
            <h2>Your rights</h2>
            <p>
              Depending on your jurisdiction, you may have rights regarding your personal data,
              including the right to access, correct, or delete it. To exercise any such rights,
              contact us at the email below. We will respond to requests in accordance with
              applicable law.
            </p>
          </section>

          <section>
            <h2>Changes to this policy</h2>
            <p>
              We may update this policy at any time. If we make material changes, we will make
              reasonable efforts to notify active users via email or an in-app notice. Your
              continued use of the Service after changes are posted constitutes acceptance of
              the updated policy.
            </p>
          </section>

          <section>
            <h2>Contact</h2>
            <p>
              For questions about this privacy policy, contact{" "}
              <a href="mailto:marc@joinue.com" className="text-primary hover:underline">marc@joinue.com</a>.
            </p>
          </section>
        </div>
      </article>

      <footer className="border-t border-white/[0.06]">
        <div className="max-w-6xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <span className="text-xs text-muted-foreground/70">&copy; {new Date().getFullYear()} Joinue LLC</span>
          <div className="flex items-center gap-5 text-xs text-muted-foreground/70">
            <Link href="/marketing/privacy" className="text-foreground font-medium">Privacy Policy</Link>
            <Link href="/marketing/terms" className="hover:text-foreground transition-colors">Terms of Use</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
