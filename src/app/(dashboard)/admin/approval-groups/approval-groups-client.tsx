"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Trash2, Users, Shield, X } from "lucide-react";
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
  members: GroupMember[];
}

interface TransitionRule {
  id: string;
  groupId: string;
  isRequired: boolean;
  sortOrder: number;
}

interface Transition {
  id: string;
  name: string;
  requiresApproval: boolean;
  lifecycleName: string;
  fromState: { name: string } | { name: string }[];
  toState: { name: string } | { name: string }[];
  rules: TransitionRule[];
}

export function ApprovalGroupsClient({
  users,
  transitions: initialTransitions,
}: {
  users: User[];
  transitions: Transition[];
}) {
  const [groups, setGroups] = useState<ApprovalGroup[]>([]);
  const [transitions, setTransitions] = useState(initialTransitions);
  const [showCreate, setShowCreate] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [addMemberGroup, setAddMemberGroup] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState("");

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
    if (!deleteId) return;
    const res = await fetch(`/api/approval-groups/${deleteId}`, { method: "DELETE" });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); return; }
    toast.success("Group deleted");
    setDeleteId(null);
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

  async function toggleTransitionRule(transitionId: string, groupId: string, currentlyAssigned: boolean) {
    if (currentlyAssigned) {
      // Remove the rule
      const transition = transitions.find((t) => t.id === transitionId);
      const rule = transition?.rules.find((r) => r.groupId === groupId);
      if (rule) {
        await fetch(`/api/transition-rules/${rule.id}`, { method: "DELETE" });
        setTransitions((prev) =>
          prev.map((t) =>
            t.id === transitionId
              ? { ...t, rules: t.rules.filter((r) => r.groupId !== groupId) }
              : t
          )
        );
      }
    } else {
      // Add a rule
      const res = await fetch("/api/transition-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transitionId, groupId }),
      });
      if (res.ok) {
        const rule = await res.json();
        setTransitions((prev) =>
          prev.map((t) =>
            t.id === transitionId
              ? { ...t, rules: [...t.rules, rule] }
              : t
          )
        );
      }
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Approval Groups</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Define who can approve lifecycle transitions and ECOs
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4 mr-2" />
          New Group
        </Button>
      </div>

      {/* Groups */}
      {groups.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <Users className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No approval groups yet. Create one to set up approval workflows.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {groups.map((group) => (
            <Card key={group.id}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Shield className="w-4 h-4 text-primary" />
                      {group.name}
                    </CardTitle>
                    {group.description && (
                      <CardDescription className="mt-1">{group.description}</CardDescription>
                    )}
                  </div>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" onClick={() => setDeleteId(group.id)}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Members</p>
                    <Button variant="outline" size="sm" className="h-6 text-xs px-2" onClick={() => { setAddMemberGroup(group.id); setSelectedUser(""); }}>
                      <Plus className="w-3 h-3 mr-1" />Add
                    </Button>
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
                          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => handleRemoveMember(group.id, member.userId)}>
                            <X className="w-3 h-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Transition Rules */}
      {groups.length > 0 && (
        <>
          <Separator />
          <div>
            <h3 className="text-lg font-semibold">Transition Approval Rules</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Check which approval groups must approve each lifecycle transition
            </p>
          </div>

          <div className="border rounded-lg bg-background overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left p-3 font-medium">Transition</th>
                  {groups.map((g) => (
                    <th key={g.id} className="text-center p-3 font-medium min-w-25">{g.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {transitions.map((t) => (
                  <tr key={t.id} className="border-b last:border-0">
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">{Array.isArray(t.fromState) ? t.fromState[0]?.name : t.fromState.name}</span>
                        <span className="text-muted-foreground">&rarr;</span>
                        <span>{Array.isArray(t.toState) ? t.toState[0]?.name : t.toState.name}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{t.name}</p>
                    </td>
                    {groups.map((g) => {
                      const isAssigned = t.rules.some((r) => r.groupId === g.id);
                      return (
                        <td key={g.id} className="text-center p-3">
                          <Checkbox
                            checked={isAssigned}
                            onCheckedChange={() => toggleTransitionRule(t.id, g.id, isAssigned)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
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

      {/* Delete confirm */}
      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete approval group?</AlertDialogTitle>
            <AlertDialogDescription>This will remove all members and approval rules for this group.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
