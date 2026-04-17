"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Upload, Search, X, FileText, ImageIcon, Loader2,
} from "lucide-react";
import { toast } from "sonner";
import type { Part } from "../parts-types";
import { CATEGORIES, FILE_ROLE_LABELS } from "../parts-types";

function useDebounce<T extends (...args: Parameters<T>) => void>(fn: T, delay: number): T {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return useCallback((...args: Parameters<T>) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => fn(...args), delay);
  }, [fn, delay]) as T;
}

interface PartFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingPart: Part | null;
  partNumberMode: "AUTO" | "MANUAL";
  onSaved: () => void;
}

export function PartFormDialog({
  open,
  onOpenChange,
  editingPart,
  partNumberMode,
  onSaved,
}: PartFormDialogProps) {
  const [formData, setFormData] = useState({
    partNumber: "", name: "", description: "", category: "MANUFACTURED",
    material: "", unitCost: "", unit: "EA", notes: "",
  });
  const [saving, setSaving] = useState(false);

  // Thumbnail state
  const dialogThumbnailRef = useRef<HTMLInputElement>(null);
  const [dialogThumbnailFile, setDialogThumbnailFile] = useState<File | null>(null);
  const [dialogThumbnailPreview, setDialogThumbnailPreview] = useState<string | null>(null);
  const [dialogThumbnailExistingUrl, setDialogThumbnailExistingUrl] = useState<string | null>(null);
  const [dialogThumbnailRemoved, setDialogThumbnailRemoved] = useState(false);

  // Attach file on part create
  const [attachFile, setAttachFile] = useState<File | null>(null);
  const [attachFileRole, setAttachFileRole] = useState("DRAWING");
  const attachFileRef = useRef<HTMLInputElement>(null);
  const [attachMode, setAttachMode] = useState<"upload" | "link">("upload");
  const [attachLinkFileId, setAttachLinkFileId] = useState<string | null>(null);
  const [attachLinkFileName, setAttachLinkFileName] = useState<string>("");
  const [attachLinkSearch, setAttachLinkSearch] = useState("");
  const [attachLinkResults, setAttachLinkResults] = useState<{ id: string; name: string; partNumber: string | null }[]>([]);
  const [attachLinkSearching, setAttachLinkSearching] = useState(false);

  const resetThumbnail = useCallback(() => {
    setDialogThumbnailFile(null);
    setDialogThumbnailPreview((prev) => {
      if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
      return null;
    });
    setDialogThumbnailExistingUrl(null);
    setDialogThumbnailRemoved(false);
  }, []);

  // Populate form when dialog opens. queueMicrotask avoids synchronous
  // setState inside an effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      if (editingPart) {
        setFormData({
          partNumber: editingPart.partNumber, name: editingPart.name, description: editingPart.description || "",
          category: editingPart.category, material: editingPart.material || "",
          unitCost: editingPart.unitCost != null ? String(editingPart.unitCost) : "", unit: editingPart.unit, notes: editingPart.notes || "",
        });
        setDialogThumbnailExistingUrl(editingPart.thumbnailUrl || null);
      } else {
        setFormData({ partNumber: "", name: "", description: "", category: "MANUFACTURED", material: "", unitCost: "", unit: "EA", notes: "" });
        resetThumbnail();
      }
    });
  }, [open, editingPart, resetThumbnail]);

  function resetAttach() {
    setAttachFile(null);
    setAttachFileRole("DRAWING");
    setAttachMode("upload");
    setAttachLinkFileId(null);
    setAttachLinkFileName("");
    setAttachLinkSearch("");
    setAttachLinkResults([]);
  }

  const doAttachLinkSearch = useCallback(async (q: string) => {
    if (q.length < 2) { setAttachLinkResults([]); setAttachLinkSearching(false); return; }
    setAttachLinkSearching(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      const files = Array.isArray(data) ? data : (data.files ?? []);
      setAttachLinkResults(files.slice(0, 8));
    } catch { setAttachLinkResults([]); }
    setAttachLinkSearching(false);
  }, []);

  const debouncedAttachLinkSearch = useDebounce(doAttachLinkSearch, 300);

  function handleThumbnailPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (dialogThumbnailPreview?.startsWith("blob:")) {
      URL.revokeObjectURL(dialogThumbnailPreview);
    }
    setDialogThumbnailFile(file);
    setDialogThumbnailPreview(URL.createObjectURL(file));
    setDialogThumbnailRemoved(false);
  }

  function handleThumbnailRemove() {
    if (dialogThumbnailPreview?.startsWith("blob:")) {
      URL.revokeObjectURL(dialogThumbnailPreview);
    }
    setDialogThumbnailFile(null);
    setDialogThumbnailPreview(null);
    setDialogThumbnailExistingUrl(null);
    setDialogThumbnailRemoved(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);

    const payload: Record<string, unknown> = {
      ...formData,
      unitCost: formData.unitCost ? parseFloat(formData.unitCost) : null,
      description: formData.description || null,
      material: formData.material || null,
      notes: formData.notes || null,
    };
    if (!editingPart && partNumberMode === "AUTO" && !formData.partNumber.trim()) {
      delete payload.partNumber;
    }

    const url = editingPart ? `/api/parts/${editingPart.id}` : "/api/parts";
    const method = editingPart ? "PUT" : "POST";

    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); setSaving(false); return; }

    const partData = await res.json();

    // Thumbnail mutations
    if (dialogThumbnailFile) {
      try {
        const fd = new FormData();
        fd.append("file", dialogThumbnailFile);
        const tRes = await fetch(`/api/parts/${partData.id}/thumbnail`, { method: "POST", body: fd });
        if (!tRes.ok) {
          const d = await tRes.json().catch(() => ({}));
          toast.error(d.error || "Thumbnail upload failed");
        }
      } catch {
        toast.error("Thumbnail upload failed");
      }
    } else if (editingPart && dialogThumbnailRemoved) {
      try {
        await fetch(`/api/parts/${partData.id}/thumbnail`, { method: "DELETE" });
      } catch { /* non-fatal */ }
    }

    // Attach file on create
    if (!editingPart && attachFile) {
      try {
        const folderRes = await fetch("/api/folders");
        const folders = await folderRes.json();
        const rootFolder = Array.isArray(folders) ? folders[0] : null;
        if (rootFolder) {
          const fd = new FormData();
          fd.append("file", attachFile);
          fd.append("folderId", rootFolder.id);
          fd.append("partNumber", partData.partNumber);
          if (typeof payload.description === "string") fd.append("description", payload.description);
          const fileRes = await fetch("/api/files", { method: "POST", body: fd });
          if (fileRes.ok) {
            const fileData = await fileRes.json();
            await fetch(`/api/parts/${partData.id}/files`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ fileId: fileData.id, role: attachFileRole, isPrimary: true }),
            });
            toast.success("Part created with file attached");
          } else {
            toast.success("Part created, but file upload failed");
          }
        }
      } catch {
        toast.success("Part created, but file attachment failed");
      }
    } else if (!editingPart && attachLinkFileId) {
      try {
        const linkRes = await fetch(`/api/parts/${partData.id}/files`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileId: attachLinkFileId, role: attachFileRole, isPrimary: true }),
        });
        toast.success(linkRes.ok ? "Part created with file linked" : "Part created, but file linking failed");
      } catch {
        toast.success("Part created, but file linking failed");
      }
    } else {
      toast.success(editingPart ? "Part updated" : "Part created");
    }

    resetThumbnail();
    resetAttach();
    setSaving(false);
    onOpenChange(false);
    onSaved();
  }

  const previewSrc = dialogThumbnailPreview || dialogThumbnailExistingUrl;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { resetThumbnail(); resetAttach(); onOpenChange(false); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editingPart ? "Edit Part" : "New Part"}</DialogTitle>
          <DialogDescription>
            {editingPart ? "Update this part's properties." : "Add a new part to your library."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSave}>
          <div className="space-y-4 py-4">
            {/* Thumbnail */}
            <div className="flex items-start gap-3">
              <label className="cursor-pointer shrink-0 group relative">
                {previewSrc ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previewSrc} alt="" className="w-16 h-16 rounded-lg object-cover border" />
                ) : (
                  <div className="w-16 h-16 rounded-lg bg-muted border border-dashed flex items-center justify-center">
                    <ImageIcon className="w-5 h-5 text-muted-foreground/40" />
                  </div>
                )}
                <div className="absolute inset-0 bg-black/50 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <Upload className="w-4 h-4 text-white" />
                </div>
                <input ref={dialogThumbnailRef} type="file" accept="image/*" className="hidden" onChange={handleThumbnailPick} />
              </label>
              <div className="flex-1 min-w-0 space-y-1">
                <Label className="text-xs">Thumbnail</Label>
                <p className="text-[11px] text-muted-foreground">Click the image to {previewSrc ? "replace" : "upload"}. Stored in Supabase Storage on save.</p>
                {previewSrc && (
                  <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={handleThumbnailRemove}>
                    Remove
                  </Button>
                )}
              </div>
            </div>

            {/* Core fields */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">
                  Part Number
                  {!editingPart && partNumberMode === "AUTO" && (
                    <span className="ml-1 text-muted-foreground font-normal">(optional)</span>
                  )}
                </Label>
                <Input
                  value={formData.partNumber}
                  onChange={(e) => setFormData({ ...formData, partNumber: e.target.value })}
                  placeholder={!editingPart && partNumberMode === "AUTO" ? "Auto-generated" : "PACE-1001"}
                  className="h-8 text-sm"
                  required={editingPart != null || partNumberMode === "MANUAL"}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Category</Label>
                <Select value={formData.category} onValueChange={(v) => setFormData({ ...formData, category: v ?? "MANUFACTURED" })}>
                  <SelectTrigger className="h-8 text-sm">
                    <SelectValue>{(v) => CATEGORIES.find((c) => c.value === v)?.label ?? ""}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Name</Label>
              <Input value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="Motor Housing" className="h-8 text-sm" required />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Description</Label>
              <Textarea value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} placeholder="Optional description..." className="text-sm" rows={2} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Material</Label>
                <Input value={formData.material} onChange={(e) => setFormData({ ...formData, material: e.target.value })} placeholder="304 SS" className="h-8 text-sm" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Unit Cost ($)</Label>
                <Input type="number" value={formData.unitCost} onChange={(e) => setFormData({ ...formData, unitCost: e.target.value })} placeholder="0.00" className="h-8 text-sm" min="0" step="0.01" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Unit</Label>
                <Input value={formData.unit} onChange={(e) => setFormData({ ...formData, unit: e.target.value })} placeholder="EA" className="h-8 text-sm" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Notes</Label>
              <Textarea value={formData.notes} onChange={(e) => setFormData({ ...formData, notes: e.target.value })} placeholder="Internal notes..." className="text-sm" rows={2} />
            </div>

            {/* Attach file on create */}
            {!editingPart && (
              <>
                <Separator />
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-semibold text-muted-foreground uppercase">Attach File (optional)</Label>
                    <div className="flex rounded-md border overflow-hidden text-xs">
                      <button
                        type="button"
                        onClick={() => { setAttachMode("upload"); setAttachLinkFileId(null); setAttachLinkFileName(""); setAttachLinkSearch(""); setAttachLinkResults([]); }}
                        className={`px-2 py-1 transition-colors ${attachMode === "upload" ? "bg-primary text-primary-foreground" : "hover:bg-muted/50"}`}
                      >
                        Upload
                      </button>
                      <button
                        type="button"
                        onClick={() => { setAttachMode("link"); setAttachFile(null); }}
                        className={`px-2 py-1 transition-colors ${attachMode === "link" ? "bg-primary text-primary-foreground" : "hover:bg-muted/50"}`}
                      >
                        Link from Vault
                      </button>
                    </div>
                  </div>

                  {attachMode === "upload" ? (
                    <>
                      {attachFile ? (
                        <div className="flex items-center gap-2 border rounded-lg p-2.5">
                          <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium truncate">{attachFile.name}</p>
                            <p className="text-xs text-muted-foreground">{(attachFile.size / 1048576).toFixed(2)} MB</p>
                          </div>
                          <Select value={attachFileRole} onValueChange={(v) => setAttachFileRole(v ?? "DRAWING")}>
                            <SelectTrigger className="h-7 text-xs w-28">
                              <SelectValue>{(v) => FILE_ROLE_LABELS[v as string] ?? ""}</SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="DRAWING">Drawing</SelectItem>
                              <SelectItem value="MODEL_3D">3D Model</SelectItem>
                              <SelectItem value="SPEC_SHEET">Spec Sheet</SelectItem>
                              <SelectItem value="DATASHEET">Datasheet</SelectItem>
                              <SelectItem value="OTHER">Other</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={() => setAttachFile(null)}>
                            <X className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <div
                          className="border-2 border-dashed rounded-lg p-4 text-center cursor-pointer hover:border-primary/50 transition-colors"
                          onClick={() => attachFileRef.current?.click()}
                        >
                          <Upload className="w-5 h-5 mx-auto text-muted-foreground mb-1" />
                          <p className="text-xs text-muted-foreground">Click to attach a file from your computer</p>
                          <p className="text-[10px] text-muted-foreground/60 mt-0.5">Uploads to vault root and links to this part</p>
                        </div>
                      )}
                      <input ref={attachFileRef} type="file" className="hidden" onChange={(e) => setAttachFile(e.target.files?.[0] || null)} />
                    </>
                  ) : (
                    <div>
                      {attachLinkFileId ? (
                        <div className="flex items-center gap-2 border rounded-lg p-2.5">
                          <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                          <p className="text-sm font-medium truncate flex-1">{attachLinkFileName}</p>
                          <Select value={attachFileRole} onValueChange={(v) => setAttachFileRole(v ?? "DRAWING")}>
                            <SelectTrigger className="h-7 text-xs w-28">
                              <SelectValue>{(v) => FILE_ROLE_LABELS[v as string] ?? ""}</SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="DRAWING">Drawing</SelectItem>
                              <SelectItem value="MODEL_3D">3D Model</SelectItem>
                              <SelectItem value="SPEC_SHEET">Spec Sheet</SelectItem>
                              <SelectItem value="DATASHEET">Datasheet</SelectItem>
                              <SelectItem value="OTHER">Other</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0" onClick={() => { setAttachLinkFileId(null); setAttachLinkFileName(""); }}>
                            <X className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <div className="space-y-1.5">
                          <div className="relative">
                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                            <Input
                              value={attachLinkSearch}
                              onChange={(e) => { setAttachLinkSearch(e.target.value); debouncedAttachLinkSearch(e.target.value); }}
                              placeholder="Search vault files..."
                              className="pl-8 h-8 text-sm"
                            />
                          </div>
                          {attachLinkSearching && (
                            <div className="flex items-center justify-center py-3 border rounded-lg bg-muted/20">
                              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                            </div>
                          )}
                          {!attachLinkSearching && attachLinkResults.length > 0 && (
                            <div className="border rounded-lg max-h-40 overflow-y-auto bg-background">
                              {attachLinkResults.map((f) => (
                                <button
                                  key={f.id}
                                  type="button"
                                  className="w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors flex items-center gap-2"
                                  onClick={() => { setAttachLinkFileId(f.id); setAttachLinkFileName(f.name); setAttachLinkSearch(""); setAttachLinkResults([]); }}
                                >
                                  <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                                  <span className="truncate flex-1">{f.name}</span>
                                  {f.partNumber && <span className="text-xs text-muted-foreground shrink-0">{f.partNumber}</span>}
                                </button>
                              ))}
                            </div>
                          )}
                          {attachLinkSearch.length >= 2 && !attachLinkSearching && attachLinkResults.length === 0 && (
                            <p className="text-xs text-muted-foreground text-center py-2">No files found</p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              type="submit"
              disabled={
                saving ||
                !formData.name.trim() ||
                ((editingPart != null || partNumberMode === "MANUAL") && !formData.partNumber.trim())
              }
            >
              {saving ? "Saving..." : editingPart ? "Save Changes" : "Create Part"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
