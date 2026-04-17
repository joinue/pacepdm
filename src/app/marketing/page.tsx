import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "PACE PDM | Lightweight Product Data Management",
  description:
    "Revision-controlled parts, routed ECO approvals, configurable lifecycle states, and an in-browser CAD viewer. All in the browser. No plugin required.",
};

// Auth pages live on the app subdomain so session cookies scope correctly.
// Falls back to relative URLs on localhost where there's no subdomain.
const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || "";
const LOGIN_URL = `${APP_ORIGIN}/login`;
const REGISTER_URL = `${APP_ORIGIN}/register`;

const FEATURES = [
  {
    title: "Parts & revisions",
    desc: "Every change creates a new revision. Previous versions stay accessible.",
  },
  {
    title: "Bill of materials",
    desc: "Multi-level BOMs with automatic rollups. Import and export via CSV.",
  },
  {
    title: "Change orders",
    desc: "Route ECOs through approval workflows with email-enforced deadlines.",
  },
  {
    title: "File vault",
    desc: "Check-out/check-in prevents two engineers from overwriting the same file.",
  },
  {
    title: "CAD viewer",
    desc: "Render STL, OBJ, STEP, and IGES directly in the browser. No plugin.",
  },
  {
    title: "Lifecycle states",
    desc: "Configure the states a part moves through and which transitions need approval.",
  },
  {
    title: "Release packages",
    desc: "Implement an ECO and get a frozen, shareable handoff with every file and BOM.",
  },
  {
    title: "Audit log",
    desc: "Complete history of who changed what and when. Exportable.",
  },
] as const;

const FILE_TYPES = [
  "STEP", "IGES", "STL", "OBJ", "PDF", "PNG", "DWG", "SLDPRT",
] as const;

