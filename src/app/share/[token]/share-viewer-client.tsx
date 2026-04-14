"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Download, Lock, AlertTriangle, Loader2 } from "lucide-react";
import { CadViewer } from "@/components/vault/cad-viewer";
import { fetchJson, errorMessage, ApiError } from "@/lib/api-client";

// Mirrors /api/public/share/[token] GET response.
interface ResolvedMetadata {
  status: "ok" | "revoked" | "expired" | "not_found";
  resourceType?: "file" | "bom";
  resourceName?: string;
  requiresPassword?: boolean;
  allowDownload?: boolean;
  expiresAt?: string | null;
  sharedByTenantName?: string | null;
}

// Mirrors /api/public/share/[token]/content GET response (file branch).
interface FileContent {
  kind: "file";
  fileName: string;
  canPreview: boolean;
  previewType?: "pdf" | "image" | "text" | "cad";
  fileType?: string;
  url?: string;
  allowDownload: boolean;
}

// Mirrors /api/public/share/[token]/content GET response (BOM branch).
interface BomContent {
  kind: "bom";
  bomName: string;
  revision: string | null;
  status: string | null;
  items: Array<{
    itemNumber: string | null;
    partNumber: string | null;
    name: string | null;
    quantity: number | null;
    unit: string | null;
    material: string | null;
    vendor: string | null;
  }>;
  allowDownload: boolean;
}

type Content = FileContent | BomContent;

export function ShareViewerClient({ token }: { token: string }) {
  const [metadata, setMetadata] = useState<ResolvedMetadata | null>(null);
  const [content, setContent] = useState<Content | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);

  const loadContent = useCallback(async () => {
    try {
      const data = await fetchJson<Content>(`/api/public/share/${token}/content`);
      setContent(data);
      setNeedsPassword(false);
    } catch (err) {
      // 401 with "password_required" → show the unlock form instead of a
      // fatal error. Any other failure is surfaced in the error state.
      if (err instanceof ApiError && err.status === 401) {
        setNeedsPassword(true);
        return;
      }
      setFatalError(errorMessage(err));
    }
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const meta = await fetchJson<ResolvedMetadata>(`/api/public/share/${token}`);
        if (cancelled) return;
        setMetadata(meta);
        if (meta.status !== "ok") {
          setLoading(false);
          return;
        }
        // Always try to load content — if a password is required, the
        // content endpoint returns 401 and we flip into the unlock form.
        // This saves a round-trip for already-unlocked sessions.
        await loadContent();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, loadContent]);

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    setUnlocking(true);
    setUnlockError(null);
    try {
      await fetchJson(`/api/public/share/${token}/unlock`, {
        method: "POST",
        body: { password },
      });
      await loadContent();
    } catch (err) {
      setUnlockError(errorMessage(err));
    } finally {
      setUnlocking(false);
    }
  }

  // ─── Header ─────────────────────────────────────────────────────────────
  const header = (
    <header className="border-b bg-card/60 backdrop-blur">
      <div className="max-w-5xl mx-auto px-6 py-3 flex items-center gap-3">
        <div className="font-semibold text-sm tracking-tight">PACE PDM</div>
        <div className="h-4 w-px bg-border" />
        <div className="text-xs text-muted-foreground">
          Shared {metadata?.resourceType === "bom" ? "BOM" : "file"}
          {metadata?.sharedByTenantName && (
            <> &middot; from {metadata.sharedByTenantName}</>
          )}
        </div>
      </div>
    </header>
  );

  // ─── Loading ────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen flex flex-col">
        {header}
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      </div>
    );
  }

  // ─── Error states: not-found / revoked / expired ───────────────────────
  if (metadata && metadata.status !== "ok") {
    const copy = {
      not_found: {
        title: "Link not found",
        body: "This share link doesn't exist or has been deleted.",
      },
      revoked: {
        title: "Link revoked",
        body: "This share link has been revoked by the person who created it.",
      },
      expired: {
        title: "Link expired",
        body: "This share link is past its expiry date.",
      },
    }[metadata.status];
    return (
      <div className="min-h-screen flex flex-col">
        {header}
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md text-center space-y-3">
            <AlertTriangle className="w-10 h-10 text-muted-foreground mx-auto" />
            <h1 className="text-lg font-semibold">{copy.title}</h1>
            <p className="text-sm text-muted-foreground">{copy.body}</p>
          </div>
        </div>
      </div>
    );
  }

  if (fatalError) {
    return (
      <div className="min-h-screen flex flex-col">
        {header}
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="max-w-md text-center space-y-3">
            <AlertTriangle className="w-10 h-10 text-destructive mx-auto" />
            <h1 className="text-lg font-semibold">Something went wrong</h1>
            <p className="text-sm text-muted-foreground">{fatalError}</p>
          </div>
        </div>
      </div>
    );
  }

  // ─── Password gate ──────────────────────────────────────────────────────
  if (needsPassword) {
    return (
      <div className="min-h-screen flex flex-col">
        {header}
        <div className="flex-1 flex items-center justify-center p-6">
          <form
            onSubmit={handleUnlock}
            className="w-full max-w-sm space-y-4 rounded-lg border bg-card p-6"
          >
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Lock className="w-4 h-4" />
              Password required
            </div>
            <p className="text-xs text-muted-foreground">
              The person who shared this {metadata?.resourceType === "bom" ? "BOM" : "file"}{" "}
              has set a password. Enter it below to continue.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="share-pw">Password</Label>
              <Input
                id="share-pw"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                autoComplete="off"
              />
            </div>
            {unlockError && (
              <div className="text-xs text-destructive">{unlockError}</div>
            )}
            <Button type="submit" disabled={unlocking || !password} className="w-full">
              {unlocking ? "Checking…" : "Unlock"}
            </Button>
          </form>
        </div>
      </div>
    );
  }

  // ─── Content ────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen flex flex-col">
      {header}
      <main className="flex-1 max-w-5xl w-full mx-auto p-6">
        {content?.kind === "file" && <FileContentView content={content} />}
        {content?.kind === "bom" && <BomContentView content={content} token={token} />}
      </main>
      <footer className="border-t text-center py-3 text-[11px] text-muted-foreground">
        Powered by <span className="font-semibold">PACE PDM</span>
      </footer>
    </div>
  );
}

