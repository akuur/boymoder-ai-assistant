import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexCliBackend,
  buildCodexCliArgs,
  createStreamParser,
  parseJsonlLine,
} from "../../src/backends/codex-cli.ts";
import type {
  CliAvailabilityResult,
  CliRunner,
  CliSpawnOptions,
  CliStreamPayload,
  NormalizedAgentEvent,
} from "../../src/backends/types.ts";

interface MockRunnerBehavior {
  availability?: CliAvailabilityResult;
  onSpawn?: (
    opts: CliSpawnOptions,
    emit: (payload: CliStreamPayload) => void
  ) => void | Promise<void>;
}

function createMockCliRunner(behavior: MockRunnerBehavior = {}) {
  const spawns: CliSpawnOptions[] = [];
  const kills: string[] = [];

  const runner: CliRunner = {
    async checkAvailability(binary: string, _cliPath?: string): Promise<CliAvailabilityResult> {
      return (
        behavior.availability ?? {
          available: true,
          binary,
          path: `/usr/local/bin/${binary}`,
          version: "0.42.0",
        }
      );
    },

    async spawn(
      opts: CliSpawnOptions,
      onPayload: (payload: CliStreamPayload) => void
    ): Promise<() => void> {
      spawns.push(opts);
      if (behavior.onSpawn) {
        queueMicrotask(() => {
          void behavior.onSpawn?.(opts, onPayload);
        });
      }
      return () => {};
    },

    async kill(runId: string): Promise<void> {
      kills.push(runId);
    },
  };

  return { runner, spawns, kills };
}

test("createStreamParser and parseJsonlLine parse realistic codex exec --json JSONL events", () => {
  const emitted: NormalizedAgentEvent[] = [];
  const parser = createStreamParser("sess-codex-1", (ev) => emitted.push(ev));

  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: "thread-xyz" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "reason-1", type: "reasoning", text: "Checking package scripts" },
    }),
    JSON.stringify({
      type: "item.started",
      item: { id: "cmd-1", type: "command_execution", command: "npm test" },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: "npm test",
        exit_code: 0,
        aggregated_output: "6 tests passed",
      },
    }),
    JSON.stringify({
      type: "item.started",
      item: {
        id: "fc-1",
        type: "file_change",
        changes: [{ kind: "modify", path: "src/app.ts" }],
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "fc-1",
        type: "file_change",
        status: "completed",
      },
    }),
    JSON.stringify({
      type: "item.updated",
      item: { id: "msg-1", type: "agent_message", text: "Updated src/app.ts" },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "msg-1", type: "agent_message", text: "Updated src/app.ts and verified tests." },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 320, output_tokens: 85 },
    }),
  ];

  for (const line of lines) {
    parser.feedLine(line);
  }

  assert.equal(parser.state.threadId, "thread-xyz");
  assert.equal(parser.state.turnActive, false);
  assert.equal(parser.state.completedEmitted, true);

  assert.deepEqual(emitted, [
    {
      type: "thought",
      sessionID: "sess-codex-1",
      text: "Checking package scripts",
      petId: undefined,
    },
    {
      type: "tool_start",
      sessionID: "sess-codex-1",
      toolName: "bash",
      toolId: "cmd-1",
      detail: "npm test",
      petId: undefined,
    },
    {
      type: "tool_end",
      sessionID: "sess-codex-1",
      toolName: "bash",
      toolId: "cmd-1",
      success: true,
      output: "6 tests passed",
      petId: undefined,
    },
    {
      type: "tool_start",
      sessionID: "sess-codex-1",
      toolName: "file_change",
      toolId: "fc-1",
      detail: "modify: src/app.ts",
      petId: undefined,
    },
    {
      type: "tool_end",
      sessionID: "sess-codex-1",
      toolName: "file_change",
      toolId: "fc-1",
      success: true,
      petId: undefined,
    },
    {
      type: "text_delta",
      sessionID: "sess-codex-1",
      delta: "Updated src/app.ts",
      petId: undefined,
    },
    {
      type: "text_delta",
      sessionID: "sess-codex-1",
      delta: " and verified tests.",
      petId: undefined,
    },
    {
      type: "completed",
      sessionID: "sess-codex-1",
      text: "Updated src/app.ts and verified tests.",
      usage: { inputTokens: 320, outputTokens: 85 },
      petId: undefined,
    },
  ]);

  const single = parseJsonlLine(
    JSON.stringify({
      type: "item.completed",
      item: { id: "r-single", type: "reasoning", text: "Quick check" },
    }),
    "sess-single",
    "sub-1"
  );
  assert.deepEqual(single, [
    { type: "thought", sessionID: "sess-single", text: "Quick check", petId: "sub-1" },
  ]);
});

