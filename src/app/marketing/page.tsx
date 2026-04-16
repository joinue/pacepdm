import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "PACE PDM — Lightweight Product Data Management",
  description:
    "Revision-controlled parts, routed ECO approvals, configurable lifecycle states, and an in-browser CAD viewer for STEP, IGES, STL, and OBJ. All in the browser.",
};

// ─── Data ─────────────────────────────────────────────────────────────────

const FEATURES = [
  {
    title: "Parts & revisions",
    desc: "Every change is a new revision. The old one doesn't disappear.",
  },
  {
    title: "Bill of materials",
    desc: "Multi-level BOMs with rollups. CSV import and export.",
  },
  {
    title: "Engineering change orders",
    desc: "Route an ECO, collect approvals, enforce deadlines by email.",
  },
  {
    title: "File vault",
    desc: "Check files out so two people can't edit the same drawing at once.",
  },
  {
    title: "In-browser CAD viewer",
    desc: "STL, OBJ, STEP, and IGES. No plugin, no license.",
  },
  {
    title: "Lifecycle states",
    desc: "Define the states a part moves through, and which transitions need approval.",
  },
  {
    title: "Release packages",
    desc: "Implement an ECO and get a frozen, shareable handoff with every file and BOM snapshot.",
  },
  {
    title: "Audit log",
    desc: "Who changed what, when. Exportable.",
  },
] as const;

const FILE_TYPES = [
  "STEP",
  "IGES",
  "STL",
  "OBJ",
  "PDF",
  "PNG",
  "JPG",
  "DWG",
  "SLDPRT",
  "SLDASM",
] as const;

// ─── Page ─────────────────────────────────────────────────────────────────

