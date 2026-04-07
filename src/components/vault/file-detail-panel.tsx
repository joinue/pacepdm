"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { X, Download, Save } from "lucide-react";
import { toast } from "sonner";

interface MetadataFieldDef {
  id: string;
  name: string;
  fieldType: string;
  options: string[] | null;
  isRequired: boolean;
}

interface FileDetail {
  id: string;
  name: string;
  partNumber: string | null;
  description: string | null;
  fileType: string;
  category: string;
  currentVersion: number;
  lifecycleState: string;
  isCheckedOut: boolean;
  checkedOutBy: { fullName: string; email: string } | null;
  checkedOutAt: string | null;
  createdAt: string;
  updatedAt: string;
  folder: { name: string; path: string };
  versions: {
    id: string;
    version: number;
    fileSize: number;
    comment: string | null;
    createdAt: string;
    uploadedBy: { fullName: string };
  }[];
  metadata: {
    id: string;
    fieldId: string;
    value: string;
    field: { name: string; fieldType: string };
  }[];
  references: {
    targetFile: { id: string; name: string; partNumber: string | null };
  }[];
  referencedBy: {
    sourceFile: { id: string; name: string; partNumber: string | null };
  }[];
}

export function FileDetailPanel({
  fileId,
  metadataFields,
  onClose,
  onRefresh,
}: {
  fileId: string;
  metadataFields: MetadataFieldDef[];
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [file, setFile] = useState<FileDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [partNumber, setPartNumber] = useState("");
  const [description, setDescription] = useState("");
  const [metadataValues, setMetadataValues] = useState<
    Record<string, string>
  >({});

  const loadFile = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/files/${fileId}`);
      const data = await res.json();
      setFile(data);
      setPartNumber(data.partNumber || "");
      setDescription(data.description || "");

      const values: Record<string, string> = {};
      for (const mv of data.metadata) {
        values[mv.fieldId] = mv.value;
      }
      setMetadataValues(values);
    } catch {
      toast.error("Failed to load file details");
    }
    setLoading(false);
  }, [fileId]);

  useEffect(() => {
    loadFile();
  }, [loadFile]);

  async function handleSaveMetadata() {
    setSaving(true);
    try {
      const metadata = Object.entries(metadataValues)
        .filter(([, value]) => value !== "")
        .map(([fieldId, value]) => ({ fieldId, value }));

      const res = await fetch(`/api/files/${fileId}/metadata`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partNumber, description, metadata }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to save");
      } else {
        toast.success("Metadata saved");
        onRefresh();
      }
    } catch {
      toast.error("Failed to save metadata");
    }
    setSaving(false);
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
  }

  if (loading || !file) {
    return (
      <div className="w-96 border rounded-lg bg-background p-4">
        Loading...
      </div>
    );
  }

  return (
    <div className="w-96 border rounded-lg bg-background flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b">
        <h3 className="font-semibold truncate">{file.name}</h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X className="w-4 h-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <Tabs defaultValue="properties" className="p-4">
          <TabsList className="w-full">
            <TabsTrigger value="properties" className="flex-1">
              Properties
            </TabsTrigger>
            <TabsTrigger value="versions" className="flex-1">
              Versions
            </TabsTrigger>
            <TabsTrigger value="relations" className="flex-1">
              Relations
            </TabsTrigger>
          </TabsList>

          {/* Properties Tab */}
          <TabsContent value="properties" className="space-y-4 mt-4">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <span className="text-muted-foreground">Type</span>
              <span>{file.fileType.toUpperCase()}</span>
              <span className="text-muted-foreground">Category</span>
              <span>{file.category}</span>
              <span className="text-muted-foreground">Version</span>
              <span>v{file.currentVersion}</span>
              <span className="text-muted-foreground">State</span>
              <Badge variant="secondary">{file.lifecycleState}</Badge>
              <span className="text-muted-foreground">Location</span>
              <span className="truncate">{file.folder.path}</span>
              <span className="text-muted-foreground">Created</span>
              <span>{new Date(file.createdAt).toLocaleDateString()}</span>
            </div>

            {file.isCheckedOut && file.checkedOutBy && (
              <div className="bg-yellow-50 border border-yellow-200 rounded p-2 text-sm">
                Checked out by {file.checkedOutBy.fullName}
              </div>
            )}

            <Separator />

            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="pn" className="text-xs">
                  Part Number
                </Label>
                <Input
                  id="pn"
                  value={partNumber}
                  onChange={(e) => setPartNumber(e.target.value)}
                  className="h-8 text-sm"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="desc" className="text-xs">
                  Description
                </Label>
                <Textarea
                  id="desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="text-sm"
                  rows={2}
                />
              </div>
            </div>

            <Separator />
            <p className="text-xs font-semibold text-muted-foreground uppercase">
              Custom Properties
            </p>

            <div className="space-y-3">
              {metadataFields.map((field) => (
                <div key={field.id} className="space-y-1">
                  <Label className="text-xs">{field.name}</Label>
                  {field.fieldType === "SELECT" && field.options ? (
                    <Select
                      value={metadataValues[field.id] || ""}
                      onValueChange={(v) =>
                        setMetadataValues((prev) => ({
                          ...prev,
                          [field.id]: v ?? "",
                        }))
                      }
                    >
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue placeholder="Select..." />
                      </SelectTrigger>
                      <SelectContent>
                        {field.options.map((opt) => (
                          <SelectItem key={opt} value={opt}>
                            {opt}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      type={field.fieldType === "NUMBER" ? "number" : "text"}
                      value={metadataValues[field.id] || ""}
                      onChange={(e) =>
                        setMetadataValues((prev) => ({
                          ...prev,
                          [field.id]: e.target.value,
                        }))
                      }
                      className="h-8 text-sm"
                    />
                  )}
                </div>
              ))}
            </div>

            <Button
              onClick={handleSaveMetadata}
              disabled={saving}
              className="w-full"
              size="sm"
            >
              <Save className="w-4 h-4 mr-2" />
              {saving ? "Saving..." : "Save Properties"}
            </Button>
          </TabsContent>

          {/* Versions Tab */}
          <TabsContent value="versions" className="mt-4">
            <div className="space-y-3">
              {file.versions.map((v) => (
                <div
                  key={v.id}
                  className="border rounded p-3 text-sm space-y-1"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">Version {v.version}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7"
                      onClick={() => {
                        fetch(
                          `/api/files/${fileId}/download?version=${v.version}`
                        )
                          .then((r) => r.json())
                          .then((d) => {
                            if (d.url) window.open(d.url, "_blank");
                          });
                      }}
                    >
                      <Download className="w-3 h-3" />
                    </Button>
                  </div>
                  <p className="text-muted-foreground">
                    {formatFileSize(v.fileSize)} &middot;{" "}
                    {v.uploadedBy.fullName}
                  </p>
                  <p className="text-muted-foreground">
                    {new Date(v.createdAt).toLocaleString()}
                  </p>
                  {v.comment && (
                    <p className="text-muted-foreground italic">
                      &ldquo;{v.comment}&rdquo;
                    </p>
                  )}
                </div>
              ))}
            </div>
          </TabsContent>

          {/* Relations Tab */}
          <TabsContent value="relations" className="mt-4 space-y-4">
            {file.references.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">
                  Contains / References
                </p>
                {file.references.map((ref) => (
                  <div
                    key={ref.targetFile.id}
                    className="text-sm py-1 border-b last:border-0"
                  >
                    {ref.targetFile.name}
                    {ref.targetFile.partNumber && (
                      <span className="text-muted-foreground ml-2">
                        ({ref.targetFile.partNumber})
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {file.referencedBy.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">
                  Where Used
                </p>
                {file.referencedBy.map((ref) => (
                  <div
                    key={ref.sourceFile.id}
                    className="text-sm py-1 border-b last:border-0"
                  >
                    {ref.sourceFile.name}
                    {ref.sourceFile.partNumber && (
                      <span className="text-muted-foreground ml-2">
                        ({ref.sourceFile.partNumber})
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {file.references.length === 0 &&
              file.referencedBy.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No file references yet.
                </p>
              )}
          </TabsContent>
        </Tabs>
      </ScrollArea>
    </div>
  );
}
