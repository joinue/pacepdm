"use client";

// Shared display for "where-used / impact" data.
//
// The component is presentation-only: it doesn't fetch, mutate, or
// route. Callers pass in the already-resolved payload from one of
// the where-used endpoints plus a set of navigation callbacks. This
// is deliberate — the file detail panel and the parts detail panel
// each have their own routing quirks (BOMs have no deep link today,
// ECOs use `?ecoId=`, parts use `?id=`), so we let the caller decide
// what happens on click rather than baking URLs in here.
//
// Every category is rendered as its own sub-section. Categories with
// no rows are hidden so the section collapses cleanly for isolated
// parts/files. The whole component renders nothing at all when every
// category is empty — the parent can decide whether to show an
// empty-state message or just drop the section.

import { Badge } from "@/components/ui/badge";
import { Package, FileText, GitBranch, ClipboardList, ArrowUpRight, Star } from "lucide-react";
import type {
  WhereUsedBom,
  WhereUsedPart,
  WhereUsedFile,
  WhereUsedEco,
} from "@/lib/where-used";

type EcoStatusVariant = "muted" | "info" | "warning" | "success" | "error" | "purple";

// Local ECO status → badge variant map. Duplicated across the codebase
// in a few places (parts page, search page, file detail panel) —
// consolidating that is out of scope for this change.
const ECO_STATUS_VARIANTS: Record<string, EcoStatusVariant> = {
  DRAFT: "muted",
  SUBMITTED: "info",
  IN_REVIEW: "warning",
  APPROVED: "success",
  REJECTED: "error",
  IMPLEMENTED: "success",
  CLOSED: "muted",
};

const BOM_STATUS_VARIANTS: Record<string, EcoStatusVariant> = {
  DRAFT: "muted",
  ACTIVE: "success",
  RELEASED: "success",
  OBSOLETE: "error",
};

export interface WhereUsedSectionProps {
  /** Header shown above the first non-empty sub-section. Hidden when every list is empty. */
  title?: string;
  boms?: WhereUsedBom[];
  /** "BOMs this item represents" (files only — when boms.fileId = fileId). */
  representsBoms?: WhereUsedBom[];
  linkedParts?: WhereUsedPart[];
  linkedFiles?: WhereUsedFile[];
  /** Transitive parent assemblies (parts only). */
  parentParts?: WhereUsedPart[];
  ecos?: WhereUsedEco[];
  /** Click handlers. All optional — when omitted, rows render as plain text. */
  onNavigateBom?: (bomId: string) => void;
  onNavigatePart?: (partId: string) => void;
  onNavigateFile?: (fileId: string) => void;
  onNavigateEco?: (ecoId: string) => void;
}

export function WhereUsedSection({
  title = "Where used",
  boms = [],
  representsBoms = [],
  linkedParts = [],
  linkedFiles = [],
  parentParts = [],
  ecos = [],
  onNavigateBom,
  onNavigatePart,
  onNavigateFile,
  onNavigateEco,
}: WhereUsedSectionProps) {
  const total =
    boms.length +
    representsBoms.length +
    linkedParts.length +
    linkedFiles.length +
    parentParts.length +
    ecos.length;
  if (total === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground uppercase">{title}</p>
        <span className="text-[10px] text-muted-foreground">{total} reference{total === 1 ? "" : "s"}</span>
      </div>

      {parentParts.length > 0 && (
        <SubSection label="Parent assemblies" count={parentParts.length} icon={<GitBranch className="w-3 h-3" />}>
          {parentParts.map((p) => (
            <PartRow key={p.partId} part={p} onClick={onNavigatePart} showDepth />
          ))}
        </SubSection>
      )}

      {representsBoms.length > 0 && (
        <SubSection label="Represents BOM" count={representsBoms.length} icon={<ClipboardList className="w-3 h-3" />}>
          {representsBoms.map((b) => (
            <BomRow key={b.bomId} bom={b} showQuantity={false} onClick={onNavigateBom} />
          ))}
        </SubSection>
      )}

      {boms.length > 0 && (
        <SubSection label="Used in BOMs" count={boms.length} icon={<ClipboardList className="w-3 h-3" />}>
          {boms.map((b) => (
            <BomRow key={`${b.bomId}-${b.quantity}`} bom={b} onClick={onNavigateBom} />
          ))}
        </SubSection>
      )}

      {linkedParts.length > 0 && (
        <SubSection label="Linked parts" count={linkedParts.length} icon={<Package className="w-3 h-3" />}>
          {linkedParts.map((p) => (
            <PartRow key={p.partId} part={p} onClick={onNavigatePart} />
          ))}
        </SubSection>
      )}

      {linkedFiles.length > 0 && (
        <SubSection label="Linked files" count={linkedFiles.length} icon={<FileText className="w-3 h-3" />}>
          {linkedFiles.map((f) => (
            <FileRow key={f.fileId} file={f} onClick={onNavigateFile} />
          ))}
        </SubSection>
      )}

      {ecos.length > 0 && (
        <SubSection label="Related ECOs" count={ecos.length} icon={<ArrowUpRight className="w-3 h-3" />}>
          {ecos.map((e) => (
            <EcoRow key={e.ecoId} eco={e} onClick={onNavigateEco} />
          ))}
        </SubSection>
      )}
    </div>
  );
}

