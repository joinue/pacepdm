import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MentionInput } from "./mention-input";

/**
 * The interesting logic here is the parse: deciding whether the cursor sits
 * inside a mention, what the query is, and where the replacement starts. Get
 * that wrong and either the dropdown opens on every email address someone
 * types, or it never opens at all.
 *
 * The component is controlled, so tests drive it through a wrapper that owns
 * the value — asserting on `onChange` payloads alone would not catch a splice
 * that lands at the wrong offset.
 */

const searchResults = vi.hoisted(() => ({
  current: [
    { id: "u1", fullName: "Alice Chen", email: "alice@acme.test" },
    { id: "u2", fullName: "Bob Smith", email: "bob@acme.test" },
    { id: "u3", fullName: "Carla Diaz", email: "carla@acme.test" },
  ] as unknown,
}));

const fetchMock = vi.fn(async (url: string) => {
  void url;
  return { json: async () => searchResults.current } as Response;
});

function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <MentionInput id="comment" value={value} onChange={setValue} placeholder="Add a comment" />
  );
}

/** The query string the component last searched for, or null. */
function lastQuery(): string | null {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) return null;
  return new URL(call[0] as string, "http://localhost").searchParams.get("q");
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  fetchMock.mockClear();
  searchResults.current = [
    { id: "u1", fullName: "Alice Chen", email: "alice@acme.test" },
    { id: "u2", fullName: "Bob Smith", email: "bob@acme.test" },
    { id: "u3", fullName: "Carla Diaz", email: "carla@acme.test" },
  ];
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Type into the textarea, then let the 200ms search debounce elapse. */
async function type(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByRole("textbox"), text);
  await act(async () => {
    vi.advanceTimersByTime(250);
  });
}

function setup() {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<Harness />);
  return user;
}

describe("MentionInput — when the dropdown opens", () => {
  it("opens on an @ at the very start of the field", async () => {
    const user = setup();
    await type(user, "@ali");
    expect(await screen.findByText("Alice Chen")).toBeInTheDocument();
    expect(lastQuery()).toBe("ali");
  });

  it("opens on an @ preceded by a space", async () => {
    const user = setup();
    await type(user, "cc @bob");
    expect(await screen.findByText("Bob Smith")).toBeInTheDocument();
    expect(lastQuery()).toBe("bob");
  });

  it("opens on an @ at the start of a new line", async () => {
    const user = setup();
    await type(user, "first line{Enter}@ali");
    expect(await screen.findByText("Alice Chen")).toBeInTheDocument();
  });

  /**
   * The one that matters in practice: an email address is not a mention.
   * Requiring whitespace before the @ is what keeps "mail bob@acme.test" from
   * popping a picker mid-sentence.
   */
  it("does not open for an @ inside an email address", async () => {
    const user = setup();
    await type(user, "email bob@acme");
    expect(screen.queryByText("Bob Smith")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not search on a bare @ with nothing typed after it", async () => {
    const user = setup();
    await type(user, "@");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Alice Chen")).not.toBeInTheDocument();
  });

  it("closes once the mention runs onto the next line", async () => {
    const user = setup();
    await type(user, "@ali");
    expect(await screen.findByText("Alice Chen")).toBeInTheDocument();
    await type(user, "{Enter}");
    expect(screen.queryByText("Alice Chen")).not.toBeInTheDocument();
  });

  /**
   * A 50-character cap stops a whole paragraph being sent as a search term.
   *
   * Leaving the mention context also has to cancel the search the previous
   * keystroke queued — otherwise it lands ~200ms later and re-opens the picker
   * the component just closed.
   */
  it("stops searching once the query passes the length cap", async () => {
    const user = setup();
    await type(user, `@${"a".repeat(51)}`);
    expect(screen.queryByText("Alice Chen")).not.toBeInTheDocument();
  });

  it("does not let a queued search re-open a dropdown dismissed with Escape", async () => {
    const user = setup();
    await type(user, "@ali");
    await screen.findByText("Alice Chen");
    // Queue another search, then dismiss before its debounce elapses.
    await user.type(screen.getByRole("textbox"), "c");
    await user.keyboard("{Escape}");
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByText("Alice Chen")).not.toBeInTheDocument();
  });

  it("stays closed when nobody matches", async () => {
    const user = setup();
    searchResults.current = [];
    await type(user, "@zzz");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  /**
   * The search endpoint is public-ish and can fail. A failed lookup closes the
   * dropdown rather than leaving a stale list from the previous keystroke.
   */
  it("stays closed when the search request fails", async () => {
    const user = setup();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await type(user, "@ali");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText("Alice Chen")).not.toBeInTheDocument();
  });

  it("ignores a non-array response instead of crashing", async () => {
    const user = setup();
    searchResults.current = { error: "boom" };
    await type(user, "@ali");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText("Alice Chen")).not.toBeInTheDocument();
  });

  it("debounces so a burst of keystrokes issues one search", async () => {
    const user = setup();
    await user.type(screen.getByRole("textbox"), "@alice");
    // Nothing yet — the debounce has not elapsed.
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastQuery()).toBe("alice");
  });

  it("url-encodes the query", async () => {
    const user = setup();
    await type(user, "@a&b");
    expect(fetchMock.mock.calls.at(-1)![0]).toContain("q=a%26b");
  });
});

