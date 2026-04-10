"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, Plus, Shield, Clock } from "lucide-react";
import { fetchJson, errorMessage } from "@/lib/api-client";

interface AccessRow {
  id: string;
  folderId: string;
  principalType: "USER" | "ROLE";
  principalId: string;
  level: "VIEW" | "EDIT" | "ADMIN";
  effect: "ALLOW" | "DENY";
  inherited: boolean;
  expiresAt: string | null;
  note: string | null;
  grantedAt: string;
  grantedBy?: { fullName: string } | null;
}

interface PrincipalOption {
  id: string;
  label: string;
  sublabel?: string;
}

interface FolderAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folderId: string | null;
  folderName: string;
  onChanged?: () => void;
}

/**
 * Manage ACL rows for a single folder. Loads existing rows on open, lets
 * a folder admin add/remove rows, and re-fetches on every mutation so the
 * view always matches the server.
 *
 * Keeps the "effective access" view out of scope intentionally — showing
 * *why* a user has access (inherited vs. explicit) is a future iteration.
 * Today you see only the rows attached directly to this folder.
 */
export function FolderAccessDialog({
  open,
  onOpenChange,
  folderId,
  folderName,
  onChanged,
}: FolderAccessDialogProps) {
  const [rows, setRows] = useState<AccessRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Principal picker state
  const [principalType, setPrincipalType] = useState<"USER" | "ROLE">("ROLE");
  const [principalId, setPrincipalId] = useState("");
  const [level, setLevel] = useState<"VIEW" | "EDIT" | "ADMIN">("VIEW");
  const [effect, setEffect] = useState<"ALLOW" | "DENY">("ALLOW");
  const [inherited, setInherited] = useState(true);
  const [expiresAt, setExpiresAt] = useState("");
  const [note, setNote] = useState("");

  // Options loaded from users + roles endpoints
  const [users, setUsers] = useState<PrincipalOption[]>([]);
  const [roles, setRoles] = useState<PrincipalOption[]>([]);

  const load = useCallback(async () => {
    if (!folderId) return;
    setLoading(true);
    try {
      const data = await fetchJson<AccessRow[]>(`/api/folders/${folderId}/access`);
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to load access rules");
    } finally {
      setLoading(false);
    }
  }, [folderId]);

  useEffect(() => {
    if (!open || !folderId) return;
    void load();
    // Principal options: users via the search endpoint (empty query returns
    // the full list up to its cap), roles via the roles endpoint.
    (async () => {
      try {
        const [u, r] = await Promise.all([
          fetchJson<Array<{ id: string; fullName: string; email: string }>>(`/api/users/search?q=`),
          fetchJson<Array<{ id: string; name: string; description: string | null }>>(`/api/roles`),
        ]);
        setUsers((u || []).map((x) => ({ id: x.id, label: x.fullName, sublabel: x.email })));
        setRoles((r || []).map((x) => ({ id: x.id, label: x.name, sublabel: x.description ?? undefined })));
      } catch {
        // Non-fatal — the picker will just be empty.
      }
    })();
  }, [open, folderId, load]);

  const handleAdd = async () => {
    if (!folderId || !principalId) {
      toast.error("Pick a user or role first");
      return;
    }
    setSaving(true);
    try {
      await fetchJson(`/api/folders/${folderId}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          principalType,
          principalId,
          level,
          effect,
          inherited,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
          note: note || null,
        }),
      });
      toast.success("Access rule added");
      setPrincipalId("");
      setNote("");
      setExpiresAt("");
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to add access rule");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (rowId: string) => {
    if (!folderId) return;
    try {
      await fetchJson(`/api/folders/${folderId}/access?rowId=${rowId}`, { method: "DELETE" });
      toast.success("Access rule removed");
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(errorMessage(err) || "Failed to remove access rule");
    }
  };

  const principalOptions = principalType === "USER" ? users : roles;
  const labelFor = (row: AccessRow) => {
    const list = row.principalType === "USER" ? users : roles;
    return list.find((o) => o.id === row.principalId)?.label || row.principalId;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="w-4 h-4" /> Manage access — {folderName}
          </DialogTitle>
          <DialogDescription>
            Grant or deny access to specific users or roles. Rules inherit to
            sub-folders by default. DENY always overrides ALLOW.
          </DialogDescription>
        </DialogHeader>

        {/* Existing rows */}
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-muted-foreground text-center py-4">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No direct rules — this folder inherits from its parent (or is fully public).
            </p>
          ) : (
            rows.map((row) => (
              <div key={row.id} className="flex items-center justify-between p-2 border rounded-md">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <Badge variant={row.effect === "DENY" ? "destructive" : "secondary"}>
                    {row.effect}
                  </Badge>
                  <Badge variant="outline">{row.level}</Badge>
                  <span className="text-sm font-medium truncate">{labelFor(row)}</span>
                  <span className="text-xs text-muted-foreground">
                    ({row.principalType.toLowerCase()})
                  </span>
                  {!row.inherited && <Badge variant="outline" className="text-[10px]">no-inherit</Badge>}
                  {row.expiresAt && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {new Date(row.expiresAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleDelete(row.id)}
                  className="h-7 w-7 p-0"
                >
                  <Trash2 className="w-4 h-4 text-destructive" />
                </Button>
              </div>
            ))
          )}
        </div>

        {/* Add new row */}
        <div className="border-t pt-4 space-y-3">
          <h4 className="text-sm font-semibold">Add rule</h4>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Principal type</Label>
              <Select
                value={principalType}
                onValueChange={(v) => { setPrincipalType(v as "USER" | "ROLE"); setPrincipalId(""); }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ROLE">Role</SelectItem>
                  <SelectItem value="USER">User</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">{principalType === "USER" ? "User" : "Role"}</Label>
              <Select value={principalId} onValueChange={(v) => setPrincipalId(v ?? "")}>
                <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  {principalOptions.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label}
                      {o.sublabel && <span className="text-xs text-muted-foreground ml-2">{o.sublabel}</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Level</Label>
              <Select value={level} onValueChange={(v) => setLevel(v as "VIEW" | "EDIT" | "ADMIN")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="VIEW">View</SelectItem>
                  <SelectItem value="EDIT">Edit</SelectItem>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Effect</Label>
              <Select value={effect} onValueChange={(v) => setEffect(v as "ALLOW" | "DENY")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALLOW">Allow</SelectItem>
                  <SelectItem value="DENY">Deny</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Expires (optional)</Label>
              <Input
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2 pt-5">
              <input
                id="inherited"
                type="checkbox"
                checked={inherited}
                onChange={(e) => setInherited(e.target.checked)}
                className="h-4 w-4"
              />
              <Label htmlFor="inherited" className="text-xs">Apply to sub-folders</Label>
            </div>
          </div>
          <div>
            <Label className="text-xs">Note (optional)</Label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g., contractor — expires end of Q2"
              maxLength={500}
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={handleAdd} disabled={saving || !principalId}>
              <Plus className="w-4 h-4 mr-1" /> Add rule
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
