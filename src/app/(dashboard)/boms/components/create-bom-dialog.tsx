"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { fetchJson, errorMessage } from "@/lib/api-client";

interface CreateBomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful create so the parent can refresh its list. */
  onCreated: () => void;
}

/**
 * Dialog for creating a new BOM. Owns its own form state — the parent
 * just controls open/close and gets a callback when a BOM is created.
 */
export function CreateBomDialog({ open, onOpenChange, onCreated }: CreateBomDialogProps) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  function close() {
    onOpenChange(false);
    setName("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      await fetchJson("/api/boms", { method: "POST", body: { name: name.trim() } });
      toast.success("BOM created");
      close();
      onCreated();
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to create BOM");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Bill of Materials</DialogTitle>
          <DialogDescription>
            Create a BOM to list the parts and materials needed to build something.
            You&apos;ll add items and link them to vault files after creating it.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="py-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Motor Assembly BOM"
                required
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={creating || !name.trim()}>
              {creating ? "Creating..." : "Create BOM"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