export default function MarketingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground overflow-x-hidden">
      {/* ── Nav ────────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-40 border-b border-white/[0.06] bg-background/70 backdrop-blur-xl">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 h-14">
          <Link href="/" className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/ppdm-logo-white.png" alt="PACE PDM" className="h-7 w-7" />
            <span className="font-semibold text-sm tracking-tight">PACE PDM</span>
          </Link>
          <div className="flex items-center gap-3">
            <a href={LOGIN_URL} className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Sign in
            </a>
            <a
              href={REGISTER_URL}
              className="inline-flex h-8 items-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors shadow-lg shadow-primary/20"
            >
              Start free
            </a>
          </div>
        </div>
      </nav>

      {/* ── Hero ───────────────────────────────────────────────── */}
      <section className="relative">
        {/* Radial glow behind the hero text */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] bg-primary/[0.07] rounded-full blur-[120px]" />
        </div>

        <div className="relative max-w-6xl mx-auto px-6 pt-20 pb-16 lg:pt-28 lg:pb-20">
          <div className="max-w-3xl space-y-6">
            <p className="text-sm font-medium text-primary tracking-wide uppercase">
              Product Data Management
            </p>
            <h1 className="text-4xl sm:text-5xl lg:text-[3.5rem] font-bold tracking-tight leading-[1.08]">
              Run your parts library{" "}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary to-primary/60">
                out of something other than a spreadsheet.
              </span>
            </h1>
            <p className="text-lg text-muted-foreground leading-relaxed max-w-2xl">
              Revision control, routed ECO approvals, and an in-browser CAD
              viewer. Built for hardware teams that have outgrown the spreadsheet
              but don&apos;t need an enterprise PLM rollout.
            </p>
            <div className="flex items-center gap-3 pt-3">
              <a
                href={REGISTER_URL}
                className="group inline-flex h-11 items-center rounded-full bg-primary px-7 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-all shadow-lg shadow-primary/25 hover:shadow-primary/40"
              >
                Start free
                <svg className="ml-2 w-4 h-4 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </a>
              <a
                href={LOGIN_URL}
                className="inline-flex h-11 items-center rounded-full border border-white/10 bg-white/[0.03] px-7 text-sm font-medium hover:bg-white/[0.06] transition-all"
              >
                Sign in
              </a>
            </div>
            <p className="text-xs text-muted-foreground/70">
              No credit card required. Import your parts from CSV in minutes.
            </p>
          </div>
        </div>
      </section>

      {/* ── Hero screenshot ────────────────────────────────────── */}
      <section className="max-w-6xl mx-auto px-6 pb-28 lg:pb-36">
        <div className="relative group">
          {/* Glow behind the screenshot */}
          <div className="absolute -inset-1 rounded-2xl bg-gradient-to-b from-primary/20 via-primary/5 to-transparent opacity-60 blur-xl pointer-events-none" aria-hidden="true" />
          <div className="relative rounded-xl border border-white/[0.08] bg-card overflow-hidden shadow-2xl shadow-black/40">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/images/screenshots/step-file-preview-in-vault.png"
              alt="STEP file rendering in the PACE PDM vault with properties panel"
              className="w-full"
            />
          </div>
        </div>
      </section>

      {/* ── Feature grid ───────────────────────────────────────── */}
      <section className="border-t border-white/[0.06]">
        <div className="max-w-6xl mx-auto px-6 py-24 lg:py-32">
          <div className="text-center mb-14">
            <p className="text-sm font-medium text-primary tracking-wide uppercase mb-3">Capabilities</p>
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
              Everything you need. Nothing you don&apos;t.
            </h2>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-5 space-y-2.5 hover:border-white/[0.12] hover:bg-white/[0.04] transition-all duration-200"
              >
                <h3 className="font-semibold text-sm">{f.title}</h3>
                <p className="text-[13px] text-muted-foreground leading-relaxed">
                  {f.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CAD viewer showcase ────────────────────────────────── */}
      <section className="border-t border-white/[0.06] bg-white/[0.01]">
        <div className="max-w-6xl mx-auto px-6 py-24 lg:py-32">
          <div className="grid lg:grid-cols-2 gap-14 items-center">
            <div className="space-y-5">
              <p className="text-sm font-medium text-primary tracking-wide uppercase">Browser-native</p>
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
                Open a STEP file in a browser tab.
              </h2>
              <p className="text-muted-foreground leading-relaxed">
                Click any CAD file in the vault and it renders instantly. Works
                for the engineer who created it, the reviewer approving the ECO,
                and the machinist on the shop floor with nothing but a laptop.
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                {FILE_TYPES.map((ft) => (
                  <span
                    key={ft}
                    className="inline-flex h-7 items-center rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5 text-[11px] font-mono text-muted-foreground"
                  >
                    .{ft.toLowerCase()}
                  </span>
                ))}
              </div>
            </div>
            <div className="relative">
              <div className="absolute -inset-1 rounded-2xl bg-gradient-to-br from-primary/15 to-transparent opacity-50 blur-xl pointer-events-none" aria-hidden="true" />
              <div className="relative rounded-xl border border-white/[0.08] bg-card overflow-hidden shadow-xl shadow-black/20">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/images/screenshots/dashboard.png" alt="PACE PDM dashboard showing approvals, checked-out files, and open ECOs" className="w-full" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Lifecycle showcase ─────────────────────────────────── */}
      <section className="border-t border-white/[0.06]">
        <div className="max-w-6xl mx-auto px-6 py-24 lg:py-32">
          <div className="grid lg:grid-cols-2 gap-14 items-center">
            <div className="order-2 lg:order-1 relative">
              <div className="absolute -inset-1 rounded-2xl bg-gradient-to-bl from-primary/15 to-transparent opacity-50 blur-xl pointer-events-none" aria-hidden="true" />
              <div className="relative rounded-xl border border-white/[0.08] bg-card overflow-hidden shadow-xl shadow-black/20">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/images/screenshots/lifecycle-management-preview.png" alt="Configurable lifecycle states with per-transition approval gates" className="w-full" />
              </div>
            </div>
            <div className="order-1 lg:order-2 space-y-5">
              <p className="text-sm font-medium text-primary tracking-wide uppercase">Configurable</p>
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
                Your workflow, defined in minutes.
              </h2>
              <p className="text-muted-foreground leading-relaxed">
                WIP, In Review, Released, Obsolete. Or whatever your team
                actually uses. Set which transitions require approval and
                change the workflow later without migrating anything.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── ECO / approval workflows ─────────────────────────── */}
      <section className="border-t border-white/[0.06] bg-white/[0.01]">
        <div className="max-w-6xl mx-auto px-6 py-24 lg:py-32">
          <div className="grid lg:grid-cols-2 gap-14 items-center">
            <div className="space-y-5">
              <p className="text-sm font-medium text-primary tracking-wide uppercase">Approvals</p>
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
                Route changes through the right people.
              </h2>
              <p className="text-muted-foreground leading-relaxed">
                Define multi-step approval workflows with deadlines. Assign them
                to lifecycle transitions so the right reviewers sign off before
                anything gets released. No more chasing signatures over email.
              </p>
            </div>
            <div className="relative">
              <div className="absolute -inset-1 rounded-2xl bg-gradient-to-br from-primary/15 to-transparent opacity-50 blur-xl pointer-events-none" aria-hidden="true" />
              <div className="relative rounded-xl border border-white/[0.08] bg-card overflow-hidden shadow-xl shadow-black/20">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/images/screenshots/approval-workflows.png" alt="Configurable approval workflows with multi-step sequences and trigger assignments" className="w-full" />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Comparison table ───────────────────────────────────── */}
      <section className="border-t border-white/[0.06]">
        <div className="max-w-6xl mx-auto px-6 py-24 lg:py-32">
          <div className="text-center mb-14">
            <p className="text-sm font-medium text-primary tracking-wide uppercase mb-3">How it compares</p>
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
              More than a spreadsheet. Less than a rollout.
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-white/[0.08]">
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground" />
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground">Spreadsheet</th>
                  <th className="text-left py-3 px-4 font-medium text-primary">PACE PDM</th>
                  <th className="text-left py-3 px-4 font-medium text-muted-foreground">Enterprise PLM</th>
                </tr>
              </thead>
              <tbody className="text-muted-foreground">
                <tr className="border-b border-white/[0.04]">
                  <td className="py-3 px-4 font-medium text-foreground">Setup time</td>
                  <td className="py-3 px-4">Already done</td>
                  <td className="py-3 px-4 text-foreground">Days</td>
                  <td className="py-3 px-4">Months</td>
                </tr>
                <tr className="border-b border-white/[0.04]">
                  <td className="py-3 px-4 font-medium text-foreground">Revision control</td>
                  <td className="py-3 px-4">Manual naming</td>
                  <td className="py-3 px-4 text-foreground">Built-in</td>
                  <td className="py-3 px-4">Built-in</td>
                </tr>
                <tr className="border-b border-white/[0.04]">
                  <td className="py-3 px-4 font-medium text-foreground">ECO approvals</td>
                  <td className="py-3 px-4">Email chains</td>
                  <td className="py-3 px-4 text-foreground">Routed workflows</td>
                  <td className="py-3 px-4">Routed workflows</td>
                </tr>
                <tr className="border-b border-white/[0.04]">
                  <td className="py-3 px-4 font-medium text-foreground">CAD viewing</td>
                  <td className="py-3 px-4">Download + local app</td>
                  <td className="py-3 px-4 text-foreground">In-browser</td>
                  <td className="py-3 px-4">Varies</td>
                </tr>
                <tr className="border-b border-white/[0.04]">
                  <td className="py-3 px-4 font-medium text-foreground">BOM management</td>
                  <td className="py-3 px-4">Flat spreadsheet</td>
                  <td className="py-3 px-4 text-foreground">Multi-level with rollups</td>
                  <td className="py-3 px-4">Multi-level with rollups</td>
                </tr>
                <tr className="border-b border-white/[0.04]">
                  <td className="py-3 px-4 font-medium text-foreground">Admin overhead</td>
                  <td className="py-3 px-4">None</td>
                  <td className="py-3 px-4 text-foreground">Minimal</td>
                  <td className="py-3 px-4">Dedicated staff</td>
                </tr>
                <tr>
                  <td className="py-3 px-4 font-medium text-foreground">Cost</td>
                  <td className="py-3 px-4">Free</td>
                  <td className="py-3 px-4 text-foreground">Low</td>
                  <td className="py-3 px-4">$$$ per seat</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── Setup + who it's for (two columns) ─────────────────── */}
      <section className="border-t border-white/[0.06] bg-white/[0.01]">
        <div className="max-w-6xl mx-auto px-6 py-24 lg:py-32">
          <div className="max-w-2xl space-y-4">
            <p className="text-sm font-medium text-primary tracking-wide uppercase">Quick start</p>
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
              Live by the end of the week.
            </h2>
            <p className="text-muted-foreground leading-relaxed">
              Import parts from a CSV, upload your files to the vault, invite
              your team. A small hardware team can be running on PACE PDM the
              same week they sign up.
            </p>
          </div>
        </div>
      </section>

      {/* ── Pricing ───────────────────────────────────────────── */}
      <section className="border-t border-white/[0.06] bg-white/[0.01]">
        <div className="max-w-6xl mx-auto px-6 py-24 lg:py-32 text-center">
          <p className="text-sm font-medium text-primary tracking-wide uppercase mb-3">Pricing</p>
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight mb-4">
            Free while in beta.
          </h2>
          <p className="text-muted-foreground max-w-lg mx-auto leading-relaxed">
            Full access. No credit card. No feature gates. We&apos;ll introduce
            paid plans down the road and give beta users a permanent discount.
          </p>
        </div>
      </section>

      {/* ── Bottom CTA ─────────────────────────────────────────── */}
      <section className="border-t border-white/[0.06]">
        <div className="relative">
          <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-primary/[0.06] rounded-full blur-[100px]" />
          </div>
          <div className="relative max-w-6xl mx-auto px-6 py-28 lg:py-36 text-center space-y-6">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
              Start free.
            </h2>
            <p className="text-muted-foreground max-w-md mx-auto">
              No credit card required. Get your parts imported in under ten minutes.
            </p>
            <div className="flex items-center justify-center gap-3 pt-3">
              <a
                href={REGISTER_URL}
                className="group inline-flex h-11 items-center rounded-full bg-primary px-7 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-all shadow-lg shadow-primary/25 hover:shadow-primary/40"
              >
                Start free
                <svg className="ml-2 w-4 h-4 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                </svg>
              </a>
              <a
                href={LOGIN_URL}
                className="inline-flex h-11 items-center rounded-full border border-white/10 bg-white/[0.03] px-7 text-sm font-medium hover:bg-white/[0.06] transition-all"
              >
                Sign in
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ─────────────────────────────────────────────── */}
      <footer className="border-t border-white/[0.06]">
        <div className="max-w-6xl mx-auto px-6 py-10">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/images/ppdm-logo-white.png" alt="PACE PDM" className="h-5 w-5 opacity-40" />
              <span className="text-xs text-muted-foreground/70">
                &copy; {new Date().getFullYear()} Joinue LLC
              </span>
            </div>
            <div className="flex items-center gap-5 text-xs text-muted-foreground/70">
              <Link href="/privacy" className="hover:text-foreground transition-colors">
                Privacy Policy
              </Link>
              <Link href="/terms" className="hover:text-foreground transition-colors">
                Terms of Use
              </Link>
              <a href="mailto:marc@joinue.com" className="hover:text-foreground transition-colors">
                Contact
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
