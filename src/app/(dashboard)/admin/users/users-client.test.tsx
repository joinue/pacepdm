import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsersClient, isPending } from "./users-client";

/**
 * What the Users page says about someone who was invited and has not set a
 * password. It used to say "Active" and "Joined <the day the email went
 * out>", so when that person said "I can't get in", the admin's screen
 * disagreed — and there was nothing to click to send the link again.
 */

const fetchJson = vi.hoisted(() => vi.fn());
const toastCalls = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/api-client", () => ({
  fetchJson,
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
vi.mock("sonner", () => ({ toast: toastCalls }));

const roles = [
  { id: "role-admin", name: "Admin" },
  { id: "role-eng", name: "Engineer" },
];

const alice = {
  id: "u-alice",
  fullName: "Alice Admin",
  email: "alice@acme.test",
  isActive: true,
  createdAt: "2026-01-01T00:00:00Z",
  acceptedAt: "2026-01-01T00:00:00Z",
  role: roles[0],
};

const pat = {
  id: "u-pat",
  fullName: "Pat Lee",
  email: "pat@acme.test",
  isActive: true,
  createdAt: "2026-09-20T00:00:00Z",
  acceptedAt: null,
  role: roles[1],
};

function rowFor(email: string) {
  return screen.getByText(email).closest("tr")!;
}

/** Name, Email, Role, Status, Joined, actions. */
function cellsOf(row: HTMLElement) {
  const [, , role, status, joined] = within(row).getAllByRole("cell");
  return { role, status, joined };
}

beforeEach(() => {
  fetchJson.mockReset();
  toastCalls.success.mockReset();
  toastCalls.error.mockReset();
});

describe("a pending invitee", () => {
  it("shows as Invited, with the invitation date, not as an active member", () => {
    render(<UsersClient users={[alice, pat]} roles={roles} currentUserId="u-alice" />);

    const { status, joined } = cellsOf(rowFor("pat@acme.test"));
    expect(status).toHaveTextContent("Invited");
    expect(status).not.toHaveTextContent("Active");
    expect(joined).toHaveTextContent(/^Invited/);

    const admin = cellsOf(rowFor("alice@acme.test"));
    expect(admin.status).toHaveTextContent("Active");
    expect(admin.joined).not.toHaveTextContent(/Invited/);
    expect(isPending(pat)).toBe(true);
    expect(isPending(alice)).toBe(false);
  });

  it("can have the invitation resent from the row's menu", async () => {
    const user = userEvent.setup();
    fetchJson.mockResolvedValue({ ok: true });
    render(<UsersClient users={[alice, pat]} roles={roles} currentUserId="u-alice" />);

    await user.click(within(rowFor("pat@acme.test")).getByRole("button", { name: /open actions/i }));
    await user.click(await screen.findByRole("menuitem", { name: /resend invitation/i }));

    expect(fetchJson).toHaveBeenCalledWith("/api/users/u-pat/resend-invite", { method: "POST" });
    expect(toastCalls.success).toHaveBeenCalledWith("Invitation re-sent to pat@acme.test");
  });

  it("offers to revoke, not remove, someone who never got in", async () => {
    const user = userEvent.setup();
    render(<UsersClient users={[alice, pat]} roles={roles} currentUserId="u-alice" />);

    await user.click(within(rowFor("pat@acme.test")).getByRole("button", { name: /open actions/i }));
    await user.click(await screen.findByRole("menuitem", { name: /revoke invitation/i }));

    expect(await screen.findByRole("heading", { name: "Revoke invitation" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
  });

  it("does not offer a resend for an accepted member", async () => {
    const user = userEvent.setup();
    const bob = { ...pat, id: "u-bob", email: "bob@acme.test", acceptedAt: "2026-09-21T00:00:00Z" };
    render(<UsersClient users={[alice, bob]} roles={roles} currentUserId="u-alice" />);

    await user.click(within(rowFor("bob@acme.test")).getByRole("button", { name: /open actions/i }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Remove from workspace"]);
  });
});

describe("inviting", () => {
  async function submitInvite(user: ReturnType<typeof userEvent.setup>, email: string) {
    await user.click(screen.getByRole("button", { name: /invite user/i }));
    await user.type(screen.getByLabelText("Full Name"), "Pat Lee");
    await user.type(screen.getByLabelText("Email"), email);
    await user.click(screen.getByLabelText("Role"));
    await user.click(await screen.findByRole("option", { name: "Engineer" }));
    await user.click(screen.getByRole("button", { name: /^invite$/i }));
  }

  it("adds a new invitee to the table as Invited", async () => {
    const user = userEvent.setup();
    fetchJson.mockResolvedValue({
      alreadyExisted: false,
      resent: false,
      user: { ...pat, id: "u-new", email: "new@acme.test", role: null },
    });
    render(<UsersClient users={[alice]} roles={roles} currentUserId="u-alice" />);

    await submitInvite(user, "new@acme.test");

    expect(fetchJson).toHaveBeenCalledWith("/api/users/invite", {
      method: "POST",
      body: { email: "new@acme.test", fullName: "Pat Lee", roleId: "role-eng" },
    });
    expect(toastCalls.success).toHaveBeenCalledWith("Invitation email sent to new@acme.test");
    expect(cellsOf(rowFor("new@acme.test")).status).toHaveTextContent("Invited");
  });

  it("updates the pending row in place when the invitation was a resend", async () => {
    const user = userEvent.setup();
    fetchJson.mockResolvedValue({
      alreadyExisted: false,
      resent: true,
      user: { ...pat, fullName: "Pat Lee", role: null },
    });
    render(<UsersClient users={[alice, pat]} roles={roles} currentUserId="u-alice" />);

    await submitInvite(user, "pat@acme.test");

    expect(toastCalls.success).toHaveBeenCalledWith("Invitation re-sent to pat@acme.test");
    expect(screen.getAllByText("pat@acme.test")).toHaveLength(1);
  });

  it("says an existing account was added and emailed, not invited", async () => {
    const user = userEvent.setup();
    fetchJson.mockResolvedValue({
      alreadyExisted: true,
      resent: false,
      user: { ...pat, id: "u-bob", email: "bob@acme.test", acceptedAt: "2026-09-23T00:00:00Z", role: null },
    });
    render(<UsersClient users={[alice]} roles={roles} currentUserId="u-alice" />);

    await submitInvite(user, "bob@acme.test");

    expect(toastCalls.success).toHaveBeenCalledWith(expect.stringMatching(/added to workspace/i));
    expect(cellsOf(rowFor("bob@acme.test")).status).toHaveTextContent("Active");
  });

  it("surfaces the server's message when the invite is refused", async () => {
    const user = userEvent.setup();
    fetchJson.mockRejectedValue(new Error("This user is active in another workspace."));
    render(<UsersClient users={[alice]} roles={roles} currentUserId="u-alice" />);

    await submitInvite(user, "bob@acme.test");

    expect(toastCalls.error).toHaveBeenCalledWith("This user is active in another workspace.");
  });
});
