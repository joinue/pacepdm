"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, Plus, Shield, Clock, Globe, Lock } from "lucide-react";
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
  // Confirms the first rule, which is the consequential one — adding any
  // rule flips the folder from public → restricted, locking out everyone
  // who isn't matched by an ALLOW. Subsequent rules just expand or
  // override an already-restricted folder, so they don't need a confirm.
  const [confirmFirstRule, setConfirmFirstRule] = useState(false);

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

  const proceedAdd = async () => {
    if (!folderId || !principalId) return;
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

  const handleAdd = () => {
    if (!folderId || !principalId) {
      toast.error("Pick a user or role first");
      return;
    }
    // First rule on a previously-public folder triggers a confirm — it's
    // the click that locks everyone else out. After that, the folder is
    // already restricted and further rules just adjust who's allowed.
    if (rows.length === 0 && effect === "ALLOW") {
      setConfirmFirstRule(true);
      return;
    }
    void proceedAdd();
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
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-8">
            <Shield className="w-4 h-4 shrink-0" />
            <span className="truncate">Manage access — {folderName}</span>
          </DialogTitle>
          <DialogDescription>
            Folders are public by default. Adding any ALLOW rule restricts the
            folder to the principals you list — everyone else loses access.
            DENY rows override ALLOW.
          </DialogDescription>
        </DialogHeader>

        {/* Live status banner — tells the admin in plain English what
            adding a rule will do, or what the current state means. The
            visual swap (Globe → Lock, info → warn colors) is the cue
            that the folder has flipped from public to restricted by
            direct rules.
            We only see *direct* rules on this folder here — inherited
            rules from ancestors aren't fetched (see the file header).
            So we hedge the "public" copy accordingly. */}
        {!loading && (
          <div
            className={
              rows.length === 0
                ? "flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 dark:border-blue-900/50 dark:bg-blue-950/30 p-3 text-xs text-blue-900 dark:text-blue-200"
                : "flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30 p-3 text-xs text-amber-900 dark:text-amber-200"
            }
          >
            {rows.length === 0 ? (
              <>
                <Globe className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <strong className="font-semibold">No direct rules.</strong>{" "}
                  This folder is public unless a parent folder restricts it.
                  Adding an ALLOW rule below will lock it down to the principals
                  you list.
                </div>
              </>
            ) : (
              <>
                <Lock className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <strong className="font-semibold">Restricted.</strong>{" "}
                  Only the principals listed below have access here — every
                  other workspace member is excluded.
                </div>
              </>
            )}
          </div>
        )}

        {/* Existing rows. On mobile each row stacks (badges row → name row →
            meta row); on sm+ it spreads across one line with the trash button
            pinned to the right. */}
        <div className="space-y-2 max-h-64 overflow-y-auto -mx-1 px-1">
          {loading ? (
            <p className="text-sm text-muted-foreground text-center py-4">Loading…</p>
          ) : rows.length === 0 ? (
            // Banner above already covers the "no direct rules" state — no
            // need for a redundant message here.
            null
          ) : (
            rows.map((row) => (
              <div
                key={row.id}
                className="flex items-start gap-2 p-2.5 border rounded-md"
              >
                <div className="flex flex-wrap items-center gap-1.5 min-w-0 flex-1">
                  <Badge variant={row.effect === "DENY" ? "destructive" : "secondary"}>
                    {row.effect}
                  </Badge>
                  <Badge variant="outline">{row.level}</Badge>
                  <span className="text-sm font-medium break-all">{labelFor(row)}</span>
                  <span className="text-xs text-muted-foreground">
                    ({row.principalType.toLowerCase()})
                  </span>
                  {!row.inherited && (
                    <Badge variant="outline" className="text-[10px]">no-inherit</Badge>
                  )}
                  {row.expiresAt && (
                    <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {new Date(row.expiresAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleDelete(row.id)}
                  className="h-7 w-7 p-0 shrink-0"
                  aria-label="Remove access rule"
                >
                  <Trash2 className="w-4 h-4 text-destructive" />
                </Button>
              </div>
            ))
          )}
        </div>

        {/* Add new row. Single column on mobile, two columns on sm+, with
            related fields (type/principal, level/effect, expires/inherit)
            paired into rows. */}
        <div className="border-t pt-4 space-y-3">
          <h4 className="text-sm font-semibold">Add rule</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Principal type</Label>
              <Select
                value={principalType}
                onValueChange={(v) => { setPrincipalType(v as "USER" | "ROLE"); setPrincipalId(""); }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>{(v) => v === "USER" ? "User" : "Role"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ROLE">Role</SelectItem>
                  <SelectItem value="USER">User</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{principalType === "USER" ? "User" : "Role"}</Label>
              <Select value={principalId} onValueChange={(v) => setPrincipalId(v ?? "")}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select…">
                    {(v) => principalOptions.find((o) => o.id === v)?.label ?? "Select…"}
                  </SelectValue>
                </SelectTrigger>
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
            <div className="space-y-1.5">
              <Label className="text-xs">Level</Label>
              <Select value={level} onValueChange={(v) => setLevel(v as "VIEW" | "EDIT" | "ADMIN")}>
                <SelectTrigger className="w-full">
                  <SelectValue>{(v) => ({ VIEW: "View", EDIT: "Edit", ADMIN: "Admin" } as Record<string, string>)[v as string] ?? ""}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="VIEW">View</SelectItem>
                  <SelectItem value="EDIT">Edit</SelectItem>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Effect</Label>
              <Select value={effect} onValueChange={(v) => setEffect(v as "ALLOW" | "DENY")}>
                <SelectTrigger className="w-full">
                  <SelectValue>{(v) => v === "DENY" ? "Deny" : "Allow"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALLOW">Allow</SelectItem>
                  <SelectItem value="DENY">Deny</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Expires (optional)</Label>
              <Input
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full"
              />
            </div>
            {/* Checkbox sits in its own grid cell so it lines up with the
                Expires input on sm+ without a brittle pt-N nudge. */}
            <label
              htmlFor="inherited"
              className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 sm:self-end sm:h-9 cursor-pointer select-none"
            >
              <input
                id="inherited"
                type="checkbox"
                checked={inherited}
                onChange={(e) => setInherited(e.target.checked)}
                className="h-4 w-4"
              />
              <span className="text-xs leading-none">Apply to sub-folders</span>
            </label>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Note (optional)</Label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g., contractor — expires end of Q2"
              maxLength={500}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            onClick={handleAdd}
            disabled={saving || !principalId}
            className="w-full sm:w-auto"
          >
            <Plus className="w-4 h-4 mr-1" /> Add rule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Confirms the very first ALLOW rule on a previously-unrestricted
        folder, since that's the click that locks everyone else out.
        We can't tell here whether a parent already restricts the folder
        (we only see direct rows), so the copy hedges accordingly — the
        user is always notified of the side effect. */}
    <AlertDialog open={confirmFirstRule} onOpenChange={setConfirmFirstRule}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restrict this folder?</AlertDialogTitle>
          <AlertDialogDescription>
            This is the first direct rule on <strong>{folderName}</strong>.
            Once added, only principals matching an ALLOW row (here or
            inherited from a parent) will be able to see this folder.
            Everyone else in the workspace will lose access until you grant
            it explicitly.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              setConfirmFirstRule(false);
              void proceedAdd();
            }}
          >
            Restrict folder
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  );
}
