// Credential resolution for the gateway.
//
// Contract: specs/001-enterprise-gateway-stt/contracts/credential-store.md
// Satisfies FR-004 through FR-007.
//
// This is the only module permitted to read the editor credential store, and it
// exposes no write path.
//
// NO CACHING. Every resolve() reads the store file. This is a requirement, not
// an optimisation left undone: a cache is the only mechanism by which this
// module could hand back a token that is no longer current, and serving a stale
// token is the precise failure FR-005 exists to prevent -- a failure already
// observed in this deployment, where the environment copy of the credential was
// 98 days behind the store copy (research.md R-003). The store is 1 to 4 KB of
// local JSON, so the read costs on the order of 200 microseconds against a
// transcription request measured at 750 milliseconds.
//
// This module deliberately accepts no logger. Prohibition 1 of the contract --
// the resolved value MUST NOT be passed to any logging function -- is then true
// by inspection of the import list rather than only by test.

import fs from "node:fs";
import os from "node:os";

function expandTilde(filePath) {
  return filePath.replace(/^~(?=\/|$)/, os.homedir());
}

// Walks `keyPath` through `root` without consulting the prototype chain, so a
// store containing a key such as "constructor" cannot yield a function.
function traverse(root, keyPath) {
  let node = root;
  for (const key of keyPath) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) {
      return { found: false };
    }
    node = node[key];
  }
  return { found: true, value: node };
}

function isKeyPath(value) {
  return Array.isArray(value) && value.length > 0 && value.every((k) => typeof k === "string");
}

// Reads the store and returns the token, or a short human-readable cause.
// Never throws, and never includes the token in a cause.
function attemptStore(storePath, storeKeyPath) {
  if (!storePath) return { ok: false, label: "credentialStorePath", detail: "not configured" };

  const label = storePath;
  if (!isKeyPath(storeKeyPath)) {
    return { ok: false, label, detail: "no credentialStoreKeyPath configured" };
  }

  let raw;
  try {
    raw = fs.readFileSync(expandTilde(storePath), "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return { ok: false, label, detail: "file not found" };
    if (err.code === "EACCES") return { ok: false, label, detail: "not readable" };
    return { ok: false, label, detail: `unreadable (${err.code || "unknown error"})` };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, label, detail: "not valid JSON" };
  }

  const where = storeKeyPath.join(".");
  const found = traverse(parsed, storeKeyPath);
  if (!found.found) return { ok: false, label, detail: `no value at ${where}` };
  if (typeof found.value !== "string") {
    return { ok: false, label, detail: `value at ${where} is not a string` };
  }
  if (found.value === "") return { ok: false, label, detail: `value at ${where} is empty` };

  return { ok: true, label, value: found.value };
}

function attemptEnv(envVar) {
  if (!envVar) return { ok: false, label: "apiKeyEnv", detail: "not configured" };

  const label = `$${envVar}`;
  const value = process.env[envVar];
  if (value === undefined) return { ok: false, label, detail: "not set" };
  if (value.trim() === "") return { ok: false, label, detail: "set but empty" };

  return { ok: true, label, value };
}

/**
 * Render a failed resolution as the user-facing message required by
 * contracts/commands.md: one line per source tried, each with why it failed,
 * followed by the corrective action. Carries no credential material.
 *
 * @param {Array<{label: string, detail: string, outcome: string}>} attempts
 * @returns {string}
 */
export function formatCredentialError(attempts) {
  const lines = (attempts || [])
    .filter((a) => a.outcome === "failed")
    .map((a) => `  ${a.label} — ${a.detail}`);
  return [
    "No credential found.",
    ...lines,
    "Log in to opencode, or set apiKeyEnv to a variable that holds a token.",
  ].join("\n");
}

/**
 * Describe a credential rejected by the service, as distinct from a credential
 * that could never be resolved. The two carry different remedies -- obtain
 * entitlement or re-authenticate, versus repair configuration -- so the
 * contract requires them to read differently. Keeping this beside the resolver
 * keeps one wording for both the transcription and correction paths.
 *
 * The catalogue a gateway advertises is not the entitlement list, so a model it
 * lists can still be refused (research.md R-006); the message therefore names
 * both possibilities rather than guessing between them.
 *
 * @param {number} status              HTTP status returned by the service
 * @param {string|null} credentialLabel Source the credential came from, if any
 * @param {string} model               Model the request named
 * @param {string} [detail]            Message the service itself supplied
 * @returns {string}
 */
