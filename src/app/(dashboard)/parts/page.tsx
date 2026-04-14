"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { useRealtimeTable } from "@/hooks/use-realtime-table";
import { WhereUsedSection } from "@/components/where-used-section";
import type { PartWhereUsed } from "@/lib/where-used";
import { useTenantUser } from "@/components/providers/tenant-provider";
import {
  Plus, Search, Loader2, Package, MoreHorizontal, Pencil,
  Trash2, X, FileText, Building2, ImageIcon, Upload, Download, ExternalLink,
} from "lucide-react";
import { toast } from "sonner";

// --- Types ---

interface Part {
  id: string;
  partNumber: string;
  name: string;
  description: string | null;
  category: string;
  revision: string;
  lifecycleState: string;
  material: string | null;
  weight: number | null;
  weightUnit: string;
  unitCost: number | null;
  currency: string;
  unit: string;
  thumbnailUrl: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PartDetail extends Part {
  vendors: PartVendorLink[];
  files: { id: string; fileId: string; role: string; isPrimary: boolean; file: { id: string; name: string; partNumber: string | null; revision: string; lifecycleState: string; fileType: string } }[];
  whereUsed: { bomId: string; bomName: string; bomRevision: string; bomStatus: string; quantity: number; unit: string }[];
  ecoHistory: {
    ecoId: string;
    ecoNumber: string;
    title: string;
    status: string;
    implementedAt: string | null;
    createdAt: string;
    fromRevision: string | null;
    toRevision: string | null;
  }[];
}

// A row from `part_vendors` joined with the canonical `vendors` record.
// `vendor.name` is the source of truth for display; the legacy `vendorName`
// text column on part_vendors is kept in sync until migration 010 drops it.
interface PartVendorLink {
  id: string;
  vendorId: string;
  vendor: { id: string; name: string } | null;
  vendorPartNumber: string | null;
  unitCost: number | null;
  currency: string;
  leadTimeDays: number | null;
  isPrimary: boolean;
  notes: string | null;
}

interface VendorSearchResult {
  id: string;
  name: string;
}

// --- Constants ---

const CATEGORIES = [
  { value: "MANUFACTURED", label: "Manufactured" },
  { value: "PURCHASED", label: "Purchased" },
  { value: "STANDARD_HARDWARE", label: "Standard Hardware" },
  { value: "RAW_MATERIAL", label: "Raw Material" },
  { value: "SUB_ASSEMBLY", label: "Sub-Assembly" },
];

const FILE_ROLE_LABELS: Record<string, string> = {
  DRAWING: "Drawing",
  MODEL_3D: "3D Model",
  SPEC_SHEET: "Spec Sheet",
  DATASHEET: "Datasheet",
  OTHER: "Other",
};

const categoryVariants: Record<string, "info" | "success" | "muted" | "warning" | "purple"> = {
  MANUFACTURED: "info",
  PURCHASED: "success",
  STANDARD_HARDWARE: "muted",
  RAW_MATERIAL: "warning",
  SUB_ASSEMBLY: "purple",
};

const stateVariants: Record<string, "warning" | "info" | "success" | "error"> = {
  WIP: "warning", "In Review": "info", Released: "success", Obsolete: "error",
};

// --- Helpers ---

function useDebounce<T extends (...args: Parameters<T>) => void>(fn: T, delay: number): T {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return useCallback((...args: Parameters<T>) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => fn(...args), delay);
  }, [fn, delay]) as T;
}

// --- Component ---

