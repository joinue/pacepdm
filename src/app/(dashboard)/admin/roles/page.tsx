"use client";

import { useState } from "react";
import { useFetch } from "@/hooks/use-fetch";
import { usePermissions } from "@/hooks/use-permissions";
import { fetchJson, errorMessage } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeaderSkeleton, ListRowsSkeleton } from "@/components/ui/page-skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Plus, Trash2, KeyRound, Copy, Eye, AlertTriangle, Lock } from "lucide-react";
import { toast } from "sonner";
import {
  PERMISSIONS,
  PERMISSION_INFO,
  SENSITIVE_PERMISSIONS,
  hasPermission,
} from "@/lib/permissions";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";

interface Role {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  isSystem: boolean;
  /** Assigned users, including deactivated ones — see GET /api/roles. */
  userCount?: number;
}

/**
 * Every permission, in the order it should be presented, grouped by the
 * domain prefix of its value. Copy comes from PERMISSION_INFO so the editor
 * and the read-only viewer describe a permission the same way.
 */
const ALL_PERMISSIONS = Object.values(PERMISSIONS).map((value) => ({
  value: value as string,
  category: value.split(".")[0],
  label: PERMISSION_INFO[value]?.label ?? value,
  description: PERMISSION_INFO[value]?.description ?? "",
  sensitive: SENSITIVE_PERMISSIONS.includes(value),
}));

const CATEGORY_LABELS: Record<string, string> = {
  file: "Files",
  folder: "Folders",
  eco: "Change orders",
  admin: "Administration",
  audit: "Audit",
  share: "Sharing",
};

const CATEGORIES = [...new Set(ALL_PERMISSIONS.map((p) => p.category))];

function permissionLabel(value: string) {
  return PERMISSION_INFO[value]?.label ?? value;
}

