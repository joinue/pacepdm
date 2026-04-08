"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Plus, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";

interface ECO {
  id: string;
  ecoNumber: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  createdAt: string;
  updatedAt: string;
}

const statusColors: Record<string, string> = {
  DRAFT: "bg-gray-500/10 text-gray-600 dark:text-gray-400",
  SUBMITTED: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  IN_REVIEW: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
  APPROVED: "bg-green-500/10 text-green-600 dark:text-green-400",
  REJECTED: "bg-red-500/10 text-red-600 dark:text-red-400",
  IMPLEMENTED: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
  CLOSED: "bg-gray-500/10 text-gray-500",
};

const priorityColors: Record<string, string> = {
  LOW: "bg-gray-500/10 text-gray-500",
  MEDIUM: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  HIGH: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  CRITICAL: "bg-red-500/10 text-red-600 dark:text-red-400",
};

const statusFlow = ["DRAFT", "SUBMITTED", "IN_REVIEW", "APPROVED", "REJECTED", "IMPLEMENTED", "CLOSED"];

export default function ECOsPage() {
  const [ecos, setEcos] = useState<ECO[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadEcos();
  }, []);

  async function loadEcos() {
    const res = await fetch("/api/ecos");
    const data = await res.json();
    setEcos(Array.isArray(data) ? data : []);
    setLoading(false);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);

    const res = await fetch("/api/ecos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, description, priority }),
    });

    if (!res.ok) {
      const d = await res.json();
      toast.error(d.error);
      setCreating(false);
      return;
    }

    toast.success("ECO created");
    setShowCreate(false);
    setTitle("");
    setDescription("");
    setPriority("MEDIUM");
    setCreating(false);
    loadEcos();
  }

  async function handleStatusChange(ecoId: string, status: string) {
    const res = await fetch(`/api/ecos/${ecoId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });

    if (!res.ok) {
      const d = await res.json();
      toast.error(d.error);
      return;
    }

    toast.success(`Status updated to ${status.replace("_", " ")}`);
    loadEcos();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Engineering Change Orders</h2>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4 mr-2" />
          New ECO
        </Button>
      </div>

      <div className="border rounded-lg bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ECO #</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead className="w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Loading...</TableCell>
              </TableRow>
            ) : ecos.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                  No ECOs yet. Create one to track engineering changes.
                </TableCell>
              </TableRow>
            ) : (
              ecos.map((eco) => (
                <TableRow key={eco.id}>
                  <TableCell className="font-mono text-sm">{eco.ecoNumber}</TableCell>
                  <TableCell>
                    <div>
                      <span className="font-medium">{eco.title}</span>
                      {eco.description && (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-xs">{eco.description}</p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className={priorityColors[eco.priority] || ""}>
                      {eco.priority}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary" className={statusColors[eco.status] || ""}>
                      {eco.status.replace("_", " ")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(eco.createdAt).toLocaleDateString()}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(eco.updatedAt).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                          <MoreHorizontal className="w-4 h-4" />
                        </Button>
                      } />
                      <DropdownMenuContent align="end">
                        {statusFlow
                          .filter((s) => s !== eco.status)
                          .map((s) => (
                            <DropdownMenuItem key={s} onClick={() => handleStatusChange(eco.id, s)}>
                              Set {s.replace("_", " ")}
                            </DropdownMenuItem>
                          ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Engineering Change Order</DialogTitle>
            <DialogDescription>Create an ECO to track an engineering change.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Title</Label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g., Update Housing Assembly tolerance" required />
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Describe the change and reason..." rows={3} />
              </div>
              <div className="space-y-2">
                <Label>Priority</Label>
                <Select value={priority} onValueChange={(v) => setPriority(v ?? "MEDIUM")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="LOW">Low</SelectItem>
                    <SelectItem value="MEDIUM">Medium</SelectItem>
                    <SelectItem value="HIGH">High</SelectItem>
                    <SelectItem value="CRITICAL">Critical</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button type="submit" disabled={creating || !title.trim()}>
                {creating ? "Creating..." : "Create ECO"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
