// Wake-phrase matching. Pure functions: no I/O, no state, no host dependency.
//
// Satisfies FR-003, FR-004, FR-005, FR-008, FR-022 and FR-023. See
// specs/002-continuous-wake-phrase/contracts/wake-phrase.md.
//
// The representation decision is the whole of this module's design. Matching
// needs a normalised view of the text and submission needs the original. The
// obvious way to have both is to join the buffer, normalise the join, match in
// it and map the offsets back — work that exists only to recover the alignment
// the join discarded a moment earlier. So the join never happens. Normalisation
// is per token, and each token carries where it came from. A phrase is a
// contiguous run of tokens; the text to submit is a slice of the original at
// the run's boundaries.
//
// Three former rules follow from that and are therefore absent here:
//
//   1. FR-023 holds by construction. No normalised representation of the buffer
//      exists, so there is nothing of the wrong kind available to submit.
//   2. Word-boundary alignment is not a rule. A run matches whole tokens or
//      does not match, so `submitted` can never satisfy a run containing the
//      token `submit`.
//   3. Punctuation tolerance is structural. `execute.` and `execute` produce
//      the same `norm`, and the span still covers the period.

// Anything that is not a letter, a number or an underscore is dropped from the
// normalised form. Unicode-aware rather than \w, so a non-ASCII transcript
// tokenises rather than collapsing to nothing.
const NON_WORD = /[^\p{L}\p{N}_]/gu;
const WORD = /\S+/gu;

export const SUBMIT = "submit";
export const INTERRUPT_SUBMIT = "interrupt_submit";

const ACTIONS = new Set([SUBMIT, INTERRUPT_SUBMIT]);

/**
 * Split text into tokens that remember where they came from.
 *
 * `text.slice(token.start, token.end)` returns the word as the developer said
 * it, punctuation and casing intact. That single property is what the rest of
 * the feature needs from tokenisation, and it is what makes FR-023 free.
 *
 * Deliberately not applied: stemming, stop-word removal, phonetic folding, or
 * any transform that maps distinct words together. Those raise the
 * false-positive rate, and a false positive submits unintended speech to an
 * agent holding file-modifying tools.
 *
 * @param {string} text
 * @returns {{norm: string, start: number, end: number}[]}
 */
export function tokenise(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const tokens = [];
  for (const match of text.matchAll(WORD)) {
    const raw = match[0];
    const norm = raw.replace(NON_WORD, "").toLowerCase();
    // A word that is entirely punctuation carries no matchable content, so it
    // is dropped and its span with it.
    if (norm.length === 0) continue;
    tokens.push({ norm, start: match.index, end: match.index + raw.length });
  }
  return tokens;
}

/**
 * Turn configuration into a matcher. Called once; the result is reused.
 *
 * @param {{canonical: string, variants?: string[], action: string}[]} config
 * @returns {{action: string, tokens: string[], source: string, canonical: string}[]}
 */
