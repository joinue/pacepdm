"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

interface Field {
  id: string;
  name: string;
  fieldType: string;
  options: string[] | null;
  isRequired: boolean;
  isSystem: boolean;
  sortOrder: number;
}

export function MetadataClient({ fields: initialFields }: { fields: Field[] }) {
  const [fields, setFields] = useState(initialFields);
  const [showCreate, setShowCreate] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [fieldType, setFieldType] = useState("TEXT");
  const [options, setOptions] = useState("");
  const [isRequired, setIsRequired] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    const body: Record<string, unknown> = { name, fieldType, isRequired };
    if (fieldType === "SELECT" && options.trim()) {
      body.options = options.split(",").map((o) => o.trim()).filter(Boolean);
    }

    const res = await fetch("/api/metadata-fields", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const d = await res.json();
      toast.error(d.error);
      setLoading(false);
      return;
    }

    const field = await res.json();
    setFields((prev) => [...prev, field]);
    toast.success("Field created");
    setShowCreate(false);
    setName("");
    setFieldType("TEXT");
    setOptions("");
    setIsRequired(false);
    setLoading(false);
  }

  async function handleDelete() {
    if (!deleteId) return;
    const res = await fetch("/api/metadata-fields", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fieldId: deleteId }),
    });

    if (!res.ok) {
      const d = await res.json();
      toast.error(d.error);
      return;
    }

    setFields((prev) => prev.filter((f) => f.id !== deleteId));
    toast.success("Field deleted");
    setDeleteId(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Metadata Fields</h2>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Add Field
        </Button>
      </div>

      <div className="border rounded-lg bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Required</TableHead>
              <TableHead>Options</TableHead>
              <TableHead className="w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.map((field) => (
              <TableRow key={field.id}>
                <TableCell className="font-medium">
                  {field.name}
                  {field.isSystem && <Badge variant="secondary" className="ml-2 text-xs">System</Badge>}
                </TableCell>
                <TableCell><Badge variant="outline">{field.fieldType}</Badge></TableCell>
                <TableCell>{field.isRequired ? "Yes" : "No"}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {field.options ? (field.options as string[]).join(", ") : "—"}
                </TableCell>
                <TableCell>
                  {!field.isSystem && (
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" onClick={() => setDeleteId(field.id)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Metadata Field</DialogTitle>
            <DialogDescription>Create a new custom property for files.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Field Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Heat Treatment" required />
              </div>
              <div className="space-y-2">
                <Label>Type</Label>
                <Select value={fieldType} onValueChange={(v) => setFieldType(v ?? "TEXT")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TEXT">Text</SelectItem>
                    <SelectItem value="NUMBER">Number</SelectItem>
                    <SelectItem value="DATE">Date</SelectItem>
                    <SelectItem value="BOOLEAN">Yes/No</SelectItem>
                    <SelectItem value="SELECT">Dropdown</SelectItem>
                    <SelectItem value="URL">URL</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {fieldType === "SELECT" && (
                <div className="space-y-2">
                  <Label>Options (comma-separated)</Label>
                  <Input value={options} onChange={(e) => setOptions(e.target.value)} placeholder="Option 1, Option 2, Option 3" />
                </div>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button type="submit" disabled={loading || !name.trim()}>
                {loading ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete field?</AlertDialogTitle>
            <AlertDialogDescription>This will remove the field and all its values from every file. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
