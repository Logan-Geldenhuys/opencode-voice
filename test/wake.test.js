import assert from "node:assert/strict";
import test from "node:test";

import {
  compilePhrases,
  DEFAULT_WAKE_PHRASES,
  findWake,
  INTERRUPT_SUBMIT,
  SUBMIT,
  tokenise,
} from "../lib/wake.js";

const compiled = compilePhrases(DEFAULT_WAKE_PHRASES);
const ACTIONS = new Set([SUBMIT, INTERRUPT_SUBMIT]);

function accepted(action) {
  return DEFAULT_WAKE_PHRASES.filter((p) => p.action === action).flatMap((p) => [
    p.canonical,
    ...(p.variants ?? []),
  ]);
}

const SUBMIT_FORMS = accepted(SUBMIT);
const INTERRUPT_FORMS = accepted(INTERRUPT_SUBMIT);

// --- tokenise: the primitive everything else rests on -----------------------

test("tokenise spans slice back to the word as it was spoken", () => {
  const text = "Rename Server.tsx, then run  the tests.";
  for (const token of tokenise(text)) {
    const raw = text.slice(token.start, token.end);
    assert.equal(raw.replace(/[^\p{L}\p{N}_]/gu, "").toLowerCase(), token.norm);
  }
  assert.deepEqual(
    tokenise(text).map((t) => t.norm),
    ["rename", "servertsx", "then", "run", "the", "tests"],
  );
  // The span covers the trailing punctuation, so slicing either side of a
  // token never leaves an orphaned comma behind.
  const server = tokenise(text)[1];
  assert.equal(text.slice(server.start, server.end), "Server.tsx,");
});

test("tokenise drops words that normalise to nothing", () => {
  assert.deepEqual(
    tokenise("hello --- world").map((t) => t.norm),
    ["hello", "world"],
  );
  assert.deepEqual(tokenise(""), []);
  assert.deepEqual(tokenise("   "), []);
});

// --- every accepted form matches, exhaustively (SC-002 at 100%) -------------

for (const form of SUBMIT_FORMS) {
  test(`accepted submission form matches: ${JSON.stringify(form)}`, () => {
    const hit = findWake([`refactor the parser ${form}`], compiled);
    assert.ok(hit);
    assert.equal(hit.action, SUBMIT);
    assert.equal(hit.before, "refactor the parser");
    assert.equal(hit.after, "");
  });
}

for (const form of INTERRUPT_FORMS) {
  test(`accepted interrupt form matches: ${JSON.stringify(form)}`, () => {
    const hit = findWake([`no wait use the other file ${form}`], compiled);
    assert.ok(hit);
    assert.equal(hit.action, INTERRUPT_SUBMIT);
    assert.equal(hit.before, "no wait use the other file");
  });
}

// --- zero tolerance: interrupt must never resolve as plain (SC-003) ---------

test("no interrupt form ever resolves to a plain submission", () => {
  const carriers = [
    (f) => [f],
    (f) => [`hold on ${f}`],
    (f) => [`hold on ${f.toUpperCase()}`],
    (f) => [`hold on ${f}.`],
    (f) => [`hold on ${f}`, "and then check the tests"],
    (f) => ["fix the parser", `then ${f}`],
  ];
  for (const form of INTERRUPT_FORMS) {
    for (const carrier of carriers) {
      const hit = findWake(carrier(form), compiled);
      assert.ok(hit, `no match for ${JSON.stringify(carrier(form))}`);
      assert.equal(
        hit.action,
        INTERRUPT_SUBMIT,
        `${JSON.stringify(carrier(form))} resolved as ${hit.action}`,
      );
    }
  }
});

test("the shared prefix does not let the shorter phrase win", () => {
  // "opencode stop and execute" contains no complete "opencode execute" run,
  // but the sort is what guarantees the longer phrase is tested first.
  const hit = findWake(["opencode stop and execute"], compiled);
  assert.equal(hit.action, INTERRUPT_SUBMIT);
  assert.equal(compiled[0].tokens.length >= compiled.at(-1).tokens.length, true);
});

test("longest wins when both phrases are literally present", () => {
  const phrases = compilePhrases([
    { canonical: "run it", action: SUBMIT },
    { canonical: "please run it", action: INTERRUPT_SUBMIT },
  ]);
  assert.equal(findWake(["ok please run it"], phrases).action, INTERRUPT_SUBMIT);
});

// --- formatting tolerance ---------------------------------------------------

test("casing, trailing punctuation and doubled spaces do not prevent a match", () => {
  for (const spoken of [
    "OpenCode Execute",
    "opencode execute.",
    "Opencode,  execute!",
    "  opencode   execute  ",
  ]) {
    const hit = findWake([`do the thing ${spoken}`], compiled);
    assert.ok(hit, `did not match ${JSON.stringify(spoken)}`);
    assert.equal(hit.action, SUBMIT);
    assert.equal(hit.before, "do the thing");
  }
});

