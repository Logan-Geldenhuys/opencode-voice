import assert from "node:assert/strict";
import test from "node:test";

import { createClient } from "../lib/llm-client.js";

function createJsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
  };
}

test("returns error when endpoint is not configured", async () => {
  const client = createClient({ model: "test-model" });
  const result = await client.complete({ prompt: "Test" });

  assert.deepEqual(result, {
    text: null,
    error: "LLM endpoint not configured",
  });
});

test("returns error when model is not configured", async () => {
  const client = createClient({ endpoint: "https://example.test/v1" });
  const result = await client.complete({ prompt: "Test" });

  assert.deepEqual(result, {
    text: null,
    error: "LLM model not configured",
  });
});

test("sends chat completions requests with reasoning_effort when configured", async () => {
  const previousKey = process.env.TEST_LLM_API_KEY;
  const previousFetch = globalThis.fetch;
  const requests = [];
  process.env.TEST_LLM_API_KEY = "secret";

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return createJsonResponse(200, {
      choices: [{ message: { content: "normalized text" } }],
    });
  };

  try {
    const client = createClient({
      endpoint: "https://example.test/v1/",
      model: "gpt-test",
      apiKeyEnv: "TEST_LLM_API_KEY",
      maxTokens: 321,
      reasoningEffort: "low",
      retries: 0,
    });

    const result = await client.complete({
      system: "System prompt",
      prompt: "User prompt",
    });

    assert.equal(result.text, "normalized text");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://example.test/v1/chat/completions");
    assert.equal(requests[0].options.method, "POST");
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      model: "gpt-test",
      max_tokens: 321,
      temperature: 0.2,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: "System prompt" },
        { role: "user", content: "User prompt" },
      ],
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) {
      delete process.env.TEST_LLM_API_KEY;
    } else {
      process.env.TEST_LLM_API_KEY = previousKey;
    }
  }
});

test("sends chat_template_kwargs when configured", async () => {
  const previousKey = process.env.TEST_LLM_API_KEY;
  const previousFetch = globalThis.fetch;
  const requests = [];
  process.env.TEST_LLM_API_KEY = "secret";

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return createJsonResponse(200, {
      choices: [{ message: { content: "text" } }],
    });
  };

  try {
    const client = createClient({
      endpoint: "https://example.test/v1",
      model: "qwen-test",
      apiKeyEnv: "TEST_LLM_API_KEY",
      chatTemplateKwargs: { enable_thinking: false },
      retries: 0,
    });

    const result = await client.complete({ prompt: "Test" });
    assert.equal(result.text, "text");
    const body = JSON.parse(requests[0].options.body);
    assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(body.reasoning_effort, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) {
      delete process.env.TEST_LLM_API_KEY;
    } else {
      process.env.TEST_LLM_API_KEY = previousKey;
    }
  }
});

test("does not send chat_template_kwargs when not configured", async () => {
  const previousKey = process.env.TEST_LLM_API_KEY;
  const previousFetch = globalThis.fetch;
  const requests = [];
  process.env.TEST_LLM_API_KEY = "secret";

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return createJsonResponse(200, {
      choices: [{ message: { content: "text" } }],
    });
  };

  try {
    const client = createClient({
      endpoint: "https://example.test/v1",
      model: "test-model",
      apiKeyEnv: "TEST_LLM_API_KEY",
      retries: 0,
    });

    const result = await client.complete({ prompt: "Test" });
    assert.equal(result.text, "text");
    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.chat_template_kwargs, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) {
      delete process.env.TEST_LLM_API_KEY;
    } else {
      process.env.TEST_LLM_API_KEY = previousKey;
    }
  }
});

test("sends requests without Authorization header when no apiKeyEnv", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return createJsonResponse(200, {
      choices: [{ message: { content: "text" } }],
    });
  };

  try {
    const client = createClient({
      endpoint: "https://example.test/v1",
      model: "test-model",
      retries: 0,
    });

    const result = await client.complete({ prompt: "Test" });
    assert.equal(result.text, "text");
    assert.equal(requests[0].options.headers.Authorization, undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("returns error when LLM fails after retries", async () => {
  const previousKey = process.env.TEST_LLM_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  process.env.TEST_LLM_API_KEY = "secret";

  globalThis.fetch = async () => {
    return createJsonResponse(500, { error: "internal error" });
  };

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };

  try {
    const client = createClient({
      endpoint: "https://example.test/v1",
      model: "test-model",
      apiKeyEnv: "TEST_LLM_API_KEY",
      retries: 1,
    });

    const result = await client.complete({ prompt: "Test" });

    assert.equal(result.text, null);
    assert.match(result.error, /LLM request failed/);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
    if (previousKey === undefined) {
      delete process.env.TEST_LLM_API_KEY;
    } else {
      process.env.TEST_LLM_API_KEY = previousKey;
    }
  }
});

test("retries transient failures and eventually returns the response text", async () => {
  const previousKey = process.env.TEST_LLM_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  let attempts = 0;
  process.env.TEST_LLM_API_KEY = "secret";

  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts < 3) {
      return createJsonResponse(429, { error: { message: "rate limited" } });
    }
    return createJsonResponse(200, {
      choices: [{ message: { content: "recovered text" } }],
    });
  };

  globalThis.setTimeout = (fn) => {
    fn();
    return 0;
  };

  try {
    const client = createClient({
      endpoint: "https://example.test/v1",
      model: "test-model",
      apiKeyEnv: "TEST_LLM_API_KEY",
      retries: 2,
    });

    const result = await client.complete({ prompt: "Retry this" });

    assert.deepEqual(result, { text: "recovered text" });
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
    if (previousKey === undefined) {
      delete process.env.TEST_LLM_API_KEY;
    } else {
      process.env.TEST_LLM_API_KEY = previousKey;
    }
  }
});

