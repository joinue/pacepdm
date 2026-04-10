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
import { Search, Loader2, X, FileText } from "lucide-react";
import { fetchJson, errorMessage } from "@/lib/api-client";
import type { SearchFile } from "../types";

interface AddEcoItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ecoId: string;
  /** Called after a successful add so the parent can refresh its item list. */
  onAdded: () => void;
}

/**
 * Adds an affected file to an ECO. The file picker debounces vault search
 * (2-char min) and the user picks a change type (ADD/MODIFY/REMOVE) plus
 * an optional reason note.
 */
export function AddEcoItemDialog({ open, onOpenChange, ecoId, onAdded }: AddEcoItemDialogProps) {
  const [fileSearch, setFileSearch] = useState("");
  const [fileResults, setFileResults] = useState<SearchFile[]>([]);
  const [searchingFiles, setSearchingFiles] = useState(false);
  const [selectedFile, setSelectedFile] = useState<SearchFile | null>(null);
  const [changeType, setChangeType] = useState("MODIFY");
  const [reason, setReason] = useState("");

  function reset() {
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
      // Endpoint returns either an array or `{files: [...]}` — handle both
      setFileResults(Array.isArray(data) ? data : data.files || []);
    } catch {
      setFileResults([]);
    } finally {
      setSearchingFiles(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedFile) return;
    try {
      await fetchJson(`/api/ecos/${ecoId}/items`, {
        method: "POST",
        body: { fileId: selectedFile.id, changeType, reason },
      });
      toast.success("Item added");
      close();
      onAdded();
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to add item");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Affected File</DialogTitle>
          <DialogDescription>Select a file that will be changed, added, or removed by this ECO.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
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
                      autoFocus
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

            <div className="space-y-2">
              <Label>Change Type <span className="text-destructive">*</span></Label>
              <Select value={changeType} onValueChange={(v) => setChangeType(v ?? "MODIFY")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ADD">Add — New file being introduced</SelectItem>
                  <SelectItem value="MODIFY">Modify — Existing file being changed</SelectItem>
                  <SelectItem value="REMOVE">Remove — File being obsoleted</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Reason</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this file affected by the change?"
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>Cancel</Button>
            <Button type="submit" disabled={!selectedFile}>Add to ECO</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
