// OpenAI-compatible LLM client for text normalization.
//
// Works with any OpenAI-compatible endpoint:
//   - Anthropic's OpenAI compatibility layer
//   - OpenAI directly
//   - Ollama, vLLM, LM Studio, etc.
//
// Configuration is passed from plugin options (tui.json):
//   ["@renjfk/opencode-voice", {
//     "endpoint": "https://api.anthropic.com/v1",
//     "model": "claude-haiku-4-5",
//     "apiKeyEnv": "ANTHROPIC_API_KEY",
//     "maxTokens": 2048,
//     "temperature": 0.2,
//     "reasoningEffort": "low",
//     "chatTemplateKwargs": {"enable_thinking": false},
//     "retries": 2,
//     "llmTimeoutMs": 15000
//   }]
//
// The credential is resolved once per request through lib/auth.js, never at
// construction and never hoisted out of the request path. A long-lived editor
// session outlives the 24-hour token it started with, so a credential captured
// at load is a credential that will be wrong later (FR-005, research.md R-003).

import { createCredentialResolver, describeRejection, formatCredentialError } from "./auth.js";

const DEFAULTS = {
  maxTokens: 2048,
  temperature: 0.2,
  reasoningEffort: null,
  chatTemplateKwargs: null,
  retries: 2,
  llmTimeoutMs: 15000,
};

function normalizeRetries(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULTS.retries;
  return Math.floor(parsed);
}

function normalizeChatTemplateKwargs(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// 0.2 is R-004's benchmark condition, not one of its findings: it held
// temperature fixed while comparing models, so it says nothing about the value
// itself. Measured directly afterwards, 8 runs per setting on two hard
// transcripts, 0 against 0.2: identical accuracy, indistinguishable latency,
// and -- the reason 0 is not the default -- identical non-determinism. Both
// settings produced two distinct outputs in 8 runs, because batched inference
// on a shared gateway is not reproducible at any temperature. Defaulting to 0
// would advertise a determinism the service does not provide. The observed
// variation was paraphrase ("back off on retry" against "back off and retry"),
// never invention.
//
// An explicit null is how a caller declines to send the parameter at all, which
// some services require because they reject it outright.
function normalizeTemperature(value) {
  if (value === undefined) return DEFAULTS.temperature;
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) return DEFAULTS.temperature;
  return parsed;
}

function normalizeTimeout(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULTS.llmTimeoutMs;
  return parsed;
}