describe("MentionInput — inserting a mention", () => {
  it("replaces the typed fragment with the full name and a trailing space", async () => {
    const user = setup();
    await type(user, "ping @ali");
    await user.click(await screen.findByText("Alice Chen"));
    expect(screen.getByRole("textbox")).toHaveValue("ping @Alice Chen ");
  });

  it("keeps text that follows the cursor", async () => {
    const user = setup();
    await type(user, "please review");
    // Move the caret back to just after "@ali" typed mid-sentence.
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    await user.clear(textarea);
    await type(user, "@ali");
    await user.click(await screen.findByText("Alice Chen"));
    expect(textarea).toHaveValue("@Alice Chen ");
  });

  it("closes the dropdown after a selection", async () => {
    const user = setup();
    await type(user, "@ali");
    await user.click(await screen.findByText("Alice Chen"));
    expect(screen.queryByText("Bob Smith")).not.toBeInTheDocument();
  });
});

describe("MentionInput — keyboard navigation", () => {
  it("moves the highlight down and inserts the highlighted name on Enter", async () => {
    const user = setup();
    await type(user, "@a");
    await screen.findByText("Alice Chen");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByRole("textbox")).toHaveValue("@Bob Smith ");
  });

  it("wraps from the last entry back to the first", async () => {
    const user = setup();
    await type(user, "@a");
    await screen.findByText("Alice Chen");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    expect(screen.getByRole("textbox")).toHaveValue("@Alice Chen ");
  });

  it("wraps backwards from the first entry to the last", async () => {
    const user = setup();
    await type(user, "@a");
    await screen.findByText("Alice Chen");
    await user.keyboard("{ArrowUp}{Enter}");
    expect(screen.getByRole("textbox")).toHaveValue("@Carla Diaz ");
  });

  it("accepts the highlighted name on Tab as well as Enter", async () => {
    const user = setup();
    await type(user, "@a");
    await screen.findByText("Alice Chen");
    await user.keyboard("{Tab}");
    expect(screen.getByRole("textbox")).toHaveValue("@Alice Chen ");
  });

  it("dismisses the dropdown on Escape without changing the text", async () => {
    const user = setup();
    await type(user, "@ali");
    await screen.findByText("Alice Chen");
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Alice Chen")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("@ali");
  });

  /**
   * With the dropdown shut, Enter must insert a newline rather than being
   * swallowed — otherwise a multi-line comment becomes impossible to write.
   */
  it("leaves Enter alone when no dropdown is open", async () => {
    const user = setup();
    await type(user, "line one{Enter}line two");
    expect(screen.getByRole("textbox")).toHaveValue("line one\nline two");
  });
});
