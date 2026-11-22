import assert from "node:assert/strict";
import test from "node:test";
import {
  ClaudeCodeBackend,
  buildClaudeCliArgs,
  createStreamParser,
  parseStreamJsonLine,
} from "../../src/backends/claude-code.ts";
import type {
  CliAvailabilityResult,
  CliRunner,
  CliSpawnOptions,
  CliStreamPayload,
  NormalizedAgentEvent,
} from "../../src/backends/types.ts";

interface MockRunnerBehavior {
  availability?: CliAvailabilityResult | (() => Promise<CliAvailabilityResult>);
  onSpawn?: (
    opts: CliSpawnOptions,
    emit: (payload: CliStreamPayload) => void
  ) => void | Promise<void>;
}

function createMockCliRunner(behavior: MockRunnerBehavior = {}) {
  const spawns: CliSpawnOptions[] = [];
  const kills: string[] = [];
  const emitters = new Map<string, (payload: CliStreamPayload) => void>();

  const runner: CliRunner = {
    async checkAvailability(binary: string, _cliPath?: string): Promise<CliAvailabilityResult> {
      if (typeof behavior.availability === "function") {
        return behavior.availability();
      }
      return (
        behavior.availability ?? {
          available: true,
          binary,
          path: `/usr/local/bin/${binary}`,
          version: "2.1.0",
        }
      );
    },

    async spawn(
      opts: CliSpawnOptions,
      onPayload: (payload: CliStreamPayload) => void
    ): Promise<() => void> {
      spawns.push(opts);
      emitters.set(opts.runId, onPayload);
      if (behavior.onSpawn) {
        queueMicrotask(() => {
          void behavior.onSpawn?.(opts, onPayload);
        });
      }
      return () => {
        emitters.delete(opts.runId);
      };
    },

    async kill(runId: string): Promise<void> {
      kills.push(runId);
    },
  };

  return { runner, spawns, kills, emitters };
}

test("parseStreamJsonLine and createStreamParser parse realistic Claude stream-json events", () => {
  const emitted: NormalizedAgentEvent[] = [];
  const parser = createStreamParser("sess-claude-1", (ev) => emitted.push(ev));

  const lines = [
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "claude-cli-abc",
      model: "claude-sonnet-4-5",
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "Inspecting project layout first." }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "I will update the config and run tests." }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_edit_1",
            name: "Edit",
            input: { file_path: "src/config.ts", old_string: "a", new_string: "b" },
          },
          {
            type: "tool_use",
            id: "toolu_bash_1",
            name: "Bash",
            input: { command: "npm test" },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_edit_1",
            content: "Edited src/config.ts",
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_bash_1",
            is_error: true,
            content: [{ type: "text", text: "Test suite failed (exit 1)" }],
          },
        ],
      },
    }),
    JSON.stringify({
      type: "permission_request",
      request_id: "perm-1",
      permission: "bash",
      patterns: ["rm -rf dist"],
      detail: "Allow running cleanup command",
    }),
    JSON.stringify({
      type: "control_request",
      request_id: "ctrl-2",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "git status" },
      },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "I will update the config and run tests.",
      usage: { input_tokens: 150, output_tokens: 42, reasoning_tokens: 18 },
      total_cost_usd: 0.0045,
    }),
  ];

  for (const line of lines) {
    parser.feedLine(line);
  }

  assert.equal(parser.state.cliSessionId, "claude-cli-abc");
  assert.equal(parser.state.model, "claude-sonnet-4-5");
  assert.equal(parser.state.completedEmitted, true);

  assert.deepEqual(emitted, [
    {
      type: "thought",
      sessionID: "sess-claude-1",
      text: "Inspecting project layout first.",
      petId: undefined,
    },
    {
      type: "text_delta",
      sessionID: "sess-claude-1",
      delta: "I will update the config and run tests.",
      petId: undefined,
    },
    {
      type: "tool_start",
      sessionID: "sess-claude-1",
      toolName: "Edit",
      toolId: "toolu_edit_1",
      detail: "src/config.ts",
      petId: undefined,
    },
    {
      type: "tool_start",
      sessionID: "sess-claude-1",
      toolName: "Bash",
      toolId: "toolu_bash_1",
      detail: "npm test",
      petId: undefined,
    },
    {
      type: "tool_end",
      sessionID: "sess-claude-1",
      toolId: "toolu_edit_1",
      success: true,
      output: "Edited src/config.ts",
      petId: undefined,
    },
    {
      type: "tool_end",
      sessionID: "sess-claude-1",
      toolId: "toolu_bash_1",
      success: false,
      output: "Test suite failed (exit 1)",
      petId: undefined,
    },
    {
      type: "permission_request",
      sessionID: "sess-claude-1",
      requestId: "perm-1",
      permission: "bash",
      patterns: ["rm -rf dist"],
      detail: "Allow running cleanup command",
      petId: undefined,
    },
    {
      type: "permission_request",
      sessionID: "sess-claude-1",
      requestId: "ctrl-2",
      permission: "Bash",
      patterns: ["git status"],
      detail: "Bash: git status",
      petId: undefined,
    },
    {
      type: "completed",
      sessionID: "sess-claude-1",
      text: "I will update the config and run tests.",
      usage: {
        inputTokens: 150,
        outputTokens: 42,
        reasoningTokens: 18,
        cost: 0.0045,
      },
      petId: undefined,
    },
  ]);

  // Single-line helper forwards petId cleanly
  const single = parseStreamJsonLine(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }] },
    }),
    "sess-single",
    "pet-9"
  );
  assert.deepEqual(single, [
    { type: "text_delta", sessionID: "sess-single", delta: "hi", petId: "pet-9" },
  ]);
});

