# Contract: Wake-phrase matching

**Feature**: 002-continuous-wake-phrase | **Module**: `lib/wake.js`

Pure functions. No I/O, no state, no host dependency. Satisfies FR-003, FR-004, FR-005, FR-008, FR-022, FR-023.

This module is separate precisely because it is the feature's correctness core and it is cheap to test exhaustively. SC-002 demands that matching be correct on every accepted form, with no tolerance — matching is deterministic, so a sampled pass rate would only measure how many cases the test author wrote. Recognition fidelity, which genuinely is a rate, is SC-012's business and is calibrated rather than tested. SC-003 demands zero misclassifications between the two phrases.

## The representation decision

Matching needs a normalised view of the text; submission needs the original. The obvious way to have both is to join the buffer, normalise the join, match in it, and map the resulting offsets back — which is what an earlier draft specified. That work exists only to recover the alignment the join discarded a moment earlier.

So do not discard it. Normalise **per token**, and have each token carry where it came from. A phrase becomes a contiguous run of tokens, and the text to submit is a slice of the original at the run's boundaries. No normalised string is ever assembled, and the mapping step has nothing to map.

Three things follow, each of which used to be a separate rule:

1. **FR-023 holds by construction.** There is no normalised representation of the buffer, so there is nothing of the wrong kind available to submit. SC-011 measures something unreachable rather than something forbidden.
2. **Word-boundary alignment is not a rule.** A token run either matches whole tokens or does not match. `submitted` is one token and can never satisfy a run containing the token `submit`, so the boundary rule from the earlier draft is deleted rather than tested.
3. **Punctuation tolerance is structural.** `execute.` and `execute` produce the same token, because punctuation is stripped inside the token and the token's span still covers the character.

## Exported surface

### `tokenise(text)`

Returns an array of tokens in order:

| Field   | Type   | Meaning                                       |
| ------- | ------ | --------------------------------------------- |
| `norm`  | string | Lowercased, punctuation removed               |
| `start` | number | Index in `text` where the token begins        |
| `end`   | number | Index in `text` one past where the token ends |

Splitting is on whitespace; each resulting word is lowercased and stripped of non-word characters. Tokens normalising to the empty string are dropped, and their spans with them.

`text.slice(token.start, token.end)` returns the word **as the developer said it**, punctuation and casing intact. This is the only property the rest of the feature needs from tokenisation, and it is what makes FR-023 free.

Deliberately **not** applied: stemming, stop-word removal, phonetic folding, or any transform that maps distinct words together. Those would raise the false-positive rate, and a false positive submits unintended speech to an agent holding file-modifying tools.

The same function serves phrase compilation: a configured phrase is `tokenise(phrase).map((t) => t.norm)`, since a phrase has no original worth preserving.

### `compilePhrases(config)`

Turns configuration into a matcher. Called once; the result is reused.

**`config`** — array of:

| Field       | Type                               | Required | Meaning                   |
| ----------- | ---------------------------------- | -------- | ------------------------- |
| `canonical` | string                             | yes      | The phrase as spoken      |
| `variants`  | string[]                           | no       | Additional accepted forms |
| `action`    | `"submit"` \| `"interrupt_submit"` | yes      | What firing it does       |

Every canonical form and variant is tokenised at compile time into an array of normalised words. The compiled set is **sorted by token count, descending** — this is the mechanism implementing FR-005, not a runtime comparison, so the longest-wins rule cannot be accidentally bypassed by a caller.

Rejects at compile time: an empty phrase list, a phrase tokenising to zero tokens, a single-token phrase (too likely to occur in ordinary speech), or two distinct actions compiling to the same token sequence.

### `findWake(entries, compiled)`

**`entries`** — the buffer as an ordered array of texts, **as transcribed**. Not a pre-joined string, and not normalised.

Returns `null` when nothing matches, or:

| Field     | Type                               | Meaning                                                              |
| --------- | ---------------------------------- | -------------------------------------------------------------------- |
| `action`  | `"submit"` \| `"interrupt_submit"` | Action to take                                                       |
| `matched` | string[]                           | The token sequence that matched. For diagnostics only                |
| `before`  | string                             | **Original** text preceding the match — becomes the prompt           |
| `after`   | string                             | **Original** text following the match — retained for the next buffer |

Internally: tokenise each entry, concatenate the token arrays while remembering which entry each token came from, and search that flat sequence for a compiled phrase. `before` is every entry before the first matched token joined with that entry's own text sliced to `token.start`; `after` is the mirror image from the last matched token's `end`. The entry texts are never modified, only sliced.

