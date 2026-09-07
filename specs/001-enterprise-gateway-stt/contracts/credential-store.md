# Contract: Credential resolution

**Feature**: 001-enterprise-gateway-stt | **Module**: `lib/auth.js`

Satisfies FR-004 through FR-007. This is the only module permitted to read the credential store, and it exposes no write path.

## Exported surface

### `createCredentialResolver(config)`

Returns a resolver object. Called once at plugin initialisation.

**`config`**

| Field          | Type     | Required | Meaning                                                                                                    |
| -------------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `storePath`    | string   | no       | Path to the editor credential store. `~` expanded. When absent, only the environment fallback is consulted |
| `storeKeyPath` | string[] | no       | Property path within the parsed store locating the token, e.g. `["anthropic", "key"]`                      |
| `envVar`       | string   | no       | Name of the environment variable used as fallback                                                          |

At least one of `storePath` or `envVar` MUST be usable, otherwise every resolution fails with `no_source`.

### `resolver.resolve()`

Returns `{ ok: true, value, source, attempts }` or `{ ok: false, attempts }`.

| Field      | Type                 | Meaning                                      |
| ---------- | -------------------- | -------------------------------------------- |
| `value`    | string               | The token. Non-empty. Present only when ok   |
| `source`   | `"store"` \| `"env"` | Which path produced it. Present only when ok |
| `attempts` | `Attempt[]`          | Ordered record of every source consulted     |

**Resolution order** — store first, environment second. The store is authoritative because it is the copy the editor itself renews.

**The attempt log.** Each consulted source appends one entry, in the order consulted:

| Field     | Type                 | Meaning                                                        |
| --------- | -------------------- | -------------------------------------------------------------- |
| `source`  | `"store"` \| `"env"` | Which source                                                   |
| `label`   | string               | How to name it to the user, e.g. the path or the variable name |
| `outcome` | `"ok"` \| `"failed"` | Whether this source yielded a usable value                     |
| `detail`  | string               | Short human-readable cause when failed, e.g. `file not found`  |

Resolution stops at the first `ok`. When every attempt failed, the log is the error message, which is why it is returned on the success path too: the diagnostics command can show that the store was skipped and the environment used, without a second code path.

An earlier revision of this contract specified four discriminated failure reasons instead. That was dropped: the taxonomy is only ever rendered in the case where every source failed, and in that case what the command contract asks to display is _which sources were tried and which failed_, which is an attempt log and not an enumeration. The log is also strictly more informative, since it distinguishes "store missing, environment unset" from "store key absent, environment unset" without needing a value for each combination.

When the store fails for any reason and `envVar` is configured and set, resolution succeeds from the environment. A store failure is therefore only surfaced when the fallback also fails.

**Failure conditions**, each of which produces a `failed` attempt rather than a distinguished return value: `storePath` configured but absent; file present but unreadable or not valid JSON; file parsed but `storeKeyPath` resolving to nothing, to a non-string, or to an empty string; `envVar` unset or empty; neither source configured at all.

### `resolver.describe()`

Returns a diagnostic string naming the configured sources and which one most recently succeeded. Retaining the name of the last successful source is permitted state; retaining its value is not. **MUST NOT include the token or any substring of it.** Intended for the diagnostics command and for error messages.

## No caching

**The resolver MUST NOT cache.** Every `resolve()` reads the store file.

This is a requirement, not an optimisation left undone. The arithmetic: the store is 1 to 4 KB of local JSON, so read and parse costs on the order of 200 microseconds, against a transcription request measured at 750 milliseconds. A cache would save roughly 0.03% of end-to-end latency, and in exchange would add a `stat` per request, mtime comparison, invalidation, an edge case for the store vanishing after a successful read, and the tests to cover all of it.

The decisive argument is not cost, though. A cache is the only mechanism by which this module could hand back a token that is no longer current, and serving a stale token is the precise failure FR-005 exists to prevent — a failure already observed in this deployment, where the environment copy of the credential was 98 days behind the store copy. Introducing a cache would reintroduce a weaker version of the bug the feature was written to fix. An uncached read satisfies "read at the moment of each request" directly, and is provable by inspection rather than by testing invalidation logic.

Reading `process.env` is likewise not cached, for the same reason and at no cost.

## Prohibitions

These are testable assertions, not guidance:

1. The resolved value MUST NOT be passed to any logging function.
2. The resolved value MUST NOT be written to any file.
3. The resolved value MUST NOT appear in any thrown error's message or stack.
4. The resolved value MUST NOT be included in `describe()` output.
5. The module MUST NOT expose a setter, writer, or persistence function of any kind.
6. The resolved value MUST NOT be retained between `resolve()` calls in any form.

Prohibition 6 is the testable form of the no-caching rule: a token altered in the store between two calls MUST be reflected by the second call.

SC-004 asserts zero occurrences of credential material in logs, temporary files, and any request other than to the configured service.

## Consumers

| Caller              | Use                                                                         |
| ------------------- | --------------------------------------------------------------------------- |
| `lib/llm-client.js` | Authorization header on the correction request                              |
| `lib/stt.js`        | Authorization header on the transcription request and the catalogue request |

Both currently read `process.env[apiKeyEnv]` inline at the point of use. Both become a `resolve()` call at the same point — per request, not hoisted, since hoisting would defeat FR-005.

## Error surfacing

A failed resolution MUST produce a user-facing message that renders the attempt log — every source tried, named, with its cause of failure — followed by the corrective action. For example:

```text
No credential found.
  ~/.local/share/opencode/auth.json — file not found
  $ANTHROPIC_API_KEY — not set
Sign in to the editor, or set apiKeyEnv to a variable holding the token.
```

A `403` from the service with a successfully resolved credential means the token is expired or lacks entitlement, and MUST be distinguishable from a resolution failure — the corrective actions differ (re-authenticate versus fix configuration). This distinction costs one branch and is retained.
