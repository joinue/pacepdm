"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Trash2, Undo2, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FormattedDate } from "@/components/ui/formatted-date";
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
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/lib/permissions";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useFetch } from "@/hooks/use-fetch";
import { fetchJson, errorMessage } from "@/lib/api-client";

/**
 * The trash: soft-deleted files, newest first, with one action each.
 *
 * Deliberately not a mode inside `VaultFileList`. That component carries
 * selection, drag-and-drop, thumbnails, checkout state and a nine-item
 * context menu, and every one of those is meaningless for a deleted file —
 * threading an `isTrash` flag through it would add branches to an already
 * oversized component to hide most of what it does. A deleted file supports
 * exactly one operation, so it gets its own small list.
 *
 * Owns its own fetch (see the `external` source in `useVaultContents`)
 * because the rows are a different shape from `FileItem`.
 */

interface DeletedFile {
  id: string;
  name: string;
  folderId: string;
  fileType: string | null;
  partNumber: string | null;
  lifecycleState: string;
  deletedAt: string;
  deletedBy: { fullName: string | null } | { fullName: string | null }[] | null;
  folder:
    | { id: string; name: string; path: string }
    | { id: string; name: string; path: string }[]
    | null;
}

/** One page of the trash, plus enough to know whether there is another. */
interface TrashPage {
  files: DeletedFile[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Supabase's joined embeds arrive as either an object or a single-element
 * array depending on FK cardinality inference — same normalisation the file
 * list does for its folder embed.
 */
function firstOf<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export function TrashList({ onRestored }: { onRestored: () => void }) {
  const [offset, setOffset] = useState(0);
  const { data, loading, error, refetch } = useFetch<TrashPage>(
    `/api/files/deleted?offset=${offset}`
  );
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<DeletedFile | null>(null);
  const [purging, setPurging] = useState(false);
  const { can } = usePermissions();
  // A UX affordance only — the route enforces FILE_PURGE regardless.
  const canPurge = can(PERMISSIONS.FILE_PURGE);

  async function handlePurge() {
    if (!purgeTarget) return;
    setPurging(true);
    try {
      await fetchJson(`/api/files/${purgeTarget.id}/purge`, { method: "DELETE" });
      toast.success(`Permanently deleted ${purgeTarget.name}`);
      setPurgeTarget(null);
      await refetch();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPurging(false);
    }
  }

  async function handleRestore(file: DeletedFile) {
    setRestoringId(file.id);
    try {
      await fetchJson(`/api/files/${file.id}/undelete`, { method: "POST" });
      toast.success(`Restored ${file.name}`);
      await refetch();
      // Let the surrounding vault re-read the folder listing too — the file
      // has just reappeared in it.
      onRestored();
    } catch (err) {
      // Surfaces the server's real message, which for the common failure is
      // the name-collision 409 explaining exactly what to do next.
      toast.error(errorMessage(err));
    } finally {
      setRestoringId(null);
    }
  }

  if (loading) {
    return <p className="text-center py-8 text-muted-foreground text-sm">Loading...</p>;
  }

  if (error) {
    return (
      <EmptyState
        icon={Trash2}
        title="Could not load deleted files"
        description={errorMessage(error)}
        action={
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Try again
          </Button>
        }
      />
    );
  }

  const files = data?.files ?? [];
  const total = data?.total ?? 0;

  if (files.length === 0 && offset === 0) {
    return (
      <EmptyState
        icon={Trash2}
        title="Nothing deleted"
        description="Deleted files appear here and can be restored to the folder they came from."
      />
    );
  }

  return (
    <div className="border rounded-lg bg-background overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Part #</TableHead>
            <TableHead>Folder</TableHead>
            <TableHead>Deleted</TableHead>
            <TableHead>Deleted by</TableHead>
            <TableHead className="w-36"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {files.map((file) => {
            const folder = firstOf(file.folder);
            const deletedBy = firstOf(file.deletedBy);
            const restoring = restoringId === file.id;
            return (
              <TableRow key={file.id}>
                <TableCell className="font-medium">{file.name}</TableCell>
                <TableCell className="text-sm">{file.partNumber || "—"}</TableCell>
                <TableCell className="text-xs text-muted-foreground" title={folder?.path}>
                  {folder?.path || folder?.name || "—"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  <FormattedDate date={file.deletedAt} variant="date" />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {deletedBy?.fullName || "—"}
                </TableCell>
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={restoring}
                    onClick={() => handleRestore(file)}
                  >
                    {restoring ? (
                      <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    ) : (
                      <Undo2 className="w-4 h-4 mr-1" />
                    )}
                    Restore
                  </Button>
                  {canPurge && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      title="Permanently delete"
                      aria-label={`Permanently delete ${file.name}`}
                      onClick={() => setPurgeTarget(file)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {/* Paging. The old flat 200-row cap left everything past it in the
          database and out of reach — invisible, un-restorable and
          un-deletable. Showing the total is the point as much as the buttons:
          it is how you know there is more. */}
      {(total > files.length || offset > 0) && (
        <div className="flex items-center justify-between gap-3 border-t px-3 py-2">
          <p className="text-xs text-muted-foreground">
            {offset + 1}–{offset + files.length} of {total} deleted file
            {total === 1 ? "" : "s"}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0 || loading}
              onClick={() => setOffset(Math.max(0, offset - (data?.limit ?? 100)))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!data?.hasMore || loading}
              onClick={() => setOffset(offset + (data?.limit ?? 100))}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <AlertDialog
        open={!!purgeTarget}
        onOpenChange={(open) => {
          if (!open) setPurgeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-destructive" />
              Permanently delete {purgeTarget?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This destroys the file and every version of it, including the stored contents. It
              cannot be undone and the file cannot be restored afterwards. The audit log keeps a
              record that it existed and who deleted it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={purging}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                // Keep the dialog open while the request is in flight so the
                // spinner is visible and a slow purge cannot be double-fired.
                e.preventDefault();
                void handlePurge();
              }}
              disabled={purging}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {purging && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              Permanently delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
