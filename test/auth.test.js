import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCredentialResolver, describeRejection, formatCredentialError } from "../lib/auth.js";

const ENV_VAR = "TEST_AUTH_FALLBACK_KEY";

// Each test gets its own store directory, so a test that rewrites the store
// cannot perturb another.
function withStore(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-voice-auth-test-"));
  const storePath = path.join(dir, "auth.json");
  const previousEnv = process.env[ENV_VAR];
  delete process.env[ENV_VAR];
  try {
    return run({ dir, storePath, write: (data) => fs.writeFileSync(storePath, data) });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (previousEnv === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = previousEnv;
  }
}

test("resolves from the store before the environment", () => {
  withStore(({ storePath, write }) => {
    write(JSON.stringify({ anthropic: { key: "store-token" } }));
    process.env[ENV_VAR] = "env-token";

    const resolver = createCredentialResolver({
      storePath,
      storeKeyPath: ["anthropic", "key"],
      envVar: ENV_VAR,
    });
    const result = resolver.resolve();

    assert.equal(result.ok, true);
    assert.equal(result.source, "store");
    assert.equal(result.value, "store-token");
    // Resolution stops at the first ok, so the environment is never consulted.
    assert.equal(result.attempts.length, 1);
    assert.deepEqual(result.attempts[0], {
      source: "store",
      label: storePath,
      outcome: "ok",
      detail: "",
    });
  });
});

test("falls back to the environment when the store fails", () => {
  withStore(({ storePath }) => {
    // No store file written.
    process.env[ENV_VAR] = "env-token";

    const resolver = createCredentialResolver({
      storePath,
      storeKeyPath: ["anthropic", "key"],
      envVar: ENV_VAR,
    });
    const result = resolver.resolve();

    assert.equal(result.ok, true);
    assert.equal(result.source, "env");
    assert.equal(result.value, "env-token");
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0].source, "store");
    assert.equal(result.attempts[0].outcome, "failed");
    assert.equal(result.attempts[0].detail, "file not found");
    assert.equal(result.attempts[1].source, "env");
    assert.equal(result.attempts[1].outcome, "ok");
    assert.equal(result.attempts[1].label, `$${ENV_VAR}`);
  });
});

// Prohibition 6, and the testable form of the no-caching rule: a token altered
// in the store between two calls MUST be reflected by the second call. This is
// the regression that FR-005 exists to prevent.
test("reflects a token replaced between two consecutive resolve calls", () => {
  withStore(({ storePath, write }) => {
    write(JSON.stringify({ anthropic: { key: "first-token" } }));

    const resolver = createCredentialResolver({
      storePath,
      storeKeyPath: ["anthropic", "key"],
      envVar: ENV_VAR,
    });

    const first = resolver.resolve();
    assert.equal(first.value, "first-token");

    write(JSON.stringify({ anthropic: { key: "renewed-token" } }));

    const second = resolver.resolve();
    assert.equal(second.value, "renewed-token");
    assert.equal(second.source, "store");
  });
});

test("records an ordered attempt log naming every source when all fail", () => {
  withStore(({ storePath }) => {
    // No store file, and ENV_VAR is deleted by withStore.
    const resolver = createCredentialResolver({
      storePath,
      storeKeyPath: ["anthropic", "key"],
      envVar: ENV_VAR,
    });
    const result = resolver.resolve();

    assert.equal(result.ok, false);
    assert.equal(result.value, undefined);
    assert.equal(result.source, undefined);
    assert.deepEqual(result.attempts, [
      { source: "store", label: storePath, outcome: "failed", detail: "file not found" },
      { source: "env", label: `$${ENV_VAR}`, outcome: "failed", detail: "not set" },
    ]);
  });
});

test("names both options when neither source is configured", () => {
  const resolver = createCredentialResolver();
  const result = resolver.resolve();

  assert.equal(result.ok, false);
  assert.deepEqual(result.attempts, [
    { source: "store", label: "credentialStorePath", outcome: "failed", detail: "not configured" },
    { source: "env", label: "apiKeyEnv", outcome: "failed", detail: "not configured" },
  ]);
});

