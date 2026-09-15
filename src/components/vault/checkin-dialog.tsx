"use client";

import { useState, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MentionInput } from "@/components/ui/mention-input";
import { Label } from "@/components/ui/label";
import { Upload } from "lucide-react";
import { toast } from "sonner";
import { errorMessage, fetchJson, isAbortError } from "@/lib/api-client";
import { formatBytes, uploadNewVersion } from "@/lib/vault-upload-client";

export function CheckInDialog({
  open,
  onOpenChange,
  fileId,
  onCheckedIn,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileId: string;
  onCheckedIn: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleCheckIn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      if (file) {
        // Straight to storage, then recorded — see lib/vault-uploads.ts. A
        // large assembly could not be checked in when the bytes went through
        // the route.
        setProgress(0);
        const result = await uploadNewVersion(fileId, file, "checkin", comment || null, {
          onProgress: ({ loaded, total }) => setProgress(total > 0 ? loaded / total : 0),
          signal: abort.signal,
        });
        toast.success(`Checked in as version ${result.version}`);
      } else {
        await fetchJson(`/api/files/${fileId}/checkin`, {
          method: "POST",
          body: { comment: comment || null },
        });
        toast.success("Check-out cancelled");
      }
      setFile(null);
      setComment("");
      onOpenChange(false);
      onCheckedIn();
    } catch (err) {
      // The comment stays, so a refused check-in can be retried without retyping it.
      if (!isAbortError(err)) toast.error(errorMessage(err));
    } finally {
      abortRef.current = null;
      setLoading(false);
      setProgress(null);
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) abortRef.current?.abort();
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Check In File</DialogTitle>
          <DialogDescription>Upload a new version or cancel the check-out.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleCheckIn}>
          <div className="space-y-4 py-4">
            <div
              className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${isDragging ? "border-primary bg-primary/5" : "hover:border-primary/50"}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDragging(true);
              }}
              onDragEnter={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDragging(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDragging(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDragging(false);
                const dropped = e.dataTransfer.files?.[0];
                if (dropped) setFile(dropped);
              }}
            >
              {file ? (
                <div>
                  <p className="font-medium">{file.name}</p>
                  <p className="text-sm text-muted-foreground">{formatBytes(file.size)}</p>
                </div>
              ) : (
                <div>
                  <Upload className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">
                    {isDragging
                      ? "Drop file here"
                      : "Drag a file here, or click to browse (optional)"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Leave empty to cancel check-out without changes
                  </p>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </div>

            {progress !== null && (
              <div className="space-y-1" role="status" aria-live="polite">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${Math.round(progress * 100)}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {progress < 1 ? `Uploading\u2026 ${Math.round(progress * 100)}%` : "Saving\u2026"}
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="comment">Comment</Label>
              <MentionInput
                id="comment"
                value={comment}
                onChange={setComment}
                placeholder="What changed in this version? (use @ to mention someone)"
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading ? "Checking in..." : file ? "Check In New Version" : "Undo Check-Out"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
