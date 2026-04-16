import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Use | PACE PDM",
  robots: { index: true, follow: true },
};

export default function TermsOfUsePage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav className="sticky top-0 z-40 border-b border-white/6 bg-background/70 backdrop-blur-xl">
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
              By accessing or using PACE PDM (the &quot;Service&quot;), operated by Joinue LLC
              (&quot;Joinue,&quot; &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;), you agree
              to be bound by these Terms of Use (&quot;Terms&quot;). If you do not agree to all
              of these Terms, you may not access or use the Service.
            </p>
          </section>

          <section>
            <h2>Description of Service</h2>
            <p>
              PACE PDM is a cloud-based product data management platform that provides revision
              control, bill of materials management, engineering change order workflows, file
              storage, and related tools. The Service is provided on an &quot;as is&quot; and
              &quot;as available&quot; basis.
            </p>
          </section>

          <section>
            <h2>Eligibility</h2>
            <p>
              You must be at least 18 years old to create an account and use the Service. By
              creating an account, you represent that you are at least 18 years of age and have
              the legal capacity to enter into these Terms.
            </p>
          </section>

          <section>
            <h2>Account responsibilities</h2>
            <p>
              You are responsible for maintaining the confidentiality of your account credentials
              and for all activities that occur under your account. You must provide accurate
              information when creating an account and notify us immediately of any unauthorized
              use. We are not liable for any loss or damage arising from your failure to maintain
              the security of your account.
            </p>
          </section>

          <section>
            <h2>Your content</h2>
            <p>
              <strong>You retain all ownership rights to the files, data, and content you upload
              to the Service.</strong> We do not claim any intellectual property rights over your
              content. By uploading content, you grant us a limited, non-exclusive license to
              store, process, transmit, and display it solely for the purpose of providing the
              Service to you.
            </p>
            <p>
              You are solely responsible for ensuring you have the right to upload, store, and
              share any content you place in the Service. You represent and warrant that your
              content does not violate any third party&apos;s rights.
            </p>
          </section>

          <section>
            <h2>Acceptable use</h2>
            <p>You agree not to:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Use the Service for any unlawful purpose or in violation of any applicable law</li>
              <li>Attempt to gain unauthorized access to the Service, other accounts, or related systems</li>
              <li>Interfere with or disrupt the Service, servers, or networks connected to it</li>
              <li>Upload content that contains malware, viruses, or other harmful code</li>
              <li>Use the Service to store or distribute content that infringes on intellectual property rights</li>
              <li>Resell, sublicense, or redistribute access to the Service without our prior written consent</li>
              <li>Use automated means (bots, scrapers) to access the Service without our permission</li>
              <li>Attempt to reverse-engineer, decompile, or extract the source code of the Service</li>
            </ul>
            <p>
              We reserve the right to suspend or terminate your access at any time, with or
              without notice, if we reasonably believe you have violated these Terms.
            </p>
          </section>

          <section>
            <h2>Shared content and public links</h2>
            <p>
              The Service allows you to generate public share links for files, BOMs, and release
              packages. You are solely responsible for managing access to shared content,
              including setting appropriate expiration dates and passwords. We are not responsible
              or liable for any unauthorized access to, or use of, content you choose to share
              via public links.
            </p>
          </section>

          <section>
            <h2>Service availability and modifications</h2>
            <p>
              We do not guarantee that the Service will be available at all times or without
              interruption. The Service may be temporarily or permanently unavailable due to
              maintenance, updates, technical issues, or circumstances beyond our control.
            </p>
            <p>
              We reserve the right to modify, suspend, or discontinue the Service (or any part
              of it) at any time, with or without notice. We will not be liable to you or any
              third party for any modification, suspension, or discontinuation of the Service.
            </p>
          </section>

          <section>
            <h2>Data handling</h2>
            <p>
              We process and store your data in accordance with our{" "}
              <Link href="/marketing/privacy" className="text-primary hover:underline">Privacy Policy</Link>,
              which is incorporated into these Terms by reference. You acknowledge and agree
              that your data is stored on third-party infrastructure and that we rely on
              third-party providers for hosting, storage, and security.
            </p>
          </section>

          <section>
            <h2>No warranty on data integrity</h2>
            <p>
              WHILE WE TAKE REASONABLE MEASURES TO PROTECT YOUR DATA, WE DO NOT WARRANT OR
              GUARANTEE THE INTEGRITY, ACCURACY, OR AVAILABILITY OF ANY DATA STORED IN THE
              SERVICE. YOU ARE SOLELY RESPONSIBLE FOR MAINTAINING INDEPENDENT BACKUPS OF YOUR
              CRITICAL DATA. WE SHALL NOT BE LIABLE FOR ANY LOSS, CORRUPTION, OR UNAVAILABILITY
              OF DATA FOR ANY REASON.
            </p>
          </section>

          <section>
            <h2>Disclaimer of warranties</h2>
            <p>
              THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; WITHOUT
              WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY, INCLUDING BUT NOT
              LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
              TITLE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE
              UNINTERRUPTED, ERROR-FREE, SECURE, OR FREE OF HARMFUL COMPONENTS. YOUR USE OF
              THE SERVICE IS AT YOUR SOLE RISK.
            </p>
          </section>

          <section>
            <h2>Limitation of liability</h2>
            <p>
              TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, JOINUE LLC AND ITS OWNER,
              OFFICERS, EMPLOYEES, AGENTS, AND AFFILIATES SHALL NOT BE LIABLE FOR ANY INDIRECT,
              INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING BUT NOT LIMITED
              TO LOSS OF PROFITS, REVENUE, DATA, BUSINESS OPPORTUNITIES, OR GOODWILL, ARISING
              OUT OF OR RELATED TO YOUR USE OF OR INABILITY TO USE THE SERVICE, REGARDLESS OF
              THE THEORY OF LIABILITY (CONTRACT, TORT, STRICT LIABILITY, OR OTHERWISE), EVEN IF
              WE HAVE BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
            </p>
            <p>
              OUR TOTAL AGGREGATE LIABILITY FOR ALL CLAIMS RELATED TO THE SERVICE SHALL NOT
              EXCEED THE LESSER OF: (A) THE AMOUNT YOU ACTUALLY PAID US IN THE TWELVE (12)
              MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM, OR (B) ONE HUNDRED DOLLARS
              ($100 USD).
            </p>
          </section>

          <section>
            <h2>Indemnification</h2>
            <p>
              You agree to indemnify, defend, and hold harmless Joinue LLC and its owner from
              and against any and all claims, damages, losses, costs, and expenses (including
              reasonable attorneys&apos; fees) arising out of or related to: (a) your use of the
              Service, (b) your content, (c) your violation of these Terms, or (d) your
              violation of any rights of a third party.
            </p>
          </section>

          <section>
            <h2>Dispute resolution</h2>
            <p>
              Any dispute arising out of or relating to these Terms or the Service shall be
              resolved through binding arbitration administered under the rules of the American
              Arbitration Association, conducted on an individual basis in the State of Delaware.
              You agree to waive any right to participate in a class action or class-wide
              arbitration. The arbitrator&apos;s decision shall be final and binding. Judgment on
              the award may be entered in any court of competent jurisdiction.
            </p>
            <p>
              Notwithstanding the above, either party may seek injunctive or equitable relief in
              any court of competent jurisdiction to protect its intellectual property rights or
              to prevent irreparable harm.
            </p>
          </section>

          <section>
            <h2>Force majeure</h2>
            <p>
              We shall not be liable for any failure or delay in performing our obligations under
              these Terms due to causes beyond our reasonable control, including but not limited
              to natural disasters, acts of government, internet or infrastructure outages,
              cyberattacks, pandemics, or failures of third-party service providers.
            </p>
          </section>

          <section>
            <h2>Modifications to terms</h2>
            <p>
              We reserve the right to modify these Terms at any time. If we make material changes,
              we will make reasonable efforts to notify active users via email or an in-app notice.
              Your continued use of the Service after updated Terms are posted constitutes your
              acceptance of the changes. If you do not agree to the updated Terms, you must stop
              using the Service.
            </p>
          </section>

          <section>
            <h2>Termination</h2>
            <p>
              Either party may terminate this agreement at any time. You may terminate by deleting
              your account. We may terminate or suspend your access immediately, with or without
              cause and with or without notice. Upon termination, your right to use the Service
              ceases immediately. We are not obligated to maintain or return your data after
              termination, though we will make reasonable efforts to allow you to export your data
              prior to a voluntary termination. Sections of these Terms that by their nature should
              survive termination will survive, including but not limited to ownership, disclaimers,
              limitations of liability, indemnification, and dispute resolution.
            </p>
          </section>

          <section>
            <h2>Entire agreement</h2>
            <p>
              These Terms, together with the Privacy Policy, constitute the entire agreement
              between you and Joinue LLC regarding the Service and supersede all prior agreements,
              representations, and understandings. If any provision of these Terms is found to be
              unenforceable, the remaining provisions will continue in full force and effect.
            </p>
          </section>

          <section>
            <h2>Governing law</h2>
            <p>
              These Terms are governed by and construed in accordance with the laws of the State
              of Delaware, without regard to its conflict of law provisions.
            </p>
          </section>

          <section>
            <h2>Contact</h2>
            <p>
              For questions about these Terms of Use, contact{" "}
              <a href="mailto:marc@joinue.com" className="text-primary hover:underline">marc@joinue.com</a>.
            </p>
          </section>
        </div>
      </article>

      <footer className="border-t border-white/6">
        <div className="max-w-6xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <span className="text-xs text-muted-foreground/70">&copy; {new Date().getFullYear()} Joinue LLC</span>
          <div className="flex items-center gap-5 text-xs text-muted-foreground/70">
            <Link href="/marketing/privacy" className="hover:text-foreground transition-colors">Privacy Policy</Link>
            <Link href="/marketing/terms" className="text-foreground font-medium">Terms of Use</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
