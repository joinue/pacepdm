"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { useTenantUser } from "@/components/providers/tenant-provider";
import { errorMessage, isAbortError } from "@/lib/api-client";
import type { DroppedFile } from "@/lib/dropped-files";
import {
  duplicateOf,
  ensureFolderPath,
  formatBytes,
  uploadNewFile,
  uploadNewVersion,
  type DuplicateFileInfo,
} from "@/lib/vault-upload-client";

/** Uploads at once. Enough to use the connection, few enough to show progress. */
const CONCURRENCY = 3;

type RowStatus = "queued" | "uploading" | "done" | "duplicate" | "error" | "skipped";

interface QueueRow {
  key: string;
  item: DroppedFile;
  status: RowStatus;
  loaded: number;
  message?: string;
  existing?: DuplicateFileInfo;
}

/**
 * Several files, or a dropped folder, uploaded as a queue with a line each.
 *
 * Subfolders in a dropped folder are created under the current folder as
 * they are needed. A file whose name already exists stops on its own line
 * with the choice to upload it as a new version or skip it; the rest carry on.
 * Per-file fields (part number, description, part link) belong to the
 * single-file form and are not offered here.
 */
export function UploadQueue({
  folderId,
  items,
  onUploaded,
  onBack,
  onClose,
}: {
  folderId: string;
  items: DroppedFile[];
  /** Called when at least one file or version has been recorded, so the list refreshes. */
  onUploaded: () => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const user = useTenantUser();
  const [rows, setRows] = useState<QueueRow[]>(() =>
    items.map((item, i) => ({
      key: `${i}:${[...item.dir, item.file.name].join("/")}`,
      item,
      status: "queued",
      loaded: 0,
    }))
  );
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const folderCache = useRef(new Map<string, Promise<string>>());
  const controller = useRef<AbortController | null>(null);

  const update = (key: string, patch: Partial<QueueRow>) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function uploadRow(row: QueueRow, signal: AbortSignal, asVersionOf?: DuplicateFileInfo) {
    update(row.key, { status: "uploading", loaded: 0, message: undefined });
    const onProgress = ({ loaded }: { loaded: number }) => update(row.key, { loaded });
    try {
      if (asVersionOf) {
        const result = await uploadNewVersion(
          asVersionOf.id,
          row.item.file,
          "version",
          "New version uploaded (replaced duplicate)",
          { onProgress, signal }
        );
        update(row.key, { status: "done", message: `Saved as version ${result.version}` });
      } else {
        const target = row.item.dir.length
          ? await ensureFolderPath(folderId, row.item.dir, folderCache.current)
          : folderId;
        await uploadNewFile(target, row.item.file, {}, { onProgress, signal });
        update(row.key, { status: "done" });
      }
      return true;
    } catch (err) {
      if (isAbortError(err)) {
        update(row.key, { status: "queued", loaded: 0 });
        return false;
      }
      const existing = duplicateOf(err);
      if (existing) {
        update(row.key, { status: "duplicate", existing, loaded: 0 });
      } else {
        update(row.key, { status: "error", loaded: 0, message: errorMessage(err) });
      }
      return false;
    }
  }

  async function runQueue(queue: QueueRow[]) {
    const abort = new AbortController();
    controller.current = abort;
    setRunning(true);
    setStarted(true);
    let next = 0;
    let anySucceeded = false;
    const worker = async () => {
      while (next < queue.length && !abort.signal.aborted) {
        const row = queue[next++];
        if (await uploadRow(row, abort.signal)) anySucceeded = true;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    setRunning(false);
    controller.current = null;
    if (anySucceeded) onUploaded();
  }

  async function uploadAsVersion(row: QueueRow) {
    if (!row.existing) return;
    const abort = new AbortController();
    if (await uploadRow(row, abort.signal, row.existing)) onUploaded();
  }

  const counts = rows.reduce<Record<RowStatus, number>>(
    (acc, r) => ({ ...acc, [r.status]: acc[r.status] + 1 }),
    { queued: 0, uploading: 0, done: 0, duplicate: 0, error: 0, skipped: 0 }
  );
  const totalBytes = rows.reduce((sum, r) => sum + r.item.file.size, 0);
  const folderCount = new Set(
    rows.filter((r) => r.item.dir.length).map((r) => r.item.dir.join("/"))
  ).size;

  return (
    <div className="space-y-4 py-4">
      <p className="text-sm text-muted-foreground">
        {rows.length} files, {formatBytes(totalBytes)}
        {folderCount > 0 &&
          ` in ${folderCount} subfolder${folderCount === 1 ? "" : "s"}, created here as needed`}
        . Categories are detected from each file&rsquo;s extension.
      </p>

      <ul className="max-h-80 overflow-y-auto divide-y rounded-lg border" aria-label="Upload queue">
        {rows.map((row) => (
          <QueueLine
            key={row.key}
            row={row}
            userId={user.id}
            onUploadAsVersion={() => void uploadAsVersion(row)}
            onSkip={() => update(row.key, { status: "skipped" })}
          />
        ))}
      </ul>

      {started && !running && (
        <p className="text-sm" role="status">
          {counts.done} uploaded
          {counts.duplicate > 0 && `, ${counts.duplicate} already exist`}
          {counts.error > 0 && `, ${counts.error} failed`}
          {counts.skipped > 0 && `, ${counts.skipped} skipped`}
        </p>
      )}

      <DialogFooter>
        {running ? (
          <Button type="button" variant="outline" onClick={() => controller.current?.abort()}>
            Stop
          </Button>
        ) : !started ? (
          <>
            <Button type="button" variant="outline" onClick={onBack}>
              Back
            </Button>
            <Button type="button" onClick={() => void runQueue(rows)}>
              Upload {rows.length} files
            </Button>
          </>
        ) : (
          <>
            {counts.error + counts.queued > 0 && (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void runQueue(rows.filter((r) => r.status === "error" || r.status === "queued"))
                }
              >
                {counts.queued > 0 ? "Resume" : "Retry failed"}
              </Button>
            )}
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </>
        )}
      </DialogFooter>
    </div>
  );
}

function QueueLine({
  row,
  userId,
  onUploadAsVersion,
  onSkip,
}: {
  row: QueueRow;
  userId: string;
  onUploadAsVersion: () => void;
  onSkip: () => void;
}) {
  const { item, status, existing } = row;
  const pct = item.file.size > 0 ? Math.round((row.loaded / item.file.size) * 100) : 0;
  const canVersion =
    existing &&
    !existing.isFrozen &&
    !(existing.isCheckedOut && existing.checkedOutById !== userId);

  return (
    <li className="px-3 py-2 text-sm space-y-1">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate">
            {item.dir.length > 0 && (
              <span className="text-muted-foreground">{item.dir.join("/")}/</span>
            )}
            {item.file.name}
          </p>
          <p className="text-xs text-muted-foreground">{formatBytes(item.file.size)}</p>
        </div>
        <span
          className={`shrink-0 text-xs ${
            status === "done"
              ? "text-success"
              : status === "error"
                ? "text-destructive"
                : status === "duplicate"
                  ? "text-warning"
                  : "text-muted-foreground"
          }`}
        >
          {status === "queued" && "Waiting"}
          {status === "uploading" && `${pct}%`}
          {status === "done" && (row.message ?? "Uploaded")}
          {status === "duplicate" && `Already exists (v${existing?.currentVersion})`}
          {status === "error" && "Failed"}
          {status === "skipped" && "Skipped"}
        </span>
      </div>

      {status === "uploading" && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      {status === "error" && row.message && (
        <p className="text-xs text-destructive">{row.message}</p>
      )}
      {status === "duplicate" && existing && (
        <div className="flex items-center gap-2">
          {canVersion ? (
            <Button type="button" size="sm" variant="outline" onClick={onUploadAsVersion}>
              Upload as version {existing.currentVersion + 1}
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">
              {existing.isFrozen
                ? "Released files cannot take a new version. Revise it first."
                : "Checked out by someone else."}
            </span>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={onSkip}>
            Skip
          </Button>
        </div>
      )}
    </li>
  );
}
