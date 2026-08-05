"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Trash2, Undo2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FormattedDate } from "@/components/ui/formatted-date";
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
  const { data, loading, error, refetch } = useFetch<DeletedFile[]>("/api/files/deleted");
  const [restoringId, setRestoringId] = useState<string | null>(null);

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

  const files = data ?? [];

  if (files.length === 0) {
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
            <TableHead className="w-24"></TableHead>
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
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
