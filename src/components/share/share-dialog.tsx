"use client";

import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { FormattedDate } from "@/components/ui/formatted-date";
import { toast } from "sonner";
import {
  Copy,
  Trash2,
  ExternalLink,
  Link as LinkIcon,
  Lock,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { fetchJson, errorMessage } from "@/lib/api-client";
import { useFetch } from "@/hooks/use-fetch";
import { ShareActivityPanel } from "./share-activity-panel";

interface ShareLink {
  id: string;
  token: string;
  url: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  allowDownload: boolean;
  hasPassword: boolean;
  label: string | null;
  accessCount: number;
  lastAccessedAt: string | null;
}

interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceType: "file" | "bom" | "release" | "part";
  resourceId: string;
  resourceName: string;
}

const RESOURCE_LABELS: Record<ShareDialogProps["resourceType"], string> = {
  file: "file",
  bom: "BOM",
  release: "release",
  part: "part",
};

/** Summary of what a part share would actually contain. */
interface PartPackageSummary {
  files: Array<{ fileName: string; isPreliminary: boolean }>;
  filesWithheld: number;
  preliminaryCount: number;
}

// Expiry options map to a relative offset from "now". "never" serializes
// to a null expiresAt so the token never expires (the decision we agreed
// on earlier — respects the user's intent, visible picker overrides it).
type ExpiryOption = "never" | "1d" | "7d" | "30d";

