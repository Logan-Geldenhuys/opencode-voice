# Contract: Wake-phrase matching

**Feature**: 002-continuous-wake-phrase | **Module**: `lib/wake.js`

Pure functions. No I/O, no state, no host dependency. Satisfies FR-003, FR-004, FR-005, FR-008, FR-022, FR-023.

This module is separate precisely because it is the feature's correctness core and it is cheap to test exhaustively. SC-002 demands 95% correct triggering across a variant set; SC-003 demands zero misclassifications between the two phrases.

## Exported surface

### `normalise(text)`

Returns a normalised string suitable for matching.

Applied in order:

1. Lowercase.
2. Strip punctuation, keeping word characters and spaces.
3. Collapse runs of whitespace to a single space, then trim.

Deliberately **not** applied: stemming, stop-word removal, or any lossy transform. Those would raise the false-positive rate, and a false positive submits unintended speech to an agent with file-modifying tools.

The output of this function is used **only to locate a phrase**. It is never submitted, never stored as the buffer, and never returned to the caller as content. Lowercasing and punctuation stripping are lossy by design, and what they lose is precisely what distinguishes `Server.tsx` from `servertsx` (FR-023).

### `compilePhrases(config)`

Turns configuration into a matcher. Called once; the result is reused.

**`config`** — array of:

| Field       | Type                               | Required | Meaning                   |
| ----------- | ---------------------------------- | -------- | ------------------------- |
| `canonical` | string                             | yes      | The phrase as spoken      |
| `variants`  | string[]                           | no       | Additional accepted forms |
| `action`    | `"submit"` \| `"interrupt_submit"` | yes      | What firing it does       |

Every canonical form and variant is normalised at compile time. The compiled set is **sorted by normalised token length, descending** — this is the mechanism implementing FR-005, not a runtime comparison, so the longest-wins rule cannot be accidentally bypassed by a caller.

Rejects at compile time: an empty phrase list, a phrase normalising to the empty string, a single-word phrase (too likely to occur in ordinary speech), or two distinct actions compiling to the same normalised form.

### `findWake(segments, compiled)`

**`segments`** — the buffer as an ordered array of segment texts, **as transcribed**. Not a pre-joined string, and not normalised.

Returns `null` when nothing matches, or:

| Field     | Type                               | Meaning                                                              |
| --------- | ---------------------------------- | -------------------------------------------------------------------- |
| `action`  | `"submit"` \| `"interrupt_submit"` | Action to take                                                       |
| `matched` | string                             | The normalised variant that matched. For diagnostics only            |
| `before`  | string                             | **Original** text preceding the match — becomes the prompt           |
| `after`   | string                             | **Original** text following the match — retained for the next buffer |

**Matching rules**

1. **Longest first.** Candidates are tested in compiled order, which is longest-normalised-first. The first hit wins and testing stops. This is what prevents the interrupt variant being read as the plain variant plus stray words.
2. **Word-boundary aligned.** A match must begin and end at a word boundary in the normalised text, so `submitted` does not match a phrase containing `submit`.
3. **Buffer-wide.** Matching is performed across the whole buffer, not per segment. A phrase spoken across a pause exists only in the join (FR-004).
4. **At most one phrase is present.** The caller invokes this after every segment append, so an earlier phrase would already have fired and cleared the buffer. The function therefore does not need to choose between multiple occurrences, and must not be written as though it does.

Rule 4 replaces a _last occurrence wins_ rule from an earlier draft. Under the once-per-append invariant that rule is unobservable: no input reaching this function in normal operation can contain two undetected phrases, so first-versus-last cannot be distinguished by any test of the running system. It was specification with no referent. A test asserts the invariant instead of a rule about violating it.

**Returning original text.** The function normalises internally to find the phrase, then maps the match position **back into the original segments** and slices those. Because the caller passes segments rather than a joined string, the module owns the join and can therefore invert it: a normalised character offset maps to a `(segmentIndex, charOffset)` pair, and `before` and `after` are assembled from the untouched originals.

This is the one place in the feature where the design chooses more code over less, and it is deliberate. Returning the normalised text would be shorter and is what an earlier draft specified, calling it "acceptable and arguably preferable". It is neither. Normalisation lowercases and strips punctuation, so `"Fix the bug in Server.tsx, then run npm test."` reaches the agent as `"fix the bug in servertsx then run npm test"`. The identifier is destroyed, the sentence boundary is gone, and the corruption lands on exactly the token class FR-009's transcript label asks the agent to be careful about — the feature would mangle identifiers in the same breath as warning about them. The failure is also invisible under casual testing, because normalised prose still reads fine. Roughly fifteen lines of offset mapping buys correctness that cannot be recovered later.

There is no `applyHomophones` and no substitution map. An earlier draft exported one to absorb recogniser distortions of the wake phrase, alongside the `variants` mechanism FR-022 already requires. Variants subsume it and express strictly more: the draft's own motivating example was `opencode` returned as `open code`, a **two-word** distortion that whole-word substitution cannot represent at all. Keeping both would mean two mechanisms for one job, the weaker one running first and able to corrupt text before matching even begins.

## Configuration contract

Defaults, overridable per FR-022:

| Phrase                      | Action             |
| --------------------------- | ------------------ |
| `opencode execute`          | `submit`           |
| `opencode stop and execute` | `interrupt_submit` |

The two share the prefix `opencode` and differ by an inserted `stop and`. This is exactly the shape FR-005 addresses, and it is why the longest-wins rule is enforced structurally at compile time rather than left to the matcher.

Variants exist because the recogniser returns predictable distortions — `open code` split into two words being the obvious one for this phrase set. Variants are configuration, not code, so a developer whose phrase is unreliable in their accent or room can fix it without a patch (FR-022).

Variants are also the **only** mechanism for tolerating non-formatting distortion. Spacing, casing and punctuation are handled by `normalise`; anything beyond that is expressed as an additional accepted form of the phrase. A single mechanism means one place to look when a phrase misfires, and it can express word splits and merges, which a per-word map cannot.

## Test obligations

`test/wake.test.js` must cover:

| Case                                                               | Asserts                              |
| ------------------------------------------------------------------ | ------------------------------------ |
| Each canonical phrase matches                                      | Baseline                             |
| Each configured variant matches                                    | FR-003                               |
| Casing, trailing punctuation, doubled spaces                       | FR-003                               |
| Phrase split by a pause, joined from two segments                  | FR-004                               |
| Interrupt variant never resolves as plain                          | **FR-005, SC-003 — zero tolerance**  |
| Plain variant does not match when the interrupt variant was spoken | FR-005                               |
| `before` excludes the phrase                                       | FR-008                               |
| `after` is retained, not discarded                                 | FR-008                               |
| `before` preserves casing and punctuation exactly                  | **FR-023, SC-011**                   |
| `Server.tsx` survives a round trip unchanged                       | **FR-023 — the specific regression** |
| Match spanning a segment boundary maps back to both originals      | FR-004 with FR-023                   |
| Word-boundary rejection                                            | Rule 2                               |
| Detection after every append leaves at most one phrase buffered    | Rule 4                               |
| Phrase-free technical conversation matches nothing                 | SC-004                               |
| Compile-time rejections                                            | Configuration validation             |

The interrupt-versus-plain case carries a zero-tolerance criterion. It is the one failure that both submits the wrong thing and fails to stop the agent, which is precisely the situation the developer reached for the interrupt phrase to escape.

The `Server.tsx` case is named explicitly rather than folded into the general casing assertion. A test written on ordinary prose passes whether or not the mapping is correct, because normalised prose is still readable; only a token whose meaning depends on case and punctuation exposes the defect.