export default function MarketingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <nav className="sticky top-0 z-40 border-b border-border/50 bg-background/80 backdrop-blur-lg">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 h-14">
          <Link href="/marketing" className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/images/ppdm-logo-white.png"
              alt="PACE PDM"
              className="h-7 w-7"
            />
            <span className="font-semibold text-sm tracking-tight">
              PACE PDM
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/register"
              className="inline-flex h-8 items-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Start free
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-24 pb-20 lg:pt-32 lg:pb-28">
        <div className="max-w-3xl space-y-6">
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.1]">
            Run your parts library out of something other than a spreadsheet.
          </h1>
          <p className="text-lg sm:text-xl text-muted-foreground leading-relaxed max-w-2xl">
            Revision control, routed ECO approvals, and an in-browser CAD
            viewer — built for hardware teams that outgrew the spreadsheet but
            don&apos;t want enterprise PLM.
          </p>
          <div className="flex items-center gap-3 pt-2">
            <Link
              href="/register"
              className="inline-flex h-10 items-center rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Start free
            </Link>
            <Link
              href="/login"
              className="inline-flex h-10 items-center rounded-full border border-border bg-background px-6 text-sm font-medium hover:bg-muted transition-colors"
            >
              Sign in
            </Link>
          </div>
          <p className="text-xs text-muted-foreground pt-1">
            No credit card. Import your parts from CSV in under ten minutes.
          </p>
        </div>
      </section>

      {/* Hero screenshot — CAD viewer */}
      <section className="max-w-6xl mx-auto px-6 pb-24">
        <div className="rounded-xl border border-border/60 bg-card overflow-hidden shadow-2xl shadow-black/20">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/screenshots/step-file-preview-in-vault.png"
            alt="STEP file preview in the PACE PDM vault — in-browser CAD rendering with properties panel"
            className="w-full"
          />
        </div>
      </section>

      {/* Feature grid */}
      <section className="border-t border-border/50 bg-card/30">
        <div className="max-w-6xl mx-auto px-6 py-20 lg:py-28">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-10">
            What&apos;s inside
          </h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-8">
            {FEATURES.map((f) => (
              <div key={f.title} className="space-y-2">
                <h3 className="font-semibold text-sm">{f.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {f.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CAD viewer showcase */}
      <section className="border-t border-border/50">
        <div className="max-w-6xl mx-auto px-6 py-20 lg:py-28">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div className="space-y-4">
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
                Open a STEP file in a browser tab.
              </h2>
              <p className="text-muted-foreground leading-relaxed">
                Click any STL, OBJ, STEP, or IGES file in the vault and it
                renders — for the engineer who owns it, for whoever&apos;s
                reviewing the ECO, and for the machinist on the shop floor with
                a laptop.
              </p>
              <div className="flex flex-wrap gap-2 pt-2">
                {FILE_TYPES.map((ft) => (
                  <span
                    key={ft}
                    className="inline-flex h-7 items-center rounded-full border border-border bg-muted/50 px-3 text-xs font-mono text-muted-foreground"
                  >
                    .{ft.toLowerCase()}
                  </span>
                ))}
              </div>
            </div>
            <div className="rounded-xl border border-border/60 bg-card overflow-hidden shadow-xl shadow-black/10">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/images/screenshots/step-file-preview-in-vault.png"
                alt="In-browser STEP file viewer"
                className="w-full"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Lifecycle showcase */}
      <section className="border-t border-border/50 bg-card/30">
        <div className="max-w-6xl mx-auto px-6 py-20 lg:py-28">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div className="order-2 lg:order-1 rounded-xl border border-border/60 bg-card overflow-hidden shadow-xl shadow-black/10">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/images/screenshots/lifecycle-management-preview.png"
                alt="Configurable lifecycle states — WIP, In Review, Released, Obsolete with per-transition approval gates"
                className="w-full"
              />
            </div>
            <div className="order-1 lg:order-2 space-y-4">
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
                Define the states a part moves through.
              </h2>
              <p className="text-muted-foreground leading-relaxed">
                WIP, In Review, Released, Obsolete — or whatever your team
                actually uses. Set which transitions require approval. Change
                the workflow later without migrating anything.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Setup section */}
      <section className="border-t border-border/50">
        <div className="max-w-6xl mx-auto px-6 py-20 lg:py-28">
          <div className="max-w-2xl space-y-4">
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

      {/* Who it's for */}
      <section className="border-t border-border/50 bg-card/30">
        <div className="max-w-6xl mx-auto px-6 py-20 lg:py-28">
          <div className="max-w-2xl space-y-4">
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
              Made for hardware engineers.
            </h2>
            <p className="text-muted-foreground leading-relaxed">
              Fast search across every part, BOM, and file. Keyboard shortcuts
              everywhere. A dark UI you can actually read at 11pm. The details
              matter because a PDM you avoid is a PDM you don&apos;t trust.
            </p>
          </div>
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="border-t border-border/50">
        <div className="max-w-6xl mx-auto px-6 py-24 lg:py-32 text-center space-y-6">
          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight">
            Start free.
          </h2>
          <p className="text-muted-foreground max-w-md mx-auto">
            No credit card. Get your parts imported in under ten minutes.
          </p>
          <div className="flex items-center justify-center gap-3 pt-2">
            <Link
              href="/register"
              className="inline-flex h-10 items-center rounded-full bg-primary px-6 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              Start free
            </Link>
            <Link
              href="/login"
              className="inline-flex h-10 items-center rounded-full border border-border bg-background px-6 text-sm font-medium hover:bg-muted transition-colors"
            >
              Sign in
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border/50">
        <div className="max-w-6xl mx-auto px-6 py-8 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/images/ppdm-logo-white.png"
              alt="PACE PDM"
              className="h-5 w-5 opacity-50"
            />
            <span className="text-xs text-muted-foreground">
              PACE Technologies
            </span>
          </div>
          <span className="text-xs text-muted-foreground">
            &copy; {new Date().getFullYear()} PACE Technologies
          </span>
        </div>
      </footer>
    </div>
  );
}