export default function PartsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const user = useTenantUser();
  const [parts, setParts] = useState<Part[]>([]);
  const [loading, setLoading] = useState(true);
  // Numbering mode comes from tenant settings; AUTO lets the server allocate
  // PRT-00001/00002/... so users don't have to type a number when creating.
  const [partNumberMode, setPartNumberMode] = useState<"AUTO" | "MANUAL">("AUTO");
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState("all");

  // Detail panel
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PartDetail | null>(null);
  const [partWhereUsed, setPartWhereUsed] = useState<PartWhereUsed | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Create/edit part
  const [showCreate, setShowCreate] = useState(false);
  const [editingPart, setEditingPart] = useState<Part | null>(null);

  // Attach file on part create
  const [attachFile, setAttachFile] = useState<File | null>(null);
  const [attachFileRole, setAttachFileRole] = useState("DRAWING");
  const attachFileRef = useRef<HTMLInputElement>(null);
  // "link" mode: pick an already-uploaded vault file instead of uploading
  const [attachMode, setAttachMode] = useState<"upload" | "link">("upload");
  const [attachLinkFileId, setAttachLinkFileId] = useState<string | null>(null);
  const [attachLinkFileName, setAttachLinkFileName] = useState<string>("");
  const [attachLinkSearch, setAttachLinkSearch] = useState("");
  const [attachLinkResults, setAttachLinkResults] = useState<{ id: string; name: string; partNumber: string | null }[]>([]);
  const [attachLinkSearching, setAttachLinkSearching] = useState(false);
  const [formData, setFormData] = useState({
    partNumber: "", name: "", description: "", category: "MANUFACTURED",
    material: "", unitCost: "", unit: "EA", notes: "",
  });
  // Thumbnail state for the create/edit dialog. Kept separate from formData
  // because the actual upload is multipart and runs after the part PUT/POST
  // succeeds. `thumbnailFile` is the freshly picked image (preview shown via
  // an object URL); `thumbnailExistingUrl` is the signed URL from the server
  // for the part being edited; `thumbnailRemoved` distinguishes "user
  // cleared the thumbnail" from "no thumbnail to begin with" so we know
  // whether to fire DELETE on save.
  const dialogThumbnailRef = useRef<HTMLInputElement>(null);
  const [dialogThumbnailFile, setDialogThumbnailFile] = useState<File | null>(null);
  const [dialogThumbnailPreview, setDialogThumbnailPreview] = useState<string | null>(null);
  const [dialogThumbnailExistingUrl, setDialogThumbnailExistingUrl] = useState<string | null>(null);
  const [dialogThumbnailRemoved, setDialogThumbnailRemoved] = useState(false);
  const [saving, setSaving] = useState(false);

  // Add vendor — vendorName has been replaced with a vendor picker
  // (`vendorId` + display label). The picker can also create a brand-new
  // vendor inline if no match is found.
  const [showAddVendor, setShowAddVendor] = useState(false);
  const [vendorForm, setVendorForm] = useState({
    vendorPartNumber: "", unitCost: "", leadTimeDays: "", isPrimary: false, notes: "",
  });
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(null);
  const [selectedVendorName, setSelectedVendorName] = useState("");
  const [vendorSearch, setVendorSearch] = useState("");
  const [vendorResults, setVendorResults] = useState<VendorSearchResult[]>([]);
  const [vendorSearching, setVendorSearching] = useState(false);

  // Link file
  const [showLinkFile, setShowLinkFile] = useState(false);
  const [fileSearch, setFileSearch] = useState("");
  const [fileResults, setFileResults] = useState<{ id: string; name: string; partNumber: string | null; lifecycleState: string }[]>([]);
  const [fileSearching, setFileSearching] = useState(false);
  const [fileRole, setFileRole] = useState("DRAWING");

  // File preview
  const [previewFile, setPreviewFile] = useState<{ id: string; name: string } | null>(null);

  // --- Data loading ---

  const loadParts = useCallback(async (q?: string, cat?: string, st?: string) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (cat && cat !== "all") params.set("category", cat);
    if (st && st !== "all") params.set("state", st);

    const res = await fetch(`/api/parts?${params}`);
    const data = await res.json();
    setParts(Array.isArray(data) ? data : []);
    setLoading(false);
  }, []);

  const loadPartDetail = useCallback(async (partId: string) => {
    setSelectedPartId(partId);
    setLoadingDetail(true);
    // Fetch the detail (for files/vendors management UI) and the unified
    // where-used payload (for the impact section) in parallel — both feed
    // different parts of the panel and neither blocks the other.
    const [detailRes, whereUsedRes] = await Promise.all([
      fetch(`/api/parts/${partId}`),
      fetch(`/api/parts/${partId}/where-used`),
    ]);
    const [detailData, whereUsedData] = await Promise.all([
      detailRes.json(),
      whereUsedRes.json(),
    ]);
    setDetail(detailData);
    setPartWhereUsed(whereUsedRes.ok ? whereUsedData : null);
    setLoadingDetail(false);
  }, []);

  useEffect(() => {
    void (async () => { await loadParts(); })();
  }, [loadParts]);

  // ─── Realtime ────────────────────────────────────────────────────────
  //
  // Any part insert/update/delete in this tenant refreshes the list.
  // When a detail panel is open, also refresh it on `eco_items` changes
  // so the "ECO History" section updates live as approvers act on an
  // ECO that touches this part — the synergy with the part-centric ECO
  // history added in the previous change. Same trick for `bom_items`:
  // when another user adds this part to a BOM, the "Used in BOMs"
  // list refreshes without the user hitting reload.
  useRealtimeTable({
    table: "parts",
    filter: `tenantId=eq.${user.tenantId}`,
    onChange: () => {
      void loadParts(searchQuery, categoryFilter, stateFilter);
      if (selectedPartId) void loadPartDetail(selectedPartId);
    },
  });
  useRealtimeTable({
    table: "eco_items",
    onChange: () => {
      if (selectedPartId) void loadPartDetail(selectedPartId);
    },
    enabled: !!selectedPartId,
  });
  useRealtimeTable({
    table: "bom_items",
    onChange: () => {
      if (selectedPartId) void loadPartDetail(selectedPartId);
    },
    enabled: !!selectedPartId,
  });

  // One-shot fetch of tenant settings to discover the numbering mode. Failure
  // is non-fatal — we fall back to AUTO and the server still enforces the rule.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/settings");
        if (!res.ok) return;
        const data = await res.json();
        const mode = data?.settings?.partNumberMode;
        if (mode === "MANUAL") setPartNumberMode("MANUAL");
      } catch { /* keep AUTO default */ }
    })();
  }, []);

  // Auto-select part from URL query param. Declared after loadPartDetail
  // so the effect can reference it without violating hook ordering rules.
  useEffect(() => {
    const partId = searchParams.get("partId");
    if (!partId || parts.length === 0 || selectedPartId) return;
    if (!parts.some((p) => p.id === partId)) return;
    void (async () => { await loadPartDetail(partId); })();
  }, [parts, searchParams, selectedPartId, loadPartDetail]);

  const debouncedSearch = useDebounce((q: string) => {
    loadParts(q, categoryFilter, stateFilter);
  }, 300);

  function handleSearchInput(q: string) {
    setSearchQuery(q);
    debouncedSearch(q);
  }

  function handleFilterChange(cat: string, st: string) {
    setCategoryFilter(cat);
    setStateFilter(st);
    loadParts(searchQuery, cat, st);
  }

  // --- File search for linking ---

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

  // --- Part CRUD ---

  function openCreateDialog() {
    setEditingPart(null);
    setFormData({ partNumber: "", name: "", description: "", category: "MANUFACTURED", material: "", unitCost: "", unit: "EA", notes: "" });
    setAttachFile(null);
    setAttachFileRole("DRAWING");
    setAttachMode("upload");
    setAttachLinkFileId(null);
    setAttachLinkFileName("");
    setAttachLinkSearch("");
    setAttachLinkResults([]);
    resetDialogThumbnail();
    setShowCreate(true);
  }

  function resetDialogThumbnail() {
    if (dialogThumbnailPreview && dialogThumbnailPreview.startsWith("blob:")) {
      URL.revokeObjectURL(dialogThumbnailPreview);
    }
    setDialogThumbnailFile(null);
    setDialogThumbnailPreview(null);
    setDialogThumbnailExistingUrl(null);
    setDialogThumbnailRemoved(false);
  }

  function openEditDialog(part: Part) {
    setEditingPart(part);
    setFormData({
      partNumber: part.partNumber, name: part.name, description: part.description || "",
      category: part.category, material: part.material || "",
      unitCost: part.unitCost != null ? String(part.unitCost) : "", unit: part.unit, notes: part.notes || "",
    });
    resetDialogThumbnail();
    setDialogThumbnailExistingUrl(part.thumbnailUrl || null);
    setShowCreate(true);
  }

  async function handleSavePart(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);

    // Strip partNumber when AUTO + creating: server will allocate the next
    // number from the per-tenant sequence. Editing always sends what's typed.
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

    // Thumbnail mutations run as a separate request because the storage
    // upload uses multipart form data — see /api/parts/[partId]/thumbnail.
    // Order matters: when both a remove and a new file are pending we
    // skip the explicit DELETE and let the upload overwrite the previous
    // object server-side.
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

    // If creating a new part with a file attached, upload and link it
    if (!editingPart && attachFile) {
      try {
        // Get root folder for upload destination
        const folderRes = await fetch("/api/folders");
        const folders = await folderRes.json();
        const rootFolder = Array.isArray(folders) ? folders[0] : null;
        if (rootFolder) {
          const formData = new FormData();
          formData.append("file", attachFile);
          formData.append("folderId", rootFolder.id);
          // Use the part number the server actually persisted (may be auto-allocated)
          formData.append("partNumber", partData.partNumber);
          if (typeof payload.description === "string") formData.append("description", payload.description);
          const fileRes = await fetch("/api/files", { method: "POST", body: formData });
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
        const res = await fetch(`/api/parts/${partData.id}/files`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileId: attachLinkFileId, role: attachFileRole, isPrimary: true }),
        });
        toast.success(res.ok ? "Part created with file linked" : "Part created, but file linking failed");
      } catch {
        toast.success("Part created, but file linking failed");
      }
    } else {
      toast.success(editingPart ? "Part updated" : "Part created");
    }

    setShowCreate(false);
    setAttachFile(null);
    setAttachFileRole("DRAWING");
    setAttachMode("upload");
    setAttachLinkFileId(null);
    setAttachLinkFileName("");
    setAttachLinkSearch("");
    setAttachLinkResults([]);
    resetDialogThumbnail();
    setSaving(false);
    loadParts(searchQuery, categoryFilter, stateFilter);
    if (editingPart && selectedPartId === editingPart.id) loadPartDetail(editingPart.id);
  }

  async function handleDeletePart(partId: string) {
    const res = await fetch(`/api/parts/${partId}`, { method: "DELETE" });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("Part deleted");
    if (selectedPartId === partId) { setSelectedPartId(null); setDetail(null); setPartWhereUsed(null); }
    loadParts(searchQuery, categoryFilter, stateFilter);
  }

  // --- Vendor picker + CRUD ---

  // Reset all add-vendor state when the dialog closes (or after a successful add)
  function resetVendorForm() {
    setVendorForm({ vendorPartNumber: "", unitCost: "", leadTimeDays: "", isPrimary: false, notes: "" });
    setSelectedVendorId(null);
    setSelectedVendorName("");
    setVendorSearch("");
    setVendorResults([]);
  }

  const doVendorSearch = useCallback(async (q: string) => {
    if (q.length < 1) { setVendorResults([]); setVendorSearching(false); return; }
    setVendorSearching(true);
    try {
      const res = await fetch(`/api/vendors?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setVendorResults(Array.isArray(data) ? data.slice(0, 8) : []);
    } catch { setVendorResults([]); }
    setVendorSearching(false);
  }, []);

  const debouncedVendorSearch = useDebounce(doVendorSearch, 250);

  function handleVendorSearchInput(q: string) {
    setVendorSearch(q);
    setSelectedVendorId(null);  // typing invalidates an earlier selection
    debouncedVendorSearch(q);
  }

  function selectVendor(v: VendorSearchResult) {
    setSelectedVendorId(v.id);
    setSelectedVendorName(v.name);
    setVendorSearch(v.name);
    setVendorResults([]);
  }

  // "Create new vendor" inline. The vendors POST endpoint is idempotent on
  // canonical name, so this is also a safe race-free way to recover if
  // someone else just created the same vendor.
  async function handleCreateInlineVendor() {
    const name = vendorSearch.trim();
    if (!name) return;
    const res = await fetch(`/api/vendors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    const created = await res.json();
    selectVendor({ id: created.id, name: created.name });
    toast.success(`Created vendor "${created.name}"`);
  }

  async function handleAddVendor(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPartId || !selectedVendorId) return;
    const res = await fetch(`/api/parts/${selectedPartId}/vendors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vendorId: selectedVendorId,
        vendorPartNumber: vendorForm.vendorPartNumber,
        unitCost: vendorForm.unitCost ? parseFloat(vendorForm.unitCost) : null,
        leadTimeDays: vendorForm.leadTimeDays ? parseInt(vendorForm.leadTimeDays) : null,
        isPrimary: vendorForm.isPrimary,
        notes: vendorForm.notes,
      }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("Vendor added");
    setShowAddVendor(false);
    resetVendorForm();
    loadPartDetail(selectedPartId);
  }

  // `linkId` is the part_vendors row id (the join row), not a vendor id.
  // The API still accepts the legacy `vendorId` field name in the body for
  // now to avoid a breaking change there.
  async function handleDeleteVendorLink(linkId: string) {
    if (!selectedPartId) return;
    await fetch(`/api/parts/${selectedPartId}/vendors`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vendorId: linkId }),
    });
    toast.success("Vendor removed");
    loadPartDetail(selectedPartId);
  }

  // --- File linking ---

  async function handleLinkFile(fileId: string) {
    if (!selectedPartId) return;
    const res = await fetch(`/api/parts/${selectedPartId}/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId, role: fileRole, isPrimary: detail?.files.length === 0 }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("File linked");
    setShowLinkFile(false);
    setFileSearch("");
    setFileResults([]);
    loadPartDetail(selectedPartId);
  }

  async function handleUnlinkFile(fileId: string) {
    if (!selectedPartId) return;
    await fetch(`/api/parts/${selectedPartId}/files`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileId }),
    });
    toast.success("File unlinked");
    loadPartDetail(selectedPartId);
  }

  // --- Thumbnail ---

  // Dialog picker: stage the picked File and show a local object URL as
  // preview. The actual storage upload happens after the part PUT/POST
  // succeeds, via the dedicated /api/parts/[partId]/thumbnail endpoint.
  function handleDialogThumbnailPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (dialogThumbnailPreview && dialogThumbnailPreview.startsWith("blob:")) {
      URL.revokeObjectURL(dialogThumbnailPreview);
    }
    setDialogThumbnailFile(file);
    setDialogThumbnailPreview(URL.createObjectURL(file));
    setDialogThumbnailRemoved(false);
  }

  function handleDialogThumbnailRemove() {
    if (dialogThumbnailPreview && dialogThumbnailPreview.startsWith("blob:")) {
      URL.revokeObjectURL(dialogThumbnailPreview);
    }
    setDialogThumbnailFile(null);
    setDialogThumbnailPreview(null);
    setDialogThumbnailExistingUrl(null);
    setDialogThumbnailRemoved(true);
  }

  // Detail-panel picker: in-place upload for an already-saved part. Hits
  // the dedicated thumbnail endpoint with multipart form data.
  async function handleThumbnailUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!selectedPartId || !e.target.files?.[0]) return;
    const file = e.target.files[0];
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/parts/${selectedPartId}/thumbnail`, { method: "POST", body: fd });
    if (res.ok) {
      toast.success("Thumbnail updated");
      loadPartDetail(selectedPartId);
      loadParts(searchQuery, categoryFilter, stateFilter);
    } else {
      const d = await res.json().catch(() => ({}));
      toast.error(d.error || "Thumbnail upload failed");
    }
    // Clear the input so picking the same file twice still fires onChange.
    e.target.value = "";
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Parts Library</h2>
        <Button size="sm" onClick={openCreateDialog}>
          <Plus className="w-4 h-4 mr-2" />
          New Part
        </Button>
      </div>

      {/* Search and filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => handleSearchInput(e.target.value)}
            placeholder="Search by part number, name, or description..."
            className="pl-8"
          />
        </div>
        <Select value={categoryFilter} onValueChange={(v) => handleFilterChange(v ?? "all", stateFilter)}>
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue placeholder="Category">
              {(v) => v === "all" ? "All Categories" : (CATEGORIES.find((c) => c.value === v)?.label ?? "Category")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {CATEGORIES.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={stateFilter} onValueChange={(v) => handleFilterChange(categoryFilter, v ?? "all")}>
          <SelectTrigger className="w-full sm:w-36">
            <SelectValue placeholder="State">
              {(v) => v === "all" ? "All States" : v}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All States</SelectItem>
            <SelectItem value="WIP">WIP</SelectItem>
            <SelectItem value="In Review">In Review</SelectItem>
            <SelectItem value="Released">Released</SelectItem>
            <SelectItem value="Obsolete">Obsolete</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="flex gap-4 flex-col lg:flex-row">
          {/* Parts table */}
          <div className="flex-1 min-w-0">
            {parts.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Package className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
                  <p className="text-muted-foreground">
                    {searchQuery || categoryFilter !== "all" || stateFilter !== "all"
                      ? "No parts match your search."
                      : "No parts yet. Click \"New Part\" to add one."}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="border rounded-lg bg-background overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10"></TableHead>
                      <TableHead>Part #</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Cost</TableHead>
                      <TableHead className="w-10"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parts.map((part) => (
                      <TableRow
                        key={part.id}
                        className={`cursor-pointer ${selectedPartId === part.id ? "bg-muted/50" : ""}`}
                        onClick={() => loadPartDetail(part.id)}
                      >
                        <TableCell>
                          {part.thumbnailUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={part.thumbnailUrl} alt="" className="w-8 h-8 rounded object-cover" />
                          ) : (
                            <div className="w-8 h-8 rounded bg-muted flex items-center justify-center">
                              <Package className="w-3.5 h-3.5 text-muted-foreground/40" />
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-sm">{part.partNumber}</TableCell>
                        <TableCell className="font-medium text-sm">{part.name}</TableCell>
                        <TableCell>
                          <Badge variant={categoryVariants[part.category] || "secondary"} className="text-[10px]">
                            {CATEGORIES.find((c) => c.value === part.category)?.label || part.category}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={stateVariants[part.lifecycleState] || "secondary"} className="text-[10px]">
                            {part.lifecycleState}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {part.unitCost != null ? `$${part.unitCost.toFixed(2)}` : "—"}
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <DropdownMenu>
                            <DropdownMenuTrigger render={
                              <Button variant="ghost" size="icon-xs"><MoreHorizontal className="w-3.5 h-3.5" /></Button>
                            } />
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => openEditDialog(part)}>
                                <Pencil className="w-3.5 h-3.5 mr-2" /> Edit
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-destructive" onClick={() => handleDeletePart(part.id)}>
                                <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          {/* Detail panel */}
          {selectedPartId && (
            <div className="lg:w-80 shrink-0 border rounded-lg bg-background">
              {loadingDetail || !detail ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="p-4 space-y-4">
                  {/* Header with thumbnail */}
                  <div className="flex items-start gap-3">
                    <label className="cursor-pointer shrink-0 group relative">
                      {detail.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={detail.thumbnailUrl} alt="" className="w-14 h-14 rounded-lg object-cover" />
                      ) : (
                        <div className="w-14 h-14 rounded-lg bg-muted flex items-center justify-center">
                          <ImageIcon className="w-5 h-5 text-muted-foreground/40" />
                        </div>
                      )}
                      <div className="absolute inset-0 bg-black/50 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <Upload className="w-4 h-4 text-white" />
                      </div>
                      <input type="file" accept="image/*" className="hidden" onChange={handleThumbnailUpload} />
                    </label>
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-sm text-muted-foreground">{detail.partNumber}</p>
                      <p className="font-semibold truncate">{detail.name}</p>
                      <div className="flex items-center gap-1.5 mt-1">
                        <Badge variant={categoryVariants[detail.category] || "secondary"} className="text-[9px]">
                          {CATEGORIES.find((c) => c.value === detail.category)?.label}
                        </Badge>
                        <Badge variant={stateVariants[detail.lifecycleState] || "secondary"} className="text-[9px]">
                          {detail.lifecycleState}
                        </Badge>
                      </div>
                    </div>
                    <Button variant="ghost" size="icon-xs" onClick={() => { setSelectedPartId(null); setDetail(null); setPartWhereUsed(null); }}>
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>

                  {detail.description && (
                    <p className="text-sm text-muted-foreground">{detail.description}</p>
                  )}

                  {/* Properties */}
                  <div className="grid grid-cols-2 gap-y-2 text-sm">
                    <span className="text-muted-foreground">Revision</span>
                    <span className="font-mono">{detail.revision}</span>
                    <span className="text-muted-foreground">Unit</span>
                    <span>{detail.unit}</span>
                    {detail.material && <>
                      <span className="text-muted-foreground">Material</span>
                      <span>{detail.material}</span>
                    </>}
                    {detail.unitCost != null && <>
                      <span className="text-muted-foreground">Cost</span>
                      <span className="font-mono">${detail.unitCost.toFixed(2)}</span>
                    </>}
                    {detail.weight != null && <>
                      <span className="text-muted-foreground">Weight</span>
                      <span>{detail.weight} {detail.weightUnit}</span>
                    </>}
                  </div>

                  <Separator />

                  {/* Linked Files */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-semibold text-muted-foreground uppercase">Files</p>
                      <Button variant="ghost" size="icon-xs" onClick={() => setShowLinkFile(true)}>
                        <Plus className="w-3 h-3" />
                      </Button>
                    </div>
                    {detail.files.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No files linked.</p>
                    ) : (
                      <div className="space-y-1">
                        {detail.files.map((pf) => {
                          const f = pf.file as unknown as { id: string; name: string; revision: string; lifecycleState: string; fileType: string };
                          return (
                            <div key={pf.id} className="flex items-center gap-2 text-sm group">
                              <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <button className="truncate hover:underline text-left flex-1" onClick={() => setPreviewFile({ id: f.id, name: f.name })}>
                                {f.name}
                              </button>
                              <span className="text-[10px] text-muted-foreground">{pf.role}</span>
                              <button onClick={() => handleUnlinkFile(f.id)} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive">
                                <X className="w-3 h-3" />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <Separator />

                  {/* Vendors */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-semibold text-muted-foreground uppercase">Vendors</p>
                      <Button variant="ghost" size="icon-xs" onClick={() => setShowAddVendor(true)}>
                        <Plus className="w-3 h-3" />
                      </Button>
                    </div>
                    {detail.vendors.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No vendors added.</p>
                    ) : (
                      <div className="space-y-2">
                        {detail.vendors.map((v) => (
                          <div key={v.id} className="text-sm border rounded-md p-2 group relative">
                            <div className="flex items-center gap-1.5">
                              <Building2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <span className="font-medium">{v.vendor?.name ?? "(unknown vendor)"}</span>
                              {v.isPrimary && <Badge variant="info" className="text-[9px] px-1 py-0">Primary</Badge>}
                            </div>
                            {v.vendorPartNumber && <p className="text-xs text-muted-foreground mt-0.5 ml-5">PN: {v.vendorPartNumber}</p>}
                            <div className="flex gap-3 ml-5 mt-0.5 text-xs text-muted-foreground">
                              {v.unitCost != null && <span>${v.unitCost.toFixed(2)}</span>}
                              {v.leadTimeDays != null && <span>{v.leadTimeDays}d lead</span>}
                            </div>
                            <button
                              onClick={() => handleDeleteVendorLink(v.id)}
                              className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <Separator />

                  {/* Unified where-used / impact section. Covers BOMs that
                      line-item this part, transitive parent assemblies (via
                      bom→file→part_files walk), and every ECO that has
                      touched this part. Empty state is the section-level
                      fallback when there are no references in any category. */}
                  {partWhereUsed &&
                  partWhereUsed.boms.length +
                    partWhereUsed.parentParts.length +
                    partWhereUsed.ecos.length >
                    0 ? (
                    <WhereUsedSection
                      boms={partWhereUsed.boms}
                      parentParts={partWhereUsed.parentParts}
                      ecos={partWhereUsed.ecos}
                      onNavigateBom={() => router.push("/boms")}
                      onNavigatePart={(partId) => loadPartDetail(partId)}
                      onNavigateEco={(ecoId) => router.push(`/ecos?ecoId=${ecoId}`)}
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground">Not used anywhere yet.</p>
                  )}

                  {detail.notes && (
                    <>
                      <Separator />
                      <div>
                        <p className="text-xs font-semibold text-muted-foreground uppercase mb-1">Notes</p>
                        <p className="text-sm text-muted-foreground">{detail.notes}</p>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Create/Edit Part Dialog */}
      <Dialog open={showCreate} onOpenChange={(open) => { if (!open) setShowCreate(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingPart ? "Edit Part" : "New Part"}</DialogTitle>
            <DialogDescription>
              {editingPart ? "Update this part's properties." : "Add a new part to your library."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSavePart}>
            <div className="space-y-4 py-4">
              {(() => {
                const previewSrc = dialogThumbnailPreview || dialogThumbnailExistingUrl;
                return (
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
                      <input
                        ref={dialogThumbnailRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={handleDialogThumbnailPick}
                      />
                    </label>
                    <div className="flex-1 min-w-0 space-y-1">
                      <Label className="text-xs">Thumbnail</Label>
                      <p className="text-[11px] text-muted-foreground">Click the image to {previewSrc ? "replace" : "upload"}. Stored in Supabase Storage on save.</p>
                      {previewSrc && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          onClick={handleDialogThumbnailRemove}
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })()}
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
                          // Results render inline (in-flow) instead of as an
                          // absolutely-positioned overlay. When the dialog is
                          // near the bottom of the viewport an overlay dropdown
                          // extends past the dialog boundary because DialogContent
                          // isn't a positioning context for it; pushing the
                          // rest of the form down with a normal-flow list keeps
                          // the whole picker inside the modal.
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
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
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

      {/* Add Vendor Dialog */}
      <Dialog open={showAddVendor} onOpenChange={(open) => { if (!open) { setShowAddVendor(false); resetVendorForm(); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Vendor</DialogTitle>
            <DialogDescription>Link an approved vendor to this part. Pick from existing or create new.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAddVendor}>
            <div className="space-y-4 py-4">
              {/* Vendor picker — search-as-you-type with inline create */}
              <div className="space-y-1">
                <Label className="text-xs">Vendor</Label>
                {selectedVendorId ? (
                  <div className="flex items-center gap-2 border rounded-md px-2 py-1.5 text-sm bg-muted/30">
                    <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="flex-1 truncate">{selectedVendorName}</span>
                    <button type="button" onClick={() => { setSelectedVendorId(null); setSelectedVendorName(""); setVendorSearch(""); }} className="text-muted-foreground hover:text-destructive">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <Input
                      value={vendorSearch}
                      onChange={(e) => handleVendorSearchInput(e.target.value)}
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
                    {/* "Create new" affordance — only when there's a query and
                        no exact match in the current results */}
                    {vendorSearch.trim().length > 0 && !vendorSearching && !vendorResults.some((v) => v.name.toLowerCase() === vendorSearch.trim().toLowerCase()) && (
                      <button
                        type="button"
                        onClick={handleCreateInlineVendor}
                        className="mt-1 text-xs text-primary hover:underline flex items-center gap-1"
                      >
                        <Plus className="w-3 h-3" /> Create &ldquo;{vendorSearch.trim()}&rdquo; as new vendor
                      </button>
                    )}
                  </div>
                )}
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Vendor Part #</Label>
                <Input value={vendorForm.vendorPartNumber} onChange={(e) => setVendorForm({ ...vendorForm, vendorPartNumber: e.target.value })} placeholder="91290A197" className="h-8 text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Unit Cost ($)</Label>
                  <Input type="number" value={vendorForm.unitCost} onChange={(e) => setVendorForm({ ...vendorForm, unitCost: e.target.value })} placeholder="0.00" className="h-8 text-sm" min="0" step="0.01" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Lead Time (days)</Label>
                  <Input type="number" value={vendorForm.leadTimeDays} onChange={(e) => setVendorForm({ ...vendorForm, leadTimeDays: e.target.value })} placeholder="14" className="h-8 text-sm" min="0" />
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
                <Label htmlFor="isPrimaryVendor" className="text-xs cursor-pointer">Primary vendor (used for BOM cost rollup)</Label>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Notes</Label>
                <Input value={vendorForm.notes} onChange={(e) => setVendorForm({ ...vendorForm, notes: e.target.value })} placeholder="Optional notes..." className="h-8 text-sm" />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setShowAddVendor(false); resetVendorForm(); }}>Cancel</Button>
              <Button type="submit" disabled={!selectedVendorId}>Add Vendor</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Link File Dialog */}
      <Dialog open={showLinkFile} onOpenChange={(open) => { if (!open) { setShowLinkFile(false); setFileSearch(""); setFileResults([]); } }}>
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

      {/* File Preview Dialog */}
      <Dialog open={!!previewFile} onOpenChange={(open) => { if (!open) setPreviewFile(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="w-4 h-4" />
              {previewFile?.name}
            </DialogTitle>
            <DialogDescription>File preview</DialogDescription>
          </DialogHeader>
          {previewFile && <FilePreviewInline fileId={previewFile.id} />}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" size="sm" onClick={() => { window.open(`/api/files/${previewFile?.id}/download`, "_blank"); }}>
              <Download className="w-3.5 h-3.5 mr-1.5" />Download
            </Button>
            <Button variant="outline" size="sm" onClick={() => { router.push(`/vault?fileId=${previewFile?.id}`); setPreviewFile(null); }}>
              <ExternalLink className="w-3.5 h-3.5 mr-1.5" />Open in Vault
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FilePreviewInline({ fileId }: { fileId: string }) {
  const [preview, setPreview] = useState<{
    canPreview: boolean;
    previewType?: string;
    fileType?: string;
    url?: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    fetch(`/api/files/${fileId}/preview`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Preview failed: ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (cancelled) return;
        setPreview(d);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || err?.name === "AbortError") return;
        setPreview(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fileId]);

  if (loading) return <p className="text-sm text-muted-foreground text-center py-8">Loading preview...</p>;
  if (!preview || !preview.canPreview) {
    return (
      <div className="text-center py-8">
        <FileText className="w-10 h-10 mx-auto mb-2 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">Preview not available for .{preview?.fileType || "unknown"} files</p>
      </div>
    );
  }

  if (preview.previewType === "image") {
    return (
      <div className="flex items-center justify-center bg-muted/30 rounded-lg p-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={preview.url} alt="File preview" className="max-w-full max-h-80 object-contain rounded" />
      </div>
    );
  }

  if (preview.previewType === "pdf") {
    return (
      <div className="w-full rounded-lg border overflow-hidden" style={{ height: "60vh", minHeight: "350px" }}>
        <object data={preview.url} type="application/pdf" className="w-full h-full">
          <div className="flex flex-col items-center justify-center h-full gap-3 p-4">
            <FileText className="w-10 h-10 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">PDF preview unavailable in this browser</p>
            <a href={preview.url} target="_blank" rel="noopener noreferrer" className="text-sm text-primary underline">
              Open PDF directly
            </a>
          </div>
        </object>
      </div>
    );
  }

  if (preview.previewType === "text") {
    return <TextPreviewInline url={preview.url!} />;
  }

  return null;
}

function TextPreviewInline({ url }: { url: string }) {
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    fetch(url)
      .then((r) => r.text())
      .then((t) => setContent(t.slice(0, 5000)))
      .catch(() => setContent("Failed to load"));
  }, [url]);

  if (!content) return <p className="text-sm text-muted-foreground text-center py-4">Loading...</p>;

  return (
    <pre className="text-xs bg-muted/30 rounded-lg p-3 overflow-x-auto max-h-80 whitespace-pre-wrap font-mono">
      {content}
    </pre>
  );
}
