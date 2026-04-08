"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { CheckCircle, XCircle, Clock, Shield } from "lucide-react";
import { toast } from "sonner";

interface PendingDecision {
  id: string;
  groupId: string;
  status: string;
  group: { name: string };
  request: {
    id: string;
    type: string;
    entityType: string;
    entityId: string;
    title: string;
    description: string | null;
    status: string;
    createdAt: string;
    requestedBy: { fullName: string; email: string };
  };
}

export default function ApprovalsPage() {
  const [pending, setPending] = useState<PendingDecision[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionTarget, setActionTarget] = useState<{ decision: PendingDecision; action: "APPROVED" | "REJECTED" } | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const loadPending = useCallback(async () => {
    const res = await fetch("/api/approvals");
    const data = await res.json();
    setPending(Array.isArray(data) ? data : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadPending();
  }, [loadPending]);

  async function handleDecision() {
    if (!actionTarget) return;
    setSubmitting(true);

    const res = await fetch(`/api/approvals/${actionTarget.decision.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: actionTarget.action, comment }),
    });

    if (!res.ok) {
      const d = await res.json();
      toast.error(d.error);
      setSubmitting(false);
      return;
    }

    const result = await res.json();
    toast.success(
      actionTarget.action === "APPROVED"
        ? result.requestComplete
          ? "Approved — all approvals complete"
          : "Approved — awaiting other approvals"
        : "Rejected"
    );

    setActionTarget(null);
    setComment("");
    setSubmitting(false);
    loadPending();
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Pending Approvals</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Items waiting for your review and approval
        </p>
      </div>

      {loading ? (
        <p className="text-center py-8 text-muted-foreground">Loading...</p>
      ) : pending.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <CheckCircle className="w-10 h-10 mx-auto mb-3 text-green-500 opacity-50" />
            <p className="text-muted-foreground">No pending approvals. You&apos;re all caught up.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {pending.map((decision) => (
            <Card key={decision.id}>
              <CardContent className="p-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="outline" className="text-xs shrink-0">
                        <Shield className="w-3 h-3 mr-1" />
                        {decision.group.name}
                      </Badge>
                      <Badge variant="secondary" className="text-xs shrink-0">
                        {decision.request.entityType === "file" ? "File Transition" : "ECO"}
                      </Badge>
                    </div>
                    <h3 className="font-medium">{decision.request.title}</h3>
                    {decision.request.description && (
                      <p className="text-sm text-muted-foreground mt-0.5">{decision.request.description}</p>
                    )}
                    <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                      <span>Requested by {decision.request.requestedBy.fullName}</span>
                      <span>&middot;</span>
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {new Date(decision.request.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive border-destructive/30 hover:bg-destructive/10"
                      onClick={() => setActionTarget({ decision, action: "REJECTED" })}
                    >
                      <XCircle className="w-4 h-4 mr-1" />
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      className="bg-green-600 hover:bg-green-700 text-white"
                      onClick={() => setActionTarget({ decision, action: "APPROVED" })}
                    >
                      <CheckCircle className="w-4 h-4 mr-1" />
                      Approve
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Decision dialog */}
      <Dialog open={!!actionTarget} onOpenChange={(open) => { if (!open) { setActionTarget(null); setComment(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {actionTarget?.action === "APPROVED" ? "Approve" : "Reject"}: {actionTarget?.decision.request.title}
            </DialogTitle>
            <DialogDescription>
              {actionTarget?.action === "APPROVED"
                ? "Confirm your approval. Add an optional comment."
                : "Provide a reason for rejection."}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={actionTarget?.action === "APPROVED" ? "Optional comment..." : "Reason for rejection..."}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setActionTarget(null); setComment(""); }}>Cancel</Button>
            <Button
              onClick={handleDecision}
              disabled={submitting || (actionTarget?.action === "REJECTED" && !comment.trim())}
              className={actionTarget?.action === "APPROVED" ? "bg-green-600 hover:bg-green-700 text-white" : "bg-destructive hover:bg-destructive/90"}
            >
              {submitting ? "Submitting..." : actionTarget?.action === "APPROVED" ? "Approve" : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