// --- buffer-wide matching (FR-004) ------------------------------------------

test("a phrase split across two entries still matches", () => {
  const hit = findWake(["update the readme opencode", "execute"], compiled);
  assert.ok(hit);
  assert.equal(hit.action, SUBMIT);
  assert.equal(hit.before, "update the readme");
  assert.equal(hit.after, "");
});

test("a match spanning an entry boundary slices both originals", () => {
  const hit = findWake(
    ["check Server.tsx then opencode", "execute and keep the CHANGELOG.md open"],
    compiled,
  );
  assert.ok(hit);
  assert.equal(hit.before, "check Server.tsx then");
  assert.equal(hit.after, "and keep the CHANGELOG.md open");
});

test("entries before and after the match are retained whole", () => {
  const hit = findWake(["first thought", "second thought opencode execute", "third"], compiled);
  assert.equal(hit.before, "first thought second thought");
  assert.equal(hit.after, "third");
});

// --- the phrase is a terminator (FR-008) ------------------------------------

test("before excludes the phrase and after is retained", () => {
  const hit = findWake(["rename the handler opencode execute now do the tests"], compiled);
  assert.equal(hit.before, "rename the handler");
  assert.equal(hit.after, "now do the tests");
  assert.ok(!hit.before.includes("opencode"));
  assert.ok(!hit.after.includes("execute"));
});

// --- FR-023 / SC-011: the original text is what survives --------------------

test("before preserves casing and punctuation exactly", () => {
  const spoken = "Rewrite the JSON parser in src/index.js, then re-run CI. opencode execute";
  const hit = findWake([spoken], compiled);
  assert.equal(hit.before, "Rewrite the JSON parser in src/index.js, then re-run CI.");
});

test("Server.tsx round-trips unchanged", () => {
  // Named on its own because ordinary prose reads perfectly well after
  // normalisation: a test on prose passes whether or not the spans are right.
  const hit = findWake(["open Server.tsx and useEffect() opencode execute"], compiled);
  assert.equal(hit.before, "open Server.tsx and useEffect()");
  assert.ok(hit.before.includes("Server.tsx"));
});

// --- word-boundary alignment is structural ----------------------------------

test("submitted does not match a phrase containing submit", () => {
  const phrases = compilePhrases([{ canonical: "now submit", action: SUBMIT }]);
  assert.equal(findWake(["the patch was now submitted upstream"], phrases), null);
  assert.ok(findWake(["the patch is ready now submit"], phrases));
});

// --- at most one phrase is buffered (rule 3) --------------------------------

test("detection after every append means at most one phrase is ever buffered", () => {
  // Simulate the caller: append, detect, and on a hit replace the buffer with
  // the retained tail. The buffer must never hold two phrases at once.
  const spoken = ["draft the plan opencode execute", "and now the tests opencode execute"];
  let buffer = [];
  const fired = [];
  for (const segment of spoken) {
    buffer.push(segment);
    const hit = findWake(buffer, compiled);
    assert.ok(hit, "a phrase in the appended segment must be detected immediately");
    fired.push(hit.before);
    buffer = hit.after ? [hit.after] : [];
    assert.equal(findWake(buffer, compiled), null, "the tail must not contain a second phrase");
  }
  assert.deepEqual(fired, ["draft the plan", "and now the tests"]);
});

// --- SC-004: phrase-free conversation matches nothing -----------------------

test("technical conversation without a phrase matches nothing", () => {
  const conversation = [
    "I think the opencode plugin is loading twice.",
    "We should execute the migration before the deploy, not after.",
    "Open the code in Server.tsx and check whether stopActiveCapture is called.",
    "Does opencode stop when the pane closes? I need to execute a test.",
  ];
  assert.equal(findWake(conversation, compiled), null);
  for (const line of conversation) {
    assert.equal(findWake([line], compiled), null, `false positive on: ${line}`);
  }
});

test("an empty or absent buffer matches nothing", () => {
  assert.equal(findWake([], compiled), null);
  assert.equal(findWake(["", "   "], compiled), null);
  assert.equal(findWake(null, compiled), null);
});

test("an empty buffer before the phrase yields an empty before", () => {
  const hit = findWake(["opencode execute"], compiled);
  assert.equal(hit.before, "");
  assert.equal(hit.after, "");
});

// --- compile-time rejections ------------------------------------------------

