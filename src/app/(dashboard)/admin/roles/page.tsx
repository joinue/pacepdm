"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Trash2, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { PERMISSIONS } from "@/lib/permissions";

interface Role {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  isSystem: boolean;
}

const ALL_PERMISSIONS = Object.entries(PERMISSIONS).map(([key, value]) => ({
  key,
  value,
  category: value.split(".")[0],
  label: key.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
}));

const CATEGORIES = [...new Set(ALL_PERMISSIONS.map((p) => p.category))];

export default function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editRole, setEditRole] = useState<Role | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedPerms, setSelectedPerms] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/roles").then((r) => r.json()).then((d) => { setRoles(Array.isArray(d) ? d : []); setLoading(false); });
  }, []);

  function openEdit(role: Role) {
    setEditRole(role);
    setName(role.name);
    setDescription(role.description || "");
    setSelectedPerms(new Set(role.permissions));
  }

  function resetForm() {
    setShowCreate(false);
    setEditRole(null);
    setName("");
    setDescription("");
    setSelectedPerms(new Set());
  }

  function togglePerm(perm: string) {
    setSelectedPerms((prev) => {
      const next = new Set(prev);
      if (next.has(perm)) next.delete(perm);
      else next.add(perm);
      return next;
    });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const perms = [...selectedPerms];

    if (editRole) {
      const res = await fetch(`/api/roles/${editRole.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, permissions: perms }),
      });
      if (!res.ok) { const d = await res.json(); toast.error(d.error); setSaving(false); return; }
      toast.success("Role updated");
      setRoles((prev) => prev.map((r) => r.id === editRole.id ? { ...r, name, description, permissions: perms } : r));
    } else {
      const res = await fetch("/api/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, permissions: perms }),
      });
      if (!res.ok) { const d = await res.json(); toast.error(d.error); setSaving(false); return; }
      const role = await res.json();
      toast.success("Role created");
      setRoles((prev) => [...prev, role]);
    }

    resetForm();
    setSaving(false);
  }

  async function handleDelete() {
    if (!deleteId) return;
    const res = await fetch(`/api/roles/${deleteId}`, { method: "DELETE" });
    if (!res.ok) { const d = await res.json(); toast.error(d.error); setDeleteId(null); return; }
    toast.success("Role deleted");
    setRoles((prev) => prev.filter((r) => r.id !== deleteId));
    setDeleteId(null);
  }

  if (loading) return <p className="text-center py-8 text-muted-foreground">Loading...</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Roles & Permissions</h2>
          <p className="text-sm text-muted-foreground mt-1">Define what each role can do</p>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4 mr-2" />
          New Role
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {roles.map((role) => (
          <Card key={role.id}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-primary" />
                    {role.name}
                    {role.isSystem && <Badge variant="secondary" className="text-xs">System</Badge>}
                  </CardTitle>
                  {role.description && <CardDescription className="mt-1">{role.description}</CardDescription>}
                </div>
                <div className="flex gap-1">
                  {!role.isSystem && (
                    <>
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => openEdit(role)}>Edit</Button>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" onClick={() => setDeleteId(role.id)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex flex-wrap gap-1">
                {role.permissions.includes("*") ? (
                  <Badge variant="default" className="text-xs">All Permissions</Badge>
                ) : (
                  role.permissions.slice(0, 8).map((p) => (
                    <Badge key={p} variant="outline" className="text-[10px]">{p}</Badge>
                  ))
                )}
                {!role.permissions.includes("*") && role.permissions.length > 8 && (
                  <Badge variant="outline" className="text-[10px]">+{role.permissions.length - 8} more</Badge>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Create/Edit dialog */}
      <Dialog open={showCreate || !!editRole} onOpenChange={(open) => { if (!open) resetForm(); }}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editRole ? "Edit Role" : "New Role"}</DialogTitle>
            <DialogDescription>Configure role name and permissions.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSave}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Role Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder='e.g., "Senior Engineer"' required />
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What can this role do?" rows={2} />
              </div>
              <div className="space-y-3">
                <Label>Permissions</Label>
                {CATEGORIES.map((cat) => (
                  <div key={cat} className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{cat}</p>
                    <div className="grid grid-cols-2 gap-1">
                      {ALL_PERMISSIONS.filter((p) => p.category === cat).map((p) => (
                        <label key={p.value} className="flex items-center gap-2 text-sm py-0.5 cursor-pointer">
                          <Checkbox
                            checked={selectedPerms.has(p.value)}
                            onCheckedChange={() => togglePerm(p.value)}
                          />
                          <span className="text-xs">{p.label.replace(`${cat.charAt(0).toUpperCase() + cat.slice(1)} `, "")}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={resetForm}>Cancel</Button>
              <Button type="submit" disabled={saving || !name.trim()}>
                {saving ? "Saving..." : editRole ? "Update" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete role?</AlertDialogTitle>
            <AlertDialogDescription>This role will be permanently deleted. Users with this role must be reassigned first.</AlertDialogDescription>
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