const EXPIRY_LABELS: Record<ExpiryOption, string> = {
  never: "Never",
  "1d": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

function computeExpiryIso(option: ExpiryOption): string | null {
  if (option === "never") return null;
  const now = Date.now();
  const days = option === "1d" ? 1 : option === "7d" ? 7 : 30;
  return new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
}

export function ShareDialog({
  open,
  onOpenChange,
  resourceType,
  resourceId,
  resourceName,
}: ShareDialogProps) {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(false);
  // Track which row's activity panel is open. At most one open at a time
  // — keeps the dialog scrollable and avoids the "everyone expanded"
  // mess when there are many links.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Form state for creating a new link
  const [label, setLabel] = useState("");
  const [expiry, setExpiry] = useState<ExpiryOption>("never");
  const [allowDownload, setAllowDownload] = useState(true);
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);
  // Part shares only. Off by default and reset on every open — an opt-in
  // that persists between dialogs is one somebody eventually sends without
  // meaning to.
  const [includeWip, setIncludeWip] = useState(false);

  const loadLinks = useCallback(async () => {
    if (!resourceId) return;
    setLoading(true);
    try {
      const data = await fetchJson<ShareLink[]>(
        `/api/share-tokens?resourceType=${resourceType}&resourceId=${encodeURIComponent(resourceId)}`
      );
      // Hide revoked so the list shows only actionable links. The revoked
      // rows still exist in the DB for audit — we just don't surface them.
      setLinks(data.filter((l) => !l.revokedAt));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [resourceType, resourceId]);

  useEffect(() => {
    if (open) {
      void loadLinks();
      // Reset the form each time the dialog opens so stale state from a
      // prior create doesn't linger.
      setLabel("");
      setExpiry("never");
      setAllowDownload(true);
      setPassword("");
      setIncludeWip(false);
    }
  }, [open, loadLinks]);

  // A part share resolves to the part's *released* files. Anything still in
  // WIP is left out, and the person about to send the link is the one who
  // needs to know that — a supplier told "here's the drawing package" and
  // given three of five documents is the exact failure this feature exists
  // to prevent.
  const { data: pkg } = useFetch<PartPackageSummary>(
    open && resourceType === "part"
      ? `/api/parts/${resourceId}/package?includeWip=${includeWip}`
      : null
  );

  async function handleCreate() {
    setCreating(true);
    try {
      const body = {
        resourceType,
        resourceId,
        expiresAt: computeExpiryIso(expiry),
        allowDownload,
        password: password.trim() ? password : null,
        label: label.trim() || null,
        ...(resourceType === "part" ? { includeWip } : {}),
      };
      const created = await fetchJson<ShareLink>("/api/share-tokens", {
        method: "POST",
        body,
      });
      setLinks((prev) => [created, ...prev]);
      setLabel("");
      setPassword("");
      setExpiry("never");
      setAllowDownload(true);
      // Copy the new URL immediately — the whole point of opening this
      // dialog is usually "give me a link to paste somewhere."
      try {
        await navigator.clipboard.writeText(created.url);
        toast.success("Share link created and copied to clipboard");
      } catch {
        toast.success("Share link created");
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleCopy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy — select and copy manually");
    }
  }

  async function handleRevoke(id: string) {
    try {
      await fetchJson(`/api/share-tokens/${id}`, { method: "DELETE" });
      setLinks((prev) => prev.filter((l) => l.id !== id));
      toast.success("Link revoked");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LinkIcon className="w-5 h-5" />
            Share {RESOURCE_LABELS[resourceType]}
          </DialogTitle>
        </DialogHeader>

        <div className="text-sm text-muted-foreground -mt-2 mb-2 truncate">{resourceName}</div>

        {/* What a part link will actually contain. Shown before the link
            is minted, because after it is sent it is too late. */}
        {resourceType === "part" && (
          <div className="mb-2 space-y-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
            <p className="text-muted-foreground">
              Recipients see the{" "}
              <strong className="font-medium text-foreground">
                {includeWip ? "current" : "released"}
              </strong>{" "}
              documents for this part, and the link follows future revisions.
            </p>

            {pkg && (
              <p>
                {pkg.files.length === 0 ? (
                  <span className="text-destructive">
                    {includeWip
                      ? "This part has no documents attached at all — recipients would see an empty package."
                      : "This part has no released documents — recipients would see an empty package."}
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    {pkg.files.length} document{pkg.files.length === 1 ? "" : "s"} included
                    {pkg.preliminaryCount > 0 && (
                      <>
                        {" · "}
                        <span className="font-medium text-foreground">
                          {pkg.preliminaryCount} preliminary
                        </span>
                      </>
                    )}
                    {pkg.filesWithheld > 0 && (
                      <>
                        {" · "}
                        <span className="text-destructive">
                          {pkg.filesWithheld} withheld (not released)
                        </span>
                      </>
                    )}
                  </span>
                )}
              </p>
            )}

            <label className="flex items-start gap-2 cursor-pointer pt-1">
              <Checkbox
                id="share-include-wip"
                checked={includeWip}
                onCheckedChange={(c) => setIncludeWip(c === true)}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block font-medium text-foreground">
                  Include work-in-progress documents
                </span>
                <span className="block text-muted-foreground">
                  For quoting before release. Recipients see a{" "}
                  <strong className="font-medium">PRELIMINARY — NOT FOR PRODUCTION</strong> label on
                  each one, and the download prefixes their filenames. Recorded in the audit log.
                </span>
              </span>
            </label>
          </div>
        )}

        {/* ── Existing links ─────────────────────────────────────── */}
        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            Active share links
          </Label>
          {loading ? (
            <div className="text-sm text-muted-foreground py-4 text-center">Loading…</div>
          ) : links.length === 0 ? (
            <div className="text-sm text-muted-foreground py-4 text-center border border-dashed rounded-md">
              No active share links yet.
            </div>
          ) : (
            <ul className="space-y-2">
              {links.map((link) => {
                const isExpanded = expandedId === link.id;
                return (
                  <li key={link.id} className="rounded-md border bg-card">
                    <div className="flex items-center gap-2 px-3 py-2">
                      <div className="flex-1 min-w-0 overflow-hidden">
                        <div className="flex items-center gap-2">
                          <code className="text-xs truncate block min-w-0">{link.url}</code>
                          {link.hasPassword && (
                            <Lock className="w-3 h-3 text-muted-foreground shrink-0" />
                          )}
                        </div>
                        <div className="text-2xs text-muted-foreground flex gap-3 mt-0.5">
                          {link.label && <span className="truncate max-w-45">{link.label}</span>}
                          <button
                            type="button"
                            onClick={() => setExpandedId(isExpanded ? null : link.id)}
                            className="inline-flex items-center gap-0.5 hover:text-foreground transition-colors"
                            title="View access activity"
                          >
                            {isExpanded ? (
                              <ChevronDown className="w-3 h-3" />
                            ) : (
                              <ChevronRight className="w-3 h-3" />
                            )}
                            {link.accessCount} view{link.accessCount === 1 ? "" : "s"}
                          </button>
                          <span>
                            {link.expiresAt ? (
                              <>
                                Expires <FormattedDate date={link.expiresAt} variant="date" />
                              </>
                            ) : (
                              "No expiry"
                            )}
                          </span>
                          <span>{link.allowDownload ? "Download allowed" : "View only"}</span>
                        </div>
                      </div>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => handleCopy(link.url)}
                        title="Copy link"
                      >
                        <Copy className="w-4 h-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => window.open(link.url, "_blank", "noopener,noreferrer")}
                        title="Open in new tab"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => handleRevoke(link.id)}
                        title="Revoke link"
                        className="text-destructive hover:text-destructive/80"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                    {isExpanded && (
                      <div className="border-t px-3 py-2">
                        <ShareActivityPanel tokenId={link.id} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <Separator className="my-3" />

        {/* ── Create a new link ──────────────────────────────────── */}
        <div className="space-y-3">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            Create a new link
          </Label>

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label htmlFor="share-label" className="text-xs">
                Label (optional)
              </Label>
              <Input
                id="share-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. CM handoff — rev B"
                maxLength={200}
              />
            </div>

            <div>
              <Label htmlFor="share-expiry" className="text-xs">
                Expiry
              </Label>
              <Select value={expiry} onValueChange={(v) => setExpiry(v as ExpiryOption)}>
                <SelectTrigger id="share-expiry">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(EXPIRY_LABELS) as ExpiryOption[]).map((key) => (
                    <SelectItem key={key} value={key}>
                      {EXPIRY_LABELS[key]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label htmlFor="share-password" className="text-xs">
                Password (optional)
              </Label>
              <Input
                id="share-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank for no gate"
                maxLength={200}
                autoComplete="new-password"
              />
            </div>

            <div className="col-span-2 flex items-center gap-2">
              <Checkbox
                id="share-download"
                checked={allowDownload}
                onCheckedChange={(v) => setAllowDownload(v === true)}
              />
              <Label htmlFor="share-download" className="text-sm font-normal cursor-pointer">
                Allow viewers to download{" "}
                {resourceType === "file"
                  ? "the file"
                  : resourceType === "bom"
                    ? "the BOM as CSV"
                    : "the release as a ZIP"}
              </Label>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? "Creating…" : "Create link"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