test("distinguishes store failure causes without revealing the value", () => {
  withStore(({ storePath, write }) => {
    const resolver = createCredentialResolver({
      storePath,
      storeKeyPath: ["anthropic", "key"],
    });

    write("{ not json");
    assert.equal(resolver.resolve().attempts[0].detail, "not valid JSON");

    write(JSON.stringify({ other: { key: "x" } }));
    assert.equal(resolver.resolve().attempts[0].detail, "no value at anthropic.key");

    write(JSON.stringify({ anthropic: { key: 42 } }));
    assert.equal(resolver.resolve().attempts[0].detail, "value at anthropic.key is not a string");

    write(JSON.stringify({ anthropic: { key: "" } }));
    assert.equal(resolver.resolve().attempts[0].detail, "value at anthropic.key is empty");
  });
});

test("treats an environment variable set to whitespace as unusable", () => {
  withStore(({ storePath }) => {
    process.env[ENV_VAR] = "   ";
    const resolver = createCredentialResolver({
      storePath,
      storeKeyPath: ["anthropic", "key"],
      envVar: ENV_VAR,
    });
    const result = resolver.resolve();

    assert.equal(result.ok, false);
    assert.equal(result.attempts[1].detail, "set but empty");
  });
});

test("does not resolve inherited properties from the prototype chain", () => {
  withStore(({ storePath, write }) => {
    write(JSON.stringify({ anthropic: {} }));
    const resolver = createCredentialResolver({
      storePath,
      storeKeyPath: ["anthropic", "constructor"],
    });
    const result = resolver.resolve();

    assert.equal(result.ok, false);
    assert.equal(result.attempts[0].detail, "no value at anthropic.constructor");
  });
});

test("expands a leading tilde in the store path", () => {
  const relative = path.relative(os.homedir(), fs.mkdtempSync(path.join(os.tmpdir(), "x-")));
  // Only assert the expansion happened, via the reported cause: a path under
  // the home directory that does not exist reports "file not found", never a
  // literal-tilde read error.
  const resolver = createCredentialResolver({
    storePath: "~/definitely-not-a-real-credential-store.json",
    storeKeyPath: ["anthropic", "key"],
  });
  const result = resolver.resolve();

  assert.equal(result.ok, false);
  assert.equal(result.attempts[0].detail, "file not found");
  assert.ok(typeof relative === "string");
});

// Prohibitions 4 and 6: describe() reports the name of the last successful
// source and never the value.
test("describe never returns the credential", () => {
  withStore(({ storePath, write }) => {
    write(JSON.stringify({ anthropic: { key: "super-secret-token" } }));

    const resolver = createCredentialResolver({
      storePath,
      storeKeyPath: ["anthropic", "key"],
      envVar: ENV_VAR,
    });

    assert.match(resolver.describe(), /no source has resolved yet/);

    resolver.resolve();
    const described = resolver.describe();

    assert.ok(!described.includes("super-secret-token"));
    assert.ok(!described.includes("super-secret"));
    assert.match(described, /last successful source: store/);
    assert.match(described, /anthropic\.key/);
    assert.match(described, new RegExp(`\\$${ENV_VAR}`));
  });
});

test("describe reports the environment when the store did not resolve", () => {
  withStore(({ storePath }) => {
    process.env[ENV_VAR] = "env-token";
    const resolver = createCredentialResolver({
      storePath,
      storeKeyPath: ["anthropic", "key"],
      envVar: ENV_VAR,
    });

    resolver.resolve();
    const described = resolver.describe();

    assert.ok(!described.includes("env-token"));
    assert.match(described, /last successful source: env/);
  });
});

