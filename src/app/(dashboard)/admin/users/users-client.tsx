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
import { UserPlus } from "lucide-react";
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

export function UsersClient({ users: initialUsers, roles }: { users: User[]; roles: Role[] }) {
  const [users, setUsers] = useState(initialUsers);
  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [roleId, setRoleId] = useState("");
  const [loading, setLoading] = useState(false);

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

  async function toggleActive(userId: string, currentlyActive: boolean) {
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !currentlyActive }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to update user");
        return;
      }
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, isActive: !currentlyActive } : u))
      );
      toast.success(`User ${currentlyActive ? "deactivated" : "activated"}`);
    } catch {
      toast.error("Failed to update user");
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
            {users.map((user) => (
              <TableRow key={user.id}>
                <TableCell className="font-medium">{user.fullName}</TableCell>
                <TableCell>{user.email}</TableCell>
                <TableCell><Badge variant="secondary">{user.role?.name}</Badge></TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto px-2 py-0.5"
                    onClick={() => toggleActive(user.id, user.isActive)}
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
            ))}
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
    </div>
  );
}
