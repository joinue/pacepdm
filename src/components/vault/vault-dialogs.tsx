"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ArrowRightLeft } from "lucide-react";
import type { VaultBrowserState } from "@/hooks/use-vault-browser";

interface VaultDialogsProps {
  vault: VaultBrowserState;
}

export function VaultDialogs({ vault }: VaultDialogsProps) {
  return (
    <>
      {/* Rename Dialog */}
      <Dialog open={!!vault.renameTarget} onOpenChange={(open) => !open && vault.setRenameTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename {vault.renameTarget?.type}</DialogTitle>
            <DialogDescription>Enter a new name for &ldquo;{vault.renameTarget?.name}&rdquo;</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="rename">New name</Label>
            <Input id="rename" value={vault.newName} onChange={(e) => vault.setNewName(e.target.value)} className="mt-2" onKeyDown={(e) => e.key === "Enter" && vault.handleRename()} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => vault.setRenameTarget(null)}>Cancel</Button>
            <Button onClick={vault.handleRename} disabled={!vault.newName.trim() || vault.newName === vault.renameTarget?.name}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <AlertDialog open={!!vault.deleteTarget} onOpenChange={(open) => !open && vault.setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {vault.deleteTarget?.type}?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &ldquo;{vault.deleteTarget?.name}&rdquo;? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={vault.handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Transition Dialog */}
      <Dialog open={!!vault.transitionTarget} onOpenChange={(open) => !open && vault.setTransitionTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Lifecycle State</DialogTitle>
            <DialogDescription>Select a transition for &ldquo;{vault.transitionTarget?.fileName}&rdquo;</DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-2">
            {vault.transitions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No transitions available from the current state.</p>
            ) : (
              vault.transitions.map((t) => (
                <Button key={t.id} variant="outline" className="w-full justify-start" onClick={() => vault.handleTransition(t.id)}>
                  <ArrowRightLeft className="w-4 h-4 mr-2" />
                  {t.name} &rarr; {t.toState.name}
                </Button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Move Dialog */}
      <Dialog open={!!vault.moveTarget} onOpenChange={(open) => !open && vault.setMoveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move File</DialogTitle>
            <DialogDescription>Select a destination folder for &ldquo;{vault.moveTarget?.name}&rdquo;</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label>Destination folder</Label>
            <Select value={vault.moveDestination} onValueChange={(v) => vault.setMoveDestination(v ?? "")}>
              <SelectTrigger className="mt-2">
                <SelectValue placeholder="Select folder...">
                  {(v) => {
                    const f = vault.moveFolders.find((x) => x.id === v);
                    return f ? (f.path || f.name) : "Select folder...";
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {vault.moveFolders.map((f) => (
                  <SelectItem key={f.id} value={f.id}>{f.path || f.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => vault.setMoveTarget(null)}>Cancel</Button>
            <Button onClick={vault.handleMove} disabled={!vault.moveDestination}>Move</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirm */}
      <AlertDialog open={vault.showBulkDeleteConfirm} onOpenChange={vault.setShowBulkDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {vault.selectedFiles.size} file(s)?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the selected files. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={vault.handleBulkDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete All</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
