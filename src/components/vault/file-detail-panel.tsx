"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { FormattedDate } from "@/components/ui/formatted-date";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { X, Download, Save, FileText, Package, ClipboardList, ArrowLeft, MoreHorizontal, LogOut, LogIn, ArrowRightLeft, Pencil, Trash2, RotateCcw, Sparkles, Loader2, ImagePlus, Plus, Search } from "lucide-react";
import { useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { fetchJson, errorMessage, isAbortError } from "@/lib/api-client";
import { useRealtimeTable } from "@/hooks/use-realtime-table";
import { WhereUsedSection } from "@/components/where-used-section";
import type { FileWhereUsed } from "@/lib/where-used";
import { CadViewer } from "@/components/vault/cad-viewer";

const FILE_CATEGORY_LABELS: Record<string, string> = {
  PART: "Part",
  ASSEMBLY: "Assembly",
  DRAWING: "Drawing PDF",
  DRAWING_2D: "2D Drawing",
  MODEL_3D: "3D Model",
  DOCUMENT: "Document",
  SIMULATION: "Simulation",
  FIRMWARE: "Firmware",
  SOFTWARE: "Software",
  PURCHASED: "Purchased Part",
  OTHER: "Other",
};

// --- Preview components ---

function FilePreview({
  fileId,
  className,
  // Enables the CAD viewer's opportunistic thumbnail capture on the
  // first successful render. Default false so we never auto-capture
  // for files that already have a good thumbnail (manual, extracted,
  // or SolidWorks-embedded). The parent passes `!file.thumbnailKey`.
  shouldCaptureCadThumbnail = false,
  onCadThumbnailCaptured,
}: {
  fileId: string;
  className?: string;
  shouldCaptureCadThumbnail?: boolean;
  onCadThumbnailCaptured?: () => void;
}) {
  const [preview, setPreview] = useState<{
    canPreview: boolean;
    previewType?: string;
    fileType?: string;
    url?: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumped after a successful thumbnail regenerate so the preview effect
  // re-fetches and shows the new image instead of cached state.
  const [refreshKey, setRefreshKey] = useState(0);
  const [regenerating, setRegenerating] = useState(false);
  const [uploadingThumb, setUploadingThumb] = useState(false);
  const thumbInputRef = useRef<HTMLInputElement>(null);

  // Note: setLoading(true) is omitted from the effect body because the lint
  // rule react-hooks/set-state-in-effect forbids synchronous setState in
  // effects. We rely on the initial useState(true) and the per-fileId remount
  // (the panel uses fileId as a key indirectly via prop change).
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    fetch(`/api/files/${fileId}/preview`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Preview failed: ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (!cancelled) {
          setPreview(d);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (cancelled || err?.name === "AbortError") return;
        setPreview(null);
        setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fileId, refreshKey]);

  // Re-runs the server-side extractor against the file already in storage.
  // Uses /api/files/[fileId]/thumbnail/regenerate which downloads the file,
  // runs the same extractor used at upload time, and updates thumbnailKey.
  // Critical for files uploaded before the extraction pipeline was working.
  async function handleRegenerate() {
    setRegenerating(true);
    try {
      const res = await fetch(`/api/files/${fileId}/thumbnail/regenerate`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to regenerate thumbnail");
        return;
      }
      if (data.regenerated) {
        toast.success("Thumbnail regenerated");
        setRefreshKey((k) => k + 1);
      } else {
        toast.warning(data.reason || "No thumbnail could be extracted from this file");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to regenerate thumbnail");
    } finally {
      setRegenerating(false);
    }
  }

  // Manual thumbnail upload — the escape hatch for files whose format
  // has no embedded preview that we can extract (e.g., newer SolidWorks
  // files saved without "Save preview picture", or any non-image CAD
  // format). User picks a PNG/JPEG, we normalise it through the image
  // branch of the dispatcher and store it as the thumbnail.
  async function handleThumbnailUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingThumb(true);
    try {
      const formData = new FormData();
      formData.append("image", file);
      const res = await fetch(`/api/files/${fileId}/thumbnail/set`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to upload thumbnail");
        return;
      }
      toast.success("Thumbnail updated");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to upload thumbnail");
    } finally {
      setUploadingThumb(false);
      // Reset so selecting the same file twice in a row still fires onChange
      if (thumbInputRef.current) thumbInputRef.current.value = "";
    }
  }

  if (loading) return <p className="text-sm text-muted-foreground text-center py-12">Loading preview...</p>;
  if (!preview || !preview.canPreview) {
    // Message distinguishes three real cases so we don't mislead users
    // into thinking a supported format is unsupported:
    //
    //   1. SolidWorks files — extraction is supported, but this specific
    //      file has no embedded preview (or hasn't been processed yet).
    //      Both "Try auto-extract" and "Upload thumbnail" are useful.
    //
    //   2. Other CAD formats (step/stl/dwg/dxf/iges) — pure-JS preview
    //      isn't possible. Only "Upload thumbnail" is useful.
    //
    //   3. Anything else unsupported for preview — generic fallback.
    const ext = (preview?.fileType || "").toLowerCase();
    const isSolidWorks = ["sldprt", "sldasm", "slddrw"].includes(ext);
    // DWG and DXF fall through to the fallback because there's no
    // pure-JS renderer we trust for them yet. STL / OBJ / STEP / STP /
    // IGES / IGS are now handled by the in-browser CadViewer above,
    // so they shouldn't hit this branch — but if the preview endpoint
    // ever stops recognising them we still want a sensible message.
    const isOtherCad = ["dwg", "dxf"].includes(ext);
    const headline = isSolidWorks
      ? "No preview extracted yet for this file"
      : isOtherCad
        ? `In-browser preview isn't supported for .${ext} files`
        : `Preview not available for .${ext || "unknown"} files`;
    return (
      <div className="text-center py-12">
        <FileText className="w-12 h-12 mx-auto mb-3 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">{headline}</p>
        <div className="mt-3 flex gap-2 justify-center flex-wrap">
          <Button variant="outline" size="sm" onClick={() => {
            fetch(`/api/files/${fileId}/download`).then(r => r.json()).then(d => { if (d.url) window.open(d.url, "_blank"); });
          }}>
            <Download className="w-3.5 h-3.5 mr-1.5" />Download file
          </Button>
          <Button variant="outline" size="sm" onClick={handleRegenerate} disabled={regenerating}>
            {regenerating
              ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              : <Sparkles className="w-3.5 h-3.5 mr-1.5" />
            }
            {regenerating ? "Regenerating..." : "Try auto-extract"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => thumbInputRef.current?.click()}
            disabled={uploadingThumb}
          >
            {uploadingThumb
              ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              : <ImagePlus className="w-3.5 h-3.5 mr-1.5" />
            }
            {uploadingThumb ? "Uploading..." : "Upload thumbnail"}
          </Button>
          <input
            ref={thumbInputRef}
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/webp"
            className="hidden"
            onChange={handleThumbnailUpload}
          />
        </div>
        <p className="mt-3 text-xs text-muted-foreground/80 max-w-sm mx-auto">
          {isSolidWorks
            ? "Auto-extract reads an embedded preview from the SolidWorks file itself. If the file has no preview (the Save preview picture option was off when it was saved), upload one manually."
            : isOtherCad
              ? "This format has no embedded raster preview we can read. Upload a thumbnail image to represent the file in the vault."
              : "Auto-extract reads an embedded preview from the file. Upload thumbnail lets you set one manually."}
        </p>
      </div>
    );
  }

  if (preview.previewType === "image") {
    return (
      <div className={`flex items-center justify-center bg-muted/30 rounded-lg p-4 ${className || ""}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={preview.url} alt="File preview" className="max-w-full max-h-full object-contain rounded" />
      </div>
    );
  }

  if (preview.previewType === "pdf") {
    return (
      <object data={preview.url} type="application/pdf" className={`w-full rounded-lg border ${className || ""}`} style={{ minHeight: "400px" }}>
        <div className="flex flex-col items-center justify-center h-full gap-3 p-4">
          <FileText className="w-10 h-10 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">PDF preview unavailable in this browser</p>
          <a href={preview.url} target="_blank" rel="noopener noreferrer" className="text-sm text-primary underline">
            Open PDF directly
          </a>
        </div>
      </object>
    );
  }

  if (preview.previewType === "cad" && preview.url && preview.fileType) {
    return (
      <CadViewer
        url={preview.url}
        fileType={preview.fileType}
        fileId={fileId}
        autoCaptureThumbnail={shouldCaptureCadThumbnail}
        onThumbnailCaptured={onCadThumbnailCaptured}
        className={className}
      />
    );
  }

  if (preview.previewType === "text") {
    return <TextPreview url={preview.url!} className={className} />;
  }

  return null;
}

function TextPreview({ url, className }: { url: string; className?: string }) {
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    fetch(url)
      .then((r) => r.text())
      .then((t) => setContent(t.slice(0, 5000)))
      .catch(() => setContent("Failed to load"));
  }, [url]);

  if (!content) return <p className="text-sm text-muted-foreground text-center py-4">Loading...</p>;

  return (
    <pre className={`text-xs bg-muted/30 rounded-lg p-3 overflow-auto whitespace-pre-wrap font-mono ${className || ""}`}>
      {content}
    </pre>
  );
}

// --- Types ---

interface MetadataFieldDef {
  id: string;
  name: string;
  fieldType: string;
  options: string[] | null;
  isRequired: boolean;
}

interface FileDetail {
  id: string;
  name: string;
  partNumber: string | null;
  description: string | null;
  fileType: string;
  category: string;
  currentVersion: number;
  revision: string;
  isFrozen: boolean;
  lifecycleState: string;
  isCheckedOut: boolean;
  checkedOutById: string | null;
  checkedOutBy: { fullName: string; email: string } | null;
  checkedOutAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present when the file has an extracted or manually-uploaded thumbnail. */
  thumbnailKey?: string | null;
  folder: { name: string; path: string };
  versions: {
    id: string;
    version: number;
    fileSize: number;
    comment: string | null;
    createdAt: string;
    uploadedBy: { fullName: string };
  }[];
  metadata: {
    id: string;
    fieldId: string;
    value: string;
    field: { name: string; fieldType: string };
  }[];
}

// --- Main component ---

export function FileDetailPanel({
  fileId,
  metadataFields,
  onClose,
  onRefresh,
  onCheckIn,
  onChangeState,
  onRename,
  onDelete,
  userId,
  layout = "full",
}: {
  fileId: string;
  metadataFields: MetadataFieldDef[];
  onClose: () => void;
  onRefresh: () => void;
  onCheckIn?: () => void;
  onChangeState?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  userId?: string;
  layout?: "full" | "compact";
}) {
  const [file, setFile] = useState<FileDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [partNumber, setPartNumber] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [metadataValues, setMetadataValues] = useState<Record<string, string>>({});
  const [whereUsedData, setWhereUsedData] = useState<FileWhereUsed | null>(null);
  const [linkedParts, setLinkedParts] = useState<{ id: string; role: string; isPrimary: boolean; part: { id: string; partNumber: string; name: string; lifecycleState: string; category: string } }[]>([]);
  const router = useRouter();
  // Inline "link to part" state inside the panel
  const [showLinkPart, setShowLinkPart] = useState(false);
  const [linkPartSearch, setLinkPartSearch] = useState("");
  const [linkPartResults, setLinkPartResults] = useState<{ id: string; partNumber: string; name: string }[]>([]);
  const [linkPartSearching, setLinkPartSearching] = useState(false);
  const [linkPartRole, setLinkPartRole] = useState("DRAWING");
  // Per-version revision history with linked ECO. Lives alongside `file.versions`
  // (which is the lightweight summary embedded in the file fetch) — this one
  // is the richer view rendered in the Versions tab so engineers can see
  // "v3 (rev B) — released by ECO-0042".
  const [revisions, setRevisions] = useState<{
    id: string;
    version: number;
    revision: string | null;
    fileSize: number;
    comment: string | null;
    createdAt: string;
    ecoId: string | null;
    uploadedBy: { fullName: string };
    eco: { id: string; ecoNumber: string; title: string; status: string } | null;
  }[]>([]);

  // Reusable refresh function — called after mutations (save, transition, etc).
  // Returns a promise so callers can await completion.
  const refreshFile = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [data, wu, revs, parts] = await Promise.all([
          fetchJson<FileDetail>(`/api/files/${fileId}`, { signal }),
          fetchJson<FileWhereUsed>(`/api/files/${fileId}/where-used`, { signal }),
          fetchJson<typeof revisions>(`/api/files/${fileId}/revisions`, { signal }),
          fetchJson<typeof linkedParts>(`/api/files/${fileId}/parts`, { signal }),
        ]);
        if (signal?.aborted) return;
        setFile(data);
        setPartNumber(data.partNumber || "");
        setDescription(data.description || "");
        setCategory(data.category || "");

        const values: Record<string, string> = {};
        for (const mv of data.metadata) {
          values[mv.fieldId] = mv.value;
        }
        setMetadataValues(values);
        setWhereUsedData(wu ?? null);
        setRevisions(Array.isArray(revs) ? revs : []);
        setLinkedParts(Array.isArray(parts) ? parts : []);
      } catch (err) {
        if (isAbortError(err)) return;
        toast.error(errorMessage(err) || "Failed to load file details");
      }
    },
    [fileId]
  );

  // Initial load — abort on unmount or fileId change so stale responses
  // can't overwrite the panel after the user has navigated away. The async
  // IIFE pushes all state updates past the synchronous effect body, which
  // satisfies the react-hooks/set-state-in-effect rule.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        await refreshFile(controller.signal);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [refreshFile]);

  // ─── Realtime ────────────────────────────────────────────────────────
  //
  // An engineer can stare at the detail panel for minutes deciding
  // whether to use a part — this is the worst possible place for stale
  // data. Subscribe to the *one* files row and its file_versions so
  // checkout toggles, renames, lifecycle transitions, and ECO-driven
  // revision releases all land in the panel within 250ms.
  //
  // Filters are by id/fileId so only events for the currently-open
  // file wake this component. When the user navigates away (fileId
  // changes or panel unmounts), the channels tear down automatically.
  useRealtimeTable({
    table: "files",
    filter: `id=eq.${fileId}`,
    onChange: () => { void refreshFile(); },
  });
  useRealtimeTable({
    table: "file_versions",
    filter: `fileId=eq.${fileId}`,
    onChange: () => { void refreshFile(); },
  });

  async function handleSaveMetadata() {
    setSaving(true);
    try {
      const metadata = Object.entries(metadataValues)
        .filter(([, value]) => value !== "")
        .map(([fieldId, value]) => ({ fieldId, value }));

      const res = await fetch(`/api/files/${fileId}/metadata`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partNumber, description, category, metadata }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to save");
      } else {
        toast.success("Metadata saved");
        onRefresh();
      }
    } catch {
      toast.error("Failed to save metadata");
    }
    setSaving(false);
  }

  function handleDownload(version?: number) {
    const qs = version ? `?version=${version}` : "";
    fetch(`/api/files/${fileId}/download${qs}`)
      .then((r) => r.json())
      .then((d) => { if (d.url) window.open(d.url, "_blank"); });
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  async function handleRestore(version: number) {
    const res = await fetch(`/api/files/${fileId}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error || "Failed to restore"); return; }
    const d = await res.json();
    toast.success(`Restored to version ${version} (now v${d.newVersion})`);
    refreshFile();
    onRefresh();
  }

  async function handleCheckout() {
    const res = await fetch(`/api/files/${fileId}/checkout`, { method: "POST" });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("File checked out");
    refreshFile();
    onRefresh();
  }

  async function doLinkPartSearch(q: string) {
    if (q.length < 2) { setLinkPartResults([]); setLinkPartSearching(false); return; }
    setLinkPartSearching(true);
    try {
      const res = await fetch(`/api/parts?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setLinkPartResults((Array.isArray(data) ? data : []).slice(0, 8));
    } catch { setLinkPartResults([]); }
    setLinkPartSearching(false);
  }

  async function handleLinkPart(partId: string) {
    const res = await fetch(`/api/files/${fileId}/parts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partId, role: linkPartRole }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("Part linked");
    setShowLinkPart(false);
    setLinkPartSearch("");
    setLinkPartResults([]);
    void refreshFile();
  }

  async function handleUnlinkPart(partId: string) {
    const res = await fetch(`/api/files/${fileId}/parts`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ partId }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("Part unlinked");
    void refreshFile();
  }

  if (loading || !file) {
    return (
      <div className="flex items-center justify-center p-12 text-muted-foreground text-sm h-full">
        Loading...
      </div>
    );
  }

  const showCheckOut = !file.isCheckedOut;
  const showCheckIn = file.isCheckedOut && file.checkedOutById === userId && !!onCheckIn;
  const hasAnyAction = showCheckOut || showCheckIn || onChangeState || onRename || onDelete;

  const actionsDropdown = hasAnyAction ? (
    <DropdownMenu>
      <DropdownMenuTrigger render={
        <Button variant="outline" size="sm" className="shrink-0">
          <MoreHorizontal className="w-4 h-4" />
        </Button>
      } />
      <DropdownMenuContent align="end">
        {showCheckOut && (
          <DropdownMenuItem onClick={handleCheckout}>
            <LogOut className="w-4 h-4 mr-2" />Check Out
          </DropdownMenuItem>
        )}
        {showCheckIn && (
          <DropdownMenuItem onClick={onCheckIn}>
            <LogIn className="w-4 h-4 mr-2" />Check In
          </DropdownMenuItem>
        )}
        {onChangeState && (
          <DropdownMenuItem onClick={onChangeState}>
            <ArrowRightLeft className="w-4 h-4 mr-2" />Change State
          </DropdownMenuItem>
        )}
        {(showCheckOut || showCheckIn || onChangeState) && (onRename || onDelete) && (
          <DropdownMenuSeparator />
        )}
        {onRename && (
          <DropdownMenuItem onClick={onRename}>
            <Pencil className="w-4 h-4 mr-2" />Rename
          </DropdownMenuItem>
        )}
        {onDelete && (
          <DropdownMenuItem onClick={onDelete} className="text-destructive">
            <Trash2 className="w-4 h-4 mr-2" />Delete
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  // --- Sidebar content (properties / versions) ---
  const sidebarContent = (
    <Tabs defaultValue="properties" className="flex flex-col min-h-0 h-full">
      <TabsList className="w-full shrink-0">
        <TabsTrigger value="properties" className="flex-1 text-xs">Properties</TabsTrigger>
        <TabsTrigger value="versions" className="flex-1 text-xs">Versions</TabsTrigger>
      </TabsList>

      <TabsContent value="properties" className="flex-1 overflow-auto mt-2">
        <div className="space-y-4">
          {file.isFrozen && (
            <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded p-2 text-xs text-blue-700 dark:text-blue-300">
              This file is {file.lifecycleState}. Properties are locked. Use Change State to revise.
            </div>
          )}

          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
            <span className="text-muted-foreground">Type</span>
            <span>{file.fileType.toUpperCase()}</span>
            <span className="text-muted-foreground">Revision</span>
            <span className="font-mono">{file.revision}.{file.currentVersion}</span>
            <span className="text-muted-foreground">State</span>
            <Badge variant="secondary">{file.lifecycleState}</Badge>
            <span className="text-muted-foreground">Location</span>
            <span className="truncate">{file.folder.path}</span>
            <span className="text-muted-foreground">Created</span>
            <FormattedDate date={file.createdAt} variant="date" />
          </div>

          {file.isCheckedOut && file.checkedOutBy && (
            <div className="bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800 rounded p-2 text-sm">
              Checked out by {file.checkedOutBy.fullName}
            </div>
          )}

          <Separator />

          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v ?? "")} disabled={file.isFrozen}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue>{(v) => FILE_CATEGORY_LABELS[v as string] ?? ""}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PART">Part</SelectItem>
                  <SelectItem value="ASSEMBLY">Assembly</SelectItem>
                  <SelectItem value="DRAWING">Drawing PDF</SelectItem>
                  <SelectItem value="DRAWING_2D">2D Drawing</SelectItem>
                  <SelectItem value="MODEL_3D">3D Model</SelectItem>
                  <SelectItem value="DOCUMENT">Document</SelectItem>
                  <SelectItem value="SIMULATION">Simulation</SelectItem>
                  <SelectItem value="FIRMWARE">Firmware</SelectItem>
                  <SelectItem value="SOFTWARE">Software</SelectItem>
                  <SelectItem value="PURCHASED">Purchased Part</SelectItem>
                  <SelectItem value="OTHER">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Linked Parts */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <Label className="text-xs">Linked Parts</Label>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => { setShowLinkPart((v) => !v); setLinkPartSearch(""); setLinkPartResults([]); setLinkPartRole("DRAWING"); }}
                >
                  <Plus className="w-3 h-3" />
                </Button>
              </div>

              {showLinkPart && (
                <div className="space-y-1.5 mb-2">
                  <Select value={linkPartRole} onValueChange={(v) => setLinkPartRole(v ?? "DRAWING")}>
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue>{(v: string) => ({ DRAWING: "Drawing", MODEL_3D: "3D Model", SPEC_SHEET: "Spec Sheet", DATASHEET: "Datasheet", OTHER: "Other" })[v] ?? v}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="DRAWING">Drawing</SelectItem>
                      <SelectItem value="MODEL_3D">3D Model</SelectItem>
                      <SelectItem value="SPEC_SHEET">Spec Sheet</SelectItem>
                      <SelectItem value="DATASHEET">Datasheet</SelectItem>
                      <SelectItem value="OTHER">Other</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
                    <Input
                      value={linkPartSearch}
                      onChange={(e) => { setLinkPartSearch(e.target.value); void doLinkPartSearch(e.target.value); }}
                      placeholder="Search parts..."
                      className="pl-7 h-7 text-xs"
                    />
                  </div>
                  {linkPartSearching && <div className="flex justify-center py-1"><Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" /></div>}
                  {linkPartResults.length > 0 && (
                    <div className="border rounded-lg max-h-36 overflow-y-auto">
                      {linkPartResults.map((p) => (
                        <button
                          key={p.id}
                          className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-muted/50 transition-colors flex items-center gap-2"
                          onClick={() => handleLinkPart(p.id)}
                        >
                          <Package className="w-3 h-3 text-muted-foreground shrink-0" />
                          <span className="font-mono shrink-0">{p.partNumber}</span>
                          <span className="truncate text-muted-foreground">{p.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {linkPartSearch.length >= 2 && !linkPartSearching && linkPartResults.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-1">No parts found</p>
                  )}
                </div>
              )}

              {linkedParts.length === 0 ? (
                <p className="text-xs text-muted-foreground">No parts linked.</p>
              ) : (
                <div className="space-y-1">
                  {linkedParts.map((lp) => (
                    <div key={lp.id} className="flex items-center gap-2 text-xs group">
                      <Package className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      <Link href="/parts" className="font-mono hover:underline shrink-0">{lp.part.partNumber}</Link>
                      <span className="truncate text-muted-foreground flex-1">{lp.part.name}</span>
                      <span className="text-[10px] text-muted-foreground shrink-0">{lp.role}</span>
                      <button
                        onClick={() => handleUnlinkPart(lp.part.id)}
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1">
              <Label htmlFor="pn" className="text-xs">Part Number</Label>
              <Input id="pn" value={partNumber} onChange={(e) => setPartNumber(e.target.value)} className="h-8 text-sm" disabled={file.isFrozen} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="desc" className="text-xs">Description</Label>
              <Textarea id="desc" value={description} onChange={(e) => setDescription(e.target.value)} className="text-sm" rows={2} disabled={file.isFrozen} />
            </div>
          </div>

          <Separator />
          <p className="text-xs font-semibold text-muted-foreground uppercase">Custom Properties</p>

          <div className="space-y-3">
            {metadataFields.map((field) => (
              <div key={field.id} className="space-y-1">
                <Label className="text-xs">{field.name}</Label>
                {field.fieldType === "SELECT" && field.options ? (
                  <Select
                    value={metadataValues[field.id] || ""}
                    onValueChange={(v) => setMetadataValues((prev) => ({ ...prev, [field.id]: v ?? "" }))}
                  >
                    <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select..." /></SelectTrigger>
                    <SelectContent>
                      {field.options.map((opt) => (
                        <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    type={field.fieldType === "NUMBER" ? "number" : "text"}
                    value={metadataValues[field.id] || ""}
                    onChange={(e) => setMetadataValues((prev) => ({ ...prev, [field.id]: e.target.value }))}
                    className="h-8 text-sm"
                  />
                )}
              </div>
            ))}
          </div>

          <Button onClick={handleSaveMetadata} disabled={saving} className="w-full" size="sm">
            <Save className="w-4 h-4 mr-2" />
            {saving ? "Saving..." : "Save Properties"}
          </Button>

          {whereUsedData && (whereUsedData.boms.length + whereUsedData.representsBoms.length + whereUsedData.ecos.length > 0) && (
            <>
              <Separator />
              <WhereUsedSection
                boms={whereUsedData.boms}
                representsBoms={whereUsedData.representsBoms}
                ecos={whereUsedData.ecos}
                onNavigateBom={() => router.push("/boms")}
                onNavigateEco={(ecoId) => router.push(`/ecos?ecoId=${ecoId}`)}
              />
            </>
          )}
          {/* The old scattered "Used in BOMs" and "Referenced in ECOs" blocks
              were merged into the WhereUsedSection above. The linkedParts
              section stays separate (higher up in this tab) because it has
              inline add/unlink management controls, not just display. */}

        </div>
      </TabsContent>

      <TabsContent value="versions" className="flex-1 overflow-auto mt-2">
        <div className="space-y-3">
          {/* Prefer the richer /revisions response (includes ecoId + linked
              ECO) over the inline file.versions summary, but fall back to it
              if the revisions fetch hasn't returned yet. */}
          {(revisions.length > 0 ? revisions : file.versions.map((v) => ({
            id: v.id,
            version: v.version,
            revision: null,
            fileSize: v.fileSize,
            comment: v.comment,
            createdAt: v.createdAt,
            ecoId: null,
            uploadedBy: v.uploadedBy,
            eco: null,
          }))).map((v) => {
            const isCurrent = v.version === file.currentVersion;
            return (
              <div key={v.id} className={`border rounded p-3 text-sm space-y-1 ${isCurrent ? "border-primary/30 bg-primary/5" : ""}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {v.revision ? `Rev ${v.revision}.${v.version}` : `Version ${v.version}`}
                    </span>
                    {isCurrent && <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Current</Badge>}
                  </div>
                  <div className="flex items-center gap-1">
                    {!isCurrent && !file.isFrozen && !file.isCheckedOut && (
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => handleRestore(v.version)}>
                        <RotateCcw className="w-3 h-3 mr-1" />Restore
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" className="h-7" onClick={() => handleDownload(v.version)}>
                      <Download className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
                <p className="text-muted-foreground">
                  {formatFileSize(v.fileSize)} &middot; {v.uploadedBy.fullName}
                </p>
                <p className="text-muted-foreground">
                  <FormattedDate date={v.createdAt} />
                </p>
                {v.eco && (
                  <Link
                    href="/ecos"
                    className="flex items-center gap-1.5 text-xs text-primary hover:underline"
                  >
                    <ClipboardList className="w-3 h-3" />
                    Released by {v.eco.ecoNumber} &mdash; {v.eco.title}
                  </Link>
                )}
                {v.comment && <p className="text-muted-foreground italic">&ldquo;{v.comment}&rdquo;</p>}
              </div>
            );
          })}
        </div>
      </TabsContent>

    </Tabs>
  );

  // --- Full layout: preview left, sidebar right (desktop vault view) ---
  if (layout === "full") {
    return (
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b shrink-0">
          <Button variant="ghost" size="sm" onClick={onClose} className="shrink-0">
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold truncate">{file.name}</h3>
            <p className="text-xs text-muted-foreground truncate">{file.folder.path} &middot; Rev {file.revision}.{file.currentVersion}</p>
          </div>
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => handleDownload()}>
            <Download className="w-3.5 h-3.5 mr-1.5" />Download
          </Button>
          {actionsDropdown}
        </div>

        {/* Preview left, sidebar right */}
        <div className="flex flex-1 min-h-0">
          <div className="flex-1 min-w-0 p-4 overflow-auto bg-muted/20">
            <FilePreview
              fileId={fileId}
              className="h-full"
              shouldCaptureCadThumbnail={!file.thumbnailKey && !file.isFrozen}
              onCadThumbnailCaptured={() => { void refreshFile(); }}
            />
          </div>
          <div className="w-80 lg:w-96 border-l p-4 overflow-auto shrink-0">
            {sidebarContent}
          </div>
        </div>
      </div>
    );
  }

  // --- Compact layout: stacked tabs (mobile sheet) ---
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b shrink-0">
        <Button variant="ghost" size="sm" onClick={onClose} className="shrink-0">
          <X className="w-4 h-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold truncate">{file.name}</h3>
          <p className="text-xs text-muted-foreground truncate">{file.folder.path}</p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => handleDownload()}>
          <Download className="w-3.5 h-3.5" />
        </Button>
        {actionsDropdown}
      </div>

      <Tabs defaultValue="preview" className="flex-1 flex flex-col min-h-0">
        <div className="px-4 pt-3 shrink-0">
          <TabsList className="w-full">
            <TabsTrigger value="preview" className="flex-1 text-xs">Preview</TabsTrigger>
            <TabsTrigger value="details" className="flex-1 text-xs">Details</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="preview" className="flex-1 overflow-auto p-4 mt-0">
          <FilePreview
            fileId={fileId}
            className="min-h-[50vh]"
            shouldCaptureCadThumbnail={!file.thumbnailKey && !file.isFrozen}
            onCadThumbnailCaptured={() => { void refreshFile(); }}
          />
        </TabsContent>
        <TabsContent value="details" className="flex-1 overflow-auto p-4 mt-0">
          {sidebarContent}
        </TabsContent>
      </Tabs>
    </div>
  );
}
