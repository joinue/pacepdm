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
  CATEGORY_LABELS,
  FILE_CATEGORIES,
  categoryForFilename,
  isCategoryPlausible,
  type FileCategory,
} from "@/lib/file-categories";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Upload, Search, AlertTriangle, Box } from "lucide-react";
import { toast } from "sonner";
import { useTenantUser } from "@/components/providers/tenant-provider";
import { errorMessage, fetchJson, isAbortError } from "@/lib/api-client";
import { readDroppedFiles, type DroppedFile } from "@/lib/dropped-files";
import {
  duplicateOf,
  formatBytes,
  uploadNewFile,
  uploadNewVersion,
  type DuplicateFileInfo,
} from "@/lib/vault-upload-client";
import { needsNeutralExport } from "./vault-types";
import { UploadQueue } from "./upload-queue";

export function UploadFileDialog({
  open,
  onOpenChange,
  folderId,
  onUploaded,
  initialItems,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderId: string;
  onUploaded: () => void;
  /** Files dropped onto the vault, loose or from folders, to start with. */
  initialItems?: DroppedFile[] | null;
}) {
  const user = useTenantUser();
  const isAdmin = user.permissions.includes("*");
  const [items, setItems] = useState<DroppedFile[]>([]);
  // One loose file gets the full form. Several files, or anything from a
  // dropped folder, go through the queue.
  const file = items.length === 1 && items[0].dir.length === 0 ? items[0].file : null;
  const isQueue = items.length > 1 || (items.length === 1 && items[0].dir.length > 0);
  const [progress, setProgress] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
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
  const [partSearchResults, setPartSearchResults] = useState<
    { id: string; partNumber: string; name: string }[]
  >([]);
  const [selectedPart, setSelectedPart] = useState<{
    id: string;
    partNumber: string;
    name: string;
  } | null>(null);
  const [newPartNumber, setNewPartNumber] = useState("");
  const [newPartName, setNewPartName] = useState("");
  const [fileRole, setFileRole] = useState("DRAWING");
  const [duplicateFile, setDuplicateFile] = useState<DuplicateFileInfo | null>(null);

  // What the server will choose if the uploader leaves Category alone. Shown
  // in the dropdown so auto-detect is visible rather than a mystery, and used
  // to warn when a manual choice contradicts the file's own extension.
  const derivedCategory = file ? categoryForFilename(file.name) : null;
  const autoDetectPlaceholder = derivedCategory
    ? `Auto-detect: ${CATEGORY_LABELS[derivedCategory]}`
    : "Auto-detect from extension";
  const categoryConflictsWithExtension =
    !!file && !!category && !isCategoryPlausible(file.name, category);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && initialItems?.length) {
      queueMicrotask(() => setItems(initialItems));
    }
  }, [open, initialItems]);

  useEffect(() => {
    if (open && isAdmin && lifecycleStates.length === 0) {
      fetch("/api/lifecycle")
        .then((r) => (r.ok ? r.json() : []))
        .then((lifecycles) => {
          if (Array.isArray(lifecycles) && lifecycles.length > 0) {
            const defaultLc =
              lifecycles.find((lc: { isDefault: boolean }) => lc.isDefault) || lifecycles[0];
            if (defaultLc?.states) {
              setLifecycleStates(
                defaultLc.states.map((s: { id: string; name: string }) => ({
                  id: s.id,
                  name: s.name,
                }))
              );
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
    // A part typed into the search but never picked used to upload with no
    // link and no warning.
    if (linkToPart && linkMode === "existing" && !selectedPart) {
      toast.error(
        "Pick a part from the search results, or untick \u201cLink this file to a part\u201d."
      );
      return;
    }

    setLoading(true);
    setProgress(0);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const created = await uploadNewFile<{ id: string }>(
        folderId,
        file,
        {
          partNumber: partNumber || undefined,
          description: description || undefined,
          category: category || undefined,
          lifecycleState: lifecycleState || undefined,
        },
        {
          onProgress: ({ loaded, total }) => setProgress(total > 0 ? loaded / total : 0),
          signal: abort.signal,
        }
      );
      await linkUploadedFile(created.id);
      resetForm();
      onOpenChange(false);
      onUploaded();
    } catch (err) {
      const existing = duplicateOf(err);
      if (existing) {
        setDuplicateFile(existing);
      } else if (!isAbortError(err)) {
        toast.error(errorMessage(err));
      }
    } finally {
      abortRef.current = null;
      setLoading(false);
      setProgress(null);
    }
  }

  /**
   * Link the uploaded file to a part. The upload has already succeeded, so a
   * failure here is a warning naming what did not happen — it used to report
   * "linked" whether or not the link worked.
   */
  async function linkUploadedFile(fileId: string) {
    if (!linkToPart) {
      toast.success("File uploaded");
      return;
    }
    try {
      let part = selectedPart;
      if (linkMode === "new") {
        part = await fetchJson<{ id: string; partNumber: string; name: string }>("/api/parts", {
          method: "POST",
          body: { partNumber: newPartNumber, name: newPartName },
        });
      }
      if (!part) return;
      await fetchJson(`/api/parts/${part.id}/files`, {
        method: "POST",
        body: { fileId, role: fileRole, isPrimary: true },
      });
      toast.success(
        linkMode === "new"
          ? `File uploaded, part ${part.partNumber} created and linked`
          : `File uploaded and linked to ${part.partNumber}`
      );
    } catch (err) {
      toast.warning(`File uploaded, but it was not linked to a part: ${errorMessage(err)}`);
    }
  }

  async function handleVersionBump() {
    if (!file || !duplicateFile) return;
    setLoading(true);
    setProgress(0);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const data = await uploadNewVersion(
        duplicateFile.id,
        file,
        "version",
        "New version uploaded (replaced duplicate)",
        {
          onProgress: ({ loaded, total }) => setProgress(total > 0 ? loaded / total : 0),
          signal: abort.signal,
        }
      );
      toast.success(`Uploaded as version ${data.version} of "${duplicateFile.name}"`);
      resetForm();
      onOpenChange(false);
      onUploaded();
    } catch (err) {
      if (!isAbortError(err)) toast.error(errorMessage(err));
    } finally {
      abortRef.current = null;
      setLoading(false);
      setProgress(null);
    }
  }

  function resetForm() {
    setItems([]);
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

  /** Closing cancels an upload in progress and forgets the picked files. */
  function handleOpenChange(next: boolean) {
    if (!next) {
      abortRef.current?.abort();
      resetForm();
    }
    onOpenChange(next);
  }

  function pickFiles(list: FileList | null) {
    const picked = Array.from(list ?? []).map((f) => ({ file: f, dir: [] }));
    if (picked.length) setItems(picked);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isQueue ? "Upload Files" : "Upload File"}</DialogTitle>
        </DialogHeader>
        {isQueue ? (
          <UploadQueue
            folderId={folderId}
            items={items}
            onUploaded={onUploaded}
            onBack={() => setItems([])}
            onClose={() => handleOpenChange(false)}
          />
        ) : duplicateFile ? (
          <div className="space-y-4 py-4">
            <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-4 /30">
              <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium">
                  &ldquo;{duplicateFile.name}&rdquo; already exists in this folder
                </p>
                <p className="text-sm text-muted-foreground">
                  Current version: {duplicateFile.currentVersion} &middot; State:{" "}
                  {duplicateFile.lifecycleState}
                </p>
              </div>
            </div>

            {duplicateFile.isFrozen ? (
              <p className="text-sm text-muted-foreground">
                This file is released/frozen and cannot accept new versions. Revise it first from
                the file detail panel.
              </p>
            ) : duplicateFile.isCheckedOut && duplicateFile.checkedOutById !== user.id ? (
              <p className="text-sm text-muted-foreground">
                This file is checked out by another user and cannot accept new versions until
                checked in.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Upload your file as version {duplicateFile.currentVersion + 1}?
              </p>
            )}

            {progress !== null && <UploadProgressBar progress={progress} />}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDuplicateFile(null)}>
                Back
              </Button>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              {!duplicateFile.isFrozen &&
                !(duplicateFile.isCheckedOut && duplicateFile.checkedOutById !== user.id) && (
                  <Button type="button" disabled={loading} onClick={handleVersionBump}>
                    {loading
                      ? "Uploading..."
                      : `Upload as Version ${duplicateFile.currentVersion + 1}`}
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
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setIsDragging(true);
                }}
                onDragEnter={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setIsDragging(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setIsDragging(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setIsDragging(false);
                  readDroppedFiles(e.dataTransfer)
                    .then((dropped) => {
                      if (dropped.length) setItems(dropped);
                    })
                    .catch((err) => toast.error(errorMessage(err)));
                }}
              >
                {file ? (
                  <div>
                    <p className="font-medium">{file.name}</p>
                    <p className="text-sm text-muted-foreground">{formatBytes(file.size)}</p>
                  </div>
                ) : (
                  <div>
                    <Upload className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
                    <p className="text-sm text-muted-foreground">
                      {isDragging
                        ? "Drop files or folders here"
                        : "Drag files or folders here, or click to browse"}
                    </p>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => pickFiles(e.target.files)}
                />
              </div>

              {progress !== null && <UploadProgressBar progress={progress} />}

              {/* A native SolidWorks file can only ever show its embedded 2D
                  bitmap — occt-import-js reads neutral formats only, so no
                  viewer work will ever make it rotate. Said here rather than
                  enforced: refusing the upload puts the friction on somebody
                  mid-task, and the first person in a hurry attaches a stale
                  STEP, which is worse than none because it looks current.
                  See docs/decisions/retention-and-formats.md. */}
              {file && needsNeutralExport(file.name) && (
                <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
                  <Box className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">This file will not preview in 3D</p>
                    <p className="text-xs text-muted-foreground">
                      SolidWorks files can only show their saved thumbnail. Upload a STEP export
                      alongside it and anyone — including a supplier on a share link — can open the
                      model. Doing it now is far easier than going back over the vault later.
                    </p>
                  </div>
                </div>
              )}

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
                    {/* The placeholder names the category auto-detect will
                        actually apply, rather than the bare phrase
                        "Auto-detect from extension". Leaving it opaque is how
                        people reached for the dropdown and mislabelled files
                        the server would have got right on its own. */}
                    <SelectValue placeholder={autoDetectPlaceholder}>
                      {(v) => CATEGORY_LABELS[v as FileCategory] ?? autoDetectPlaceholder}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {FILE_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {CATEGORY_LABELS[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {categoryConflictsWithExtension && derivedCategory && (
                  <p className="text-xs text-warning">
                    A .{file?.name.split(".").pop()?.toLowerCase()} file is normally a{" "}
                    {CATEGORY_LABELS[derivedCategory]}. Saving it as{" "}
                    {CATEGORY_LABELS[category as FileCategory] ?? category} is allowed, but the
                    label will not match the file.
                  </p>
                )}
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
                    <SelectTrigger>
                      <SelectValue placeholder="Default (WIP)" />
                    </SelectTrigger>
                    <SelectContent>
                      {lifecycleStates.map((s) => (
                        <SelectItem key={s.id} value={s.name}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-2xs text-muted-foreground">
                    Override the initial lifecycle state for this file.
                  </p>
                </div>
              )}

              {/* Link to Part section */}
              <div className="border-t pt-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox checked={linkToPart} onCheckedChange={(v) => setLinkToPart(!!v)} />
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
                          <SelectValue>
                            {(v) =>
                              (
                                ({
                                  DRAWING: "Drawing",
                                  MODEL_3D: "3D Model",
                                  SPEC_SHEET: "Spec Sheet",
                                  DATASHEET: "Datasheet",
                                  OTHER: "Other",
                                }) as Record<string, string>
                              )[v as string] ?? ""
                            }
                          </SelectValue>
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
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
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

function UploadProgressBar({ progress }: { progress: number }) {
  const pct = Math.round(progress * 100);
  return (
    <div className="space-y-1" role="status" aria-live="polite">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">
        {pct < 100 ? `Uploading\u2026 ${pct}%` : "Saving\u2026"}
      </p>
    </div>
  );
}
