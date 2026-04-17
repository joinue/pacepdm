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
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleCheckIn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    try {
      const formData = new FormData();
      if (file) formData.append("file", file);
      if (comment) formData.append("comment", comment);

      const res = await fetch(`/api/files/${fileId}/checkin`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to check in");
        setLoading(false);
        return;
      }

      const data = await res.json();
      toast.success(file ? "File checked in with new version" : "Check-out cancelled");
      if (data.warnings?.length) {
        for (const w of data.warnings) toast.warning(w);
      }
      setFile(null);
      setComment("");
      onOpenChange(false);
      onCheckedIn();
    } catch {
      toast.error("Failed to check in");
    }
    setLoading(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Check In File</DialogTitle>
          <DialogDescription>
            Upload a new version or cancel the check-out.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleCheckIn}>
          <div className="space-y-4 py-4">
            <div
              className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${isDragging ? "border-primary bg-primary/5" : "hover:border-primary/50"}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); }}
              onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); }}
              onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); }}
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
                  <p className="text-sm text-muted-foreground">
                    {(file.size / 1048576).toFixed(2)} MB
                  </p>
                </div>
              ) : (
                <div>
                  <Upload className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">
                    {isDragging ? "Drop file here" : "Drag a file here, or click to browse (optional)"}
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
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading
                ? "Checking in..."
                : file
                ? "Check In New Version"
                : "Undo Check-Out"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
