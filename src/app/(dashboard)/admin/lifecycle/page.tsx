"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Plus, Trash2, ArrowRight, Tag } from "lucide-react";
import { toast } from "sonner";

interface LifecycleState {
  id: string;
  lifecycleId: string;
  name: string;
  color: string;
  isInitial: boolean;
  isFinal: boolean;
  sortOrder: number;
}

interface LifecycleTransition {
  id: string;
  lifecycleId: string;
  fromStateId: string;
  toStateId: string;
  name: string;
  requiresApproval: boolean;
  fromState: { id: string; name: string } | null;
  toState: { id: string; name: string } | null;
}

interface Lifecycle {
  id: string;
  name: string;
  isDefault: boolean;
  states: LifecycleState[];
  transitions: LifecycleTransition[];
}

export default function LifecyclePage() {
  const [lifecycles, setLifecycles] = useState<Lifecycle[]>([]);
  const [loading, setLoading] = useState(true);

  // Create lifecycle
  const [showCreateLifecycle, setShowCreateLifecycle] = useState(false);
  const [lcName, setLcName] = useState("");
  const [lcIsDefault, setLcIsDefault] = useState(false);
  const [creatingLc, setCreatingLc] = useState(false);

  // Add state
  const [addStateTo, setAddStateTo] = useState<string | null>(null);
  const [stateName, setStateName] = useState("");
  const [stateColor, setStateColor] = useState("#6b7280");
  const [stateIsInitial, setStateIsInitial] = useState(false);
  const [stateIsFinal, setStateIsFinal] = useState(false);

  // Add transition
  const [addTransitionTo, setAddTransitionTo] = useState<string | null>(null);
  const [transFromStateId, setTransFromStateId] = useState("");
  const [transToStateId, setTransToStateId] = useState("");
  const [transName, setTransName] = useState("");
  const [transRequiresApproval, setTransRequiresApproval] = useState(false);

  // Delete confirmations
  const [deleteLifecycleId, setDeleteLifecycleId] = useState<string | null>(null);
  const [deleteStateInfo, setDeleteStateInfo] = useState<{
    lifecycleId: string;
    stateId: string;
    stateName: string;
  } | null>(null);
  const [deleteTransitionInfo, setDeleteTransitionInfo] = useState<{
    lifecycleId: string;
    transitionId: string;
    transitionName: string;
  } | null>(null);

  const loadData = useCallback(async () => {
    try {
      const res = await fetch("/api/lifecycle");
      const data = await res.json();
      setLifecycles(Array.isArray(data) ? data : []);
    } catch {
      toast.error("Failed to load lifecycles");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void (async () => { await loadData(); })();
  }, [loadData]);

  // --- Lifecycle CRUD ---

  async function handleCreateLifecycle(e: React.FormEvent) {
    e.preventDefault();
    setCreatingLc(true);
    const res = await fetch("/api/lifecycle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: lcName, isDefault: lcIsDefault }),
    });
    if (!res.ok) {
      const d = await res.json();
      toast.error(d.error);
      setCreatingLc(false);
      return;
    }
    toast.success("Lifecycle created");
    setShowCreateLifecycle(false);
    setLcName("");
    setLcIsDefault(false);
    setCreatingLc(false);
    loadData();
  }

  async function handleDeleteLifecycle() {
    if (!deleteLifecycleId) return;
    const res = await fetch(`/api/lifecycle/${deleteLifecycleId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const d = await res.json();
      toast.error(d.error);
      setDeleteLifecycleId(null);
      return;
    }
    toast.success("Lifecycle deleted");
    setDeleteLifecycleId(null);
    loadData();
  }

  // --- State CRUD ---

  async function handleAddState(e: React.FormEvent) {
    e.preventDefault();
    if (!addStateTo) return;
    const res = await fetch(`/api/lifecycle/${addStateTo}/states`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: stateName,
        color: stateColor,
        isInitial: stateIsInitial,
        isFinal: stateIsFinal,
      }),
    });
    if (!res.ok) {
      const d = await res.json();
      toast.error(d.error);
      return;
    }
    toast.success("State added");
    setAddStateTo(null);
    setStateName("");
    setStateColor("#6b7280");
    setStateIsInitial(false);
    setStateIsFinal(false);
    loadData();
  }

  async function handleDeleteState() {
    if (!deleteStateInfo) return;
    const res = await fetch(
      `/api/lifecycle/${deleteStateInfo.lifecycleId}/states`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stateId: deleteStateInfo.stateId }),
      }
    );
    if (!res.ok) {
      const d = await res.json();
      toast.error(d.error);
      setDeleteStateInfo(null);
      return;
    }
    toast.success("State deleted");
    setDeleteStateInfo(null);
    loadData();
  }

  // --- Transition CRUD ---

  async function handleAddTransition(e: React.FormEvent) {
    e.preventDefault();
    if (!addTransitionTo) return;
    const res = await fetch(`/api/lifecycle/${addTransitionTo}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromStateId: transFromStateId,
        toStateId: transToStateId,
        name: transName,
        requiresApproval: transRequiresApproval,
      }),
    });
    if (!res.ok) {
      const d = await res.json();
      toast.error(d.error);
      return;
    }
    toast.success("Transition added");
    setAddTransitionTo(null);
    setTransFromStateId("");
    setTransToStateId("");
    setTransName("");
    setTransRequiresApproval(false);
    loadData();
  }

  async function handleDeleteTransition() {
    if (!deleteTransitionInfo) return;
    const res = await fetch(
      `/api/lifecycle/${deleteTransitionInfo.lifecycleId}/transitions`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transitionId: deleteTransitionInfo.transitionId,
        }),
      }
    );
    if (!res.ok) {
      const d = await res.json();
      toast.error(d.error);
      setDeleteTransitionInfo(null);
      return;
    }
    toast.success("Transition deleted");
    setDeleteTransitionInfo(null);
    loadData();
  }

  // --- Helpers ---

  function getStatesForLifecycle(lifecycleId: string): LifecycleState[] {
    const lc = lifecycles.find((l) => l.id === lifecycleId);
    return lc?.states || [];
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-5 h-5 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Lifecycle Management</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Define lifecycle states and transitions for files
          </p>
        </div>
        <Button size="sm" onClick={() => setShowCreateLifecycle(true)}>
          <Plus className="w-4 h-4 mr-2" />
          New Lifecycle
        </Button>
      </div>

      {lifecycles.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <Tag className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">
              No lifecycles yet. Create one to define states and transitions for
              your files.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-4">
        {lifecycles.map((lc) => (
          <Card key={lc.id}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <Tag className="w-4 h-4 text-primary" />
                  {lc.name}
                  {lc.isDefault && (
                    <Badge variant="secondary" className="text-xs">
                      Default
                    </Badge>
                  )}
                </CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-destructive"
                  onClick={() => setDeleteLifecycleId(lc.id)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="pt-0 space-y-5">
              {/* States Section */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    States
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 text-xs px-2"
                    onClick={() => setAddStateTo(lc.id)}
                  >
                    <Plus className="w-3 h-3 mr-1" />
                    Add State
                  </Button>
                </div>

                {lc.states.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic py-2">
                    No states yet -- add at least one state
                  </p>
                ) : (
                  <div className="flex gap-2 flex-wrap">
                    {lc.states.map((state) => (
                      <div
                        key={state.id}
                        className="flex items-center gap-1 group"
                      >
                        <Badge
                          style={{
                            backgroundColor: state.color + "20",
                            color: state.color,
                            borderColor: state.color,
                          }}
                          variant="outline"
                        >
                          <span
                            className="w-2 h-2 rounded-full mr-1.5 inline-block"
                            style={{ backgroundColor: state.color }}
                          />
                          {state.name}
                          {state.isInitial && " (Initial)"}
                          {state.isFinal && " (Final)"}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 text-destructive"
                          onClick={() =>
                            setDeleteStateInfo({
                              lifecycleId: lc.id,
                              stateId: state.id,
                              stateName: state.name,
                            })
                          }
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Separator />

              {/* Transitions Section */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Transitions
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 text-xs px-2"
                    onClick={() => setAddTransitionTo(lc.id)}
                    disabled={lc.states.length < 2}
                  >
                    <Plus className="w-3 h-3 mr-1" />
                    Add Transition
                  </Button>
                </div>

                {lc.transitions.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic py-2">
                    No transitions yet
                    {lc.states.length < 2
                      ? " -- add at least two states first"
                      : " -- add transitions between states"}
                  </p>
                ) : (
                  <div className="space-y-1">
                    {lc.transitions.map((t) => {
                      const fromName =
                        (Array.isArray(t.fromState)
                          ? (t.fromState as unknown as { name: string }[])[0]
                              ?.name
                          : t.fromState?.name) || "?";
                      const toName =
                        (Array.isArray(t.toState)
                          ? (t.toState as unknown as { name: string }[])[0]
                              ?.name
                          : t.toState?.name) || "?";
                      return (
                        <div
                          key={t.id}
                          className="flex items-center gap-3 p-2 rounded-md border bg-muted/20 group"
                        >
                          <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 text-sm">
                              <span className="font-medium">{fromName}</span>
                              <span className="text-muted-foreground">
                                &rarr;
                              </span>
                              <span className="font-medium">{toName}</span>
                              <span className="text-muted-foreground">
                                ({t.name})
                              </span>
                              {t.requiresApproval && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px]"
                                >
                                  Requires Approval
                                </Badge>
                              )}
                            </div>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 text-destructive"
                            onClick={() =>
                              setDeleteTransitionInfo({
                                lifecycleId: lc.id,
                                transitionId: t.id,
                                transitionName: t.name,
                              })
                            }
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Create Lifecycle Dialog */}
      <Dialog open={showCreateLifecycle} onOpenChange={setShowCreateLifecycle}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Lifecycle</DialogTitle>
            <DialogDescription>
              Create a new lifecycle to define states and transitions for files.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateLifecycle}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input
                  value={lcName}
                  onChange={(e) => setLcName(e.target.value)}
                  placeholder='e.g., "Standard Release"'
                  required
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={lcIsDefault}
                  onCheckedChange={(checked) =>
                    setLcIsDefault(checked === true)
                  }
                />
                <span className="text-sm">Set as default lifecycle</span>
              </label>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowCreateLifecycle(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={creatingLc || !lcName.trim()}
              >
                {creatingLc ? "Creating..." : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add State Dialog */}
      <Dialog
        open={!!addStateTo}
        onOpenChange={(open) => {
          if (!open) {
            setAddStateTo(null);
            setStateName("");
            setStateColor("#6b7280");
            setStateIsInitial(false);
            setStateIsFinal(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add State</DialogTitle>
            <DialogDescription>
              Add a new state to this lifecycle. States represent stages a file
              can be in.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAddState}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input
                  value={stateName}
                  onChange={(e) => setStateName(e.target.value)}
                  placeholder='e.g., "Draft", "In Review", "Released"'
                  required
                />
              </div>
              <div className="space-y-2">
                <Label>Color</Label>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={stateColor}
                    onChange={(e) => setStateColor(e.target.value)}
                    className="w-10 h-10 rounded border cursor-pointer"
                  />
                  <Input
                    value={stateColor}
                    onChange={(e) => setStateColor(e.target.value)}
                    placeholder="#6b7280"
                    className="w-32"
                  />
                  <Badge
                    style={{
                      backgroundColor: stateColor + "20",
                      color: stateColor,
                      borderColor: stateColor,
                    }}
                    variant="outline"
                  >
                    Preview
                  </Badge>
                </div>
              </div>
              <div className="space-y-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={stateIsInitial}
                    onCheckedChange={(checked) =>
                      setStateIsInitial(checked === true)
                    }
                  />
                  <div>
                    <span className="text-sm">Initial state</span>
                    <p className="text-xs text-muted-foreground">
                      Files start in this state when created
                    </p>
                  </div>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={stateIsFinal}
                    onCheckedChange={(checked) =>
                      setStateIsFinal(checked === true)
                    }
                  />
                  <div>
                    <span className="text-sm">Final state</span>
                    <p className="text-xs text-muted-foreground">
                      Files in this state are considered complete/released
                    </p>
                  </div>
                </label>
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setAddStateTo(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={!stateName.trim()}>
                Add State
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add Transition Dialog */}
      <Dialog
        open={!!addTransitionTo}
        onOpenChange={(open) => {
          if (!open) {
            setAddTransitionTo(null);
            setTransFromStateId("");
            setTransToStateId("");
            setTransName("");
            setTransRequiresApproval(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Transition</DialogTitle>
            <DialogDescription>
              Define a transition between two states. Transitions control how
              files move between lifecycle states.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAddTransition}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>From State</Label>
                <Select
                  value={transFromStateId}
                  onValueChange={(v) => setTransFromStateId(v ?? "")}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select source state..." />
                  </SelectTrigger>
                  <SelectContent>
                    {addTransitionTo &&
                      getStatesForLifecycle(addTransitionTo).map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>To State</Label>
                <Select
                  value={transToStateId}
                  onValueChange={(v) => setTransToStateId(v ?? "")}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select target state..." />
                  </SelectTrigger>
                  <SelectContent>
                    {addTransitionTo &&
                      getStatesForLifecycle(addTransitionTo).map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Transition Name</Label>
                <Input
                  value={transName}
                  onChange={(e) => setTransName(e.target.value)}
                  placeholder='e.g., "Submit for Review", "Approve", "Release"'
                  required
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={transRequiresApproval}
                  onCheckedChange={(checked) =>
                    setTransRequiresApproval(checked === true)
                  }
                />
                <div>
                  <span className="text-sm">Requires approval</span>
                  <p className="text-xs text-muted-foreground">
                    This transition must be approved before it takes effect
                  </p>
                </div>
              </label>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setAddTransitionTo(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  !transFromStateId || !transToStateId || !transName.trim()
                }
              >
                Add Transition
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Lifecycle Confirmation */}
      <AlertDialog
        open={!!deleteLifecycleId}
        onOpenChange={(open) => !open && setDeleteLifecycleId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete lifecycle?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the lifecycle and all its states and
              transitions. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteLifecycle}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete State Confirmation */}
      <AlertDialog
        open={!!deleteStateInfo}
        onOpenChange={(open) => !open && setDeleteStateInfo(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete state &ldquo;{deleteStateInfo?.stateName}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove this state. It cannot be deleted if
              transitions reference it or files are in this state.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteState}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete Transition Confirmation */}
      <AlertDialog
        open={!!deleteTransitionInfo}
        onOpenChange={(open) => !open && setDeleteTransitionInfo(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete transition &ldquo;{deleteTransitionInfo?.transitionName}
              &rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove this transition. Files will no longer
              be able to use this path between states.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteTransition}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
