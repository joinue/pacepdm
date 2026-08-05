"use client";

import React, { useState, useEffect } from "react";
import { useFetch } from "@/hooks/use-fetch";
import { fetchJson, errorMessage } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Plus, X, Building2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { VendorSearchResult } from "../parts-types";

interface AddVendorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partId: string;
  onAdded: () => void;
}

export function AddVendorDialog({ open, onOpenChange, partId, onAdded }: AddVendorDialogProps) {
  const [vendorForm, setVendorForm] = useState({
    vendorPartNumber: "",
    unitCost: "",
    leadTimeDays: "",
    isPrimary: false,
    notes: "",
  });
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(null);
  const [selectedVendorName, setSelectedVendorName] = useState("");
  const [vendorSearch, setVendorSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(vendorSearch), 250);
    return () => clearTimeout(id);
  }, [vendorSearch]);

  // The debounced query drives the URL and `useFetch` does the rest — which
  // matters more here than on a page: a typeahead fires a request per pause,
  // and the hook aborts the superseded one instead of letting a slow early
  // response land on top of a fast later one.
  //
  // Null URL (no query, or a vendor already chosen) means no request at all.
  const searchUrl =
    !selectedVendorId && debouncedSearch.trim().length > 0
      ? `/api/vendors?q=${encodeURIComponent(debouncedSearch.trim())}`
      : null;

  const { data: vendorData, loading: vendorSearching } = useFetch<VendorSearchResult[]>(searchUrl);

  // `useFetch` keeps the last payload when the URL goes null, so the results
  // are gated on the same condition that built the URL rather than on `data`.
  const vendorResults = searchUrl ? (vendorData ?? []).slice(0, 8) : [];

  function reset() {
    setVendorForm({
      vendorPartNumber: "",
      unitCost: "",
      leadTimeDays: "",
      isPrimary: false,
      notes: "",
    });
    setSelectedVendorId(null);
    setSelectedVendorName("");
    setVendorSearch("");
    setDebouncedSearch("");
  }

  function handleSearchInput(q: string) {
    setVendorSearch(q);
    setSelectedVendorId(null);
  }

  function selectVendor(v: VendorSearchResult) {
    setSelectedVendorId(v.id);
    setSelectedVendorName(v.name);
    setVendorSearch(v.name);
  }

  async function handleCreateInlineVendor() {
    const name = vendorSearch.trim();
    if (!name) return;
    try {
      const created = await fetchJson<VendorSearchResult>("/api/vendors", {
        method: "POST",
        body: { name },
      });
      selectVendor({ id: created.id, name: created.name });
      toast.success(`Created vendor "${created.name}"`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedVendorId) return;
    try {
      await fetchJson(`/api/parts/${partId}/vendors`, {
        method: "POST",
        body: {
          vendorId: selectedVendorId,
          vendorPartNumber: vendorForm.vendorPartNumber,
          unitCost: vendorForm.unitCost ? parseFloat(vendorForm.unitCost) : null,
          leadTimeDays: vendorForm.leadTimeDays ? parseInt(vendorForm.leadTimeDays) : null,
          isPrimary: vendorForm.isPrimary,
          notes: vendorForm.notes,
        },
      });
      toast.success("Vendor added");
      onOpenChange(false);
      reset();
      onAdded();
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
          reset();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Vendor</DialogTitle>
          <DialogDescription>
            Link an approved vendor to this part. Pick from existing or create new.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div className="space-y-1">
              <Label className="text-xs">Vendor</Label>
              {selectedVendorId ? (
                <div className="flex items-center gap-2 border rounded-md px-2 py-1.5 text-sm bg-muted/30">
                  <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="flex-1 truncate">{selectedVendorName}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedVendorId(null);
                      setSelectedVendorName("");
                      setVendorSearch("");
                    }}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <Input
                    value={vendorSearch}
                    onChange={(e) => handleSearchInput(e.target.value)}
                    placeholder="Search vendors..."
                    className="h-8 text-sm"
                    autoComplete="off"
                  />
                  {vendorSearching && (
                    <Loader2 className="absolute right-2 top-2 w-4 h-4 animate-spin text-muted-foreground" />
                  )}
                  {vendorResults.length > 0 && (
                    <div className="absolute z-10 mt-1 w-full border rounded-md bg-popover shadow-md max-h-48 overflow-y-auto">
                      {vendorResults.map((v) => (
                        <button
                          key={v.id}
                          type="button"
                          onClick={() => selectVendor(v)}
                          className="w-full text-left px-2 py-1.5 text-sm hover:bg-muted flex items-center gap-2"
                        >
                          <Building2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                          <span className="truncate">{v.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {vendorSearch.trim().length > 0 &&
                    !vendorSearching &&
                    !vendorResults.some(
                      (v) => v.name.toLowerCase() === vendorSearch.trim().toLowerCase()
                    ) && (
                      <button
                        type="button"
                        onClick={handleCreateInlineVendor}
                        className="mt-1 text-xs text-primary hover:underline flex items-center gap-1"
                      >
                        <Plus className="w-3 h-3" /> Create &ldquo;{vendorSearch.trim()}&rdquo; as
                        new vendor
                      </button>
                    )}
                </div>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Vendor Part #</Label>
              <Input
                value={vendorForm.vendorPartNumber}
                onChange={(e) => setVendorForm({ ...vendorForm, vendorPartNumber: e.target.value })}
                placeholder="91290A197"
                className="h-8 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Unit Cost ($)</Label>
                <Input
                  type="number"
                  value={vendorForm.unitCost}
                  onChange={(e) => setVendorForm({ ...vendorForm, unitCost: e.target.value })}
                  placeholder="0.00"
                  className="h-8 text-sm"
                  min="0"
                  step="0.01"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Lead Time (days)</Label>
                <Input
                  type="number"
                  value={vendorForm.leadTimeDays}
                  onChange={(e) => setVendorForm({ ...vendorForm, leadTimeDays: e.target.value })}
                  placeholder="14"
                  className="h-8 text-sm"
                  min="0"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="isPrimaryVendor"
                checked={vendorForm.isPrimary}
                onChange={(e) => setVendorForm({ ...vendorForm, isPrimary: e.target.checked })}
                className="h-3.5 w-3.5"
              />
              <Label htmlFor="isPrimaryVendor" className="text-xs cursor-pointer">
                Primary vendor (used for BOM cost rollup)
              </Label>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Notes</Label>
              <Input
                value={vendorForm.notes}
                onChange={(e) => setVendorForm({ ...vendorForm, notes: e.target.value })}
                placeholder="Optional notes..."
                className="h-8 text-sm"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
                reset();
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!selectedVendorId}>
              Add Vendor
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