// ---- Credential resolution (T013) ----

// Minimal stand-in for lib/auth.js's resolver. Counts calls so a test can
// assert resolution happens per request rather than once per client.
function createStubResolver(tokens, { configured = true } = {}) {
  const queue = [...tokens];
  const stub = {
    calls: 0,
    resolve() {
      stub.calls += 1;
      const value = queue.length > 1 ? queue.shift() : queue[0];
      if (value === null) {
        return {
          ok: false,
          attempts: [
            {
              source: "store",
              label: "/tmp/absent.json",
              outcome: "failed",
              detail: "file not found",
            },
            { source: "env", label: "$STUB_KEY", outcome: "failed", detail: "not set" },
          ],
        };
      }
      return {
        ok: true,
        value,
        source: "store",
        attempts: [{ source: "store", label: "/tmp/auth.json", outcome: "ok", detail: "" }],
      };
    },
    isConfigured() {
      return configured;
    },
  };
  return stub;
}

test("resolves the credential on every request, so a renewal is picked up mid-session", async () => {
  const previousFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (_url, options) => {
    sent.push(options.headers["Authorization"]);
    return createJsonResponse(200, { choices: [{ message: { content: "ok" } }] });
  };

  const resolver = createStubResolver(["token-before-renewal", "token-after-renewal"]);

  try {
    const client = createClient(
      { endpoint: "https://example.test/v1", model: "gpt-test", retries: 0 },
      null,
      resolver,
    );

    await client.complete({ prompt: "First" });
    await client.complete({ prompt: "Second" });

    assert.equal(resolver.calls, 2, "resolve() must be called once per request");
    assert.deepEqual(sent, ["Bearer token-before-renewal", "Bearer token-after-renewal"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("reports an unresolved credential without issuing a request", async () => {
  const previousFetch = globalThis.fetch;
  let requested = false;
  globalThis.fetch = async () => {
    requested = true;
    return createJsonResponse(200, { choices: [{ message: { content: "ok" } }] });
  };

  try {
    const client = createClient(
      { endpoint: "https://example.test/v1", model: "gpt-test", retries: 0 },
      null,
      createStubResolver([null]),
    );

    const result = await client.complete({ prompt: "Test" });

    assert.equal(result.text, null);
    assert.match(result.error, /^No credential found\./);
    assert.match(result.error, /\/tmp\/absent\.json — file not found/);
    assert.match(result.error, /\$STUB_KEY — not set/);
    assert.equal(requested, false, "no request may be sent without a credential");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("a rejected credential reads differently from an unresolved one", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    createJsonResponse(403, { error: { message: "model not entitled" } });

  try {
    const client = createClient(
      { endpoint: "https://example.test/v1", model: "gpt-test", retries: 0 },
      null,
      createStubResolver(["valid-token"]),
    );

    const result = await client.complete({ prompt: "Test" });

    assert.equal(result.text, null);
    assert.doesNotMatch(result.error, /No credential found/);
    assert.match(result.error, /403/);
    assert.match(result.error, /gpt-test/);
    assert.match(result.error, /\/tmp\/auth\.json/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("the credential never reaches logged output", async () => {
  const previousFetch = globalThis.fetch;
  const token = "sk-should-never-be-logged";
  const logged = [];
  const logger = {
    log: (...args) => logged.push(args.map((arg) => String(arg)).join(" ")),
  };

  try {
    globalThis.fetch = async () =>
      createJsonResponse(200, { choices: [{ message: { content: "ok" } }] });
    const client = createClient(
      { endpoint: "https://example.test/v1", model: "gpt-test", retries: 0 },
      logger,
      createStubResolver([token]),
    );
    await client.complete({ prompt: "Succeeds" });

    globalThis.fetch = async () => createJsonResponse(401, {});
    await client.complete({ prompt: "Rejected" });

    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    await client.complete({ prompt: "Throws" });

    assert.ok(logged.length > 0, "the client must log something to make this meaningful");
    for (const line of logged) {
      assert.doesNotMatch(line, /sk-should-never-be-logged/);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

// ---- Temperature (T026) ----

test("sends the configured temperature, and 0 rather than omitting it", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return createJsonResponse(200, { choices: [{ message: { content: "text" } }] });
  };

  try {
    const base = { endpoint: "https://example.test/v1", model: "test-model", retries: 0 };

    // Default is the 0.2 measured in research.md R-004.
    await createClient(base).complete({ prompt: "Test" });
    assert.equal(JSON.parse(requests[0].options.body).temperature, 0.2);

    // An explicit value is honoured.
    await createClient({ ...base, temperature: 1.4 }).complete({ prompt: "Test" });
    assert.equal(JSON.parse(requests[1].options.body).temperature, 1.4);

    // Zero is a legitimate temperature and must survive a truthiness check.
    await createClient({ ...base, temperature: 0 }).complete({ prompt: "Test" });
    assert.equal(JSON.parse(requests[2].options.body).temperature, 0);

    // Out of range falls back to the default rather than sending a rejected value.
    await createClient({ ...base, temperature: 7 }).complete({ prompt: "Test" });
    assert.equal(JSON.parse(requests[3].options.body).temperature, 0.2);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("omits temperature entirely when set to null, for services that reject it", async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return createJsonResponse(200, { choices: [{ message: { content: "text" } }] });
  };

  try {
    const client = createClient({
      endpoint: "https://example.test/v1",
      model: "test-model",
      temperature: null,
      retries: 0,
    });

    await client.complete({ prompt: "Test" });
    const body = JSON.parse(requests[0].options.body);
    assert.equal("temperature" in body, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
