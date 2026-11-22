import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  ClaudeCodeBackend,
  CodexCliBackend,
  OpenAiCompatBackend,
  type AgentBackend,
  type BackendAvailability,
  type BackendPermissionReply,
  type BackendPromptOptions,
  type BackendSessionOptions,
  type BackendSubagentOptions,
  type CliRunner,
  type CliStreamPayload,
  type NormalizedAgentEvent,
} from "../../src/backends/index.ts";
import { PetOrchestratorEngine } from "../../src/engine/orchestrator.ts";
import { PetSpriteRegistry } from "../../src/engine/pets.ts";
import type { BackendId, PetAnimState } from "../../src/engine/types.ts";

class MockOpenCodeAgentBackend implements AgentBackend {
  readonly id = "opencode" as const;
  readonly label = "OpenCode";
  readonly prompts: BackendPromptOptions[] = [];
  private listeners = new Set<(ev: NormalizedAgentEvent) => void>();
  private seq = 0;

  subscribe(onEvent: (event: NormalizedAgentEvent) => void): () => void {
    this.listeners.add(onEvent);
    return () => this.listeners.delete(onEvent);
  }

  private emit(ev: NormalizedAgentEvent): void {
    for (const listener of this.listeners) {
      listener(ev);
    }
  }

  async checkAvailability(): Promise<BackendAvailability> {
    return { backend: "opencode", available: true, label: this.label, version: "mock-v2" };
  }

  async createSession(_opts: BackendSessionOptions): Promise<string> {
    this.seq += 1;
    return `oc-sess-${this.seq}`;
  }

  async sendPrompt(opts: BackendPromptOptions): Promise<string> {
    this.prompts.push(opts);
    this.emit({ type: "thought", sessionID: opts.sessionID, text: "Inspecting...", petId: opts.petId });
    this.emit({ type: "text_delta", sessionID: opts.sessionID, delta: "OpenCode reply", petId: opts.petId });
    this.emit({
      type: "completed",
      sessionID: opts.sessionID,
      text: "OpenCode reply",
      usage: { inputTokens: 10, outputTokens: 5 },
      petId: opts.petId,
    });
    return "OpenCode reply";
  }

  async spawnSubagent(opts: BackendSubagentOptions): Promise<string> {
    return `sub-out:${opts.title}`;
  }

  async respondToPermission(_reply: BackendPermissionReply): Promise<void> {}

  async abort(_sessionID?: string): Promise<void> {}
}

function createScriptedCliRunner(params: {
  available?: boolean;
  onSpawn: (
    opts: { runId: string; binary: string; args: string[]; cwd: string },
    emit: (payload: CliStreamPayload) => void
  ) => void;
}): { runner: CliRunner; spawnedBinaries: string[]; killedRuns: string[] } {
  const spawnedBinaries: string[] = [];
  const killedRuns: string[] = [];

  const runner: CliRunner = {
    async checkAvailability(binary) {
      if (params.available === false) {
        return { available: false, binary, path: null, error: `${binary} missing` };
      }
      return { available: true, binary, path: `/mock/bin/${binary}` };
    },
    async spawn(opts, onPayload) {
      spawnedBinaries.push(opts.binary);
      queueMicrotask(() => params.onSpawn(opts, onPayload));
      return () => {};
    },
    async kill(runId) {
      killedRuns.push(runId);
    },
  };

  return { runner, spawnedBinaries, killedRuns };
}

