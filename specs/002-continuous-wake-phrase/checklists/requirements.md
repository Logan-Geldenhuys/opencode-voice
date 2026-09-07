# Specification Quality Checklist: Continuous Listening with Wake-Phrase Submission

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-06
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Items marked incomplete require spec updates before `/speckit.clarify` or `/speckit.plan`.

### Validation findings

- **Zero `[NEEDS CLARIFICATION]` markers.** The three decisions that would otherwise
  have needed clarification were settled by the user in advance: automatic submission
  on wake phrase is intended; all captured speech may go to the corporate gateway; no
  language-model correction is applied to continuous speech.
- **This feature is not independently deliverable.** It depends on the enterprise
  gateway speech-to-text feature for transcription, credentials and audio capture.
  Recorded as the first assumption rather than left implicit, because the spec-kit
  convention of independently testable user stories otherwise implies a standalone MVP
  that does not exist here.
- **FR-012 states an outcome, not a widget.** The developer must not lose track of a
  live microphone. Whether that is served by a persistent display or by announcement
  plus an on-demand report is a planning question, and the requirement is written to
  remain testable either way.
- **SC-007 is deliberately behavioural, not visual.** It measures whether the developer
  is told, and can ask, rather than prescribing a rendering surface.
- **Two hazards are accepted rather than solved,** and are recorded as assumptions so
  they are not mistaken for oversights: speaking the wake phrase while talking _about_
  it will trigger it, and ambient conversation enters the buffer. Both are mitigated by
  opt-in activation, a bounded buffer age, and an inspectable, discardable buffer.
- **SC-005 measures a cost and privacy property, not performance.** Requests must not
  exceed distinct utterances, which is the testable form of "silence and noise never
  leave the machine".

### Revisions after planning

Planning showed that four requirements had specified a mechanism where they should have
stated an outcome, and that one outcome had not been stated at all. Those five have been
rewritten or added. One requirement was added; none were removed.

- **FR-012** previously implied a persistent display with signalling as a fallback. The
  host's notification call returns nothing that can be updated or dismissed, so a
  persistent notification is unrepresentable rather than merely awkward, and the
  alternative rendering surface is unproven from an external plugin and needs a build
  step to use ergonomically. The requirement now states what the fallback stated:
  announce every transition, and answer on demand. The outcome is unchanged.
- **SC-007** previously measured whether microphone state could be determined within
  two seconds of looking at the screen. That target cannot be met by any mechanism
  available, so it has been replaced rather than restated more weakly. It now measures
  that every transition is announced when it occurs and that the status command answers
  correctly, including mid-transcription.
- **FR-017** previously required held-key dictation to suspend continuous capture,
  discard the overlap, and resume. It now requires the two modes to be mutually
  exclusive, with the second attempt refused. Nothing the developer asked for is lost:
  both modes exist, and while listening the wake phrase already performs what the held
  key is for. **SC-010** was rewritten to match, measuring the refusal and the absence
  of concurrent recorders rather than the absence of duplicates across twenty
  alternating exchanges.
- **FR-021** previously required a way to observe segmentation outside the editor, which
  read as an obligation to build a tool. It now requires the procedure to be documented
  using the capture tooling the feature already depends on. The recorder does this in
  two lines of shell.
- **FR-023 is new,** and is the one place where planning found a requirement missing
  rather than over-specified. Wake-phrase matching runs on normalised text, and an
  earlier contract concluded that submitting that normalised form was acceptable. It is
  not: normalisation lowercases and strips punctuation, so `Server.tsx` becomes
  `servertsx` and sentence boundaries across a long buffer are lost. The feature would
  have corrupted exactly the terms FR-009's transcript label asks the agent to treat
  carefully. **SC-011** measures it character for character, and the quickstart names an
  identifier explicitly, because normalised prose still reads well enough that a test
  written on ordinary sentences passes either way.

**FR-003** was narrowed rather than changed: formatting variation is still tolerated
automatically, but anything beyond it is now handled by configured variants alone. A
second per-word substitution mechanism was specified and removed, because the distortions
that occur in practice span word boundaries and whole-word substitution cannot express
them.
