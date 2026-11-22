import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { OpenAiCompatBackend } from "../../src/backends/openai-compat.ts";
import type { NormalizedAgentEvent } from "../../src/backends/types.ts";

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function startTestServer(
  handler: (req: RecordedRequest, res: http.ServerResponse) => void | Promise<void>
): Promise<{
  baseUrl: string;
  port: number;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      void handler(recorded, res);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Expected numeric TCP address");
  }

  const close = async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  };

  return {
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    port: addr.port,
    requests,
    close,
  };
}

async function getClosedPortBaseUrl(): Promise<string> {
  const srv = await startTestServer((_req, res) => {
    res.statusCode = 200;
    res.end();
  });
  const baseUrl = srv.baseUrl;
  await srv.close();
  return baseUrl;
}

test("OpenAiCompatBackend checkAvailability succeeds on 200 /models and fails gracefully on 401 or closed port", async (t) => {
  let modelsStatus = 200;
  const srv = await startTestServer((req, res) => {
    if (req.url === "/v1/models") {
      res.statusCode = modelsStatus;
      res.setHeader("Content-Type", "application/json");
      res.end(
        modelsStatus === 200
          ? JSON.stringify({ object: "list", data: [{ id: "qwen-3" }] })
          : JSON.stringify({ error: { message: "Unauthorized" } })
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  t.after(() => srv.close());

  const backend = new OpenAiCompatBackend({
    baseUrl: srv.baseUrl,
    apiKey: "secret-key",
    model: "qwen-3",
  });

  const ok = await backend.checkAvailability();
  assert.equal(ok.backend, "openai-compat");
  assert.equal(ok.available, true);
  assert.equal(srv.requests[0].headers.authorization, "Bearer secret-key");

  modelsStatus = 401;
  const unauth = await backend.checkAvailability();
  assert.equal(unauth.backend, "openai-compat");
  assert.equal(unauth.available, false);
  assert.match(unauth.error ?? "", /401/);

  const closedBaseUrl = await getClosedPortBaseUrl();
  const closedBackend = new OpenAiCompatBackend({ baseUrl: closedBaseUrl });
  const refused = await closedBackend.checkAvailability();
  assert.equal(refused.backend, "openai-compat");
  assert.equal(refused.available, false);
  assert.ok((refused.error ?? "").length > 0);
});

test("OpenAiCompatBackend streams SSE chunks and parses split <think> tags into thought, text_delta, and clean completed text", async (t) => {
  const srv = await startTestServer((req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/chat/completions");

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");

    const ssePayloads = [
      JSON.stringify({ choices: [{ delta: { content: "<thi" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "nk>step 1</th" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "ink>**Answer**" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "\n- item 1\n- item 2" } }] }),
      JSON.stringify({
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 40, completion_tokens: 18 },
      }),
      "[DONE]",
    ];

    for (const payload of ssePayloads) {
      res.write(`data: ${payload}\n\n`);
    }
    res.end();
  });
  t.after(() => srv.close());

  const backend = new OpenAiCompatBackend({
    baseUrl: srv.baseUrl,
    apiKey: "test-token",
    model: "deepseek-r1",
  });
  const events: NormalizedAgentEvent[] = [];
  backend.subscribe((ev) => events.push(ev));

  const sessionID = await backend.createSession({
    directory: "/tmp/repo",
    title: "SSE Think Test",
    system: "Be concise.",
  });

  const finalText = await backend.sendPrompt({
    sessionID,
    directory: "/tmp/repo",
    text: "Explain the answer",
  });

  assert.equal(finalText, "**Answer**\n- item 1\n- item 2");

  const posted = JSON.parse(srv.requests[0].body) as {
    model: string;
    stream: boolean;
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(posted.model, "deepseek-r1");
  assert.equal(posted.stream, true);
  assert.deepEqual(posted.messages, [
    { role: "system", content: "Be concise." },
    { role: "user", content: "Explain the answer" },
  ]);

  const thoughts = events
    .filter((e): e is Extract<NormalizedAgentEvent, { type: "thought" }> => e.type === "thought")
    .map((e) => e.text)
    .join("");
  assert.equal(thoughts, "step 1");

  const deltas = events
    .filter(
      (e): e is Extract<NormalizedAgentEvent, { type: "text_delta" }> => e.type === "text_delta"
    )
    .map((e) => e.delta)
    .join("");
  assert.equal(deltas, "**Answer**\n- item 1\n- item 2");

  const completed = events.find(
    (e): e is Extract<NormalizedAgentEvent, { type: "completed" }> => e.type === "completed"
  );
  assert.ok(completed);
  assert.equal(completed.text, "**Answer**\n- item 1\n- item 2");
  assert.ok(!completed.text.includes("<think>"));
  assert.ok(!completed.text.includes("</think>"));
  assert.deepEqual(completed.usage, {
    inputTokens: 40,
    outputTokens: 18,
    reasoningTokens: undefined,
  });
});

test("OpenAiCompatBackend emits error event and rejects cleanly on HTTP 401, HTTP 500, and connection refused", async (t) => {
  let responseStatus = 401;
  let responseBody = "Invalid API key";

  const srv = await startTestServer((_req, res) => {
    res.statusCode = responseStatus;
    res.setHeader("Content-Type", "text/plain");
    res.end(responseBody);
  });
  t.after(() => srv.close());

  const backend = new OpenAiCompatBackend({
    baseUrl: srv.baseUrl,
    model: "gpt-4o-mini",
  });
  const events: NormalizedAgentEvent[] = [];
  backend.subscribe((ev) => events.push(ev));

  const sess = await backend.createSession({ directory: "/tmp/repo", title: "Errors" });

  // 1. HTTP 401 Unauthorized
  await assert.rejects(
    () => backend.sendPrompt({ sessionID: sess, directory: "/tmp/repo", text: "Hello" }),
    /HTTP 401: Invalid API key/
  );
  assert.equal(events.at(-1)?.type, "error");
  if (events.at(-1)?.type === "error") {
    assert.match(events.at(-1)!.message, /HTTP 401: Invalid API key/);
    assert.equal(events.at(-1)!.recoverable, false);
  }

  // 2. HTTP 500 Internal Server Error
  responseStatus = 500;
  responseBody = "Upstream model overloaded";
  await assert.rejects(
    () => backend.sendPrompt({ sessionID: sess, directory: "/tmp/repo", text: "Hello" }),
    /HTTP 500: Upstream model overloaded/
  );
  assert.equal(events.at(-1)?.type, "error");
  if (events.at(-1)?.type === "error") {
    assert.match(events.at(-1)!.message, /HTTP 500: Upstream model overloaded/);
    assert.equal(events.at(-1)!.recoverable, false);
  }

  // 3. Connection refused (unreachable port)
  const closedBaseUrl = await getClosedPortBaseUrl();
  const offlineBackend = new OpenAiCompatBackend({
    baseUrl: closedBaseUrl,
    model: "gpt-4o-mini",
  });
  const offlineEvents: NormalizedAgentEvent[] = [];
  offlineBackend.subscribe((ev) => offlineEvents.push(ev));

  const offlineSess = await offlineBackend.createSession({
    directory: "/tmp/repo",
    title: "Refused",
  });
  await assert.rejects(() =>
    offlineBackend.sendPrompt({ sessionID: offlineSess, directory: "/tmp/repo", text: "Hello" })
  );
  assert.equal(offlineEvents.length, 1);
  assert.equal(offlineEvents[0].type, "error");
  assert.equal(offlineEvents[0].recoverable, false);
});

test("OpenAiCompatBackend abort() aborts in-flight SSE requests and emits recoverable error", async (t) => {
  let resolveRequestArrived!: () => void;
  const requestArrived = new Promise<void>((resolve) => {
    resolveRequestArrived = resolve;
  });

  const srv = await startTestServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Partial" } }] })}\n\n`);
    resolveRequestArrived();
    // Leave response open until aborted or server closes
  });
  t.after(() => srv.close());

  const backend = new OpenAiCompatBackend({
    baseUrl: srv.baseUrl,
    model: "gpt-4o-mini",
  });
  const events: NormalizedAgentEvent[] = [];
  backend.subscribe((ev) => events.push(ev));

  const sessionID = await backend.createSession({ directory: "/tmp/repo", title: "Abort SSE" });
  const pending = backend.sendPrompt({
    sessionID,
    directory: "/tmp/repo",
    text: "Stream forever",
  });

  await requestArrived;
  await backend.abort(sessionID);
  await assert.rejects(() => pending, /Aborted/);

  const errEv = events.find((e) => e.type === "error");
  assert.ok(errEv);
  assert.equal(errEv.type, "error");
  assert.equal(errEv.recoverable, true);
  assert.equal(errEv.message, "Aborted");
});

test("OpenAiCompatBackend spawnSubagent emits subagent_spawn, subagent_update, and completed", async (t) => {
  const srv = await startTestServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    const chunks = [
      JSON.stringify({ choices: [{ delta: { content: "<think>Checking diff</think>" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "All looks good." } }] }),
      "[DONE]",
    ];
    for (const chunk of chunks) {
      res.write(`data: ${chunk}\n\n`);
    }
    res.end();
  });
  t.after(() => srv.close());

  const backend = new OpenAiCompatBackend({
    baseUrl: srv.baseUrl,
    model: "gpt-4o-mini",
  });
  const events: NormalizedAgentEvent[] = [];
  backend.subscribe((ev) => events.push(ev));

  const output = await backend.spawnSubagent({
    subagentId: "sub-openai-1",
    role: "Reviewer",
    title: "Review changes",
    directory: "/tmp/repo",
    prompt: "Please review",
  });

  assert.equal(output, "All looks good.");

  const spawnEv = events.find((e) => e.type === "subagent_spawn");
  assert.ok(spawnEv);
  assert.equal(spawnEv.type, "subagent_spawn");
  assert.equal(spawnEv.subagentId, "sub-openai-1");
  assert.equal(spawnEv.role, "Reviewer");
  assert.equal(spawnEv.title, "Review changes");

  const updates = events.filter((e) => e.type === "subagent_update");
  assert.deepEqual(
    updates.map((u) => ({ state: u.state, statusText: u.statusText })),
    [
      { state: "work", statusText: "Thinking..." },
      { state: "work", statusText: "Writing response..." },
      { state: "idle", statusText: "Done" },
    ]
  );

  const completedEv = events.find((e) => e.type === "completed");
  assert.ok(completedEv);
  assert.equal(completedEv.type, "completed");
  assert.equal(completedEv.text, "All looks good.");
  assert.equal(completedEv.petId, "sub-openai-1");
});
