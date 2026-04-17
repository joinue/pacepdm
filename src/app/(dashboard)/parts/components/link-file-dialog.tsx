"use client";

import React, { useState, useCallback, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Search, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { FILE_ROLE_LABELS } from "../parts-types";

function useDebounce<T extends (...args: Parameters<T>) => void>(fn: T, delay: number): T {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return useCallback((...args: Parameters<T>) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => fn(...args), delay);
  }, [fn, delay]) as T;
}

interface LinkFileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partId: string;
  hasExistingFiles: boolean;
  onLinked: () => void;
}

export function LinkFileDialog({ open, onOpenChange, partId, hasExistingFiles, onLinked }: LinkFileDialogProps) {
  const [fileSearch, setFileSearch] = useState("");
  const [fileResults, setFileResults] = useState<{ id: string; name: string; partNumber: string | null; lifecycleState: string }[]>([]);
  const [fileSearching, setFileSearching] = useState(false);
  const [fileRole, setFileRole] = useState("DRAWING");

  const doFileSearch = useCallback(async (q: string) => {
    if (q.length < 2) { setFileResults([]); setFileSearching(false); return; }
    setFileSearching(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      const files = Array.isArray(data) ? data : (data.files ?? []);
      setFileResults(files.slice(0, 8));
    } catch { setFileResults([]); }
    setFileSearching(false);
  }, []);

  const debouncedFileSearch = useDebounce(doFileSearch, 300);

  async function handleLinkFile(fileId: string) {
    const res = await fetch(`/api/parts/${partId}/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId, role: fileRole, isPrimary: !hasExistingFiles }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("File linked");
    onOpenChange(false);
    setFileSearch("");
    setFileResults([]);
    onLinked();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { onOpenChange(false); setFileSearch(""); setFileResults([]); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link File</DialogTitle>
          <DialogDescription>Search for a vault file to link to this part.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-1">
            <Label className="text-xs">File Role</Label>
            <Select value={fileRole} onValueChange={(v) => setFileRole(v ?? "DRAWING")}>
              <SelectTrigger className="h-8 text-sm">
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
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Search Files</Label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                value={fileSearch}
                onChange={(e) => { setFileSearch(e.target.value); debouncedFileSearch(e.target.value); }}
                placeholder="Search vault files..."
                className="pl-8 h-8 text-sm"
              />
            </div>
            {fileSearching && (
              <div className="flex items-center justify-center py-2">
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              </div>
            )}
            {fileResults.length > 0 && (
              <div className="border rounded-lg max-h-40 overflow-y-auto">
                {fileResults.map((f) => (
                  <button
                    key={f.id}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors flex items-center gap-2"
                    onClick={() => handleLinkFile(f.id)}
                  >
                    <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="truncate">{f.name}</span>
                    {f.partNumber && <span className="text-xs text-muted-foreground shrink-0">{f.partNumber}</span>}
                  </button>
                ))}
              </div>
            )}
            {fileSearch.length >= 2 && !fileSearching && fileResults.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-2">No files found</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