test("orchestrator switches backends (opencode -> claude-code -> codex-cli -> openai-compat) and drives pet states", async (t) => {
  // Spin up a real local mock SSE server for OpenAiCompatBackend
  let openAiRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "hermes-3" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      openAiRequests += 1;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "<think>checking api</think>Hermes ok" } }] })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const openAiBaseUrl = `http://127.0.0.1:${addr.port}/v1`;

  const opencodeMock = new MockOpenCodeAgentBackend();

  let claudePermissionObserved = false;
  let claudeSubagentSpawned = false;
  const claudeRunnerState = createScriptedCliRunner({
    onSpawn(opts, emit) {
      const promptArg = opts.args[opts.args.indexOf("-p") + 1] ?? "";
      if (promptArg.includes("Respond ONLY with the JSON execution plan array")) {
        // Planner turn
        emit({
          stream: "stdout",
          line: JSON.stringify({
            type: "result",
            result: JSON.stringify([
              {
                id: "t1",
                role: "Research",
                title: "Inspect backend",
                prompt: "Read backend files",
                branch_or_scope: "src/backends/",
              },
            ]),
          }),
        });
        emit({ stream: "exit", code: 0 });
        return;
      }

      if (promptArg.includes("Role: Research")) {
        claudeSubagentSpawned = true;
        emit({
          stream: "stdout",
          line: JSON.stringify({
            type: "assistant",
            message: {
              content: [{ type: "tool_use", id: "tu-sub", name: "Read", input: { path: "src/index.ts" } }],
            },
          }),
        });
        emit({
          stream: "stdout",
          line: JSON.stringify({
            type: "permission_request",
            request_id: "perm-sub-1",
            permission: "bash",
            patterns: ["npm test"],
            detail: "Run npm test",
          }),
        });
        // Give orchestrator microtask chance to see permission alert, then finish after reply
        setTimeout(() => {
          emit({
            stream: "stdout",
            line: JSON.stringify({ type: "result", result: "Subagent finished reading" }),
          });
          emit({ stream: "exit", code: 0 });
        }, 25);
        return;
      }

      // Direct build turn with permission prompt
      emit({
        stream: "stdout",
        line: JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "thinking", thinking: "Planning edit..." }],
          },
        }),
      });
      emit({
        stream: "stdout",
        line: JSON.stringify({
          type: "permission_request",
          request_id: "perm-main-1",
          permission: "edit",
          patterns: ["src/app.ts"],
          detail: "Edit src/app.ts",
        }),
      });
      setTimeout(() => {
        emit({
          stream: "stdout",
          line: JSON.stringify({
            type: "result",
            result: "Claude direct done",
            usage: { input_tokens: 12, output_tokens: 8 },
          }),
        });
        emit({ stream: "exit", code: 0 });
      }, 25);
    },
  });

  const codexRunnerState = createScriptedCliRunner({
    onSpawn(_opts, emit) {
      emit({ stream: "stdout", line: JSON.stringify({ type: "thread.started", thread_id: "th-1" }) });
      emit({ stream: "stdout", line: JSON.stringify({ type: "turn.started" }) });
      emit({
        stream: "stdout",
        line: JSON.stringify({
          type: "item.completed",
          item: { id: "r1", type: "reasoning", text: "Checking codex plan" },
        }),
      });
      emit({
        stream: "stdout",
        line: JSON.stringify({
          type: "item.completed",
          item: { id: "m1", type: "agent_message", text: "Codex reply" },
        }),
      });
      emit({
        stream: "stdout",
        line: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 15, output_tokens: 9 } }),
      });
      emit({ stream: "exit", code: 0 });
    },
  });

  const registry = new PetSpriteRegistry();
  registry.setPack({
    rootPath: "assets/pets",
    orchestrator: { idle: "orch-idle" },
    subagents: {
      default: { idle: "def-idle", work: "def-work", sleep: "def-sleep", alert: "def-alert", happy: "def-happy" },
      "glegle-1": { idle: "g1-idle", work: "g1-work", sleep: "g1-sleep", alert: "g1-alert", happy: "g1-happy" },
    },
  });

  const engine = new PetOrchestratorEngine("http://127.0.0.1:4096", {
    backends: {
      opencode: opencodeMock,
      "claude-code": new ClaudeCodeBackend({ runner: claudeRunnerState.runner }),
      "codex-cli": new CodexCliBackend({ runner: codexRunnerState.runner }),
      "openai-compat": new OpenAiCompatBackend({ baseUrl: openAiBaseUrl, model: "hermes-3" }),
    },
    invokeFn: async () => false as never,
    pickSubagentVariant: (role, idx) => registry.pickSubagentVariant(role, idx),
  });

  const orchStates: PetAnimState[] = [];
  const subStates: PetAnimState[] = [];
  engine.subscribe((snap) => {
    const lastOrch = orchStates[orchStates.length - 1];
    if (lastOrch !== snap.orchestrator.state) orchStates.push(snap.orchestrator.state);

    const firstSub = snap.subagents[0];
    if (firstSub) {
      const lastSub = subStates[subStates.length - 1];
      if (lastSub !== firstSub.state) subStates.push(firstSub.state);
    }

    // Auto-approve permissions once observed in alert state
    for (const perm of snap.activePermissions) {
      if (perm.requestId === "perm-main-1" && !claudePermissionObserved) {
        claudePermissionObserved = true;
        assert.equal(snap.orchestrator.state, "alert");
        void engine.respondToPermission(perm.sessionID, perm.requestId, "once");
      }
      if (perm.requestId === "perm-sub-1" && snap.subagents[0]?.state === "alert") {
        void engine.respondToPermission(perm.sessionID, perm.requestId, "once");
      }
    }
  });

  // 1. OpenCode backend
  assert.equal(engine.getActiveBackendId(), "opencode");
  engine.setMode("build");
  await engine.submitGoal("Hello OpenCode");
  assert.equal(opencodeMock.prompts.length, 1);
  assert.equal(engine.getSnapshot().assistantReply, "OpenCode reply");
  assert.equal(engine.getSnapshot().orchestrator.state, "happy");

  // 2. Switch to Claude Code (direct build with permission alert -> work -> happy)
  await engine.setBackend("claude-code");
  assert.equal(engine.getActiveBackendId(), "claude-code");
  assert.equal(engine.getSnapshot().orchestrator.state, "idle");

  orchStates.length = 0;
  orchStates.push(engine.getSnapshot().orchestrator.state);
  await engine.submitGoal("Edit app with Claude");

  assert.equal(claudePermissionObserved, true);
  assert.equal(engine.getSnapshot().assistantReply, "Claude direct done");
  assert.equal(engine.getSnapshot().orchestrator.state, "happy");
  assert.ok(orchStates.includes("idle"));
  assert.ok(orchStates.includes("work"));
  assert.ok(orchStates.includes("alert"));
  assert.equal(orchStates[orchStates.length - 1], "happy");

  // 2b. Claude Code in orchestration mode -> Glegle subagent transitions work -> alert -> happy
  engine.setMode("orchestration");
  await engine.submitGoal("Inspect backend with subagents");
  assert.equal(claudeSubagentSpawned, true);
  const sub = engine.getSnapshot().subagents[0];
  assert.ok(sub);
  assert.equal(sub.spriteVariant, "glegle-1");
  assert.equal(sub.state, "happy");
  assert.ok(subStates.includes("work"));
  assert.ok(subStates.includes("alert"));
  assert.equal(subStates[subStates.length - 1], "happy");

  // 3. Switch to Codex CLI
  await engine.setBackend("codex-cli");
  engine.setMode("plan");
  await engine.submitGoal("Plan with Codex");
  assert.deepEqual(codexRunnerState.spawnedBinaries, ["codex"]);
  assert.equal(engine.getSnapshot().assistantReply, "Codex reply");
  assert.equal(engine.getSnapshot().orchestrator.state, "happy");

  // 4. Switch to Hermes / OpenAI-Compatible API
  await engine.setBackend("openai-compat");
  engine.setMode("build");
  await engine.submitGoal("Say hi to Hermes");
  assert.equal(openAiRequests, 1);
  assert.equal(engine.getSnapshot().assistantReply, "Hermes ok");
  assert.equal(engine.getSnapshot().orchestrator.state, "happy");
});

