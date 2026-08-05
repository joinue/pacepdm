"use client";

import React, { useState, useEffect } from "react";
import { useFetch } from "@/hooks/use-fetch";
import { fetchJson, errorMessage } from "@/lib/api-client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { FILE_ROLE_LABELS } from "../parts-types";

interface FileSearchResult {
  id: string;
  name: string;
  partNumber: string | null;
  lifecycleState: string;
}

/** `/api/search` returns buckets; older callers saw a bare array. */
type FileSearchResponse = FileSearchResult[] | { files?: FileSearchResult[] };

interface LinkFileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partId: string;
  hasExistingFiles: boolean;
  onLinked: () => void;
}

export function LinkFileDialog({
  open,
  onOpenChange,
  partId,
  hasExistingFiles,
  onLinked,
}: LinkFileDialogProps) {
  const [fileSearch, setFileSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [fileRole, setFileRole] = useState("DRAWING");

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(fileSearch), 300);
    return () => clearTimeout(id);
  }, [fileSearch]);

  // Two characters minimum, same as before — below that the search matches
  // most of the vault and the result list is noise.
  const searchUrl =
    debouncedSearch.trim().length >= 2
      ? `/api/search?q=${encodeURIComponent(debouncedSearch.trim())}`
      : null;

  const { data: searchData, loading: fileSearching } = useFetch<FileSearchResponse>(searchUrl);

  const fileResults = !searchUrl
    ? []
    : (Array.isArray(searchData) ? searchData : (searchData?.files ?? [])).slice(0, 8);

  async function handleLinkFile(fileId: string) {
    try {
      await fetchJson(`/api/parts/${partId}/files`, {
        method: "POST",
        body: { fileId, role: fileRole, isPrimary: !hasExistingFiles },
      });
      toast.success("File linked");
      onOpenChange(false);
      setFileSearch("");
      setDebouncedSearch("");
      onLinked();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          onOpenChange(false);
          setFileSearch("");
          setDebouncedSearch("");
        }
      }}
    >
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
                onChange={(e) => setFileSearch(e.target.value)}
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
                    {f.partNumber && (
                      <span className="text-xs text-muted-foreground shrink-0">{f.partNumber}</span>
                    )}
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