function shouldRetry(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isTimeout(err) {
  return err?.name === "TimeoutError" || err?.name === "AbortError";
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create an LLM completion function.
 *
 * @param {object} [pluginOptions] - Static config from tui.json plugin options
 * @param {{ log?: (scope: string, message: string, level?: string) => void }} [logger]
 * @param {{ resolve: () => object, isConfigured: () => boolean }} [credentials]
 *        Credential resolver. When omitted, one is derived from `apiKeyEnv`,
 *        which preserves the behaviour of callers that predate lib/auth.js.
 * @returns {{ complete: (opts: { system?: string, prompt: string, config?: object }) => Promise<{ text: string | null, error?: string }> }}
 */
export function createClient(pluginOptions, logger, credentials) {
  function getConfig() {
    return {
      endpoint: pluginOptions?.endpoint,
      model: pluginOptions?.model,
      apiKeyEnv: pluginOptions?.apiKeyEnv,
      maxTokens: pluginOptions?.maxTokens ?? DEFAULTS.maxTokens,
      temperature: normalizeTemperature(pluginOptions?.temperature),
      reasoningEffort: pluginOptions?.reasoningEffort ?? DEFAULTS.reasoningEffort,
      chatTemplateKwargs: normalizeChatTemplateKwargs(
        pluginOptions?.chatTemplateKwargs ?? DEFAULTS.chatTemplateKwargs,
      ),
      retries: normalizeRetries(pluginOptions?.retries ?? DEFAULTS.retries),
      llmTimeoutMs: normalizeTimeout(pluginOptions?.llmTimeoutMs ?? DEFAULTS.llmTimeoutMs),
    };
  }

  /**
   * Send a chat completion request to an OpenAI-compatible endpoint.
   *
   * @param {object} opts
   * @param {string} [opts.system]  - System prompt
   * @param {string} opts.prompt    - User message
   * @param {object} [opts.config]  - Per-call overrides (e.g. { maxTokens: 4096 })
   * @returns {Promise<{ text: string | null, error?: string }>}
   */
  async function complete({ system, prompt, config: overrides }) {
    const cfg = { ...getConfig(), ...overrides };
    if (!cfg.endpoint) {
      logger?.log?.("LLM", "completion skipped: endpoint not configured", "warn");
      return { text: null, error: "LLM endpoint not configured" };
    }
    if (!cfg.model) {
      logger?.log?.("LLM", "completion skipped: model not configured", "warn");
      return { text: null, error: "LLM model not configured" };
    }

    // Resolved per request, inside complete(), so a token renewed mid-session
    // is picked up by the next request rather than at the next editor restart.
    const resolver = credentials ?? createCredentialResolver({ envVar: cfg.apiKeyEnv });
    const credential = resolver.resolve();
    if (!credential.ok && resolver.isConfigured()) {
      logger?.log?.("LLM", "completion skipped: credential unresolved", "error");
      return { text: null, error: formatCredentialError(credential.attempts) };
    }
    const apiKey = credential.ok ? credential.value : null;
    const credentialLabel = credential.ok
      ? credential.attempts.find((a) => a.outcome === "ok")?.label
      : null;

    const endpoint = cfg.endpoint.replace(/\/+$/, "") + "/chat/completions";

    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });

    const body = {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      messages,
    };
    // Checked against null and undefined rather than truthiness, because 0 is a
    // legitimate temperature and the most deterministic one available.
    if (cfg.temperature !== null && cfg.temperature !== undefined) {
      body.temperature = cfg.temperature;
    }
    if (cfg.reasoningEffort) body.reasoning_effort = cfg.reasoningEffort;
    if (cfg.chatTemplateKwargs) body.chat_template_kwargs = cfg.chatTemplateKwargs;

    for (let attempt = 0; attempt <= cfg.retries; attempt++) {
      try {
        logger?.log?.(
          "LLM",
          `Completion request attempt=${attempt + 1} model=${cfg.model} maxTokens=${cfg.maxTokens} temperature=${cfg.temperature} promptChars=${prompt.length}`,
          "debug",
        );
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
          },
          body: JSON.stringify(body),
          // Bounded so a service that accepts the connection and then stalls
          // surfaces as a timeout instead of leaving the pipeline waiting
          // indefinitely with a "Normalizing..." toast on screen.
          signal: AbortSignal.timeout(cfg.llmTimeoutMs),
        });

        if (!response.ok) {
          logger?.log?.(
            "LLM",
            `Completion response status=${response.status}`,
            shouldRetry(response.status) ? "warn" : "error",
          );
          if (attempt < cfg.retries && shouldRetry(response.status)) {
            await wait(250 * 2 ** attempt);
            continue;
          }
          if (response.status === 401 || response.status === 403) {
            return {
              text: null,
              error: describeRejection(response.status, credentialLabel, cfg.model),
            };
          }
          return { text: null, error: `LLM request failed (${response.status})` };
        }

        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content || null;
        if (text) {
          logger?.log?.("LLM", `Completion succeeded chars=${text.length}`, "debug");
          return { text };
        }

        logger?.log?.("LLM", "Completion returned empty content", "warn");

        if (attempt < cfg.retries) {
          await wait(250 * 2 ** attempt);
          continue;
        }
        return { text: null, error: "Empty LLM response" };
      } catch (err) {
        const timedOut = isTimeout(err);
        logger?.log?.(
          "LLM",
          `Completion error attempt=${attempt + 1}: ${timedOut ? `timed out after ${cfg.llmTimeoutMs}ms` : err.message}`,
          timedOut ? "error" : "warn",
        );
        // A request that exhausted its own bound is not retried. The retry
        // would spend another full bound to reach the same conclusion, and a
        // dictation pipeline whose point is a response in a couple of seconds
        // is already lost by then. Say so instead.
        if (timedOut) {
          return {
            text: null,
            error: `The correction request exceeded its ${cfg.llmTimeoutMs}ms bound (llmTimeoutMs). Raise llmTimeoutMs, or set endpoint to a service that responds faster.`,
          };
        }
        if (attempt < cfg.retries) {
          await wait(250 * 2 ** attempt);
          continue;
        }
        return { text: null, error: `LLM error: ${err.message}` };
      }
    }

    return { text: null, error: "LLM request failed after retries" };
  }

  return { complete };
}
