"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { FormattedDate } from "@/components/ui/formatted-date";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { UserPlus, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface User {
  id: string;
  fullName: string;
  email: string;
  isActive: boolean;
  createdAt: string;
  role: { id: string; name: string } | null;
}

interface Role {
  id: string;
  name: string;
}

export function UsersClient({
  users: initialUsers,
  roles,
  currentUserId,
}: {
  users: User[];
  roles: Role[];
  currentUserId: string;
}) {
  const [users, setUsers] = useState(initialUsers);
  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [roleId, setRoleId] = useState("");
  const [loading, setLoading] = useState(false);

  // Deactivation confirmation
  const [deactivateTarget, setDeactivateTarget] = useState<User | null>(null);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    try {
      const res = await fetch("/api/users/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, fullName, roleId }),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || "Failed to invite user");
        setLoading(false);
        return;
      }

      toast.success(
        data.alreadyExisted
          ? "User added to workspace (they already have an account)"
          : `Invitation email sent to ${email}`
      );

      setUsers((prev) => [...prev, {
        ...data.user,
        role: roles.find((r) => r.id === roleId) || null,
      }]);
      resetAndClose();
    } catch {
      toast.error("Failed to invite user");
    }
    setLoading(false);
  }

  function resetAndClose() {
    setShowInvite(false);
    setEmail("");
    setFullName("");
    setRoleId("");
  }

  function handleStatusClick(user: User) {
    if (!user.isActive) {
      // Reactivation — no confirmation needed
      void setActive(user.id, true);
      return;
    }
    // Deactivation — show confirmation dialog
    setDeactivateTarget(user);
  }

  async function confirmDeactivate() {
    if (!deactivateTarget) return;
    await setActive(deactivateTarget.id, false);
    setDeactivateTarget(null);
  }

  async function setActive(userId: string, isActive: boolean) {
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to update user");
        return;
      }
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, isActive } : u))
      );
      if (!isActive && data.releasedCheckouts > 0) {
        toast.success(`User deactivated. ${data.releasedCheckouts} checked-out file${data.releasedCheckouts === 1 ? "" : "s"} released.`);
      } else {
        toast.success(`User ${isActive ? "activated" : "deactivated"}`);
      }
    } catch {
      toast.error("Failed to update user");
    }
  }

  async function changeRole(user: User, newRoleId: string) {
    if (user.role?.id === newRoleId) return;
    const newRole = roles.find((r) => r.id === newRoleId);
    if (!newRole) return;

    // Optimistically swap; revert on failure so the dropdown reflects
    // server truth (e.g., privilege ceiling rejected the change).
    const previousRole = user.role;
    setUsers((prev) =>
      prev.map((u) => (u.id === user.id ? { ...u, role: { id: newRole.id, name: newRole.name } } : u))
    );

    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roleId: newRoleId }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to change role");
        setUsers((prev) =>
          prev.map((u) => (u.id === user.id ? { ...u, role: previousRole } : u))
        );
        return;
      }
      toast.success(`${user.fullName} is now ${newRole.name}`);
    } catch {
      toast.error("Failed to change role");
      setUsers((prev) =>
        prev.map((u) => (u.id === user.id ? { ...u, role: previousRole } : u))
      );
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Users</h2>
        <Button size="sm" onClick={() => setShowInvite(true)}>
          <UserPlus className="w-4 h-4 mr-2" />
          Invite User
        </Button>
      </div>

      <div className="border rounded-lg bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Joined</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => {
              // Self-row uses a read-only badge — the API rejects
              // self-role-change anyway, no point showing an input that
              // would only ever 400.
              const isSelf = user.id === currentUserId;
              return (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">{user.fullName}</TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>
                    {isSelf ? (
                      <Badge variant="secondary">{user.role?.name}</Badge>
                    ) : (
                      <Select
                        value={user.role?.id ?? ""}
                        onValueChange={(v) => v && changeRole(user, v)}
                      >
                        <SelectTrigger className="h-8 w-36">
                          <SelectValue placeholder="—">
                            {(value) => roles.find((r) => r.id === value)?.name ?? "—"}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {roles.map((role) => (
                            <SelectItem key={role.id} value={role.id}>
                              {role.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-auto px-2 py-0.5"
                      onClick={() => handleStatusClick(user)}
                    >
                      <Badge variant={user.isActive ? "default" : "destructive"}>
                        {user.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </Button>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <FormattedDate date={user.createdAt} variant="date" />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <Dialog open={showInvite} onOpenChange={(open) => { if (!open) resetAndClose(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite User</DialogTitle>
            <DialogDescription>
              They&apos;ll receive an email with a link to set their password.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleInvite}>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="invName">Full Name</Label>
                  <Input
                    id="invName"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Jane Smith"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="invEmail">Email</Label>
                  <Input
                    id="invEmail"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="jane@company.com"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label>Role</Label>
                  <Select value={roleId} onValueChange={(v) => setRoleId(v ?? "")}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select role...">
                        {(value) => roles.find((r) => r.id === value)?.name ?? "Select role..."}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {roles.map((role) => (
                        <SelectItem key={role.id} value={role.id}>
                          {role.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={resetAndClose}>
                  Cancel
                </Button>
                <Button type="submit" disabled={loading || !roleId}>
                  {loading ? "Inviting..." : "Invite"}
                </Button>
              </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Deactivation confirmation */}
      <Dialog open={!!deactivateTarget} onOpenChange={(open) => { if (!open) setDeactivateTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate user</DialogTitle>
            <DialogDescription>
              Are you sure you want to deactivate {deactivateTarget?.fullName}?
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-sm space-y-1">
                <p>This user will be immediately logged out and unable to sign back in.</p>
                <p>Any files they have checked out will be automatically released so other team members can edit them.</p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Their data (files, parts, BOMs, ECOs) will be preserved. You can reactivate them at any time.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeactivateTarget(null)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirmDeactivate}>
              Deactivate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