test("createStreamParser handles malformed JSON lines gracefully without halting subsequent valid lines", () => {
  const emitted: NormalizedAgentEvent[] = [];
  const parser = createStreamParser("sess-malformed", (ev) => emitted.push(ev));

  const badEvents = parser.feedLine("{not-valid-json");
  assert.equal(badEvents.length, 1);
  assert.equal(badEvents[0].type, "error");
  assert.equal(badEvents[0].recoverable, true);
  assert.match(badEvents[0].message, /Malformed Claude stream-json line/);

  // Empty/whitespace lines are ignored cleanly
  assert.deepEqual(parser.feedLine("   "), []);

  // Subsequent valid line continues to parse normally
  const goodEvents = parser.feedLine(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Recovered output" }] },
    })
  );
  assert.deepEqual(goodEvents, [
    { type: "text_delta", sessionID: "sess-malformed", delta: "Recovered output", petId: undefined },
  ]);
  assert.equal(emitted.length, 2);
});

test("ClaudeCodeBackend executes sendPrompt via mock CliRunner and builds expected CLI args", async () => {
  const args = buildClaudeCliArgs({
    prompt: "Fix bug",
    system: "Be concise",
    disableMutatingTools: true,
    model: "claude-sonnet-4-5",
  });
  assert.deepEqual(args, [
    "-p",
    "Fix bug",
    "--verbose",
    "--output-format",
    "stream-json",
    "--append-system-prompt",
    "Be concise",
    "--permission-mode",
    "plan",
    "--model",
    "claude-sonnet-4-5",
  ]);

  const { runner, spawns } = createMockCliRunner({
    onSpawn(_opts, emit) {
      emit({
        stream: "stdout",
        line: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "cli-1" }),
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "thinking", thinking: "Checking files" }] },
          }),
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "Done fixing." }] },
          }),
          JSON.stringify({
            type: "result",
            is_error: false,
            result: "Done fixing.",
            usage: { input_tokens: 20, output_tokens: 5 },
          }),
        ].join("\n"),
      });
      emit({ stream: "exit", code: 0 });
    },
  });

  const backend = new ClaudeCodeBackend({ runner, model: "claude-sonnet-4-5" });
  const events: NormalizedAgentEvent[] = [];
  backend.subscribe((ev) => events.push(ev));

  const sessionID = await backend.createSession({
    directory: "/tmp/repo",
    title: "Test run",
  });
  const reply = await backend.sendPrompt({
    sessionID,
    directory: "/tmp/repo",
    text: "Fix the bug",
    disableMutatingTools: true,
  });

  assert.equal(reply, "Done fixing.");
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].binary, "claude");
  assert.equal(spawns[0].cwd, "/tmp/repo");
  assert.ok(spawns[0].args.includes("--permission-mode"));
  assert.ok(spawns[0].args.includes("plan"));
  assert.deepEqual(
    events.map((e) => e.type),
    ["thought", "text_delta", "completed"]
  );
});

test("ClaudeCodeBackend emits error event and rejects cleanly on non-zero exit code", async () => {
  const { runner } = createMockCliRunner({
    onSpawn(_opts, emit) {
      emit({ stream: "stderr", line: "Authentication token expired" });
      emit({ stream: "exit", code: 1 });
    },
  });

  const backend = new ClaudeCodeBackend({ runner });
  const events: NormalizedAgentEvent[] = [];
  backend.subscribe((ev) => events.push(ev));

  const sessionID = await backend.createSession({ directory: "/tmp/repo", title: "Fail run" });
  await assert.rejects(
    () =>
      backend.sendPrompt({
        sessionID,
        directory: "/tmp/repo",
        text: "Hello",
      }),
    /Authentication token expired/
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].recoverable, false);
  assert.match(events[0].message, /Authentication token expired/);
});

