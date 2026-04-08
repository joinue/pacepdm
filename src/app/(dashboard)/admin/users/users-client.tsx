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
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { UserPlus, Copy, Check } from "lucide-react";
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
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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

      if (data.tempPassword) {
        setTempPassword(data.tempPassword);
      } else {
        toast.success("User added to workspace");
        resetAndClose();
      }

      setUsers((prev) => [...prev, {
        ...data.user,
        role: roles.find((r) => r.id === roleId) || null,
      }]);
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
    setTempPassword(null);
    setCopied(false);
  }

  async function copyPassword() {
    if (tempPassword) {
      await navigator.clipboard.writeText(tempPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
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
                  <Badge variant={user.isActive ? "default" : "destructive"}>
                    {user.isActive ? "Active" : "Inactive"}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {new Date(user.createdAt).toLocaleDateString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={showInvite} onOpenChange={(open) => { if (!open) resetAndClose(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tempPassword ? "User Created" : "Invite User"}</DialogTitle>
            {!tempPassword && (
              <DialogDescription>Add a new user to your workspace.</DialogDescription>
            )}
          </DialogHeader>

          {tempPassword ? (
            <div className="space-y-4 py-4">
              <p className="text-sm">
                User <span className="font-medium">{fullName}</span> has been created.
                Share this temporary password with them:
              </p>
              <div className="flex items-center gap-2 bg-muted p-3 rounded-md">
                <code className="flex-1 text-sm font-mono">{tempPassword}</code>
                <Button variant="ghost" size="sm" onClick={copyPassword}>
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                The user should change their password after first login.
              </p>
              <DialogFooter>
                <Button onClick={resetAndClose}>Done</Button>
              </DialogFooter>
            </div>
          ) : (
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
                      <SelectValue placeholder="Select role..." />
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
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
