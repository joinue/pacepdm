"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { FileText, Download, ExternalLink } from "lucide-react";

interface FilePreviewDialogProps {
  file: { id: string; name: string } | null;
  onClose: () => void;
}

export function FilePreviewDialog({ file, onClose }: FilePreviewDialogProps) {
  const router = useRouter();

  return (
    <Dialog open={!!file} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-4 h-4" />
            {file?.name}
          </DialogTitle>
          <DialogDescription>File preview</DialogDescription>
        </DialogHeader>
        {file && <FilePreviewInline fileId={file.id} />}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" size="sm" onClick={() => { window.open(`/api/files/${file?.id}/download`, "_blank"); }}>
            <Download className="w-3.5 h-3.5 mr-1.5" />Download
          </Button>
          <Button variant="outline" size="sm" onClick={() => { router.push(`/vault?fileId=${file?.id}`); onClose(); }}>
            <ExternalLink className="w-3.5 h-3.5 mr-1.5" />Open in Vault
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FilePreviewInline({ fileId }: { fileId: string }) {
  const [preview, setPreview] = useState<{
    canPreview: boolean;
    previewType?: string;
    fileType?: string;
    url?: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    fetch(`/api/files/${fileId}/preview`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Preview failed: ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (cancelled) return;
        setPreview(d);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || err?.name === "AbortError") return;
        setPreview(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fileId]);

  if (loading) return <p className="text-sm text-muted-foreground text-center py-8">Loading preview...</p>;
  if (!preview || !preview.canPreview) {
    return (
      <div className="text-center py-8">
        <FileText className="w-10 h-10 mx-auto mb-2 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">Preview not available for .{preview?.fileType || "unknown"} files</p>
      </div>
    );
  }

  if (preview.previewType === "image") {
    return (
      <div className="flex items-center justify-center bg-muted/30 rounded-lg p-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={preview.url} alt="File preview" className="max-w-full max-h-80 object-contain rounded" />
      </div>
    );
  }

  if (preview.previewType === "pdf") {
    return (
      <div className="w-full rounded-lg border overflow-hidden" style={{ height: "60vh", minHeight: "350px" }}>
        <object data={preview.url} type="application/pdf" className="w-full h-full">
          <div className="flex flex-col items-center justify-center h-full gap-3 p-4">
            <FileText className="w-10 h-10 text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">PDF preview unavailable in this browser</p>
            <a href={preview.url} target="_blank" rel="noopener noreferrer" className="text-sm text-primary underline">
              Open PDF directly
            </a>
          </div>
        </object>
      </div>
    );
  }

  if (preview.previewType === "text") {
    return <TextPreviewInline url={preview.url!} />;
  }

  return null;
}

function TextPreviewInline({ url }: { url: string }) {
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    fetch(url)
      .then((r) => r.text())
      .then((t) => setContent(t.slice(0, 5000)))
      .catch(() => setContent("Failed to load"));
  }, [url]);

  if (!content) return <p className="text-sm text-muted-foreground text-center py-4">Loading...</p>;

  return (
    <pre className="text-xs bg-muted/30 rounded-lg p-3 overflow-x-auto max-h-80 whitespace-pre-wrap font-mono">
      {content}
    </pre>
  );
}
