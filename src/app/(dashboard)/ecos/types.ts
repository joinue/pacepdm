// Types for the ECOs page and its sub-components.

export interface ECO {
  id: string;
  ecoNumber: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  reason: string | null;
  changeType: string | null;
  costImpact: string | null;
  disposition: string | null;
  effectivity: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy?: { fullName: string; email: string };
}

export interface ECOItem {
  id: string;
  ecoId: string;
  // Exactly one of partId/fileId is set — XOR enforced in DB + API.
  partId: string | null;
  fileId: string | null;
  changeType: string;
  reason: string | null;
  fromRevision: string | null;
  toRevision: string | null;
  part: {
    id: string;
    partNumber: string;
    name: string;
    revision: string;
    lifecycleState: string;
    category: string;
  } | null;
  file: {
    id: string;
    name: string;
    partNumber: string | null;
    lifecycleState: string;
    currentVersion: number;
  } | null;
}

export interface SearchPart {
  id: string;
  partNumber: string;
  name: string;
  revision: string;
  lifecycleState: string;
  category: string;
}

export interface ApprovalData {
  id: string;
  title: string;
  status: string;
  currentStepOrder: number;
  createdAt: string;
  completedAt: string | null;
  requestedBy: { fullName: string; email: string };
  workflow: { name: string } | null;
  decisions: ApprovalDecision[];
  timeline: ApprovalTimelineEntry[];
}

export interface ApprovalDecision {
  id: string;
  status: string;
  signatureLabel: string | null;
  approvalMode: string | null;
  comment: string | null;
  decidedAt: string | null;
  deadlineAt: string | null;
  group: { name: string };
  decider: { fullName: string } | null;
  step: { stepOrder: number; signatureLabel: string } | null;
}

export interface ApprovalTimelineEntry {
  id: string;
  event: string;
  details: string | null;
  createdAt: string;
  user: { fullName: string } | null;
}

export interface SearchFile {
  id: string;
  name: string;
  partNumber: string | null;
  lifecycleState: string;
}

/**
 * Form fields for the Create ECO dialog. Stored as strings so the inputs
 * stay controlled and we don't have to do conversion until submit.
 */
export interface NewEcoForm {
  title: string;
  description: string;
  priority: string;
  reason: string;
  changeType: string;
}

export const EMPTY_NEW_ECO: NewEcoForm = {
  title: "",
  description: "",
  priority: "MEDIUM",
  reason: "",
  changeType: "",
};