export default function RolesPage() {
  const { data, loading, error, setData, refetch } = useFetch<Role[]>("/api/roles");
  const roles = data ?? [];
  const setRoles = (updater: (prev: Role[]) => Role[]) => setData((prev) => updater(prev ?? []));

  // The actor's own permissions. The server enforces the privilege ceiling
  // (permissionsExceedingActor in POST /api/roles and PUT /api/roles/[id]);
  // this mirrors it in the UI so an unavailable permission reads as
  // unavailable instead of failing with a 403 after the form is filled in.
  const { permissions: actorPermissions, can } = usePermissions();
  const canGrant = (permission: string) => hasPermission(actorPermissions, permission);
  const canAuthorRoles = can(PERMISSIONS.ADMIN_ROLES);

  const [showCreate, setShowCreate] = useState(false);
  const [editRole, setEditRole] = useState<Role | null>(null);
  const [viewRole, setViewRole] = useState<Role | null>(null);
  const [deleteRole, setDeleteRole] = useState<Role | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedPerms, setSelectedPerms] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  function openEdit(role: Role) {
    setEditRole(role);
    setName(role.name);
    setDescription(role.description || "");
    setSelectedPerms(new Set(role.permissions));
  }

  /**
   * Clone a role into the create form. This is the intended path to a
   * custom role — system roles cannot be edited, so "start from Engineer
   * and add one thing" would otherwise mean re-ticking eleven boxes from
   * memory.
   *
   * A wildcard role expands to the concrete permissions the actor holds:
   * "*" is not a value a custom role can be given (the ceiling check
   * rejects it for anyone who lacks "*", and granting it would just be a
   * second Admin), so cloning Admin means cloning what Admin can do.
   */
  function openDuplicate(role: Role) {
    const expanded = role.permissions.includes("*")
      ? ALL_PERMISSIONS.map((p) => p.value).filter(canGrant)
      : role.permissions.filter(canGrant);

    setEditRole(null);
    setShowCreate(true);
    setName(`${role.name} copy`);
    setDescription(role.description || "");
    setSelectedPerms(new Set(expanded));
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

    try {
      if (editRole) {
        await fetchJson(`/api/roles/${editRole.id}`, {
          method: "PUT",
          body: { name, description, permissions: perms },
        });
        toast.success("Role updated");
        setRoles((prev) =>
          prev.map((r) =>
            r.id === editRole.id ? { ...r, name, description, permissions: perms } : r
          )
        );
      } else {
        const role = await fetchJson<Role>("/api/roles", {
          method: "POST",
          body: { name, description, permissions: perms },
        });
        toast.success("Role created");
        setRoles((prev) => [...prev, { userCount: 0, ...role }]);
      }
      resetForm();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteRole) return;
    try {
      await fetchJson(`/api/roles/${deleteRole.id}`, { method: "DELETE" });
      toast.success("Role deleted");
      setRoles((prev) => prev.filter((r) => r.id !== deleteRole.id));
    } catch (err) {
      toast.error(errorMessage(err));
      // The delete guard counts users server-side; if it disagreed with the
      // count we rendered, our count is the stale one.
      refetch();
    } finally {
      setDeleteRole(null);
    }
  }

  if (loading) {
    return (
      <PageContainer>
        <PageHeaderSkeleton actions />
        <ListRowsSkeleton rows={4} />
      </PageContainer>
    );
  }

  if (error) {
    return (
      <PageContainer>
        <PageHeader title="Roles & Permissions" description="Define what each role can do" />
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load roles"
          description={errorMessage(error)}
          action={
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              Try again
            </Button>
          }
        />
      </PageContainer>
    );
  }

  return (
    <TooltipProvider delay={300}>
      <PageContainer>
        <PageHeader
          title="Roles & Permissions"
          description="Define what each role can do"
          actions={
            canAuthorRoles ? (
              <Button size="sm" onClick={() => setShowCreate(true)}>
                <Plus className="w-4 h-4 mr-2" />
                New Role
              </Button>
            ) : undefined
          }
        />

        {roles.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="No roles yet"
            description="Roles decide what each person in the workspace can do."
          />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {roles.map((role) => {
              const inUse = (role.userCount ?? 0) > 0;
              return (
                <Card key={role.id}>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <CardTitle className="text-base flex items-center gap-2">
                          <KeyRound className="w-4 h-4 text-primary shrink-0" />
                          <span className="truncate">{role.name}</span>
                          {role.isSystem && (
                            <Badge variant="secondary" className="text-xs shrink-0">
                              System
                            </Badge>
                          )}
                        </CardTitle>
                        {role.description && (
                          <CardDescription className="mt-1">{role.description}</CardDescription>
                        )}
                        <p className="mt-1 text-xs text-muted-foreground">
                          {role.userCount ?? 0} {role.userCount === 1 ? "user" : "users"}
                        </p>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        {/* System roles are frozen server-side, so the only
                            thing to offer is a way to read them. Without this
                            an admin comparing Engineer against Manager has no
                            way to see what either actually grants. */}
                        {role.isSystem ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setViewRole(role)}
                          >
                            <Eye className="w-3.5 h-3.5 mr-1.5" />
                            View
                          </Button>
                        ) : (
                          canAuthorRoles && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => openEdit(role)}
                            >
                              Edit
                            </Button>
                          )
                        )}
                        {canAuthorRoles && (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 p-0"
                                  aria-label={`Duplicate ${role.name}`}
                                  onClick={() => openDuplicate(role)}
                                >
                                  <Copy className="w-3.5 h-3.5" />
                                </Button>
                              }
                            />
                            <TooltipContent>Duplicate as a custom role</TooltipContent>
                          </Tooltip>
                        )}
                        {!role.isSystem && canAuthorRoles && (
                          <Tooltip>
                            {/* The button is wrapped rather than used as the
                                trigger directly: a disabled button emits no
                                pointer events, so a tooltip anchored to it
                                would never open — and the disabled case is
                                the one that needs explaining. */}
                            <TooltipTrigger
                              render={
                                <span className="inline-flex">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 p-0 text-destructive"
                                    aria-label={`Delete ${role.name}`}
                                    disabled={inUse}
                                    onClick={() => setDeleteRole(role)}
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </Button>
                                </span>
                              }
                            />
                            <TooltipContent>
                              {inUse
                                ? `Reassign ${role.userCount === 1 ? "its user" : "its users"} first`
                                : "Delete role"}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="flex flex-wrap gap-1">
                      {role.permissions.includes("*") ? (
                        <Badge variant="default" className="text-xs">
                          All Permissions
                        </Badge>
                      ) : (
                        <>
                          {role.permissions.slice(0, 6).map((p) => (
                            <Badge key={p} variant="outline" className="text-3xs">
                              {permissionLabel(p)}
                            </Badge>
                          ))}
                          {role.permissions.length > 6 && (
                            <Badge variant="outline" className="text-3xs">
                              +{role.permissions.length - 6} more
                            </Badge>
                          )}
                          {role.permissions.length === 0 && (
                            <span className="text-xs text-muted-foreground">No permissions</span>
                          )}
                        </>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* Read-only view — the only way to inspect a system role. */}
        <Dialog open={!!viewRole} onOpenChange={(open) => !open && setViewRole(null)}>
          <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {viewRole?.name}
                <Badge variant="secondary" className="text-xs">
                  System
                </Badge>
              </DialogTitle>
              <DialogDescription>
                {viewRole?.description}
                {viewRole?.description ? " " : ""}
                System roles ship with the product and cannot be changed. Duplicate this role to
                make a version you can edit.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              {viewRole?.permissions.includes("*") ? (
                <p className="text-sm text-muted-foreground">
                  Holds every permission, including any added in future releases.
                </p>
              ) : (
                CATEGORIES.map((cat) => {
                  const granted = ALL_PERMISSIONS.filter(
                    (p) => p.category === cat && viewRole?.permissions.includes(p.value)
                  );
                  if (granted.length === 0) return null;
                  return (
                    <div key={cat} className="space-y-1.5">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        {CATEGORY_LABELS[cat] ?? cat}
                      </p>
                      {granted.map((p) => (
                        <div key={p.value} className="text-sm">
                          <span className="font-medium">{p.label}</span>
                          <p className="text-xs text-muted-foreground">{p.description}</p>
                        </div>
                      ))}
                    </div>
                  );
                })
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setViewRole(null)}>
                Close
              </Button>
              {canAuthorRoles && (
                <Button
                  onClick={() => {
                    const role = viewRole;
                    setViewRole(null);
                    if (role) openDuplicate(role);
                  }}
                >
                  <Copy className="w-4 h-4 mr-2" />
                  Duplicate
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Create/Edit dialog */}
        <Dialog
          open={showCreate || !!editRole}
          onOpenChange={(open) => {
            if (!open) resetForm();
          }}
        >
          <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editRole ? "Edit Role" : "New Role"}</DialogTitle>
              <DialogDescription>Configure role name and permissions.</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSave}>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>Role Name</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder='e.g., "Senior Engineer"'
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label>Description</Label>
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="What can this role do?"
                    rows={2}
                  />
                </div>
                <div className="space-y-3">
                  <Label>Permissions</Label>
                  {CATEGORIES.map((cat) => (
                    <div key={cat} className="space-y-1.5">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        {CATEGORY_LABELS[cat] ?? cat}
                      </p>
                      <div className="space-y-1">
                        {ALL_PERMISSIONS.filter((p) => p.category === cat).map((p) => {
                          const grantable = canGrant(p.value);
                          return (
                            <label
                              key={p.value}
                              className={
                                grantable
                                  ? "flex items-start gap-2 py-0.5 cursor-pointer"
                                  : "flex items-start gap-2 py-0.5 opacity-50 cursor-not-allowed"
                              }
                            >
                              <Checkbox
                                className="mt-0.5"
                                checked={selectedPerms.has(p.value)}
                                disabled={!grantable}
                                onCheckedChange={() => togglePerm(p.value)}
                              />
                              <span className="min-w-0">
                                <span className="flex items-center gap-1.5 text-xs font-medium">
                                  {p.label}
                                  {p.sensitive && (
                                    <AlertTriangle
                                      className="w-3 h-3 text-destructive shrink-0"
                                      aria-label="Sensitive permission"
                                    />
                                  )}
                                  {!grantable && (
                                    <Lock
                                      className="w-3 h-3 text-muted-foreground shrink-0"
                                      aria-label="You do not hold this permission"
                                    />
                                  )}
                                </span>
                                <span className="block text-3xs text-muted-foreground">
                                  {!grantable
                                    ? "You can't grant a permission you don't hold."
                                    : p.description}
                                </span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={resetForm}>
                  Cancel
                </Button>
                <Button type="submit" disabled={saving || !name.trim()}>
                  {saving ? "Saving..." : editRole ? "Update" : "Create"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <AlertDialog open={!!deleteRole} onOpenChange={(open) => !open && setDeleteRole(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {deleteRole?.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                This role will be permanently deleted. Users with this role must be reassigned
                first.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </PageContainer>
    </TooltipProvider>
  );
}