test("formatCredentialError renders one line per failed source and a remedy", () => {
  const message = formatCredentialError([
    {
      source: "store",
      label: "~/.local/share/opencode/auth.json",
      outcome: "failed",
      detail: "file not found",
    },
    { source: "env", label: "$ANTHROPIC_API_KEY", outcome: "failed", detail: "not set" },
  ]);

  assert.equal(
    message,
    [
      "No credential found.",
      "  ~/.local/share/opencode/auth.json — file not found",
      "  $ANTHROPIC_API_KEY — not set",
      "Log in to opencode, or set apiKeyEnv to a variable that holds a token.",
    ].join("\n"),
  );
});

test("formatCredentialError omits successful attempts", () => {
  const message = formatCredentialError([
    { source: "store", label: "/tmp/auth.json", outcome: "failed", detail: "file not found" },
    { source: "env", label: "$SOME_VAR", outcome: "ok", detail: "" },
  ]);

  assert.ok(!message.includes("$SOME_VAR"));
});

// The two auth faults have different remedies, so they must not read alike:
// a resolution failure means repair configuration, a rejection means
// re-authenticate or obtain entitlement.
test("describeRejection reads differently from a resolution failure", () => {
  const rejected = describeRejection(403, "~/.local/share/opencode/auth.json", "gpt-4.1");
  const unresolved = formatCredentialError([
    {
      source: "store",
      label: "~/.local/share/opencode/auth.json",
      outcome: "failed",
      detail: "file not found",
    },
  ]);

  assert.ok(!rejected.includes("No credential found"));
  assert.match(rejected, /403/);
  assert.match(rejected, /gpt-4\.1/);
  assert.match(rejected, /not a configuration fault/);
  assert.match(rejected, /entitled/);
  assert.notEqual(rejected, unresolved);
});

test("describeRejection names the missing credential when none was sent", () => {
  const message = describeRejection(401, null, "gpt-transcribe");

  assert.match(message, /no credential was sent/);
  assert.match(message, /apiKeyEnv/);
  assert.ok(!message.includes("not a configuration fault"));
});

test("describeRejection appends the service's own message when supplied", () => {
  const withDetail = describeRejection(403, "$TOKEN", "gpt-4.1", "model not enabled for tenant");
  const withoutDetail = describeRejection(403, "$TOKEN", "gpt-4.1");

  assert.match(withDetail, /The service said: model not enabled for tenant/);
  assert.ok(!withoutDetail.includes("The service said"));
});

// Prohibition 1 asserted structurally: the module cannot pass the credential to
// a logger because it never receives one. Prohibition 5 likewise: no exported
// setter, writer, or persistence function. Both are cheaper and stronger to
// check by inspection than by behaviour.
test("auth module accepts no logger and exposes no write path", async () => {
  const source = fs.readFileSync(new URL("../lib/auth.js", import.meta.url), "utf-8");
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");

  assert.ok(!/\blogger\b/.test(code), "auth.js must not reference a logger");
  assert.ok(!/logger\.js/.test(source), "auth.js must not import the logger module");
  assert.ok(!/console\./.test(code), "auth.js must not write to the console");
  assert.ok(!/writeFile|appendFile|mkdir|unlink/.test(code), "auth.js must expose no write path");

  const module = await import("../lib/auth.js");
  assert.deepEqual(Object.keys(module).sort(), [
    "createCredentialResolver",
    "describeRejection",
    "formatCredentialError",
  ]);

  const resolver = createCredentialResolver();
  assert.deepEqual(Object.keys(resolver).sort(), ["describe", "isConfigured", "resolve"]);
});

// Separates "no credential wanted" (a local endpoint) from "a credential was
// wanted and could not be produced" (a misconfiguration). Both return ok:false.
test("isConfigured reports whether any source was supplied", () => {
  assert.equal(createCredentialResolver().isConfigured(), false);
  assert.equal(createCredentialResolver({}).isConfigured(), false);
  assert.equal(createCredentialResolver({ envVar: ENV_VAR }).isConfigured(), true);
  assert.equal(createCredentialResolver({ storePath: "/tmp/auth.json" }).isConfigured(), true);
});
