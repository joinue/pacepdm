"use client";

import { Badge } from "@/components/ui/badge";
import { FormattedDate } from "@/components/ui/formatted-date";
import { ClipboardList, Loader2 } from "lucide-react";
import { statusVariants, priorityVariants } from "../constants";
import type { ECO } from "../types";

interface EcoListProps {
  ecos: ECO[];
  loading: boolean;
  selectedEcoId: string | null;
  onSelect: (eco: ECO) => void;
}

/**
 * Left-side list of ECOs. Each card shows ECO number, status, priority,
 * title, and a snippet of the description. Selected card gets a primary
 * border highlight.
 */
export function EcoList({ ecos, loading, selectedEcoId, onSelect }: EcoListProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (ecos.length === 0) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <ClipboardList className="w-10 h-10 mx-auto mb-3 opacity-30" />
        <p className="font-medium">No ECOs yet</p>
        <p className="text-sm mt-1">Create one to start tracking engineering changes.</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {ecos.map((eco) => (
        <div
          key={eco.id}
          onClick={() => onSelect(eco)}
          className={`border rounded-lg p-3.5 cursor-pointer transition-all ${
            selectedEcoId === eco.id
              ? "border-primary bg-primary/5 shadow-sm"
              : "bg-background hover:border-foreground/20 hover:shadow-sm"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[11px] font-mono text-muted-foreground">{eco.ecoNumber}</span>
                <Badge variant={statusVariants[eco.status] || "muted"} className="text-[10px]">
                  {eco.status.replace("_", " ")}
                </Badge>
              </div>
              <p className="font-medium text-sm leading-snug">{eco.title}</p>
              {eco.description && (
                <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{eco.description}</p>
              )}
            </div>
            <Badge variant={priorityVariants[eco.priority] || "muted"} className="text-[10px] shrink-0">
              {eco.priority}
            </Badge>
          </div>
          <p className="text-[10px] text-muted-foreground/60 mt-2">
            <FormattedDate date={eco.createdAt} variant="date" />
          </p>
        </div>
      ))}
    </div>
  );
}