function SubSection({
  label,
  count,
  icon,
  children,
}: {
  label: string;
  count: number;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        {icon}
        <span>{label}</span>
        <span className="text-muted-foreground/60">({count})</span>
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function RowShell({
  onClick,
  children,
}: {
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const className =
    "w-full text-left flex items-center gap-1.5 text-xs px-2 py-1 rounded transition-colors";
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`${className} hover:bg-muted/50`}>
        {children}
      </button>
    );
  }
  return <div className={className}>{children}</div>;
}

function BomRow({
  bom,
  showQuantity = true,
  onClick,
}: {
  bom: WhereUsedBom;
  showQuantity?: boolean;
  onClick?: (bomId: string) => void;
}) {
  return (
    <RowShell onClick={onClick ? () => onClick(bom.bomId) : undefined}>
      <span className="font-medium truncate flex-1">{bom.bomName}</span>
      {showQuantity && bom.quantity > 0 && (
        <span className="text-[10px] text-muted-foreground shrink-0 font-mono">
          ×{bom.quantity} {bom.unit}
        </span>
      )}
      <span className="text-[10px] text-muted-foreground shrink-0 font-mono">Rev {bom.bomRevision}</span>
      <Badge variant={BOM_STATUS_VARIANTS[bom.bomStatus] || "muted"} className="text-[9px] px-1 py-0 shrink-0">
        {bom.bomStatus}
      </Badge>
    </RowShell>
  );
}

function PartRow({
  part,
  onClick,
  showDepth = false,
}: {
  part: WhereUsedPart;
  onClick?: (partId: string) => void;
  showDepth?: boolean;
}) {
  return (
    <RowShell onClick={onClick ? () => onClick(part.partId) : undefined}>
      <Package className="w-3 h-3 text-muted-foreground shrink-0" />
      <span className="font-mono shrink-0">{part.partNumber}</span>
      <span className="truncate text-muted-foreground flex-1">{part.name}</span>
      {part.isPrimary && <Star className="w-2.5 h-2.5 text-amber-500 shrink-0" />}
      {part.role && <span className="text-[10px] text-muted-foreground shrink-0">{part.role}</span>}
      {showDepth && typeof part.depth === "number" && part.depth > 0 && (
        <span className="text-[10px] text-muted-foreground/70 shrink-0">L{part.depth}</span>
      )}
      <span className="text-[10px] text-muted-foreground shrink-0 font-mono">Rev {part.revision}</span>
    </RowShell>
  );
}

function FileRow({
  file,
  onClick,
}: {
  file: WhereUsedFile;
  onClick?: (fileId: string) => void;
}) {
  return (
    <RowShell onClick={onClick ? () => onClick(file.fileId) : undefined}>
      <FileText className="w-3 h-3 text-muted-foreground shrink-0" />
      <span className="truncate flex-1">{file.name}</span>
      {file.isPrimary && <Star className="w-2.5 h-2.5 text-amber-500 shrink-0" />}
      {file.role && <span className="text-[10px] text-muted-foreground shrink-0">{file.role}</span>}
      <span className="text-[10px] text-muted-foreground shrink-0 font-mono">Rev {file.revision}</span>
    </RowShell>
  );
}

function EcoRow({
  eco,
  onClick,
}: {
  eco: WhereUsedEco;
  onClick?: (ecoId: string) => void;
}) {
  return (
    <RowShell onClick={onClick ? () => onClick(eco.ecoId) : undefined}>
      <span className="font-mono shrink-0">{eco.ecoNumber}</span>
      <span className="truncate text-muted-foreground flex-1">{eco.title}</span>
      {eco.changeType && (
        <span className="text-[10px] text-muted-foreground shrink-0">{eco.changeType}</span>
      )}
      {eco.fromRevision && eco.toRevision && (
        <span className="text-[10px] font-mono text-muted-foreground shrink-0">
          {eco.fromRevision} → {eco.toRevision}
        </span>
      )}
      <Badge variant={ECO_STATUS_VARIANTS[eco.status] || "muted"} className="text-[9px] px-1 py-0 shrink-0">
        {eco.status}
      </Badge>
    </RowShell>
  );
}