test("CodexCliBackend spawnSubagent emits subagent_spawn, subagent_update progress, and completed", async () => {
  const args = buildCodexCliArgs({ prompt: "Write tests", model: "gpt-5-codex" });
  assert.deepEqual(args, ["exec", "--json", "-m", "gpt-5-codex", "--", "Write tests"]);

  const { runner, spawns } = createMockCliRunner({
    onSpawn(_opts, emit) {
      emit({
        stream: "stdout",
        line: [
          JSON.stringify({ type: "thread.started", thread_id: "th-sub-1" }),
          JSON.stringify({ type: "turn.started" }),
          JSON.stringify({
            type: "item.completed",
            item: { id: "r1", type: "reasoning", text: "Planning test cases" },
          }),
          JSON.stringify({
            type: "item.started",
            item: { id: "c1", type: "command_execution", command: "node --test" },
          }),
          JSON.stringify({
            type: "item.completed",
            item: {
              id: "c1",
              type: "command_execution",
              command: "node --test",
              exit_code: 0,
              aggregated_output: "ok",
            },
          }),
          JSON.stringify({
            type: "item.started",
            item: {
              id: "f1",
              type: "file_change",
              changes: [{ kind: "add", path: "tests/new.test.ts" }],
            },
          }),
          JSON.stringify({
            type: "item.completed",
            item: { id: "f1", type: "file_change", status: "completed" },
          }),
          JSON.stringify({
            type: "item.completed",
            item: { id: "m1", type: "agent_message", text: "Added tests." },
          }),
          JSON.stringify({
            type: "turn.completed",
            usage: { input_tokens: 100, output_tokens: 25 },
          }),
        ].join("\n"),
      });
      emit({ stream: "exit", code: 0 });
    },
  });

  const backend = new CodexCliBackend({ runner, model: "gpt-5-codex" });
  const events: NormalizedAgentEvent[] = [];
  backend.subscribe((ev) => events.push(ev));

  const output = await backend.spawnSubagent({
    subagentId: "sub-tester-1",
    role: "Tester",
    title: "Add unit tests",
    directory: "/tmp/repo",
    prompt: "Write tests for codex",
  });

  assert.equal(output, "Added tests.");
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].binary, "codex");

  const spawnEv = events.find((e) => e.type === "subagent_spawn");
  assert.ok(spawnEv);
  assert.equal(spawnEv.type, "subagent_spawn");
  assert.equal(spawnEv.subagentId, "sub-tester-1");
  assert.equal(spawnEv.role, "Tester");
  assert.equal(spawnEv.title, "Add unit tests");

  const updates = events.filter((e) => e.type === "subagent_update");
  assert.deepEqual(
    updates.map((u) => ({ state: u.state, statusText: u.statusText, detail: u.detail })),
    [
      { state: "work", statusText: "Thinking...", detail: undefined },
      { state: "work", statusText: "Debugging...", detail: "node --test" },
      { state: "work", statusText: "Building...", detail: "add: tests/new.test.ts" },
      { state: "idle", statusText: "Done", detail: undefined },
    ]
  );

  const completedEv = events.find((e) => e.type === "completed");
  assert.ok(completedEv);
  assert.equal(completedEv.type, "completed");
  assert.equal(completedEv.text, "Added tests.");
  assert.equal(completedEv.petId, "sub-tester-1");
});

test("createStreamParser handles malformed JSONL lines and turn.failed without crashing", () => {
  const emitted: NormalizedAgentEvent[] = [];
  const parser = createStreamParser("sess-err-1", (ev) => emitted.push(ev));

  const malformed = parser.feedLine("{broken jsonl");
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0].type, "error");
  assert.equal(malformed[0].recoverable, true);
  assert.match(malformed[0].message, /Malformed Codex JSONL line/);

  // Parser keeps working after malformed line
  const valid = parser.feedLine(
    JSON.stringify({
      type: "item.completed",
      item: { id: "m1", type: "agent_message", text: "Partial" },
    })
  );
  assert.equal(valid.length, 1);
  assert.equal(valid[0].type, "text_delta");

  const failed = parser.feedLine(
    JSON.stringify({
      type: "turn.failed",
      error: { message: "Model quota exceeded" },
    })
  );
  assert.deepEqual(failed, [
    {
      type: "error",
      sessionID: "sess-err-1",
      message: "Model quota exceeded",
      recoverable: false,
      petId: undefined,
    },
  ]);
  assert.equal(parser.state.turnError, "Model quota exceeded");
  assert.equal(emitted.length, 3);
});

