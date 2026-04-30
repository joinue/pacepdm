"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { FormattedDate } from "@/components/ui/formatted-date";
import { fetchJson, errorMessage } from "@/lib/api-client";
import { toast } from "sonner";
import { AlertCircle, Eye, Download, Lock, Link2, Archive } from "lucide-react";

// Server payload shape — mirrors `ShareAccessRowWithFile` but only the
// fields we render.
interface ActivityRow {
  id: string;
  action: "resolve" | "unlock" | "view-content" | "download" | "zip-download";
  success: boolean;
  failureReason: string | null;
  fileName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

interface ActivityResponse {
  rows: ActivityRow[];
  nextBefore: string | null;
}

interface ShareActivityPanelProps {
  tokenId: string;
}

const ACTION_LABELS: Record<ActivityRow["action"], string> = {
  resolve: "Opened link",
  unlock: "Password attempt",
  "view-content": "Viewed",
  download: "Downloaded",
  "zip-download": "Downloaded ZIP",
};

const ACTION_ICONS: Record<ActivityRow["action"], typeof Eye> = {
  resolve: Link2,
  unlock: Lock,
  "view-content": Eye,
  download: Download,
  "zip-download": Archive,
};

const FAILURE_LABELS: Record<string, string> = {
  wrong_password: "wrong password",
  revoked: "link revoked",
  expired: "link expired",
};

// Short browser label parsed from the leading bytes of a User-Agent
// string. Heuristic only — we keep the full UA in `title` for hover.
// Order matters: Chrome impersonates "Mozilla/Safari", so test specifics
// first.
function shortBrowser(ua: string | null): string {
  if (!ua) return "Unknown";
  const u = ua.toLowerCase();
  if (u.includes("slackbot")) return "Slack preview";
  if (u.includes("twitterbot")) return "Twitter preview";
  if (u.includes("facebookexternalhit")) return "Facebook preview";
  if (u.includes("linkedinbot")) return "LinkedIn preview";
  if (u.includes("discordbot")) return "Discord preview";
  if (u.includes("googlebot")) return "Googlebot";
  if (u.includes("bot") || u.includes("crawler") || u.includes("spider")) return "Bot";
  if (u.includes("edg/")) return "Edge";
  if (u.includes("chrome/")) return "Chrome";
  if (u.includes("firefox/")) return "Firefox";
  if (u.includes("safari/")) return "Safari";
  return ua.slice(0, 24);
}

export function ShareActivityPanel({ tokenId }: ShareActivityPanelProps) {
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const loadPage = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: "25" });
        if (cursor) params.set("before", cursor);
        const data = await fetchJson<ActivityResponse>(
          `/api/share-tokens/${tokenId}/activity?${params.toString()}`
        );
        setRows((prev) => (cursor ? [...prev, ...data.rows] : data.rows));
        setNextBefore(data.nextBefore);
        setLoadedOnce(true);
      } catch (err) {
        toast.error(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [tokenId]
  );

  useEffect(() => {
    void loadPage(null);
  }, [loadPage]);

  if (loading && !loadedOnce) {
    return (
      <div className="text-xs text-muted-foreground py-3 text-center">
        Loading activity…
      </div>
    );
  }

  if (loadedOnce && rows.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-3 text-center">
        No accesses yet.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="text-[10px] text-muted-foreground/80 italic">
        Includes link previews from chat apps (Slack, iMessage), which can
        inflate counts.
      </div>
      <ul className="space-y-1">
        {rows.map((r) => {
          const Icon = r.success ? ACTION_ICONS[r.action] : AlertCircle;
          return (
            <li
              key={r.id}
              className={`flex items-center gap-2 text-xs px-2 py-1 rounded ${
                r.success ? "bg-muted/40" : "bg-destructive/10"
              }`}
            >
              <Icon
                className={`w-3 h-3 shrink-0 ${
                  r.success ? "text-muted-foreground" : "text-destructive"
                }`}
              />
              <span className="font-medium">
                {ACTION_LABELS[r.action]}
                {!r.success && r.failureReason && (
                  <span className="text-destructive ml-1">
                    — {FAILURE_LABELS[r.failureReason] ?? r.failureReason}
                  </span>
                )}
              </span>
              {r.fileName && (
                <span className="text-muted-foreground truncate max-w-40">
                  {r.fileName}
                </span>
              )}
              <span className="text-muted-foreground ml-auto whitespace-nowrap">
                <FormattedDate date={r.createdAt} variant="datetime" />
              </span>
              {r.ipAddress && (
                <span className="text-muted-foreground font-mono text-[10px]">
                  {r.ipAddress}
                </span>
              )}
              <span
                className="text-muted-foreground text-[10px]"
                title={r.userAgent ?? undefined}
              >
                {shortBrowser(r.userAgent)}
              </span>
            </li>
          );
        })}
      </ul>
      {nextBefore && (
        <div className="flex justify-center pt-1">
          <Button
            size="sm"
            variant="ghost"
            className="text-xs h-7"
            onClick={() => void loadPage(nextBefore)}
            disabled={loading}
          >
            {loading ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