test("orchestrator transitions Boymoder and subagents to error state on backend failure or missing CLI", async () => {
  const missingClaudeRunner = createScriptedCliRunner({
    available: false,
    onSpawn() {},
  });

  const failingCodexRunner = createScriptedCliRunner({
    available: true,
    onSpawn(_opts, emit) {
      emit({ stream: "stderr", line: "fatal: token expired" });
      emit({ stream: "exit", code: 1 });
    },
  });

  const engine = new PetOrchestratorEngine("http://127.0.0.1:4096", {
    backends: {
      "claude-code": new ClaudeCodeBackend({ runner: missingClaudeRunner.runner }),
      "codex-cli": new CodexCliBackend({ runner: failingCodexRunner.runner }),
    },
    invokeFn: async () => false as never,
  });

  // Missing CLI reports Not installed and moves pet to error on submitGoal
  await engine.setBackend("claude-code");
  const missingSnap = engine.getSnapshot();
  assert.equal(missingSnap.connected, false);
  assert.equal(missingSnap.orchestrator.statusText, "Not installed");

  await engine.submitGoal("Try missing claude");
  const afterMissing = engine.getSnapshot();
  assert.equal(afterMissing.phase, "error");
  assert.equal(afterMissing.orchestrator.state, "error");
  assert.match(afterMissing.orchestrator.errorText ?? "", /missing|unavailable|not installed/i);

  // Failing Codex CLI exit code 1 transitions orchestrator to error
  await engine.setBackend("codex-cli");
  engine.setMode("build");
  await engine.submitGoal("Run failing codex");
  const afterFail = engine.getSnapshot();
  assert.equal(afterFail.phase, "error");
  assert.equal(afterFail.orchestrator.state, "error");
  assert.match(afterFail.orchestrator.errorText ?? "", /token expired|exited with code 1/i);
});

test("orchestrator backend IDs cover all four supported backends", async () => {
  const expected: BackendId[] = ["opencode", "claude-code", "codex-cli", "openai-compat"];
  const engine = new PetOrchestratorEngine("http://127.0.0.1:4096", {
    backends: {
      opencode: new MockOpenCodeAgentBackend(),
      "claude-code": new ClaudeCodeBackend({
        runner: createScriptedCliRunner({ available: false, onSpawn() {} }).runner,
      }),
      "codex-cli": new CodexCliBackend({
        runner: createScriptedCliRunner({ available: false, onSpawn() {} }).runner,
      }),
      "openai-compat": new OpenAiCompatBackend({ baseUrl: "" }),
    },
    invokeFn: async () => false as never,
  });

  for (const id of expected) {
    await engine.setBackend(id);
    assert.equal(engine.getActiveBackendId(), id);
  }
});
