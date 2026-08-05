"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useFetch } from "@/hooks/use-fetch";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Plus,
  Search,
  Loader2,
  Building2,
  MoreHorizontal,
  Pencil,
  Trash2,
  ExternalLink,
  Mail,
  Phone,
  User,
  Package,
  ArrowUpRight,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { EntityThumbnail, ThumbnailPicker } from "@/components/ui/entity-thumbnail";
import { fetchJson, uploadFile, errorMessage } from "@/lib/api-client";

interface Vendor {
  id: string;
  name: string;
  website: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  notes: string | null;
  partCount?: number;
  /** Signed URL for the vendor's logo, or null. See src/lib/thumbnails.ts. */
  thumbnailUrl?: string | null;
}

interface VendorPartLink {
  id: string;
  partId: string;
  vendorPartNumber: string | null;
  unitCost: number | null;
  currency: string | null;
  leadTimeDays: number | null;
  isPrimary: boolean;
  part: { id: string; partNumber: string; name: string } | null;
}

interface VendorDetail extends Vendor {
  usedBy: VendorPartLink[];
}

const EMPTY_FORM = {
  name: "",
  website: "",
  contactName: "",
  contactEmail: "",
  contactPhone: "",
  notes: "",
};

export default function VendorsPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  // Edit dialog handles both create and update — `editingId` discriminates
  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  // Logo chosen in the dialog. Held until save, because a vendor being created
  // has no id to upload against yet — the same two-step the part form uses.
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [logoCleared, setLogoCleared] = useState(false);

  // Detail sheet — shows contact info + parts linked to this vendor
  const [detailVendorId, setDetailVendorId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // Local debounce — keeps the search snappy without re-running on every
  // keystroke. 250ms matches the parts-page vendor picker for consistency.
  // The debounced value feeds the fetch URL, so the initial load (empty
  // query, all vendors) needs no separate effect.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery), 250);
    return () => clearTimeout(id);
  }, [searchQuery]);

  const vendorsUrl = `/api/vendors?withCounts=1${
    debouncedQuery ? `&q=${encodeURIComponent(debouncedQuery)}` : ""
  }`;
  const { data: vendorData, loading, error, refetch: loadVendors } = useFetch<Vendor[]>(vendorsUrl);
  const vendors = vendorData ?? [];

  // Detail is keyed off the selected id, so opening the sheet is a URL
  // change rather than a hand-rolled fetch — and switching vendors quickly
  // aborts the previous request instead of racing it.
  const { data: detailVendor, loading: detailLoading } = useFetch<VendorDetail>(
    detailVendorId ? `/api/vendors/${detailVendorId}` : null
  );

  function openDetail(v: Vendor) {
    setDetailVendorId(v.id);
    setDetailOpen(true);
  }

  /** Drop any pending logo choice and release the object URL behind it. */
  const resetLogo = useCallback((existingUrl: string | null = null) => {
    setLogoFile(null);
    setLogoPreview((prev) => {
      if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
      return existingUrl;
    });
    setLogoCleared(false);
  }, []);

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    resetLogo();
    setShowDialog(true);
  }

  function openEdit(v: Vendor) {
    setEditingId(v.id);
    setForm({
      name: v.name,
      website: v.website ?? "",
      contactName: v.contactName ?? "",
      contactEmail: v.contactEmail ?? "",
      contactPhone: v.contactPhone ?? "",
      notes: v.notes ?? "",
    });
    resetLogo(v.thumbnailUrl ?? null);
    setShowDialog(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const vendor = await fetchJson<Vendor>(
        editingId ? `/api/vendors/${editingId}` : "/api/vendors",
        { method: editingId ? "PUT" : "POST", body: form }
      );

      // The logo is a second request against the saved vendor. A failure here
      // is reported on its own — the vendor itself did save, and telling the
      // user otherwise would send them back to re-enter the form.
      if (logoFile) {
        try {
          await uploadFile(`/api/vendors/${vendor.id}/thumbnail`, logoFile);
        } catch (err) {
          toast.error(`Vendor saved, but the logo did not upload: ${errorMessage(err)}`);
        }
      } else if (editingId && logoCleared) {
        try {
          await fetchJson(`/api/vendors/${vendor.id}/thumbnail`, { method: "DELETE" });
        } catch (err) {
          toast.error(`Vendor saved, but the logo was not removed: ${errorMessage(err)}`);
        }
      }

      toast.success(editingId ? "Vendor updated" : "Vendor created");
      setShowDialog(false);
      resetLogo();
      void loadVendors();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(v: Vendor) {
    if (!confirm(`Delete vendor "${v.name}"? This cannot be undone.`)) return;
    try {
      await fetchJson(`/api/vendors/${v.id}`, { method: "DELETE" });
      toast.success("Vendor deleted");
      void loadVendors();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <PageContainer>
      <PageHeader
        title="Vendors"
        actions={
          <>
            <Button size="sm" onClick={openCreate}>
              <Plus className="w-4 h-4 mr-2" />
              New Vendor
            </Button>
          </>
        }
      />

      <div className="relative max-w-md">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search vendors by name..."
          className="pl-8"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-12 text-center text-destructive text-sm">
            {errorMessage(error)}
          </CardContent>
        </Card>
      ) : vendors.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Building2 className="w-10 h-10 mx-auto mb-3 opacity-50" />
            <p className="text-sm">No vendors yet.</p>
            <p className="text-xs mt-1">Create one to start linking parts.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead>Website</TableHead>
                <TableHead>Used by</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {vendors.map((v) => (
                <TableRow
                  key={v.id}
                  className="cursor-pointer hover:bg-muted/40"
                  onClick={() => openDetail(v)}
                >
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2.5">
                      <EntityThumbnail src={v.thumbnailUrl} kind="vendor" size="sm" />
                      <span className="hover:underline">{v.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {v.contactName || v.contactEmail || v.contactPhone || "—"}
                  </TableCell>
                  <TableCell className="text-sm">
                    {v.website ? (
                      <a
                        href={v.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-primary hover:underline inline-flex items-center gap-1"
                      >
                        Link <ExternalLink className="w-3 h-3" />
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {v.partCount && v.partCount > 0 ? (
                      <Badge variant="info">
                        {v.partCount} part{v.partCount === 1 ? "" : "s"}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button variant="ghost" size="icon-xs">
                            <MoreHorizontal className="w-4 h-4" />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEdit(v)}>
                          <Pencil className="w-3.5 h-3.5 mr-2" /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleDelete(v)}
                          className="text-destructive"
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Sheet open={detailOpen} onOpenChange={setDetailOpen}>
        <SheetContent className="w-full sm:max-w-xl flex flex-col overflow-hidden">
          <SheetHeader className="border-b">
            <SheetTitle className="flex items-center gap-2.5">
              <EntityThumbnail src={detailVendor?.thumbnailUrl} kind="vendor" size="sm" />
              {detailVendor?.name || "Vendor"}
            </SheetTitle>
            <SheetDescription>Contact details and parts sourced from this vendor.</SheetDescription>
          </SheetHeader>

          {detailLoading || !detailVendor ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-5">
              <div className="space-y-2 text-sm">
                {detailVendor.website && (
                  <a
                    href={detailVendor.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-primary hover:underline"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    {detailVendor.website}
                  </a>
                )}
                {detailVendor.contactName && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <User className="w-3.5 h-3.5" />
                    {detailVendor.contactName}
                  </div>
                )}
                {detailVendor.contactEmail && (
                  <a
                    href={`mailto:${detailVendor.contactEmail}`}
                    className="flex items-center gap-2 text-muted-foreground hover:text-foreground"
                  >
                    <Mail className="w-3.5 h-3.5" />
                    {detailVendor.contactEmail}
                  </a>
                )}
                {detailVendor.contactPhone && (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Phone className="w-3.5 h-3.5" />
                    {detailVendor.contactPhone}
                  </div>
                )}
                {detailVendor.notes && (
                  <p className="text-muted-foreground whitespace-pre-wrap pt-1">
                    {detailVendor.notes}
                  </p>
                )}
                {!detailVendor.website &&
                  !detailVendor.contactName &&
                  !detailVendor.contactEmail &&
                  !detailVendor.contactPhone &&
                  !detailVendor.notes && (
                    <p className="text-xs text-muted-foreground italic">
                      No contact details on file.
                    </p>
                  )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                    <Package className="w-3.5 h-3.5" />
                    Linked Parts
                  </h3>
                  <Badge variant="secondary">{detailVendor.usedBy.length}</Badge>
                </div>

                {detailVendor.usedBy.length === 0 ? (
                  <Card>
                    <CardContent className="py-6 text-center text-xs text-muted-foreground">
                      No parts are linked to this vendor yet.
                    </CardContent>
                  </Card>
                ) : (
                  <Card className="overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Part</TableHead>
                          <TableHead>Vendor P/N</TableHead>
                          <TableHead className="text-right">Cost</TableHead>
                          <TableHead className="text-right">Lead</TableHead>
                          <TableHead className="w-8" />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detailVendor.usedBy.map((link) => (
                          <TableRow key={link.id}>
                            <TableCell className="font-medium">
                              {link.part ? (
                                <div className="flex flex-col">
                                  <span className="flex items-center gap-1.5">
                                    {link.part.partNumber}
                                    {link.isPrimary && (
                                      <Badge variant="info" className="text-3xs px-1 py-0">
                                        Primary
                                      </Badge>
                                    )}
                                  </span>
                                  <span className="text-xs text-muted-foreground truncate max-w-45">
                                    {link.part.name}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-muted-foreground italic">Unknown part</span>
                              )}
                            </TableCell>
                            <TableCell className="text-xs">
                              {link.vendorPartNumber || (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="text-xs text-right">
                              {link.unitCost != null ? (
                                `${link.currency || ""} ${Number(link.unitCost).toFixed(2)}`.trim()
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="text-xs text-right">
                              {link.leadTimeDays != null ? (
                                `${link.leadTimeDays}d`
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell>
                              {link.part && (
                                <Link
                                  href={`/parts?partId=${link.part.id}`}
                                  className="text-muted-foreground hover:text-foreground inline-flex"
                                  aria-label="Open part"
                                >
                                  <ArrowUpRight className="w-3.5 h-3.5" />
                                </Link>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Card>
                )}
              </div>

              <div className="flex gap-2 pt-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setDetailOpen(false);
                    if (detailVendor) openEdit(detailVendor);
                  }}
                >
                  <Pencil className="w-3.5 h-3.5 mr-2" /> Edit vendor
                </Button>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Vendor" : "New Vendor"}</DialogTitle>
            <DialogDescription>
              {editingId
                ? "Update vendor details. Renaming affects everywhere this vendor is used."
                : "Add a vendor that can be linked to parts."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSave}>
            <div className="space-y-4 py-4">
              <div className="flex items-start gap-3">
                <ThumbnailPicker
                  src={logoPreview}
                  kind="vendor"
                  size="lg"
                  label="Choose a vendor logo"
                  onSelect={(file) => {
                    setLogoFile(file);
                    setLogoPreview((prev) => {
                      if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
                      return URL.createObjectURL(file);
                    });
                    setLogoCleared(false);
                  }}
                  onRemove={() => {
                    setLogoFile(null);
                    setLogoPreview((prev) => {
                      if (prev?.startsWith("blob:")) URL.revokeObjectURL(prev);
                      return null;
                    });
                    setLogoCleared(true);
                  }}
                />
                <div className="flex-1 min-w-0 space-y-1">
                  <Label className="text-xs">Logo</Label>
                  <p className="text-2xs text-muted-foreground">
                    Click the tile to {logoPreview ? "replace" : "upload"}. Saved when you save the
                    vendor.
                  </p>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Name</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="McMaster-Carr"
                  required
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Website</Label>
                <Input
                  value={form.website}
                  onChange={(e) => setForm({ ...form, website: e.target.value })}
                  placeholder="https://..."
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Contact Name</Label>
                  <Input
                    value={form.contactName}
                    onChange={(e) => setForm({ ...form, contactName: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Contact Email</Label>
                  <Input
                    type="email"
                    value={form.contactEmail}
                    onChange={(e) => setForm({ ...form, contactEmail: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Contact Phone</Label>
                <Input
                  value={form.contactPhone}
                  onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Notes</Label>
                <Input
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="Optional notes..."
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowDialog(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !form.name.trim()}>
                {saving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : editingId ? (
                  "Save"
                ) : (
                  "Create"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </PageContainer>
  );
}