test("compilePhrases rejects malformed configuration", () => {
  assert.throws(() => compilePhrases([]), /non-empty array/);
  assert.throws(() => compilePhrases("opencode execute"), /non-empty array/);
  assert.throws(() => compilePhrases([{ canonical: "run it" }]), /action must be/);
  assert.throws(() => compilePhrases([{ canonical: "run it", action: "abort" }]), /action must be/);
  assert.throws(() => compilePhrases([{ canonical: "   ", action: SUBMIT }]), /non-empty string/);
  assert.throws(() => compilePhrases([{ canonical: "!!!", action: SUBMIT }]), /no matchable words/);
  assert.throws(() => compilePhrases([{ canonical: "execute", action: SUBMIT }]), /single word/);
  assert.throws(
    () => compilePhrases([{ canonical: "run it", variants: "go now", action: SUBMIT }]),
    /variants must be an array/,
  );
});

test("compilePhrases rejects one form meaning two things", () => {
  assert.throws(
    () =>
      compilePhrases([
        { canonical: "opencode execute", action: SUBMIT },
        { canonical: "OpenCode, execute!", action: INTERRUPT_SUBMIT },
      ]),
    /cannot mean two things/,
  );
});

test("compilePhrases deduplicates a form repeated under the same action", () => {
  const phrases = compilePhrases([
    { canonical: "opencode execute", variants: ["OpenCode execute."], action: SUBMIT },
  ]);
  assert.equal(phrases.length, 1);
});

test("compilePhrases sorts by token count descending", () => {
  const phrases = compilePhrases([
    { canonical: "run it", action: SUBMIT },
    { canonical: "please stop and run it", action: INTERRUPT_SUBMIT },
  ]);
  assert.deepEqual(
    phrases.map((p) => p.tokens.length),
    [5, 2],
  );
});

test("the defaults compile", () => {
  assert.equal(compiled.length, SUBMIT_FORMS.length + INTERRUPT_FORMS.length);
  for (const phrase of compiled) {
    assert.ok(phrase.tokens.length >= 2);
    assert.ok(ACTIONS.has(phrase.action));
  }
});

// The name in "hey nome ..." arrives as something different from every speaker,
// so what the phrase rests on is the two tokens around it. These traps are
// ordinary speech about code containing a homophone of the name, and they must
// not fire: the words "hey node" or "hey norm" on their own are a topic, not an
// address. This is the property that made lengthening the phrase worth it, so
// it is asserted rather than left to whoever next edits the variant list.
test("the name alone is not an address", () => {
  const traps = [
    "hey node is crashing on startup",
    "the hey node thing in the changelog",
    "hey norm reviewed the pull request",
    "so I said hey name the function fetchUser and it worked",
    "can you rename this hey known issue",
    "hey names are hard",
    "does node execute top level await yet",
    "add a node execute step to the pipeline",
    // A real utterance, dictated while the three-token phrase was live. It
    // names the assistant and asks it something, and it still must not fire:
    // addressing the assistant is not the same as instructing it to go.
    "hey noam tell me what i'm saying",
  ];
  for (const trap of traps) {
    assert.equal(findWake([trap], compiled), null, trap);
  }
});

// Every rendering of the name this speaker's own microphone has produced. The
// list is the measurement, not a guess: "node" and "norm" both came back from
// real utterances of "hey nome" on the same hardware, which is why the phrase
// does not depend on any one of them being right.
const OBSERVED_NAMES = ["nome", "node", "norm", "nom", "gnome", "no me", "noam"];

test("every observed rendering of the name is accepted", () => {
  for (const name of OBSERVED_NAMES) {
    const hit = findWake([`refactor the parser hey ${name} execute`], compiled);
    assert.ok(hit, name);
    assert.equal(hit.action, SUBMIT, name);
    assert.equal(hit.before, "refactor the parser", name);
  }
});

// Zero tolerance under SC-003: the interrupt form must never resolve as a plain
// submit. It holds because compilePhrases sorts by token count descending, so
// every interrupt form outranks every submit form regardless of the name.
test("the interrupt form outranks the submit form for every observed name", () => {
  for (const name of OBSERVED_NAMES) {
    const hit = findWake([`refactor the parser hey ${name} stop and execute`], compiled);
    assert.ok(hit, name);
    assert.equal(hit.action, INTERRUPT_SUBMIT, name);
    assert.equal(hit.before, "refactor the parser", name);
  }
});

test("the phrase carries punctuation and casing as the recogniser wrote it", () => {
  const hit = findWake(
    ["the parser is probably fine. Hey Norm, execute. Fix the failing test."],
    compiled,
  );
  assert.ok(hit);
  assert.equal(hit.action, SUBMIT);
  assert.equal(hit.before, "the parser is probably fine.");
  assert.equal(hit.after, "Fix the failing test.");
});
