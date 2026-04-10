"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Trash2, Users, Shield, X, Archive, ArchiveRestore } from "lucide-react";
import { toast } from "sonner";

interface User {
  id: string;
  fullName: string;
  email: string;
}

interface GroupMember {
  id: string;
  userId: string;
  user: { id: string; fullName: string; email: string };
}

interface ApprovalGroup {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  usageCount: number;
  members: GroupMember[];
}

export function ApprovalGroupsClient({
  users,
}: {
  users: User[];
}) {
  const [groups, setGroups] = useState<ApprovalGroup[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ApprovalGroup | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [addMemberGroup, setAddMemberGroup] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const loadGroups = useCallback(async () => {
    const res = await fetch("/api/approval-groups");
    const data = await res.json();
    setGroups(Array.isArray(data) ? data : []);
  }, []);

  useEffect(() => {
    // Async IIFE keeps the effect body free of synchronous setState calls
    // (the callback transitively updates state). See src/lib/README.md.
    void (async () => { await loadGroups(); })();
  }, [loadGroups]);

  const { activeGroups, archivedGroups } = useMemo(() => ({
    activeGroups: groups.filter((g) => g.isActive),
    archivedGroups: groups.filter((g) => !g.isActive),
  }), [groups]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const res = await fetch("/api/approval-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); setLoading(false); return; }
    toast.success("Group created");
    setShowCreate(false);
    setName("");
    setDescription("");
    setLoading(false);
    loadGroups();
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    const res = await fetch(`/api/approval-groups/${deleteTarget.id}`, { method: "DELETE" });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    const result = await res.json();
    toast.success(result.archived ? "Group archived" : "Group deleted");
    setDeleteTarget(null);
    loadGroups();
  }

  async function handleRestore(groupId: string) {
    const res = await fetch(`/api/approval-groups/${groupId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: true }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("Group restored");
    loadGroups();
  }

  async function handleAddMember() {
    if (!addMemberGroup || !selectedUser) return;
    const res = await fetch(`/api/approval-groups/${addMemberGroup}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: selectedUser }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("Member added");
    setAddMemberGroup(null);
    setSelectedUser("");
    loadGroups();
  }

  async function handleRemoveMember(groupId: string, userId: string) {
    const res = await fetch(`/api/approval-groups/${groupId}/members`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("Member removed");
    loadGroups();
  }

  function renderGroupCard(group: ApprovalGroup, archived = false) {
    return (
      <Card key={group.id} className={archived ? "opacity-70" : undefined}>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between">
            <div className="min-w-0 flex-1">
              <CardTitle className="text-base flex items-center gap-2">
                <Shield className="w-4 h-4 text-primary shrink-0" />
                <span className="truncate">{group.name}</span>
                {group.usageCount > 0 && (
                  <Badge variant="secondary" className="text-xs font-normal">
                    {group.usageCount} step{group.usageCount === 1 ? "" : "s"}
                  </Badge>
                )}
              </CardTitle>
              {group.description && (
                <CardDescription className="mt-1">{group.description}</CardDescription>
              )}
            </div>
            {archived ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                title="Restore"
                onClick={() => handleRestore(group.id)}
              >
                <ArchiveRestore className="w-3.5 h-3.5" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-destructive"
                title={group.usageCount > 0 ? "Archive" : "Delete"}
                onClick={() => setDeleteTarget(group)}
              >
                {group.usageCount > 0 ? <Archive className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Members</p>
              {!archived && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-xs px-2"
                  onClick={() => { setAddMemberGroup(group.id); setSelectedUser(""); }}
                >
                  <Plus className="w-3 h-3 mr-1" />Add
                </Button>
              )}
            </div>
            {group.members.length === 0 ? (
              <p className="text-xs text-muted-foreground italic py-2">No members yet</p>
            ) : (
              <div className="space-y-1">
                {group.members.map((member) => (
                  <div key={member.id} className="flex items-center justify-between py-1">
                    <div>
                      <span className="text-sm">{member.user.fullName}</span>
                      <span className="text-xs text-muted-foreground ml-2">{member.user.email}</span>
                    </div>
                    {!archived && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0"
                        onClick={() => handleRemoveMember(group.id, member.userId)}
                      >
                        <X className="w-3 h-3" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  const willArchive = (deleteTarget?.usageCount ?? 0) > 0;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Approval Groups</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Manage groups of users. Attach groups to approval steps in Admin → Workflows.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4 mr-2" />
          New Group
        </Button>
      </div>

      {/* Active groups */}
      {activeGroups.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <Users className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No active approval groups. Create one to set up approval workflows.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {activeGroups.map((g) => renderGroupCard(g))}
        </div>
      )}

      {/* Archived groups */}
      {archivedGroups.length > 0 && (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => setShowArchived((s) => !s)}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <Archive className="w-3.5 h-3.5" />
            <span>{showArchived ? "Hide" : "Show"} archived ({archivedGroups.length})</span>
          </button>
          {showArchived && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {archivedGroups.map((g) => renderGroupCard(g, true))}
            </div>
          )}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Approval Group</DialogTitle>
            <DialogDescription>Create a group of users who can approve transitions.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Group Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g., "Quality Review"' required />
              </div>
              <div className="space-y-2">
                <Label>Description (optional)</Label>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this group approve?" rows={2} />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button type="submit" disabled={loading || !name.trim()}>{loading ? "Creating..." : "Create"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add member dialog */}
      <Dialog open={!!addMemberGroup} onOpenChange={(open) => !open && setAddMemberGroup(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Member</DialogTitle>
            <DialogDescription>Select a user to add to this approval group.</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Select value={selectedUser} onValueChange={(v) => setSelectedUser(v ?? "")}>
              <SelectTrigger><SelectValue placeholder="Select user..." /></SelectTrigger>
              <SelectContent>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>{u.fullName} ({u.email})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddMemberGroup(null)}>Cancel</Button>
            <Button onClick={handleAddMember} disabled={!selectedUser}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete / archive confirm — copy adapts to whether the group is in use */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {willArchive ? "Archive approval group?" : "Delete approval group?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {willArchive ? (
                <>
                  &quot;{deleteTarget?.name}&quot; is referenced by {deleteTarget?.usageCount} workflow step
                  {deleteTarget?.usageCount === 1 ? "" : "s"}, so it will be archived instead of deleted to
                  preserve the audit trail. It will no longer appear in workflow pickers and can be restored
                  later from the archived section.
                </>
              ) : (
                <>This group has never been used. It will be permanently deleted along with its members.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className={willArchive ? undefined : "bg-destructive text-destructive-foreground hover:bg-destructive/90"}
            >
              {willArchive ? "Archive" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
