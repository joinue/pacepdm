import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * An approval can complete while its effect does not land: the file was
 * checked out or had changed state, or the ECO had already moved on. The
 * engine leaves the request approved and returns a `warning` naming why.
 * This page used to drop that warning, so an approved request whose file
 * never moved looked, from here, exactly like one that did.
 */

const fetchJson = vi.hoisted(() => vi.fn());
const toastCalls = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));

vi.mock("@/lib/api-client", () => ({
  fetchJson,
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  isAbortError: () => false,
}));
vi.mock("sonner", () => ({ toast: toastCalls }));
vi.mock("@/hooks/use-realtime-table", () => ({ useRealtimeTable: () => undefined }));
vi.mock("@/hooks/use-realtime-echo-guard", () => ({
  useRealtimeEchoGuard: () => ({ markLocalWrite: () => undefined, isEcho: () => false }),
}));

import ApprovalsPage from "./page";

const pendingDecision = {
  id: "dec-1",
  groupId: "group-1",
  status: "PENDING",
  signatureLabel: "Release sign-off",
  approvalMode: "ANY",
  deadlineAt: null,
  group: { name: "Engineering" },
  request: {
    id: "req-1",
    type: "FILE_TRANSITION",
    entityType: "file",
    entityId: "file-1",
    title: "Release: bracket.sldprt",
    description: null,
    status: "PENDING",
    createdAt: "2026-09-10T12:00:00.000Z",
    currentStepOrder: 1,
    requestedBy: { fullName: "Carol", email: "carol@example.com" },
  },
};

const warning =
  "The request was approved, but the file was not moved to Released: bracket.sldprt is " +
  "checked out by Bob. Once it is checked in, request the transition again.";

beforeEach(() => {
  vi.clearAllMocks();
  fetchJson.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === "PUT") {
      return Promise.resolve({
        success: true,
        requestComplete: true,
        requestStatus: "APPROVED",
        warning,
      });
    }
    if (url === "/api/approvals") return Promise.resolve([pendingDecision]);
    return Promise.resolve([]);
  });
});

describe("ApprovalsPage — deciding", () => {
  it("shows the engine's warning when an approval's effect did not land", async () => {
    const user = userEvent.setup();
    render(<ApprovalsPage />);

    await user.click(await screen.findByRole("button", { name: /Approve/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(toastCalls.warning).toHaveBeenCalledWith(warning));
    expect(toastCalls.success).toHaveBeenCalledWith("Approved — all steps complete");
  });
});
