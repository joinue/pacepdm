import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommentThread, type Comment } from "./comment-thread";

/**
 * The thread's two decisions: whose replies show edit/withdraw controls, and
 * that a reply is posted to the post's thread and handed back to the caller
 * appended — the caller owns the post, the thread only reports.
 */

const fetchJson = vi.hoisted(() => vi.fn());
const toastCalls = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/api-client", () => ({
  fetchJson,
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));
vi.mock("sonner", () => ({ toast: toastCalls }));

const POST_ID = "post-1";

const fromSam: Comment = {
  id: "c-1",
  postId: POST_ID,
  body: "Does this affect Acme's order?",
  createdAt: "2026-09-20T11:00:00Z",
  editedAt: null,
  authorId: "user-2",
  author: { fullName: "Sam" },
};
const fromAlice: Comment = {
  id: "c-2",
  postId: POST_ID,
  body: "No — it shipped last week.",
  createdAt: "2026-09-20T11:30:00Z",
  editedAt: "2026-09-20T11:35:00Z",
  authorId: "user-1",
  author: { fullName: "Alice" },
};

function renderThread(overrides: Partial<Parameters<typeof CommentThread>[0]> = {}) {
  const props = {
    postId: POST_ID,
    comments: [fromSam, fromAlice],
    currentUserId: "user-2",
    currentUserName: "Sam",
    isAdmin: false,
    onChange: vi.fn(),
    onLocalWrite: vi.fn(),
    ...overrides,
  };
  render(<CommentThread {...props} />);
  return props;
}

const replyBy = (name: string) => screen.getByText(name).closest("li")!;

beforeEach(() => {
  fetchJson.mockReset();
  toastCalls.error.mockReset();
});

describe("CommentThread", () => {
  it("shows the replies with their count, and marks an edited one", () => {
    renderThread();

    expect(screen.getByText("2 replies")).toBeInTheDocument();
    expect(screen.getByText("Does this affect Acme's order?")).toBeInTheDocument();
    expect(within(replyBy("Alice")).getByText("edited")).toBeInTheDocument();
    expect(within(replyBy("Sam")).queryByText("edited")).not.toBeInTheDocument();
  });

  it("offers edit and withdraw only on the reader's own reply", () => {
    renderThread();

    const own = replyBy("Sam");
    expect(within(own).getByRole("button", { name: "Edit this reply" })).toBeInTheDocument();
    expect(within(own).getByRole("button", { name: "Withdraw this reply" })).toBeInTheDocument();

    const theirs = replyBy("Alice");
    expect(within(theirs).queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
    expect(within(theirs).queryByRole("button", { name: /withdraw/i })).not.toBeInTheDocument();
  });

  it("lets an admin withdraw, but not edit, someone else's reply", () => {
    renderThread({ currentUserId: "user-5", currentUserName: "Ada", isAdmin: true });

    const theirs = replyBy("Alice");
    expect(within(theirs).getByRole("button", { name: "Withdraw this reply" })).toBeInTheDocument();
    expect(within(theirs).queryByRole("button", { name: "Edit this reply" })).not.toBeInTheDocument();
  });

  it("posts a reply to the post's thread and hands the thread back with it appended", async () => {
    const user = userEvent.setup();
    const saved: Comment = {
      id: "c-3",
      postId: POST_ID,
      body: "Thanks — I'll tell them.",
      createdAt: "2026-09-20T12:00:00Z",
      editedAt: null,
      authorId: "user-2",
      author: { fullName: "Sam" },
    };
    fetchJson.mockResolvedValue(saved);
    const props = renderThread();

    // The button appears once there is something to send.
    expect(screen.queryByRole("button", { name: "Reply" })).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/reply/i), "Thanks — I'll tell them.");
    await user.click(screen.getByRole("button", { name: "Reply" }));

    expect(props.onLocalWrite).toHaveBeenCalled();
    expect(fetchJson).toHaveBeenCalledWith(`/api/change-log/${POST_ID}/comments`, {
      method: "POST",
      body: { body: "Thanks — I'll tell them." },
    });
    expect(props.onChange).toHaveBeenCalledWith([fromSam, fromAlice, saved]);
    expect(screen.getByPlaceholderText(/reply/i)).toHaveValue("");
  });

  it("keeps the draft and says why when the reply is refused", async () => {
    const user = userEvent.setup();
    fetchJson.mockRejectedValue(new Error("That post is not in the change log"));
    const props = renderThread({ comments: [] });

    await user.type(screen.getByPlaceholderText(/reply/i), "Still there?");
    await user.click(screen.getByRole("button", { name: "Reply" }));

    expect(toastCalls.error).toHaveBeenCalledWith("That post is not in the change log");
    expect(props.onChange).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(/reply/i)).toHaveValue("Still there?");
  });

  it("withdraws a reply and hands the thread back without it", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fetchJson.mockResolvedValue({ success: true });
    const props = renderThread();

    await user.click(within(replyBy("Sam")).getByRole("button", { name: "Withdraw this reply" }));

    expect(fetchJson).toHaveBeenCalledWith(`/api/change-log/${POST_ID}/comments/c-1`, {
      method: "DELETE",
    });
    expect(props.onChange).toHaveBeenCalledWith([fromAlice]);
  });
});