test("CodexCliBackend handles turn.failed and non-zero exit codes cleanly", async () => {
  // 1. turn.failed in stdout
  const failTurnRunner = createMockCliRunner({
    onSpawn(_opts, emit) {
      emit({
        stream: "stdout",
        line: JSON.stringify({
          type: "turn.failed",
          error: { message: "Sandbox permission denied" },
        }),
      });
      emit({ stream: "exit", code: 1 });
    },
  }).runner;

  const backend1 = new CodexCliBackend({ runner: failTurnRunner });
  const events1: NormalizedAgentEvent[] = [];
  backend1.subscribe((ev) => events1.push(ev));

  const sess1 = await backend1.createSession({ directory: "/tmp/repo", title: "Turn failed" });
  await assert.rejects(
    () => backend1.sendPrompt({ sessionID: sess1, directory: "/tmp/repo", text: "Run" }),
    /Sandbox permission denied/
  );
  assert.equal(events1.filter((e) => e.type === "error").length, 1);
  assert.equal(events1[0].type, "error");
  assert.equal(events1[0].recoverable, false);

  // 2. Non-zero exit code without turn.failed JSON
  const exitErrRunner = createMockCliRunner({
    onSpawn(_opts, emit) {
      emit({ stream: "stderr", line: "codex binary crashed" });
      emit({ stream: "exit", code: 2 });
    },
  }).runner;

  const backend2 = new CodexCliBackend({ runner: exitErrRunner });
  const events2: NormalizedAgentEvent[] = [];
  backend2.subscribe((ev) => events2.push(ev));

  const sess2 = await backend2.createSession({ directory: "/tmp/repo", title: "Exit code 2" });
  await assert.rejects(
    () => backend2.sendPrompt({ sessionID: sess2, directory: "/tmp/repo", text: "Run" }),
    /codex binary crashed/
  );
  assert.equal(events2.length, 1);
  assert.equal(events2[0].type, "error");
  assert.equal(events2[0].recoverable, false);
  assert.match(events2[0].message, /codex binary crashed/);
});

test("CodexCliBackend checkAvailability and abort work cleanly", async () => {
  const { runner, spawns, kills } = createMockCliRunner({
    availability: {
      available: false,
      binary: "codex",
      path: null,
      error: "codex not installed",
    },
  });

  const backend = new CodexCliBackend({ runner });
  const avail = await backend.checkAvailability();
  assert.equal(avail.backend, "codex-cli");
  assert.equal(avail.available, false);
  assert.equal(avail.error, "codex not installed");

  const sessionID = await backend.createSession({ directory: "/tmp/repo", title: "Abort" });
  const pending = backend.sendPrompt({
    sessionID,
    directory: "/tmp/repo",
    text: "Long task",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(spawns.length, 1);

  await backend.abort(sessionID);
  await assert.rejects(() => pending, /Aborted/);
  assert.deepEqual(kills, [spawns[0].runId]);
});

test("CodexCliBackend passes -s read-only and -- when disableMutatingTools is true, resumes threadId, and handles stream: error", async () => {
  const readOnlyArgs = buildCodexCliArgs({
    prompt: "-leading-dash prompt",
    model: "gpt-5-codex",
    disableMutatingTools: true,
  });
  assert.deepEqual(readOnlyArgs, [
    "exec",
    "--json",
    "-s",
    "read-only",
    "-m",
    "gpt-5-codex",
    "--",
    "-leading-dash prompt",
  ]);

  const resumeArgs = buildCodexCliArgs({
    prompt: "Follow up",
    model: "gpt-5-codex",
    disableMutatingTools: true,
    threadId: "th-123",
  });
  assert.deepEqual(resumeArgs, [
    "exec",
    "resume",
    "--json",
    "-s",
    "read-only",
    "-m",
    "gpt-5-codex",
    "th-123",
    "--",
    "Follow up",
  ]);

  const { runner, spawns } = createMockCliRunner({
    onSpawn(_opts, emit) {
      if (spawns.length === 1) {
        emit({
          stream: "stdout",
          line: [
            JSON.stringify({ type: "thread.started", thread_id: "th-resume-1" }),
            JSON.stringify({
              type: "item.completed",
              item: { id: "m1", type: "agent_message", text: "Read-only result" },
            }),
            JSON.stringify({ type: "turn.completed" }),
          ].join("\n"),
        });
        emit({ stream: "exit", code: 0 });
        return;
      }
      emit({ stream: "error", error: "Codex stream failed" });
    },
  });

  const backend = new CodexCliBackend({ runner });
  const events: NormalizedAgentEvent[] = [];
  backend.subscribe((ev) => events.push(ev));

  const sessionID = await backend.createSession({ directory: "", title: "Read-only & error" });
  const first = await backend.sendPrompt({
    sessionID,
    directory: "",
    text: "Inspect only",
    disableMutatingTools: true,
  });

  assert.equal(first, "Read-only result");
  assert.equal(spawns[0].cwd, "");
  assert.deepEqual(spawns[0].args, [
    "exec",
    "--json",
    "-s",
    "read-only",
    "--",
    "Inspect only",
  ]);

  await assert.rejects(
    () =>
      backend.sendPrompt({
        sessionID,
        directory: "/tmp/repo",
        text: "Follow-up",
        disableMutatingTools: true,
      }),
    /Codex stream failed/
  );

  assert.deepEqual(spawns[1].args, [
    "exec",
    "resume",
    "--json",
    "-s",
    "read-only",
    "th-resume-1",
    "--",
    "Follow-up",
  ]);

  const errEv = events.at(-1);
  assert.ok(errEv);
  assert.equal(errEv.type, "error");
  assert.equal(errEv.recoverable, false);
  assert.equal(errEv.message, "Codex stream failed");
});
