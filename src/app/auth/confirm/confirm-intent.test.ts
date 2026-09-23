import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api-client";
import { explainFailure, intentFor } from "./confirm-intent";

/**
 * The confirm page's copy follows where the link lands, not the token type:
 * a resent invitation to a confirmed account is a `recovery` token that is
 * still an invitation.
 */
describe("intentFor", () => {
  it("reads an invitation from its destination whatever the token type", () => {
    expect(intentFor("/accept-invite", "invite")).toBe("invite");
    expect(intentFor("/accept-invite", "recovery")).toBe("invite");
  });

  it("reads a sign-up confirmation from its destination", () => {
    expect(intentFor("/onboarding", "signup")).toBe("signup");
    expect(intentFor("/onboarding", "recovery")).toBe("signup");
  });

  it("falls back to the token type when the destination says nothing", () => {
    expect(intentFor("/", "recovery")).toBe("recovery");
    expect(intentFor("/", "invite")).toBe("invite");
    expect(intentFor("/", null)).toBe("other");
  });
});

describe("explainFailure", () => {
  const expired = new ApiError("Email link is invalid or has expired", 400);

  it("tells an invitee to ask for a resend", () => {
    const failure = explainFailure(expired, "invite");
    expect(failure.message).toMatch(/expired or was already used/);
    expect(failure.hint).toMatch(/resend/i);
  });

  it("points a sign-up at the sign-in page's new link", () => {
    expect(explainFailure(expired, "signup").hint).toMatch(/new link/i);
  });

  it("points a password reset at requesting another", () => {
    expect(explainFailure(expired, "recovery").hint).toMatch(/Request a new one/);
  });

  it("passes an unrecognised error through as it is", () => {
    const failure = explainFailure(new ApiError("Database is on fire", 500), "invite");
    expect(failure).toEqual({ message: "Database is on fire", hint: "" });
  });
});