export function compilePhrases(config) {
  if (!Array.isArray(config) || config.length === 0) {
    throw new Error("listenWakePhrases must be a non-empty array of phrases");
  }

  const compiled = [];
  // Normalised token sequence -> the action already claiming it, so a
  // conflicting claim can name both sides.
  const claimed = new Map();

  for (const [index, entry] of config.entries()) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`listenWakePhrases[${index}] must be an object`);
    }
    const { canonical, variants = [], action } = entry;
    if (!ACTIONS.has(action)) {
      throw new Error(
        `listenWakePhrases[${index}].action must be "${SUBMIT}" or "${INTERRUPT_SUBMIT}", got ${JSON.stringify(action)}`,
      );
    }
    if (typeof canonical !== "string" || canonical.trim() === "") {
      throw new Error(`listenWakePhrases[${index}].canonical must be a non-empty string`);
    }
    if (!Array.isArray(variants)) {
      throw new Error(`listenWakePhrases[${index}].variants must be an array of strings`);
    }

    for (const form of [canonical, ...variants]) {
      if (typeof form !== "string") {
        throw new Error(`listenWakePhrases[${index}] contains a non-string accepted form`);
      }
      const tokens = tokenise(form).map((t) => t.norm);
      if (tokens.length === 0) {
        throw new Error(`Wake phrase ${JSON.stringify(form)} contains no matchable words`);
      }
      // A one-word phrase occurs too readily in ordinary speech, and the cost
      // of a false positive here is an unintended prompt to an agent that can
      // modify files.
      if (tokens.length === 1) {
        throw new Error(
          `Wake phrase ${JSON.stringify(form)} is a single word; use at least two so it cannot fire in ordinary speech`,
        );
      }

      const key = tokens.join(" ");
      const owner = claimed.get(key);
      if (owner === action) continue; // Same phrase, same action: nothing to add.
      if (owner) {
        throw new Error(
          `Wake phrase ${JSON.stringify(form)} resolves to "${key}", which is already bound to ${owner}; one form cannot mean two things`,
        );
      }
      claimed.set(key, action);
      // `canonical` travels with every accepted form so a caller reporting
      // what to say can name the phrase rather than listing its variants.
      compiled.push({ action, tokens, source: form, canonical });
    }
  }

  // Sorting here is the mechanism implementing FR-005. Longest-wins is
  // therefore structural, not a comparison inside the search loop that a
  // caller could bypass by constructing the list themselves.
  compiled.sort((a, b) => b.tokens.length - a.tokens.length);
  return compiled;
}

// Flatten the buffer into one token sequence while remembering which entry
// each token came from. This is the concatenation the design permits: token
// arrays, not text.
function flatten(entries) {
  const flat = [];
  for (const [entryIndex, text] of entries.entries()) {
    for (const token of tokenise(text)) {
      flat.push({ ...token, entry: entryIndex });
    }
  }
  return flat;
}

function runMatches(flat, at, tokens) {
  for (let k = 0; k < tokens.length; k += 1) {
    if (flat[at + k].norm !== tokens[k]) return false;
  }
  return true;
}

// Join whole entries and partial slices the same way: as separate utterances
// separated by a single space. Empty and whitespace-only pieces contribute
// nothing rather than accumulating separators.
function joinParts(parts) {
  return parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");
}

/**
 * Find a wake phrase in the buffer.
 *
 * @param {string[]} entries - The buffer as transcribed. Not pre-joined, not normalised
 * @param {ReturnType<typeof compilePhrases>} compiled
 * @returns {{action: string, matched: string[], before: string, after: string} | null}
 */
export function findWake(entries, compiled) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  if (!Array.isArray(compiled) || compiled.length === 0) return null;

  const flat = flatten(entries);
  if (flat.length === 0) return null;

  for (const phrase of compiled) {
    const width = phrase.tokens.length;
    if (width > flat.length) continue;

    for (let i = 0; i + width <= flat.length; i += 1) {
      if (!runMatches(flat, i, phrase.tokens)) continue;

      // Rule 3: at most one phrase is present. The caller runs detection after
      // every segment append, so an earlier phrase would already have fired and
      // cleared the buffer. There is nothing to choose between, so this returns
      // on the first hit rather than continuing to look for a later one.
      const first = flat[i];
      const last = flat[i + width - 1];

      const before = joinParts([
        ...entries.slice(0, first.entry),
        entries[first.entry].slice(0, first.start),
      ]);
      const after = joinParts([
        entries[last.entry].slice(last.end),
        ...entries.slice(last.entry + 1),
      ]);

      return { action: phrase.action, matched: phrase.tokens, before, after };
    }
  }

  return null;
}

// Defaults per the configuration contract. The two phrases share the prefix
// `opencode` and differ by an inserted `stop and`: exactly the shape FR-005
// addresses, and why longest-wins is enforced at compile time.
//
// The variant lists are starting points, not findings. Which distortions the
// recogniser actually produces is established by the calibration in
// quickstart.md, whose output is this list (SC-012, FR-022).
export const DEFAULT_WAKE_PHRASES = [
  {
    canonical: "opencode execute",
    variants: ["open code execute"],
    action: SUBMIT,
  },
  {
    canonical: "opencode stop and execute",
    variants: ["open code stop and execute", "opencode stop execute"],
    action: INTERRUPT_SUBMIT,
  },
];
