import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Use | PACE PDM",
  robots: { index: true, follow: true },
};

export default function TermsOfUsePage() {
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
        <h1 className="text-3xl font-bold tracking-tight mb-2">Terms of Use</h1>
        <p className="text-sm text-muted-foreground mb-10">Last updated: April 15, 2026</p>

        <div className="space-y-8 text-sm text-muted-foreground leading-relaxed [&_h2]:text-foreground [&_h2]:font-semibold [&_h2]:text-base [&_h2]:mb-3 [&_h2]:mt-0 [&_strong]:text-foreground">
          <section>
            <h2>Agreement to terms</h2>
            <p>
              By accessing or using PACE PDM (the &quot;Service&quot;), operated by Joinnovations LLC
              (&quot;Joinnovations,&quot; &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;), you agree
              to be bound by these Terms of Use. If you do not agree, do not use the Service.
            </p>
          </section>

          <section>
            <h2>Description of Service</h2>
            <p>
              PACE PDM is a cloud-based product data management platform that provides revision
              control, bill of materials management, engineering change order workflows, file
              storage, and related tools for hardware engineering teams.
            </p>
          </section>

          <section>
            <h2>Account registration</h2>
            <p>
              You must provide accurate and complete information when creating an account. You are
              responsible for maintaining the confidentiality of your account credentials and for
              all activities that occur under your account. You must notify us immediately of any
              unauthorized use.
            </p>
          </section>

          <section>
            <h2>Your content</h2>
            <p>
              <strong>You retain all ownership rights to the files, data, and content you upload
              to the Service.</strong> We do not claim any intellectual property rights over your
              content. By uploading content, you grant us a limited license to store, process,
              and display it solely for the purpose of providing the Service to you.
            </p>
            <p>
              You are responsible for ensuring you have the right to upload and share any content
              you store in the Service.
            </p>
          </section>

          <section>
            <h2>Acceptable use</h2>
            <p>You agree not to:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Use the Service for any unlawful purpose</li>
              <li>Attempt to gain unauthorized access to the Service or its infrastructure</li>
              <li>Interfere with or disrupt the Service or servers connected to it</li>
              <li>Upload content that contains malware, viruses, or other harmful code</li>
              <li>Use the Service to store or distribute content that infringes on intellectual property rights</li>
              <li>Resell, sublicense, or redistribute access to the Service without our written consent</li>
            </ul>
          </section>

          <section>
            <h2>Shared content and public links</h2>
            <p>
              The Service allows you to generate public share links for files, BOMs, and release
              packages. You are responsible for managing access to shared content, including
              setting appropriate expiration dates and passwords. We are not responsible for
              unauthorized access to content you choose to share via public links.
            </p>
          </section>

          <section>
            <h2>Service availability</h2>
            <p>
              We strive to maintain high availability of the Service but do not guarantee
              uninterrupted access. The Service may be temporarily unavailable due to maintenance,
              updates, or circumstances beyond our control. We will make reasonable efforts to
              provide advance notice of planned downtime.
            </p>
          </section>

          <section>
            <h2>Data handling</h2>
            <p>
              We process and store your data in accordance with our{" "}
              <Link href="/marketing/privacy" className="text-primary hover:underline">Privacy Policy</Link>.
              You may export your data at any time using the export tools available in the Service.
              Upon account deletion, we will remove your data in accordance with our data retention
              policy as described in the Privacy Policy.
            </p>
          </section>

          <section>
            <h2>Limitation of liability</h2>
            <p>
              TO THE MAXIMUM EXTENT PERMITTED BY LAW, JOINNOVATIONS AND ITS OFFICERS, DIRECTORS,
              EMPLOYEES, AND AGENTS SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL,
              CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED TO LOSS OF PROFITS,
              DATA, OR BUSINESS OPPORTUNITIES, ARISING OUT OF OR RELATED TO YOUR USE OF THE
              SERVICE, REGARDLESS OF THE THEORY OF LIABILITY.
            </p>
            <p>
              OUR TOTAL LIABILITY FOR ALL CLAIMS RELATED TO THE SERVICE SHALL NOT EXCEED THE
              AMOUNT YOU PAID US IN THE TWELVE (12) MONTHS PRECEDING THE EVENT GIVING RISE TO
              THE CLAIM, OR ONE HUNDRED DOLLARS ($100), WHICHEVER IS GREATER.
            </p>
          </section>

          <section>
            <h2>Indemnification</h2>
            <p>
              You agree to indemnify and hold harmless Joinnovations from any claims, damages,
              losses, or expenses (including reasonable legal fees) arising out of your use of the
              Service, your violation of these Terms, or your violation of any rights of a third party.
            </p>
          </section>

          <section>
            <h2>Disclaimer of warranties</h2>
            <p>
              THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; WITHOUT WARRANTIES
              OF ANY KIND, WHETHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED
              WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
              WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR SECURE.
            </p>
          </section>

          <section>
            <h2>Modifications to terms</h2>
            <p>
              We may update these Terms from time to time. If we make material changes, we will
              notify active users via email or an in-app notice at least 30 days before the
              changes take effect. Continued use of the Service after changes become effective
              constitutes acceptance of the updated Terms.
            </p>
          </section>

          <section>
            <h2>Termination</h2>
            <p>
              Either party may terminate this agreement at any time. You may terminate by deleting
              your account. We may terminate or suspend your access if you violate these Terms.
              Upon termination, your right to use the Service ceases immediately. Provisions that
              by their nature should survive termination will survive, including ownership,
              liability limitations, and indemnification.
            </p>
          </section>

          <section>
            <h2>Governing law</h2>
            <p>
              These Terms are governed by the laws of the State of Delaware, without regard to
              conflict of law provisions. Any disputes arising under these Terms shall be resolved
              in the state or federal courts located in Delaware.
            </p>
          </section>

          <section>
            <h2>Contact</h2>
            <p>
              For questions about these Terms of Use, contact us at{" "}
              <a href="mailto:legal@pacepdm.com" className="text-primary hover:underline">legal@pacepdm.com</a>.
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
            <Link href="/marketing/privacy" className="hover:text-foreground transition-colors">Privacy Policy</Link>
            <Link href="/marketing/terms" className="text-foreground font-medium">Terms of Use</Link>
            <span>&copy; {new Date().getFullYear()} Joinnovations LLC</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
