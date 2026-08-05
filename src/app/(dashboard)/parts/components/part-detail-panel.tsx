"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { Separator } from "@/components/ui/separator";
import { WhereUsedSection } from "@/components/where-used-section";
import type { PartWhereUsed } from "@/lib/where-used";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, X, FileText, Building2, ImageIcon, Upload, Loader2 } from "lucide-react";
import type { PartDetail, PartVendorLink } from "../parts-types";
import { CATEGORIES, categoryVariants } from "../parts-types";

interface PartDetailPanelProps {
  detail: PartDetail | null;
  loading: boolean;
  partWhereUsed: PartWhereUsed | null;
  onClose: () => void;
  onThumbnailUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onShowLinkFile: () => void;
  onShowAddVendor: () => void;
  onUnlinkFile: (fileId: string) => void;
  onDeleteVendorLink: (linkId: string) => void;
  onPreviewFile: (file: { id: string; name: string }) => void;
  onNavigatePartDetail: (partId: string) => void;
  /** Declare/undeclare the part as an end item. */
  onToggleEndItem: (isEndItem: boolean) => void;
}

export function PartDetailPanel({
  detail,
  loading,
  partWhereUsed,
  onClose,
  onThumbnailUpload,
  onShowLinkFile,
  onShowAddVendor,
  onUnlinkFile,
  onDeleteVendorLink,
  onPreviewFile,
  onNavigatePartDetail,
  onToggleEndItem,
}: PartDetailPanelProps) {
  const router = useRouter();

  if (loading || !detail) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
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
            <input type="file" accept="image/*" className="hidden" onChange={onThumbnailUpload} />
          </label>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-sm text-muted-foreground">{detail.partNumber}</p>
            <p className="font-semibold truncate">{detail.name}</p>
            <div className="flex items-center gap-1.5 mt-1">
              <Badge
                variant={categoryVariants[detail.category] || "secondary"}
                className="text-4xs"
              >
                {CATEGORIES.find((c) => c.value === detail.category)?.label}
              </Badge>
              <StatusBadge status={detail.lifecycleState} kind="lifecycle" className="text-4xs" />
            </div>
          </div>
          <Button variant="ghost" size="icon-xs" onClick={onClose}>
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>

        {detail.description && (
          <p className="text-sm text-muted-foreground">{detail.description}</p>
        )}

        {/*
          End item designation. Deliberately declared here rather than
          inferred from whether anything uses the part: a spare you sell is
          both a component and a product, and no arrangement of BOM rows can
          tell you which parts you sell. See
          docs/decisions/bom-structure.md.
        */}
        <label className="flex items-start gap-2.5 rounded-md border border-border/60 p-2.5 cursor-pointer hover:bg-foreground/5">
          <Checkbox
            checked={detail.isEndItem === true}
            onCheckedChange={(checked) => onToggleEndItem(checked === true)}
            className="mt-0.5"
          />
          <span className="min-w-0">
            <span className="text-sm block">End item</span>
            <span className="text-xs text-muted-foreground block">
              Sold or shipped on its own. Its BOM is listed as a product, even when the part is also
              used inside something else.
            </span>
          </span>
        </label>

        {/* Properties */}
        <div className="grid grid-cols-2 gap-y-2 text-sm">
          <span className="text-muted-foreground">Revision</span>
          <span className="font-mono">{detail.revision}</span>
          <span className="text-muted-foreground">Unit</span>
          <span>{detail.unit}</span>
          {detail.material && (
            <>
              <span className="text-muted-foreground">Material</span>
              <span>{detail.material}</span>
            </>
          )}
          {detail.unitCost != null && (
            <>
              <span className="text-muted-foreground">Cost</span>
              <span className="font-mono">${detail.unitCost.toFixed(2)}</span>
            </>
          )}
          {detail.weight != null && (
            <>
              <span className="text-muted-foreground">Weight</span>
              <span>
                {detail.weight} {detail.weightUnit}
              </span>
            </>
          )}
        </div>

        <Separator />

        {/* Linked Files */}
        <LinkedFilesSection
          files={detail.files}
          onShowLinkFile={onShowLinkFile}
          onPreviewFile={onPreviewFile}
          onUnlinkFile={onUnlinkFile}
        />

        <Separator />

        {/* Vendors */}
        <VendorsSection
          vendors={detail.vendors}
          onShowAddVendor={onShowAddVendor}
          onDeleteVendorLink={onDeleteVendorLink}
        />

        <Separator />

        {/* Where Used */}
        {partWhereUsed &&
        partWhereUsed.boms.length + partWhereUsed.parentParts.length + partWhereUsed.ecos.length >
          0 ? (
          <WhereUsedSection
            boms={partWhereUsed.boms}
            parentParts={partWhereUsed.parentParts}
            ecos={partWhereUsed.ecos}
            onNavigateBom={(bomId) => router.push(`/boms/${bomId}`)}
            onNavigatePart={(partId) => onNavigatePartDetail(partId)}
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
    </div>
  );
}

function LinkedFilesSection({
  files,
  onShowLinkFile,
  onPreviewFile,
  onUnlinkFile,
}: {
  files: PartDetail["files"];
  onShowLinkFile: () => void;
  onPreviewFile: (file: { id: string; name: string }) => void;
  onUnlinkFile: (fileId: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase">Files</p>
        <Button variant="ghost" size="icon-xs" onClick={onShowLinkFile}>
          <Plus className="w-3 h-3" />
        </Button>
      </div>
      {files.length === 0 ? (
        <p className="text-xs text-muted-foreground">No files linked.</p>
      ) : (
        <div className="space-y-1">
          {files.map((pf) => {
            const f = pf.file as unknown as {
              id: string;
              name: string;
              revision: string;
              lifecycleState: string;
              fileType: string;
            };
            return (
              <div key={pf.id} className="flex items-center gap-2 text-sm group">
                <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <button
                  className="truncate hover:underline text-left flex-1"
                  onClick={() => onPreviewFile({ id: f.id, name: f.name })}
                >
                  {f.name}
                </button>
                <span className="text-3xs text-muted-foreground">{pf.role}</span>
                <button
                  onClick={() => onUnlinkFile(f.id)}
                  className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function VendorsSection({
  vendors,
  onShowAddVendor,
  onDeleteVendorLink,
}: {
  vendors: PartVendorLink[];
  onShowAddVendor: () => void;
  onDeleteVendorLink: (linkId: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase">Vendors</p>
        <Button variant="ghost" size="icon-xs" onClick={onShowAddVendor}>
          <Plus className="w-3 h-3" />
        </Button>
      </div>
      {vendors.length === 0 ? (
        <p className="text-xs text-muted-foreground">No vendors added.</p>
      ) : (
        <div className="space-y-2">
          {vendors.map((v) => (
            <div key={v.id} className="text-sm border rounded-md p-2 group relative">
              <div className="flex items-center gap-1.5">
                <Building2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span className="font-medium">{v.vendor?.name ?? "(unknown vendor)"}</span>
                {v.isPrimary && (
                  <Badge variant="info" className="text-4xs px-1 py-0">
                    Primary
                  </Badge>
                )}
              </div>
              {v.vendorPartNumber && (
                <p className="text-xs text-muted-foreground mt-0.5 ml-5">
                  PN: {v.vendorPartNumber}
                </p>
              )}
              <div className="flex gap-3 ml-5 mt-0.5 text-xs text-muted-foreground">
                {v.unitCost != null && <span>${v.unitCost.toFixed(2)}</span>}
                {v.leadTimeDays != null && <span>{v.leadTimeDays}d lead</span>}
              </div>
              <button
                onClick={() => onDeleteVendorLink(v.id)}
                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
