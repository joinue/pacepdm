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
import { X, Download, Save, FileText, Package, ClipboardList, ArrowLeft, MoreHorizontal, LogOut, LogIn, ArrowRightLeft, Pencil, Trash2, RotateCcw } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

// --- Preview components ---

function FilePreview({ fileId, className }: { fileId: string; className?: string }) {
  const [preview, setPreview] = useState<{
    canPreview: boolean;
    previewType?: string;
    fileType?: string;
    url?: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/files/${fileId}/preview`)
      .then((r) => {
        if (!r.ok) throw new Error(`Preview failed: ${r.status}`);
        return r.json();
      })
      .then((d) => { setPreview(d); setLoading(false); })
      .catch(() => { setPreview(null); setLoading(false); });
  }, [fileId]);

  if (loading) return <p className="text-sm text-muted-foreground text-center py-12">Loading preview...</p>;
  if (!preview || !preview.canPreview) {
    return (
      <div className="text-center py-12">
        <FileText className="w-12 h-12 mx-auto mb-3 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">Preview not available for .{preview?.fileType || "unknown"} files</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => {
          fetch(`/api/files/${fileId}/download`).then(r => r.json()).then(d => { if (d.url) window.open(d.url, "_blank"); });
        }}>
          <Download className="w-3.5 h-3.5 mr-1.5" />Download file
        </Button>
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
  references: {
    targetFile: { id: string; name: string; partNumber: string | null };
  }[];
  referencedBy: {
    sourceFile: { id: string; name: string; partNumber: string | null };
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
  const [whereUsed, setWhereUsed] = useState<{
    bomId: string; bomName: string; bomRevision: string; bomStatus: string;
    itemNumber: string; itemName: string; quantity: number; unit: string;
  }[]>([]);
  const [linkedEcos, setLinkedEcos] = useState<{id: string; changeType: string; reason: string | null; eco: { id: string; ecoNumber: string; title: string; status: string; priority: string }}[]>([]);

  const loadFile = useCallback(async () => {
    setLoading(true);
    try {
      const [fileRes, whereRes, ecosRes] = await Promise.all([
        fetch(`/api/files/${fileId}`),
        fetch(`/api/files/${fileId}/where-used`),
        fetch(`/api/files/${fileId}/ecos`),
      ]);
      const data = await fileRes.json();
      setFile(data);
      setPartNumber(data.partNumber || "");
      setDescription(data.description || "");
      setCategory(data.category || "");

      const values: Record<string, string> = {};
      for (const mv of data.metadata) {
        values[mv.fieldId] = mv.value;
      }
      setMetadataValues(values);

      const wu = await whereRes.json();
      setWhereUsed(Array.isArray(wu) ? wu : []);

      const ecos = await ecosRes.json();
      setLinkedEcos(Array.isArray(ecos) ? ecos : []);
    } catch {
      toast.error("Failed to load file details");
    }
    setLoading(false);
  }, [fileId]);

  useEffect(() => {
    loadFile();
  }, [loadFile]);

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
    loadFile();
    onRefresh();
  }

  async function handleCheckout() {
    const res = await fetch(`/api/files/${fileId}/checkout`, { method: "POST" });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("File checked out");
    loadFile();
    onRefresh();
  }

  if (loading || !file) {
    return (
      <div className="flex items-center justify-center p-12 text-muted-foreground text-sm h-full">
        Loading...
      </div>
    );
  }

  const ecoStatusVariants: Record<string, string> = {
    DRAFT: "muted", SUBMITTED: "info", IN_REVIEW: "warning",
    APPROVED: "success", REJECTED: "error", IMPLEMENTED: "purple", CLOSED: "muted",
  };
  const changeTypeVariants: Record<string, { label: string; variant: string }> = {
    ADD: { label: "Add", variant: "info" },
    MODIFY: { label: "Modify", variant: "warning" },
    REMOVE: { label: "Remove", variant: "error" },
  };

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

  // --- Sidebar content (properties / versions / relations) ---
  const sidebarContent = (
    <Tabs defaultValue="properties" className="flex flex-col min-h-0 h-full">
      <TabsList className="w-full shrink-0">
        <TabsTrigger value="properties" className="flex-1 text-xs">Properties</TabsTrigger>
        <TabsTrigger value="versions" className="flex-1 text-xs">Versions</TabsTrigger>
        <TabsTrigger value="relations" className="flex-1 text-xs">Relations</TabsTrigger>
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
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="PART">Part</SelectItem>
                  <SelectItem value="ASSEMBLY">Assembly</SelectItem>
                  <SelectItem value="DRAWING">Drawing</SelectItem>
                  <SelectItem value="DOCUMENT">Document</SelectItem>
                  <SelectItem value="OTHER">Other</SelectItem>
                </SelectContent>
              </Select>
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

          {whereUsed.length > 0 && (
            <>
              <Separator />
              <p className="text-xs font-semibold text-muted-foreground uppercase">Used in BOMs</p>
              <div className="space-y-1.5">
                {whereUsed.map((wu) => (
                  <Link key={wu.bomId} href="/boms" className="flex items-center justify-between text-sm p-2 rounded-md hover:bg-muted/50 transition-colors">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Package className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        <span className="font-medium truncate">{wu.bomName}</span>
                      </div>
                      <p className="text-xs text-muted-foreground ml-5">
                        Item {wu.itemNumber}: {wu.itemName} &times; {wu.quantity} {wu.unit}
                      </p>
                    </div>
                    <span className="text-[10px] text-muted-foreground shrink-0">Rev {wu.bomRevision}</span>
                  </Link>
                ))}
              </div>
            </>
          )}

          {linkedEcos.length > 0 && (
            <>
              <Separator />
              <p className="text-xs font-semibold text-muted-foreground uppercase">Referenced in ECOs</p>
              <div className="space-y-1.5">
                {linkedEcos.map((item) => {
                  const eco = item.eco;
                  const ct = changeTypeVariants[item.changeType] || { label: item.changeType, variant: "muted" };
                  return (
                    <Link key={item.id} href="/ecos" className="flex items-center justify-between text-sm p-2 rounded-md hover:bg-muted/50 transition-colors">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <ClipboardList className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                          <span className="font-medium truncate">{eco.ecoNumber} &mdash; {eco.title}</span>
                        </div>
                        <div className="flex items-center gap-1.5 ml-5 mt-0.5">
                          <Badge variant={(ecoStatusVariants[eco.status] || "muted") as "muted" | "info" | "warning" | "success" | "error" | "purple"} className="text-[10px] px-1.5 py-0">
                            {eco.status}
                          </Badge>
                          <Badge variant={ct.variant as "muted" | "info" | "warning" | "error"} className="text-[10px] px-1.5 py-0">
                            {ct.label}
                          </Badge>
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </TabsContent>

      <TabsContent value="versions" className="flex-1 overflow-auto mt-2">
        <div className="space-y-3">
          {file.versions.map((v) => {
            const isCurrent = v.version === file.currentVersion;
            return (
              <div key={v.id} className={`border rounded p-3 text-sm space-y-1 ${isCurrent ? "border-primary/30 bg-primary/5" : ""}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">Version {v.version}</span>
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
                {v.comment && <p className="text-muted-foreground italic">&ldquo;{v.comment}&rdquo;</p>}
              </div>
            );
          })}
        </div>
      </TabsContent>

      <TabsContent value="relations" className="flex-1 overflow-auto mt-2 space-y-4">
        {file.references.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Contains / References</p>
            {file.references.map((ref) => (
              <div key={ref.targetFile.id} className="text-sm py-1 border-b last:border-0">
                {ref.targetFile.name}
                {ref.targetFile.partNumber && <span className="text-muted-foreground ml-2">({ref.targetFile.partNumber})</span>}
              </div>
            ))}
          </div>
        )}
        {file.referencedBy.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Where Used</p>
            {file.referencedBy.map((ref) => (
              <div key={ref.sourceFile.id} className="text-sm py-1 border-b last:border-0">
                {ref.sourceFile.name}
                {ref.sourceFile.partNumber && <span className="text-muted-foreground ml-2">({ref.sourceFile.partNumber})</span>}
              </div>
            ))}
          </div>
        )}
        {file.references.length === 0 && file.referencedBy.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">No file references yet.</p>
        )}
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
            <FilePreview fileId={fileId} className="h-full" />
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
          <FilePreview fileId={fileId} className="min-h-[50vh]" />
        </TabsContent>
        <TabsContent value="details" className="flex-1 overflow-auto p-4 mt-0">
          {sidebarContent}
        </TabsContent>
      </Tabs>
    </div>
  );
}
