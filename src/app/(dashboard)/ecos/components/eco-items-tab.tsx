"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, Loader2, FileText, Trash2 } from "lucide-react";
import { fetchJson, errorMessage } from "@/lib/api-client";
import { changeTypeLabels } from "../constants";
import type { ECOItem } from "../types";

interface EcoItemsTabProps {
  ecoId: string;
  ecoStatus: string;
  items: ECOItem[];
  loading: boolean;
  onAddClick: () => void;
  onItemRemoved: () => void;
}

/**
 * "Affected Items" tab. Lists files linked to the ECO with their change
 * type. Add/remove buttons only show in DRAFT.
 */
export function EcoItemsTab({
  ecoId,
  ecoStatus,
  items,
  loading,
  onAddClick,
  onItemRemoved,
}: EcoItemsTabProps) {
  const isDraft = ecoStatus === "DRAFT";

  async function handleRemove(itemId: string) {
    try {
      await fetchJson(`/api/ecos/${ecoId}/items`, {
        method: "DELETE",
        body: { itemId },
      });
      toast.success("Item removed");
      onItemRemoved();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <ScrollArea className="h-[calc(100vh-22rem)]">
      <div className="space-y-3 pr-1">
        {isDraft && (
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {items.length} file{items.length !== 1 ? "s" : ""} affected by this change
            </p>
            <Button size="sm" variant="outline" onClick={onAddClick}>
              <Plus className="w-3.5 h-3.5 mr-1.5" />Add File
            </Button>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="font-medium text-sm">No affected items</p>
            <p className="text-xs mt-1.5">
              {isDraft
                ? "Add the files that this ECO will change, add, or remove."
                : "No files were linked to this ECO."}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => {
              const ct = changeTypeLabels[item.changeType] || { label: item.changeType, variant: "info" as const };
              return (
                <div key={item.id} className="flex items-start gap-3 p-3 rounded-lg border bg-background group">
                  <FileText className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{item.file.name}</span>
                      <Badge variant={ct.variant} className="text-[10px] shrink-0">{ct.label}</Badge>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                      {item.file.partNumber && <span>{item.file.partNumber}</span>}
                      {item.file.partNumber && <span>&middot;</span>}
                      <span>{item.file.lifecycleState}</span>
                      <span>&middot;</span>
                      <span>v{item.file.currentVersion}</span>
                    </div>
                    {item.reason && (
                      <p className="text-xs text-muted-foreground mt-1.5 italic">{item.reason}</p>
                    )}
                  </div>
                  {isDraft && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 text-destructive shrink-0"
                      onClick={() => handleRemove(item.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
