"use client";

import { useState, useRef, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Upload, Search, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useTenantUser } from "@/components/providers/tenant-provider";

interface DuplicateFileInfo {
  id: string;
  name: string;
  currentVersion: number;
  isCheckedOut: boolean;
  checkedOutById: string | null;
  isFrozen: boolean;
  lifecycleState: string;
}

export function UploadFileDialog({
  open,
  onOpenChange,
  folderId,
  onUploaded,
  initialFile,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderId: string;
  onUploaded: () => void;
  initialFile?: File | null;
}) {
  const user = useTenantUser();
  const isAdmin = user.permissions.includes("*");
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [partNumber, setPartNumber] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [lifecycleState, setLifecycleState] = useState("");
  const [lifecycleStates, setLifecycleStates] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [linkToPart, setLinkToPart] = useState(false);
  const [linkMode, setLinkMode] = useState<"existing" | "new">("existing");
  const [partSearchQuery, setPartSearchQuery] = useState("");
  const [partSearchResults, setPartSearchResults] = useState<{id: string; partNumber: string; name: string}[]>([]);
  const [selectedPart, setSelectedPart] = useState<{id: string; partNumber: string; name: string} | null>(null);
  const [newPartNumber, setNewPartNumber] = useState("");
  const [newPartName, setNewPartName] = useState("");
  const [fileRole, setFileRole] = useState("DRAWING");
  const [duplicateFile, setDuplicateFile] = useState<DuplicateFileInfo | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && initialFile) {
      queueMicrotask(() => setFile(initialFile));
    }
  }, [open, initialFile]);

  useEffect(() => {
    if (open && isAdmin && lifecycleStates.length === 0) {
      fetch("/api/lifecycle")
        .then((r) => r.ok ? r.json() : [])
        .then((lifecycles) => {
          if (Array.isArray(lifecycles) && lifecycles.length > 0) {
            const defaultLc = lifecycles.find((lc: { isDefault: boolean }) => lc.isDefault) || lifecycles[0];
            if (defaultLc?.states) {
              setLifecycleStates(defaultLc.states.map((s: { id: string; name: string }) => ({ id: s.id, name: s.name })));
            }
          }
        })
        .catch(() => {});
    }
  }, [open, isAdmin, lifecycleStates.length]);

  // Debounced part search. The clear-on-empty branch runs through a
  // microtask (queueMicrotask) so the effect body never calls setState
  // synchronously, satisfying react-hooks/set-state-in-effect.
  useEffect(() => {
    const shouldClear = !linkToPart || linkMode !== "existing" || partSearchQuery.length < 2;
    if (shouldClear) {
      queueMicrotask(() => setPartSearchResults([]));
      return;
    }
    const timeout = setTimeout(() => {
      fetch(`/api/parts?q=${encodeURIComponent(partSearchQuery)}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((d) => setPartSearchResults(Array.isArray(d) ? d.slice(0, 8) : []))
        .catch(() => setPartSearchResults([]));
    }, 300);
    return () => clearTimeout(timeout);
  }, [partSearchQuery, linkToPart, linkMode]);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;

    setLoading(true);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("folderId", folderId);
      if (partNumber) formData.append("partNumber", partNumber);
      if (description) formData.append("description", description);
      if (category) formData.append("category", category);
      if (lifecycleState) formData.append("lifecycleState", lifecycleState);

      const res = await fetch("/api/files", {
        method: "POST",
        body: formData,
      });

      const fileData = await res.json();

      if (!res.ok) {
        if (res.status === 409 && fileData.code === "DUPLICATE_FILE" && fileData.existingFile) {
          setDuplicateFile(fileData.existingFile);
          setLoading(false);
          return;
        }
        toast.error(fileData.error || "Failed to upload file");
        setLoading(false);
        return;
      }

      // Link to part if requested
      if (linkToPart && linkMode === "existing" && selectedPart) {
        await fetch(`/api/parts/${selectedPart.id}/files`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileId: fileData.id, role: fileRole, isPrimary: true }),
        });
        toast.success(`File uploaded and linked to ${selectedPart.partNumber}`);
      } else if (linkToPart && linkMode === "new" && newPartNumber && newPartName) {
        const partRes = await fetch("/api/parts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ partNumber: newPartNumber, name: newPartName }),
        });
        if (partRes.ok) {
          const part = await partRes.json();
          await fetch(`/api/parts/${part.id}/files`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileId: fileData.id, role: fileRole, isPrimary: true }),
          });
          toast.success(`File uploaded, part ${newPartNumber} created and linked`);
        } else {
          toast.success("File uploaded but failed to create part");
        }
      } else {
        toast.success("File uploaded successfully");
      }

      // Surface thumbnail extraction warnings so users know to upload manually
      if (fileData.warnings?.length) {
        for (const w of fileData.warnings) {
          toast.warning(w);
        }
      }

      resetForm();
      onOpenChange(false);
      onUploaded();
    } catch {
      toast.error("Failed to upload file");
    }
    setLoading(false);
  }

  async function handleVersionBump() {
    if (!file || !duplicateFile) return;
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("comment", `New version uploaded (replaced duplicate)`);

      const res = await fetch(`/api/files/${duplicateFile.id}/upload-version`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || "Failed to upload new version");
        setLoading(false);
        return;
      }

      toast.success(`Uploaded as version ${data.version} of "${duplicateFile.name}"`);
      if (data.warnings?.length) {
        for (const w of data.warnings) toast.warning(w);
      }
      resetForm();
      onOpenChange(false);
      onUploaded();
    } catch {
      toast.error("Failed to upload new version");
    }
    setLoading(false);
  }

  function resetForm() {
    setFile(null);
    setPartNumber("");
    setDescription("");
    setCategory("");
    setLifecycleState("");
    setLinkToPart(false);
    setLinkMode("existing");
    setPartSearchQuery("");
    setPartSearchResults([]);
    setSelectedPart(null);
    setNewPartNumber("");
    setNewPartName("");
    setFileRole("DRAWING");
    setDuplicateFile(null);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload File</DialogTitle>
        </DialogHeader>
        {duplicateFile ? (
          <div className="space-y-4 py-4">
            <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
              <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  &ldquo;{duplicateFile.name}&rdquo; already exists in this folder
                </p>
                <p className="text-sm text-muted-foreground">
                  Current version: {duplicateFile.currentVersion} &middot; State: {duplicateFile.lifecycleState}
                </p>
              </div>
            </div>

            {duplicateFile.isFrozen ? (
              <p className="text-sm text-muted-foreground">
                This file is released/frozen and cannot accept new versions. Revise it first from the file detail panel.
              </p>
            ) : duplicateFile.isCheckedOut && duplicateFile.checkedOutById !== user.id ? (
              <p className="text-sm text-muted-foreground">
                This file is checked out by another user and cannot accept new versions until checked in.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Upload your file as version {duplicateFile.currentVersion + 1}?
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDuplicateFile(null)}>
                Back
              </Button>
              <Button type="button" variant="outline" onClick={() => { resetForm(); onOpenChange(false); }}>
                Cancel
              </Button>
              {!duplicateFile.isFrozen && !(duplicateFile.isCheckedOut && duplicateFile.checkedOutById !== user.id) && (
                <Button type="button" disabled={loading} onClick={handleVersionBump}>
                  {loading ? "Uploading..." : `Upload as Version ${duplicateFile.currentVersion + 1}`}
                </Button>
              )}
            </DialogFooter>
          </div>
        ) : (
        <form onSubmit={handleUpload}>
          <div className="space-y-4 py-4">
            <div
              className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${isDragging ? "border-primary bg-primary/5" : "hover:border-primary/50"}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); }}
              onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); }}
              onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDragging(false);
                const dropped = e.dataTransfer.files?.[0];
                if (dropped) setFile(dropped);
              }}
            >
              {file ? (
                <div>
                  <p className="font-medium">{file.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {(file.size / 1048576).toFixed(2)} MB
                  </p>
                </div>
              ) : (
                <div>
                  <Upload className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">
                    {isDragging ? "Drop file here" : "Drag a file here, or click to browse"}
                  </p>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="partNumber">Part Number (optional)</Label>
              <Input
                id="partNumber"
                value={partNumber}
                onChange={(e) => setPartNumber(e.target.value)}
                placeholder="e.g., PACE-1001"
              />
            </div>

            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder="Auto-detect from extension">
                    {(v) => ({ PART: "Part", ASSEMBLY: "Assembly", DRAWING: "Drawing PDF", DRAWING_2D: "2D Drawing", MODEL_3D: "3D Model", DOCUMENT: "Document", SIMULATION: "Simulation", FIRMWARE: "Firmware", SOFTWARE: "Software", PURCHASED: "Purchased Part", OTHER: "Other" } as Record<string, string>)[v as string] ?? "Auto-detect from extension"}
                  </SelectValue>
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

            <div className="space-y-2">
              <Label htmlFor="description">Description (optional)</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Brief description of this file"
                rows={2}
              />
            </div>

            {isAdmin && lifecycleStates.length > 0 && (
              <div className="space-y-2">
                <Label>Initial State</Label>
                <Select value={lifecycleState} onValueChange={(v) => setLifecycleState(v ?? "")}>
                  <SelectTrigger><SelectValue placeholder="Default (WIP)" /></SelectTrigger>
                  <SelectContent>
                    {lifecycleStates.map((s) => (
                      <SelectItem key={s.id} value={s.name}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">Override the initial lifecycle state for this file.</p>
              </div>
            )}

            {/* Link to Part section */}
            <div className="border-t pt-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={linkToPart}
                  onCheckedChange={(v) => setLinkToPart(!!v)}
                />
                <span className="text-sm font-medium">Link this file to a part</span>
                <span className="text-xs text-muted-foreground">(optional)</span>
              </label>

              {linkToPart && (
                <div className="mt-3 space-y-3 pl-6">
                  {/* Mode toggle */}
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant={linkMode === "existing" ? "default" : "outline"}
                      onClick={() => setLinkMode("existing")}
                      className="text-xs h-7"
                    >
                      Existing Part
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={linkMode === "new" ? "default" : "outline"}
                      onClick={() => setLinkMode("new")}
                      className="text-xs h-7"
                    >
                      New Part
                    </Button>
                  </div>

                  {linkMode === "existing" ? (
                    <div className="space-y-2">
                      <div className="relative">
                        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input
                          placeholder="Search parts by number or name..."
                          value={partSearchQuery}
                          onChange={(e) => {
                            setPartSearchQuery(e.target.value);
                            setSelectedPart(null);
                          }}
                          className="pl-9"
                        />
                      </div>
                      {selectedPart && (
                        <div className="flex items-center gap-2 text-sm bg-muted rounded px-2 py-1.5">
                          <span className="font-medium">{selectedPart.partNumber}</span>
                          <span className="text-muted-foreground">{selectedPart.name}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="ml-auto h-5 w-5 p-0 text-muted-foreground"
                            onClick={() => {
                              setSelectedPart(null);
                              setPartSearchQuery("");
                            }}
                          >
                            &times;
                          </Button>
                        </div>
                      )}
                      {!selectedPart && partSearchResults.length > 0 && (
                        <div className="border rounded-md max-h-40 overflow-y-auto">
                          {partSearchResults.map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors flex items-center gap-2"
                              onClick={() => {
                                setSelectedPart(p);
                                setPartSearchQuery(p.partNumber);
                                setPartSearchResults([]);
                              }}
                            >
                              <span className="font-medium">{p.partNumber}</span>
                              <span className="text-muted-foreground">{p.name}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="space-y-1">
                        <Label htmlFor="newPartNumber">Part Number</Label>
                        <Input
                          id="newPartNumber"
                          value={newPartNumber}
                          onChange={(e) => setNewPartNumber(e.target.value)}
                          placeholder="e.g., PACE-2001"
                          required={linkToPart && linkMode === "new"}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="newPartName">Part Name</Label>
                        <Input
                          id="newPartName"
                          value={newPartName}
                          onChange={(e) => setNewPartName(e.target.value)}
                          placeholder="e.g., Main Housing"
                          required={linkToPart && linkMode === "new"}
                        />
                      </div>
                    </div>
                  )}

                  {/* File role select */}
                  <div className="space-y-1">
                    <Label>File Role</Label>
                    <Select value={fileRole} onValueChange={(v) => setFileRole(v ?? "DRAWING")}>
                      <SelectTrigger>
                        <SelectValue>{(v) => ({ DRAWING: "Drawing", MODEL_3D: "3D Model", SPEC_SHEET: "Spec Sheet", DATASHEET: "Datasheet", OTHER: "Other" } as Record<string, string>)[v as string] ?? ""}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="DRAWING">Drawing</SelectItem>
                        <SelectItem value="MODEL_3D">3D Model</SelectItem>
                        <SelectItem value="SPEC_SHEET">Spec Sheet</SelectItem>
                        <SelectItem value="DATASHEET">Datasheet</SelectItem>
                        <SelectItem value="OTHER">Other</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading || !file}>
              {loading ? "Uploading..." : "Upload"}
            </Button>
          </DialogFooter>
        </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
