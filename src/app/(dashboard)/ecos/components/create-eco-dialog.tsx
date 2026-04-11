"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { fetchJson, errorMessage } from "@/lib/api-client";
import { reasonLabels, changeTypeLabelsEco } from "../constants";
import { type ECO, type NewEcoForm, EMPTY_NEW_ECO } from "../types";

interface CreateEcoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the created ECO so the parent can select it. */
  onCreated: (eco: ECO) => void;
}

/**
 * Create ECO dialog. Owns its own form state — the parent only controls
 * open/close and gets a callback with the created ECO.
 */
export function CreateEcoDialog({ open, onOpenChange, onCreated }: CreateEcoDialogProps) {
  const [form, setForm] = useState<NewEcoForm>(EMPTY_NEW_ECO);
  const [creating, setCreating] = useState(false);

  function close() {
    onOpenChange(false);
    setForm(EMPTY_NEW_ECO);
  }

  function setField<K extends keyof NewEcoForm>(key: K, value: NewEcoForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const created = await fetchJson<ECO>("/api/ecos", {
        method: "POST",
        body: {
          title: form.title,
          description: form.description,
          priority: form.priority,
          reason: form.reason || null,
          changeType: form.changeType || null,
        },
      });
      toast.success("ECO created");
      close();
      onCreated(created);
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to create ECO");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Engineering Change Order</DialogTitle>
          <DialogDescription>Create an ECO to propose and track an engineering change.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Title</Label>
              <Input
                value={form.title}
                onChange={(e) => setField("title", e.target.value)}
                placeholder="e.g., Update Housing Assembly tolerance"
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                value={form.description}
                onChange={(e) => setField("description", e.target.value)}
                placeholder="Describe the change and the reason for it..."
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label>Reason for Change</Label>
              <Select value={form.reason} onValueChange={(v) => setField("reason", v ?? "")}>
                <SelectTrigger>
                  <SelectValue placeholder="Select reason...">
                    {(v) => reasonLabels[v as keyof typeof reasonLabels] ?? "Select reason..."}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(reasonLabels).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Change Type</Label>
                <Select value={form.changeType} onValueChange={(v) => setField("changeType", v ?? "")}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select type...">
                      {(v) => changeTypeLabelsEco[v as keyof typeof changeTypeLabelsEco] ?? "Select type..."}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(changeTypeLabelsEco).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Priority</Label>
                <Select value={form.priority} onValueChange={(v) => setField("priority", v ?? "MEDIUM")}>
                  <SelectTrigger>
                    <SelectValue>{(v) => ({ LOW: "Low", MEDIUM: "Medium", HIGH: "High", CRITICAL: "Critical" } as Record<string, string>)[v as string] ?? ""}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="LOW">Low</SelectItem>
                    <SelectItem value="MEDIUM">Medium</SelectItem>
                    <SelectItem value="HIGH">High</SelectItem>
                    <SelectItem value="CRITICAL">Critical</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>Cancel</Button>
            <Button type="submit" disabled={creating || !form.title.trim()}>
              {creating ? "Creating..." : "Create ECO"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
