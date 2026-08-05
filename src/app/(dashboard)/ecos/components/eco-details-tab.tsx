"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge } from "@/components/ui/status-badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FormattedDate } from "@/components/ui/formatted-date";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Pencil } from "lucide-react";
import { fetchJson, errorMessage } from "@/lib/api-client";
import {
  EFFECTIVITY_LABELS,
  EFFECTIVITY_TYPES,
  formatEffectivity,
  fromDateInputValue,
  toDateInputValue,
  validateEffectivity,
  type EffectivityType,
} from "../effectivity";
import {
  reasonLabels,
  changeTypeLabelsEco,
  costImpactLabels,
  dispositionLabels,
} from "../constants";
import type { ECO } from "../types";

interface EcoDetailsTabProps {
  eco: ECO;
  /** Called with the updated ECO so the parent can refresh state. */
  onUpdated: (eco: ECO) => void;
}

/**
 * "Details" tab of the ECO detail panel. Shows the ECO's metadata in a
 * read-only grid by default; switching to edit mode replaces it with a
 * form. Edit is only allowed in DRAFT (server enforces this too).
 */
export function EcoDetailsTab({ eco, onUpdated }: EcoDetailsTabProps) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Form fields — initialised when editing starts
  const [title, setTitle] = useState(eco.title);
  const [description, setDescription] = useState(eco.description || "");
  const [priority, setPriority] = useState(eco.priority);
  const [reason, setReason] = useState(eco.reason || "");
  const [changeType, setChangeType] = useState(eco.changeType || "");
  const [costImpact, setCostImpact] = useState(eco.costImpact || "");
  const [disposition, setDisposition] = useState(eco.disposition || "");
  const [effectivity, setEffectivity] = useState(eco.effectivity || "");
  const [effectivityType, setEffectivityType] = useState<EffectivityType | "">(
    eco.effectivityType || ""
  );
  const [effectiveFrom, setEffectiveFrom] = useState(toDateInputValue(eco.effectiveFrom));
  const [effectiveSerial, setEffectiveSerial] = useState(eco.effectiveSerial || "");

  function startEditing() {
    setTitle(eco.title);
    setDescription(eco.description || "");
    setPriority(eco.priority);
    setReason(eco.reason || "");
    setChangeType(eco.changeType || "");
    setCostImpact(eco.costImpact || "");
    setDisposition(eco.disposition || "");
    setEffectivity(eco.effectivity || "");
    setEffectivityType(eco.effectivityType || "");
    setEffectiveFrom(toDateInputValue(eco.effectiveFrom));
    setEffectiveSerial(eco.effectiveSerial || "");
    setEditing(true);
  }

  async function handleSave() {
    // Same two rules the API enforces, checked here so a missing date costs
    // a message rather than a round trip.
    const problem = validateEffectivity({
      effectivityType: effectivityType || null,
      effectiveFrom: fromDateInputValue(effectiveFrom),
      effectiveSerial,
    });
    if (problem) {
      toast.error(problem);
      return;
    }

    setSaving(true);
    try {
      const updated = await fetchJson<ECO>(`/api/ecos/${eco.id}`, {
        method: "PUT",
        body: {
          title,
          description,
          priority,
          reason: reason || null,
          changeType: changeType || null,
          costImpact: costImpact || null,
          disposition: disposition || null,
          effectivity: effectivity || null,
          effectivityType: effectivityType || null,
          // Only send the field the chosen type uses. Leaving a stale serial
          // on a DATE ECO would make the row contradict itself.
          effectiveFrom: effectivityType === "DATE" ? fromDateInputValue(effectiveFrom) : null,
          effectiveSerial: effectivityType === "SERIAL" ? effectiveSerial.trim() || null : null,
        },
      });
      onUpdated(updated);
      setEditing(false);
      toast.success("ECO updated");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <ScrollArea className="h-[calc(100vh-22rem)]">
      {editing ? (
        <div className="space-y-4 pr-1">
          <div className="space-y-2">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="Describe the change and reason..."
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v ?? priority)}>
                <SelectTrigger>
                  <SelectValue>
                    {(v) =>
                      (
                        ({
                          LOW: "Low",
                          MEDIUM: "Medium",
                          HIGH: "High",
                          CRITICAL: "Critical",
                        }) as Record<string, string>
                      )[v as string] ?? ""
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="LOW">Low</SelectItem>
                  <SelectItem value="MEDIUM">Medium</SelectItem>
                  <SelectItem value="HIGH">High</SelectItem>
                  <SelectItem value="CRITICAL">Critical</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Reason for Change</Label>
              <Select value={reason} onValueChange={(v) => setReason(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder="Select reason...">
                    {(v) => reasonLabels[v as keyof typeof reasonLabels] ?? "Select reason..."}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(reasonLabels).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Change Type</Label>
              <Select value={changeType} onValueChange={(v) => setChangeType(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder="Select type...">
                    {(v) =>
                      changeTypeLabelsEco[v as keyof typeof changeTypeLabelsEco] ?? "Select type..."
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(changeTypeLabelsEco).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Cost Impact</Label>
              <Select value={costImpact} onValueChange={(v) => setCostImpact(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder="Select impact...">
                    {(v) =>
                      costImpactLabels[v as keyof typeof costImpactLabels] ?? "Select impact..."
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(costImpactLabels).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Disposition</Label>
              <Select value={disposition} onValueChange={(v) => setDisposition(v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder="Select disposition...">
                    {(v) =>
                      dispositionLabels[v as keyof typeof dispositionLabels] ??
                      "Select disposition..."
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(dispositionLabels).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Effectivity</Label>
              <Select
                value={effectivityType}
                onValueChange={(v) => setEffectivityType((v as EffectivityType) ?? "")}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Not specified" />
                </SelectTrigger>
                <SelectContent>
                  {EFFECTIVITY_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {EFFECTIVITY_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Only the field the chosen type uses is shown — an empty
                  serial box under a date ECO invites someone to fill it. */}
              {effectivityType === "DATE" && (
                <Input
                  type="date"
                  aria-label="Effective from"
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                />
              )}
              {effectivityType === "SERIAL" && (
                <Input
                  aria-label="Effective from serial"
                  value={effectiveSerial}
                  onChange={(e) => setEffectiveSerial(e.target.value)}
                  placeholder="e.g., SN-500"
                />
              )}
            </div>
            <div className="space-y-2">
              <Label>Effectivity notes</Label>
              <Input
                value={effectivity}
                onChange={(e) => setEffectivity(e.target.value)}
                placeholder="e.g., after existing stock is consumed"
              />
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <Button size="sm" onClick={handleSave} disabled={saving || !title.trim()}>
              {saving ? "Saving..." : "Save Changes"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-5 pr-1">
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
              Description
            </p>
            {eco.description ? (
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{eco.description}</p>
            ) : (
              <p className="text-sm text-muted-foreground/60 italic">No description provided.</p>
            )}
          </div>

          <Separator />

          <div className="grid grid-cols-2 gap-x-6 gap-y-4">
            <MetadataField label="Priority">
              <StatusBadge status={eco.priority} kind="priority" />
            </MetadataField>
            <MetadataField label="Status">
              <StatusBadge status={eco.status} kind="eco" />
            </MetadataField>
            <MetadataField label="Reason for Change">
              {eco.reason ? (
                <span className="text-sm">{reasonLabels[eco.reason] || eco.reason}</span>
              ) : (
                <span className="text-sm text-muted-foreground/60 italic">Not set</span>
              )}
            </MetadataField>
            <MetadataField label="Change Type">
              {eco.changeType ? (
                <span className="text-sm">
                  {changeTypeLabelsEco[eco.changeType] || eco.changeType}
                </span>
              ) : (
                <span className="text-sm text-muted-foreground/60 italic">Not set</span>
              )}
            </MetadataField>
            <MetadataField label="Cost Impact">
              {eco.costImpact ? (
                <span className="text-sm">
                  {costImpactLabels[eco.costImpact] || eco.costImpact}
                </span>
              ) : (
                <span className="text-sm text-muted-foreground/60 italic">Not set</span>
              )}
            </MetadataField>
            <MetadataField label="Disposition">
              {eco.disposition ? (
                <span className="text-sm">
                  {dispositionLabels[eco.disposition] || eco.disposition}
                </span>
              ) : (
                <span className="text-sm text-muted-foreground/60 italic">Not set</span>
              )}
            </MetadataField>
            <MetadataField label="Effectivity">
              {formatEffectivity(eco) || eco.effectivity ? (
                <span className="text-sm">
                  {formatEffectivity(eco)}
                  {/* The note supplements the typed value rather than
                      replacing it, and stands alone on older ECOs that only
                      ever had prose. */}
                  {eco.effectivity && (
                    <span className="text-muted-foreground">
                      {formatEffectivity(eco) ? " — " : ""}
                      {eco.effectivity}
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-sm text-muted-foreground/60 italic">Not set</span>
              )}
            </MetadataField>
            <MetadataField label="Created">
              <span className="text-sm">
                <FormattedDate date={eco.createdAt} />
              </span>
            </MetadataField>
            <MetadataField label="Last Updated">
              <span className="text-sm">
                <FormattedDate date={eco.updatedAt} />
              </span>
            </MetadataField>
            {eco.createdBy && (
              <div className="col-span-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                  Created By
                </p>
                <p className="text-sm">
                  {eco.createdBy.fullName}{" "}
                  <span className="text-muted-foreground">({eco.createdBy.email})</span>
                </p>
              </div>
            )}
          </div>

          {eco.status === "DRAFT" && (
            <>
              <Separator />
              <Button size="sm" variant="outline" onClick={startEditing}>
                <Pencil className="w-3.5 h-3.5 mr-1.5" />
                Edit Details
              </Button>
            </>
          )}
        </div>
      )}
    </ScrollArea>
  );
}

function MetadataField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
        {label}
      </p>
      {children}
    </div>
  );
}