// ─── File view ─────────────────────────────────────────────────────────────

function FileContentView({ content }: { content: FileContent }) {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold truncate">{content.fileName}</h1>
          {content.fileType && (
            <p className="text-xs text-muted-foreground uppercase tracking-wide mt-0.5">
              {content.fileType}
            </p>
          )}
        </div>
        {content.allowDownload && content.url && (
          <a
            href={content.url}
            download={content.fileName}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <Download className="w-4 h-4 mr-1.5" /> Download
          </a>
        )}
      </div>

      <div className="rounded-lg border bg-muted/20 min-h-[60vh] flex items-center justify-center overflow-hidden">
        {!content.canPreview || !content.url ? (
          <div className="text-center text-sm text-muted-foreground p-8">
            Preview isn&apos;t available for this file type.
            {content.allowDownload
              ? " Use the Download button above to view it locally."
              : " The sender hasn't enabled downloads on this link."}
          </div>
        ) : content.previewType === "image" ? (
          // Next/Image requires configured domains for remote; for signed
          // Supabase URLs we fall back to a plain <img> to avoid config friction.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={content.url}
            alt={content.fileName}
            className="max-h-[75vh] max-w-full object-contain"
          />
        ) : content.previewType === "pdf" ? (
          <object
            data={content.url}
            type="application/pdf"
            className="w-full h-[75vh]"
          >
            <div className="text-sm text-muted-foreground p-4">
              PDF preview failed to load.
            </div>
          </object>
        ) : content.previewType === "cad" ? (
          <CadViewer
            url={content.url}
            fileType={content.fileType || ""}
            className="w-full h-[75vh]"
          />
        ) : content.previewType === "text" ? (
          <TextPreview url={content.url} />
        ) : (
          <div className="text-sm text-muted-foreground p-8">No preview available.</div>
        )}
      </div>
    </div>
  );
}

function TextPreview({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((r) => r.text())
      .then((t) => {
        if (!cancelled) setText(t.slice(0, 200_000));
      })
      .catch((e) => {
        if (!cancelled) setErr(e?.message ?? "Failed to load text");
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (err) return <div className="text-sm text-destructive p-4">{err}</div>;
  if (text === null) {
    return (
      <div className="text-sm text-muted-foreground p-4 flex items-center gap-2">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading…
      </div>
    );
  }
  return (
    <pre className="text-xs font-mono p-4 whitespace-pre-wrap w-full overflow-auto max-h-[75vh]">
      {text}
    </pre>
  );
}

// ─── BOM view ──────────────────────────────────────────────────────────────

function BomContentView({
  content,
  token,
}: {
  content: BomContent;
  token: string;
}) {
  function handleCsvDownload() {
    // Client-side CSV so we don't need a separate server route just for
    // this (and so we never stream a large BOM through the public API).
    const headers = ["Item", "Part #", "Name", "Qty", "Unit", "Material", "Vendor"];
    const rows = content.items.map((i) => [
      i.itemNumber ?? "",
      i.partNumber ?? "",
      i.name ?? "",
      i.quantity?.toString() ?? "",
      i.unit ?? "",
      i.material ?? "",
      i.vendor ?? "",
    ]);
    const csv = [headers, ...rows]
      .map((row) =>
        row
          .map((cell) => {
            const s = cell.toString();
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(",")
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${content.bomName.replace(/[^a-z0-9]+/gi, "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    // Reference token so the signature is non-confusing — downloads are
    // tied to the share link even though the CSV is built client-side.
    void token;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold truncate">{content.bomName}</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {content.revision && <>Rev {content.revision}</>}
            {content.status && <> &middot; {content.status}</>}
            &middot; {content.items.length} item{content.items.length === 1 ? "" : "s"}
          </p>
        </div>
        {content.allowDownload && (
          <Button variant="outline" size="sm" onClick={handleCsvDownload}>
            <Download className="w-4 h-4 mr-1.5" /> Download CSV
          </Button>
        )}
      </div>

      <div className="rounded-lg border overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Item</th>
              <th className="text-left px-3 py-2 font-medium">Part #</th>
              <th className="text-left px-3 py-2 font-medium">Name</th>
              <th className="text-right px-3 py-2 font-medium">Qty</th>
              <th className="text-left px-3 py-2 font-medium">Unit</th>
              <th className="text-left px-3 py-2 font-medium">Material</th>
              <th className="text-left px-3 py-2 font-medium">Vendor</th>
            </tr>
          </thead>
          <tbody>
            {content.items.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center text-muted-foreground py-8">
                  This BOM has no items.
                </td>
              </tr>
            ) : (
              content.items.map((i, idx) => (
                <tr key={idx} className="border-t">
                  <td className="px-3 py-2 font-mono text-xs">{i.itemNumber}</td>
                  <td className="px-3 py-2 font-mono text-xs">{i.partNumber}</td>
                  <td className="px-3 py-2">{i.name}</td>
                  <td className="px-3 py-2 text-right">{i.quantity}</td>
                  <td className="px-3 py-2">{i.unit}</td>
                  <td className="px-3 py-2">{i.material}</td>
                  <td className="px-3 py-2">{i.vendor}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
