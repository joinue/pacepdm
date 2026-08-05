// Revision sequencing.
//
// Replaces `String.fromCharCode(revision.charCodeAt(0) + 1)`, which was the
// only revision logic in the app and was wrong in three ways: `Z` became
// `[`, a two-character revision lost everything after the first character
// (`R2` became `S`), and it used letters the standard reserves. All three
// failed silently, writing a corrupt revision rather than refusing.
//
// ── The alphabetic scheme ────────────────────────────────────────────────
//
// ASME Y14.35 excludes I, O, Q, S, X and Z from revision letters: I and O
// read as 1 and 0, Q as O, S as 5, Z as 2, and X is reserved for
// experimental. So the sequence is
//
//   A B C D E F G H J K L M N P R T U V W Y  AA AB … AY  BA …
//
// twenty letters per position, then two letters, and so on without bound.
//
// ── Other schemes ────────────────────────────────────────────────────────
//
// PACE's own part numbers carry revisions like `R2` and `R4`, so a
// letters-only sequencer would be useless on their data. Two more schemes
// are recognised: a plain integer (`1` → `2`), and an alphabetic prefix with
// a trailing integer (`R2` → `R3`, `Rev09` → `Rev10`, preserving the zero
// padding).
//
// Anything else returns null. A caller that cannot sequence a revision must
// say so — inventing one is how `R2` became `S`.

/** ASME Y14.35: I, O, Q, S, X and Z are not revision letters. */
const LETTERS = "ABCDEFGHJKLMNPRTUVWY";

export type RevisionScheme = "alpha" | "numeric" | "prefixed";

export interface RevisionInfo {
  scheme: RevisionScheme;
  next: string;
}

const ALPHA = /^[A-Z]+$/;
const NUMERIC = /^\d+$/;
const PREFIXED = /^([A-Za-z][A-Za-z-]*?)(\d+)$/;

/**
 * Increment an alphabetic revision within the reserved-letter alphabet,
 * carrying like an odometer: Y → AA, AY → BA, YY → AAA.
 */
function nextAlpha(revision: string): string | null {
  const digits: number[] = [];
  for (const char of revision) {
    const index = LETTERS.indexOf(char);
    // A revision containing a letter the standard reserves cannot be
    // sequenced — we do not know what the author's alphabet was.
    if (index === -1) return null;
    digits.push(index);
  }

  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i] < LETTERS.length - 1) {
      digits[i]++;
      return digits.map((d) => LETTERS[d]).join("");
    }
    digits[i] = 0; // carry
  }
  // Overflowed every position: YY → AAA.
  return LETTERS[0].repeat(digits.length + 1);
}

/**
 * The revision that follows `current`, or null when the format is not one we
 * can sequence.
 *
 * Returning null rather than guessing is deliberate. The caller turns it
 * into a refusal the user can act on ("set the next revision by hand"),
 * which is strictly better than writing a plausible-looking wrong value into
 * the field a release is identified by.
 */
export function nextRevision(current: string | null | undefined): RevisionInfo | null {
  const value = (current ?? "").trim();
  if (!value) return null;

  if (ALPHA.test(value)) {
    const next = nextAlpha(value);
    return next ? { scheme: "alpha", next } : null;
  }

  if (NUMERIC.test(value)) {
    // Preserve zero padding: 09 → 10, 009 → 010.
    const next = String(Number(value) + 1);
    return { scheme: "numeric", next: next.padStart(value.length, "0") };
  }

  const prefixed = value.match(PREFIXED);
  if (prefixed) {
    const [, prefix, digits] = prefixed;
    const next = String(Number(digits) + 1);
    return { scheme: "prefixed", next: `${prefix}${next.padStart(digits.length, "0")}` };
  }

  return null;
}

/**
 * True when `revision` uses only letters the standard permits. Used to warn
 * on data coming in from elsewhere rather than to reject it — an imported
 * part at revision `S` is a fact about the source system, not an error we
 * get to refuse.
 */
export function usesReservedLetter(revision: string): boolean {
  return ALPHA.test(revision) && [...revision].some((c) => !LETTERS.includes(c));
}
