"use client";

import { useState } from "react";
import { toast } from "sonner";
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Search, Loader2, X, FileText, Package } from "lucide-react";
import { fetchJson, errorMessage } from "@/lib/api-client";
import type { SearchFile, SearchPart } from "../types";

interface AddEcoItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ecoId: string;
  /** Called after a successful add so the parent can refresh its item list. */
  onAdded: () => void;
}

/**
 * Adds an affected item to an ECO. Two tabs: "Part" (the recommended
 * path — a part carries revision metadata and cascades to all its linked
 * files on implement) and "File" (for loose documents not attached to
 * any part).
 *
 * Each picker debounces search (2-char min). After selection the user
 * picks a change type (ADD/MODIFY/REMOVE) and an optional reason. Part
 * items also accept an optional toRevision override — leave blank and
 * the server auto-bumps A→B on implement.
 */
export function AddEcoItemDialog({ open, onOpenChange, ecoId, onAdded }: AddEcoItemDialogProps) {
  const [target, setTarget] = useState<"part" | "file">("part");

  const [partSearch, setPartSearch] = useState("");
  const [partResults, setPartResults] = useState<SearchPart[]>([]);
  const [searchingParts, setSearchingParts] = useState(false);
  const [selectedPart, setSelectedPart] = useState<SearchPart | null>(null);
  const [toRevision, setToRevision] = useState("");

  const [fileSearch, setFileSearch] = useState("");
  const [fileResults, setFileResults] = useState<SearchFile[]>([]);
  const [searchingFiles, setSearchingFiles] = useState(false);
  const [selectedFile, setSelectedFile] = useState<SearchFile | null>(null);

  const [changeType, setChangeType] = useState("MODIFY");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setTarget("part");
    setPartSearch("");
    setPartResults([]);
    setSelectedPart(null);
    setToRevision("");
    setFileSearch("");
    setFileResults([]);
    setSelectedFile(null);
    setChangeType("MODIFY");
    setReason("");
  }

  function close() {
    onOpenChange(false);
    reset();
  }

  async function searchParts(q: string) {
    setPartSearch(q);
    if (q.length < 2) {
      setPartResults([]);
      return;
    }
    setSearchingParts(true);
    try {
      const data = await fetchJson<SearchPart[]>(
        `/api/parts?q=${encodeURIComponent(q)}`
      );
      setPartResults((data || []).slice(0, 10));
    } catch {
      setPartResults([]);
    } finally {
      setSearchingParts(false);
    }
  }

  async function searchFiles(q: string) {
    setFileSearch(q);
    if (q.length < 2) {
      setFileResults([]);
      return;
    }
    setSearchingFiles(true);
    try {
      const data = await fetchJson<SearchFile[] | { files: SearchFile[] }>(
        `/api/files?q=${encodeURIComponent(q)}&limit=10`
      );
      setFileResults(Array.isArray(data) ? data : data.files || []);
    } catch {
      setFileResults([]);
    } finally {
      setSearchingFiles(false);
    }
  }

  const canSubmit = target === "part" ? !!selectedPart : !!selectedFile;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { changeType, reason };
      if (target === "part" && selectedPart) {
        body.partId = selectedPart.id;
        if (toRevision.trim()) body.toRevision = toRevision.trim();
      } else if (target === "file" && selectedFile) {
        body.fileId = selectedFile.id;
      }
      await fetchJson(`/api/ecos/${ecoId}/items`, { method: "POST", body });
      toast.success("Item added");
      close();
      onAdded();
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to add item");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Affected Item</DialogTitle>
          <DialogDescription>
            Link a part (recommended) or a loose file to this ECO. Parts cascade their linked drawings, models, and specs on implement.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <Tabs value={target} onValueChange={(v) => setTarget(v as "part" | "file")}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="part"><Package className="w-3.5 h-3.5 mr-1.5" />Part</TabsTrigger>
                <TabsTrigger value="file"><FileText className="w-3.5 h-3.5 mr-1.5" />File</TabsTrigger>
              </TabsList>

              <TabsContent value="part" className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label>Part <span className="text-destructive">*</span></Label>
                  {selectedPart ? (
                    <div className="flex items-center gap-3 p-3 border rounded-lg bg-muted/20">
                      <Package className="w-5 h-5 text-primary shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {selectedPart.partNumber} — {selectedPart.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Rev {selectedPart.revision} &middot; {selectedPart.lifecycleState} &middot; {selectedPart.category}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 shrink-0"
                        onClick={() => { setSelectedPart(null); setPartSearch(""); }}
                      >
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <div className="relative">
                        <Search className="absolute left-3 top-2.5 w-4 h-4 text-muted-foreground" />
                        <Input
                          value={partSearch}
                          onChange={(e) => searchParts(e.target.value)}
                          placeholder="Search by part number or name..."
                          className="pl-9"
                          autoFocus
                        />
                      </div>
                      {searchingParts && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Searching...
                        </div>
                      )}
                      {partResults.length > 0 && (
                        <div className="border rounded-lg overflow-hidden max-h-48 overflow-y-auto">
                          {partResults.map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              className="w-full text-left px-3 py-2.5 text-sm hover:bg-muted/50 border-b last:border-0 flex items-center gap-3 transition-colors"
                              onClick={() => { setSelectedPart(p); setPartResults([]); }}
                            >
                              <Package className="w-4 h-4 text-muted-foreground shrink-0" />
                              <div className="min-w-0 flex-1">
                                <span className="font-medium">{p.partNumber} — {p.name}</span>
                                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                  <span>Rev {p.revision}</span>
                                  <span>&middot;</span>
                                  <span>{p.lifecycleState}</span>
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                      {partSearch.length >= 2 && !searchingParts && partResults.length === 0 && (
                        <p className="text-xs text-muted-foreground/60 px-1 italic">
                          No parts found matching &ldquo;{partSearch}&rdquo;
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <Label>To Revision</Label>
                  <Input
                    value={toRevision}
                    onChange={(e) => setToRevision(e.target.value)}
                    placeholder={selectedPart ? `Leave blank to auto-bump from ${selectedPart.revision}` : "Leave blank to auto-bump"}
                    maxLength={8}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    If blank, the server bumps a single-letter revision on implement (e.g. A → B).
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="file" className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label>File <span className="text-destructive">*</span></Label>
                  {selectedFile ? (
                    <div className="flex items-center gap-3 p-3 border rounded-lg bg-muted/20">
                      <FileText className="w-5 h-5 text-primary shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{selectedFile.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {selectedFile.partNumber || "No part number"} &middot; {selectedFile.lifecycleState}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 shrink-0"
                        onClick={() => { setSelectedFile(null); setFileSearch(""); }}
                      >
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <div className="relative">
                        <Search className="absolute left-3 top-2.5 w-4 h-4 text-muted-foreground" />
                        <Input
                          value={fileSearch}
                          onChange={(e) => searchFiles(e.target.value)}
                          placeholder="Search files by name or part number..."
                          className="pl-9"
                        />
                      </div>
                      {searchingFiles && (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Searching...
                        </div>
                      )}
                      {fileResults.length > 0 && (
                        <div className="border rounded-lg overflow-hidden max-h-48 overflow-y-auto">
                          {fileResults.map((f) => (
                            <button
                              key={f.id}
                              type="button"
                              className="w-full text-left px-3 py-2.5 text-sm hover:bg-muted/50 border-b last:border-0 flex items-center gap-3 transition-colors"
                              onClick={() => { setSelectedFile(f); setFileResults([]); }}
                            >
                              <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                              <div className="min-w-0 flex-1">
                                <span className="font-medium">{f.name}</span>
                                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                  {f.partNumber && <span>{f.partNumber}</span>}
                                  {f.partNumber && <span>&middot;</span>}
                                  <span>{f.lifecycleState}</span>
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                      {fileSearch.length >= 2 && !searchingFiles && fileResults.length === 0 && (
                        <p className="text-xs text-muted-foreground/60 px-1 italic">
                          No files found matching &ldquo;{fileSearch}&rdquo;
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </TabsContent>
            </Tabs>

            <div className="space-y-2">
              <Label>Change Type <span className="text-destructive">*</span></Label>
              <Select value={changeType} onValueChange={(v) => setChangeType(v ?? "MODIFY")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ADD">Add — Newly introduced</SelectItem>
                  <SelectItem value="MODIFY">Modify — Existing item being changed</SelectItem>
                  <SelectItem value="REMOVE">Remove — Item being obsoleted</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Reason</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this item affected by the change?"
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>Cancel</Button>
            <Button type="submit" disabled={!canSubmit || submitting}>
              {submitting && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              Add to ECO
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