export function describeRejection(status, credentialLabel, model, detail) {
  const suffix = detail ? ` The service said: ${detail}` : "";
  if (!credentialLabel) {
    return (
      `The service rejected the request (${status}) and no credential was sent. ` +
      `Set apiKeyEnv, or credentialStorePath, to a source that holds a token.${suffix}`
    );
  }
  // 401 and 403 are reported separately because they send the developer to
  // different places. A resolved credential rules out configuration as the
  // cause of either, which is what makes the split worth making: 401 means the
  // token itself was refused, 403 means it authenticated and the account is not
  // entitled to this tier. The catalogue is not the entitlement list, so a tier
  // the selector offered can still be refused here (research.md R-006).
  if (status === 403) {
    return (
      `The service accepted the credential from ${credentialLabel} but refused model ${model} ` +
      `(403). Authentication succeeded, so this is an entitlement problem rather than a ` +
      `credential one: select a different transcription tier, or have ${model} enabled for ` +
      `the account.${suffix}`
    );
  }
  return (
    `The service rejected the credential from ${credentialLabel} (${status}) for model ${model}. ` +
    `The credential resolved, so this is not a configuration fault: re-authenticate in opencode ` +
    `so a fresh token is written to the store.${suffix}`
  );
}

/**
 * Create a credential resolver. Called once at plugin initialisation; the
 * resolver itself holds no token between calls.
 *
 * @param {object} [config]
 * @param {string} [config.storePath]       Path to the editor credential store. `~` expanded
 * @param {string[]} [config.storeKeyPath]  Property path to the token, e.g. ["anthropic", "key"]
 * @param {string} [config.envVar]          Name of the fallback environment variable
 * @returns {{ resolve: () => object, describe: () => string, isConfigured: () => boolean }}
 */
export function createCredentialResolver({ storePath, storeKeyPath, envVar } = {}) {
  // The name of the last successful source is permitted state. Its value is
  // not, and is never assigned here (prohibition 6).
  let lastSuccessfulSource = null;

  /**
   * Whether any credential source is configured at all.
   *
   * Callers need this to separate two very different situations that both
   * produce `ok: false`. An endpoint with no credential source configured is
   * an ordinary local deployment -- Ollama, vLLM, LM Studio -- which is
   * supposed to be reached unauthenticated. A configured source that fails to
   * yield a token is a misconfiguration the user asked to be told about.
   * Treating those alike would either break local endpoints or swallow real
   * credential faults.
   *
   * @returns {boolean}
   */
  function isConfigured() {
    return Boolean(storePath) || Boolean(envVar);
  }

  /**
   * Resolve the credential. Store first, environment second: the store is
   * authoritative because it is the copy the editor itself renews.
   *
   * Both sources are always consulted in order, and an unconfigured source
   * records a `failed` attempt reading "not configured". That keeps `source`
   * within the contract's `"store" | "env"` union while still satisfying its
   * requirement that every source consulted be recorded -- the contract's
   * "neither source configured at all" case is simply both attempts reporting
   * "not configured", which names the two options the user must fix.
   *
   * @returns {{ok: true, value: string, source: "store"|"env", attempts: object[]}
   *          | {ok: false, attempts: object[]}}
   */
  function resolve() {
    const attempts = [];

    const store = attemptStore(storePath, storeKeyPath);
    attempts.push({
      source: "store",
      label: store.label,
      outcome: store.ok ? "ok" : "failed",
      detail: store.ok ? "" : store.detail,
    });
    if (store.ok) {
      lastSuccessfulSource = "store";
      return { ok: true, value: store.value, source: "store", attempts };
    }

    const env = attemptEnv(envVar);
    attempts.push({
      source: "env",
      label: env.label,
      outcome: env.ok ? "ok" : "failed",
      detail: env.ok ? "" : env.detail,
    });
    if (env.ok) {
      lastSuccessfulSource = "env";
      return { ok: true, value: env.value, source: "env", attempts };
    }

    return { ok: false, attempts };
  }

  /**
   * Diagnostic string naming the configured sources and which one most recently
   * succeeded. MUST NOT include the token or any substring of it, and cannot:
   * the only retained state is the source name.
   *
   * @returns {string}
   */
  function describe() {
    const sources = [
      storePath
        ? `store ${storePath}${isKeyPath(storeKeyPath) ? ` at ${storeKeyPath.join(".")}` : ""}`
        : "store not configured",
      envVar ? `env $${envVar}` : "env not configured",
    ];
    const last = lastSuccessfulSource
      ? `last successful source: ${lastSuccessfulSource}`
      : "no source has resolved yet";
    return `${sources.join(", ")}; ${last}`;
  }

  return { resolve, describe, isConfigured };
}