test("ClaudeCodeBackend checkAvailability reports missing and present claude CLI cleanly", async () => {
  const missingRunner = createMockCliRunner({
    availability: {
      available: false,
      binary: "claude",
      path: null,
      error: "claude not found in PATH",
    },
  }).runner;

  const unavailable = await new ClaudeCodeBackend({ runner: missingRunner }).checkAvailability();
  assert.equal(unavailable.backend, "claude-code");
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.binary, "claude");
  assert.equal(unavailable.error, "claude not found in PATH");

  const presentRunner = createMockCliRunner({
    availability: {
      available: true,
      binary: "claude",
      path: "/usr/local/bin/claude",
      version: "2.1.12",
    },
  }).runner;

  const available = await new ClaudeCodeBackend({ runner: presentRunner }).checkAvailability();
  assert.equal(available.backend, "claude-code");
  assert.equal(available.available, true);
  assert.equal(available.path, "/usr/local/bin/claude");
  assert.equal(available.version, "2.1.12");
});

test("ClaudeCodeBackend abort() calls runner.kill(runId) on active runs and rejects cleanly", async () => {
  const { runner, spawns, kills } = createMockCliRunner();
  const backend = new ClaudeCodeBackend({ runner });
  const events: NormalizedAgentEvent[] = [];
  backend.subscribe((ev) => events.push(ev));

  const sessionID = await backend.createSession({ directory: "/tmp/repo", title: "Abort run" });
  const promptPromise = backend.sendPrompt({
    sessionID,
    directory: "/tmp/repo",
    text: "Long running task",
  });

  // Yield microtask so spawn() registers the active run
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(spawns.length, 1);
  const runId = spawns[0].runId;

  await backend.abort(sessionID);
  await assert.rejects(() => promptPromise, /Aborted/);

  assert.deepEqual(kills, [runId]);
  const errEv = events.find((e) => e.type === "error");
  assert.ok(errEv);
  assert.equal(errEv.type, "error");
  assert.equal(errEv.recoverable, true);
  assert.equal(errEv.message, "Aborted");
});

test("ClaudeCodeBackend abort while spawn is in-flight still triggers runner.kill(runId) once spawn resolves", async () => {
  const spawns: CliSpawnOptions[] = [];
  const kills: string[] = [];
  let spawnResolved = false;
  let resolveSpawn!: (unlisten: () => void) => void;
  const unlistenCalls: number[] = [];

  const runner: CliRunner = {
    async checkAvailability(binary: string) {
      return { available: true, binary };
    },
    spawn(opts) {
      spawns.push(opts);
      return new Promise<() => void>((resolve) => {
        resolveSpawn = (fn) => {
          spawnResolved = true;
          resolve(fn);
        };
      });
    },
    async kill(runId: string) {
      if (spawnResolved) {
        kills.push(`after:${runId}`);
      } else {
        kills.push(`before:${runId}`);
      }
    },
  };

  const backend = new ClaudeCodeBackend({ runner });
  const sessionID = await backend.createSession({ directory: "", title: "In-flight abort" });

  const promptPromise = backend.sendPrompt({
    sessionID,
    directory: "",
    text: "Long task",
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].cwd, "");
  const runId = spawns[0].runId;

  await backend.abort(sessionID);
  await assert.rejects(() => promptPromise, /Aborted/);

  resolveSpawn(() => {
    unlistenCalls.push(1);
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(unlistenCalls.length, 1);
  assert.ok(kills.includes(`after:${runId}`));
});

test("ClaudeCodeBackend handles stream: error payload and resumes cliSessionId on follow-up turns", async () => {
  const { runner, spawns } = createMockCliRunner({
    onSpawn(opts, emit) {
      if (spawns.length === 1) {
        emit({
          stream: "stdout",
          line: [
            JSON.stringify({ type: "system", subtype: "init", session_id: "claude-sess-42" }),
            JSON.stringify({
              type: "assistant",
              message: { content: [{ type: "text", text: "First turn" }] },
            }),
            JSON.stringify({ type: "result", is_error: false, result: "First turn" }),
          ].join("\n"),
        });
        emit({ stream: "exit", code: 0 });
        return;
      }
      assert.ok(opts.args.includes("--resume"));
      assert.ok(opts.args.includes("claude-sess-42"));
      emit({ stream: "error", error: "Failed to read CLI stream" });
    },
  });

  const backend = new ClaudeCodeBackend({ runner });
  const events: NormalizedAgentEvent[] = [];
  backend.subscribe((ev) => events.push(ev));

  const sessionID = await backend.createSession({ directory: "/tmp/repo", title: "Stream error" });
  const first = await backend.sendPrompt({
    sessionID,
    directory: "/tmp/repo",
    text: "Turn 1",
  });
  assert.equal(first, "First turn");

  await assert.rejects(
    () =>
      backend.sendPrompt({
        sessionID,
        directory: "/tmp/repo",
        text: "Turn 2",
      }),
    /Failed to read CLI stream/
  );

  const errEv = events.at(-1);
  assert.ok(errEv);
  assert.equal(errEv.type, "error");
  assert.equal(errEv.recoverable, false);
  assert.equal(errEv.message, "Failed to read CLI stream");
});