**Matching rules**

1. **Longest first.** Candidates are tested in compiled order, which is longest-token-count-first. The first hit wins and testing stops. This is what prevents the interrupt phrase being read as the plain phrase plus stray words.
2. **Buffer-wide.** Matching is performed across the whole flattened token sequence, not per entry. A token run may cross an entry boundary, which is how a phrase spoken across a pause matches at all (FR-004).
3. **At most one phrase is present.** The caller invokes this after every segment append, so an earlier phrase would already have fired and cleared the buffer. The function therefore does not need to choose between multiple occurrences, and must not be written as though it does.

Rule 3 replaces a _last occurrence wins_ rule from an earlier draft. Under the once-per-append invariant that rule is unobservable: no input reaching this function in normal operation can contain two undetected phrases, so first-versus-last cannot be distinguished by any test of the running system. It was specification with no referent. A test asserts the invariant instead of a rule about violating it.

The earlier draft's word-boundary rule is also gone, for the stronger reason that it is now impossible to violate. It was a rule about substring matching in a joined normalised string, and there is no such string.

There is no `applyHomophones` and no substitution map. An earlier draft exported one to absorb recogniser distortions of the wake phrase, alongside the `variants` mechanism FR-022 already requires. Variants subsume it and express strictly more: the draft's own motivating example was `opencode` returned as `open code`, a **two-word** distortion that whole-word substitution cannot represent at all. Keeping both would mean two mechanisms for one job, the weaker one running first and able to corrupt text before matching even begins.

## Configuration contract

Defaults, overridable per FR-022:

| Phrase                      | Action             |
| --------------------------- | ------------------ |
| `opencode execute`          | `submit`           |
| `opencode stop and execute` | `interrupt_submit` |

The two share the prefix `opencode` and differ by an inserted `stop and`. This is exactly the shape FR-005 addresses, and it is why the longest-wins rule is enforced structurally at compile time rather than left to the matcher.

Variants exist because the recogniser returns predictable distortions — `open code` split into two words being the obvious one for this phrase set. Variants are configuration, not code, so a developer whose phrase is unreliable in their accent or room can fix it without a patch (FR-022). Establishing which distortions actually occur is the calibration procedure in quickstart.md, whose output is this list (SC-012).

Variants are also the **only** mechanism for tolerating non-formatting distortion. Spacing, casing and punctuation are handled by tokenisation; anything beyond that is expressed as an additional accepted form of the phrase. A single mechanism means one place to look when a phrase misfires, and it can express word splits and merges, which a per-word map cannot.

## Test obligations

`test/wake.test.js` must cover:

| Case                                                             | Asserts                              |
| ---------------------------------------------------------------- | ------------------------------------ |
| Each canonical phrase matches                                    | Baseline                             |
| Each configured variant matches                                  | FR-003, SC-002 at 100%               |
| Casing, trailing punctuation, doubled spaces                     | FR-003                               |
| Phrase split by a pause, spanning two entries                    | FR-004                               |
| Interrupt phrase never resolves as plain                         | **FR-005, SC-003 — zero tolerance**  |
| Plain phrase does not match when the interrupt phrase was spoken | FR-005                               |
| `before` excludes the phrase                                     | FR-008                               |
| `after` is retained, not discarded                               | FR-008                               |
| `before` preserves casing and punctuation exactly                | **FR-023, SC-011**                   |
| `Server.tsx` survives a round trip unchanged                     | **FR-023 — the specific regression** |
| Match spanning an entry boundary slices both originals correctly | FR-004 with FR-023                   |
| `submitted` does not match a phrase containing `submit`          | Token runs match whole tokens        |
| `tokenise` spans slice back to the original word                 | The property FR-023 rests on         |
| Detection after every append leaves at most one phrase buffered  | Rule 3                               |
| Phrase-free technical conversation matches nothing               | SC-004                               |
| Compile-time rejections                                          | Configuration validation             |

The interrupt-versus-plain case carries a zero-tolerance criterion. It is the one failure that both submits the wrong thing and fails to stop the agent, which is precisely the situation the developer reached for the interrupt phrase to escape.

The `Server.tsx` case is named explicitly rather than folded into the general casing assertion. A test written on ordinary prose passes whether or not spans are handled correctly, because normalised prose is still readable; only a token whose meaning depends on case and punctuation exposes the defect.

The `tokenise` span assertion is listed separately from the `before`/`after` assertions because it is the primitive they both depend on. If spans are wrong, every higher-level test can still pass on single-entry prose while the feature corrupts identifiers in the field.
