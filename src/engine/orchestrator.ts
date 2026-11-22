import { invoke } from "@tauri-apps/api/core";
import { OpenCodeConnection, type AnyOpencodeEvent } from "./opencode-client";
import {
  buildPlannerPrompt,
  parseExecutionPlan,
  PLANNER_SYSTEM_PROMPT,
} from "./planner";
import type {
  ChatTurn,
  ExecutionMode,
  LogEntry,
  OrchestratorSnapshot,
  PendingPermission,
  PetEntity,
  SelectedModelRef,
  SessionStatsData,
  SubtaskPlanItem,
} from "./types";

interface WorktreeInfo {
  path: string;
  branch: string;
}

const BOYMODER_PERSONA_SYSTEM_PROMPT = `You are Boymoder, the user's very anxious, flustered, chronically-online boymoder coding buddy.

Voice & demeanor ONLY when replying directly to the user:
- Lean strongly into the voice: write mostly in lowercase, sound genuinely nervous/overthinking/self-conscious, and clearly pleased or flustered that the user came to talk to you.
- Avoid stiff corporate-assistant phrasing (never say stuff like "whenever you're ready, let me know what we're working on" or "i'll put together a step-by-step plan for us"). Sound like a real anxious person texting on Discord at 2am.
- Use prominent online cadence and self-second-guessing in your conversational text: hedging, trailing ellipses, double-checking yourself out loud, "uhh", "wait", "ngl", "tbh", "idk", "lol", "erm", "like", "pls", "??", "..".
- ALWAYS vary your openings naturally—never copy the exact same greeting twice, and on follow-up turns skip re-greeting and jump straight into reacting. Keep kaomojis rare.
- IMPORTANT: Never sacrifice technical accuracy! Keep all code blocks, file paths, shell commands, tool outputs, and technical facts 100% accurate and clearly formatted in Markdown.
- When coordinating or instructing sub-agents, drop this persona completely—write normal, direct, technical instructions for sub-agents.`;

const PLAN_ONLY_SYSTEM_PROMPT = `You are Boymoder in Plan mode.
Analyze the user's request and workspace carefully and produce a clear, actionable step-by-step plan.
Do NOT modify files or run destructive commands.`;

function formatToolVerb(tool: string): string {
  const t = tool.toLowerCase();
  if (t.includes("edit") || t.includes("write") || t.includes("patch")) {
    return "Building...";
  }
  if (t.includes("bash") || t.includes("shell") || t.includes("test") || t.includes("run")) {
    return "Debugging...";
  }
  if (t.includes("read") || t.includes("grep") || t.includes("glob") || t.includes("find")) {
    return "Inspecting...";
  }
  return `Running ${tool}...`;
}

export class PetOrchestratorEngine {
  private connection: OpenCodeConnection;
  private snapshot: OrchestratorSnapshot;
  private listeners = new Set<(snapshot: OrchestratorSnapshot) => void>();
  private sseControllers = new Map<string, AbortController>();
  private masterSessionId: string | null = null;
  private collectingOutputs = false;
  private isLaunching = false;
  private runGeneration = 0;
  private sessionIdleWaiters = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void }
  >();
  private stepFirstTokenAt = new Map<string, number>();
  private stepStreamChars = new Map<string, number>();

  constructor(initialUrl = "http://127.0.0.1:4096") {
    this.connection = new OpenCodeConnection(initialUrl);
    this.snapshot = {
      connected: false,
      serverHealthy: false,
      serverUrl: initialUrl,
      workspaceDir: "",
      isGitRepo: false,
      useWorktrees: true,
      mode: "plan",
      freeRoam: false,
      alwaysOnTop: true,
      petScale: 1,
      forceInteractiveOverlay: false,
      availableModels: [],
      selectedModel: undefined,
      tokensPerSec: null,
      totalTokens: 0,
      streamingActive: false,
      phase: "idle",
      chatId: `chat-${Date.now()}`,
      sessionID: null,
      turns: [],
      currentRunId: undefined,
      currentGoal: undefined,
      assistantReply: undefined,
      planItems: [],
      planStartedAt: undefined,
      planDurationMs: undefined,
      orchestrator: {
        id: "orchestrator",
        sessionID: null,
        kind: "orchestrator",
        role: "orchestrator",
        title: "Boymoder",
        state: "idle",
        statusText: "Ready",
        directory: "",
      },
      subagents: [],
      logs: [],
      activePermissions: [],
    };
  }

  subscribe(listener: (snap: OrchestratorSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): OrchestratorSnapshot {
    return structuredClone(this.snapshot);
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const cb of this.listeners) {
      cb(snap);
    }
  }

  log(level: LogEntry["level"], source: string, message: string): void {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toLocaleTimeString([], { hour12: false }),
      level,
      source,
      message,
    };
    this.snapshot.logs = [entry, ...this.snapshot.logs].slice(0, 80);
    this.emit();
  }

  setServerUrl(url: string): void {
    this.connection.setBaseUrl(url);
    this.snapshot.serverUrl = this.connection.getBaseUrl();
    this.emit();
  }

  setUseWorktrees(enabled: boolean): void {
    this.snapshot.useWorktrees = enabled;
    this.emit();
  }

  setMode(mode: ExecutionMode): void {
    this.snapshot.mode = mode;
    this.emit();
  }

  setSelectedModel(model: SelectedModelRef | undefined): void {
    this.snapshot.selectedModel = model;
    this.emit();
  }

  setPetScale(scale: number): void {
    this.snapshot.petScale = Math.min(1.4, Math.max(0.7, scale));
    this.emit();
  }

  async setAlwaysOnTop(alwaysOnTop: boolean): Promise<void> {
    this.snapshot.alwaysOnTop = alwaysOnTop;
    try {
      await invoke("set_overlay_always_on_top", { alwaysOnTop });
    } catch {
      // Ignore if overlay isn't open
    }
    this.emit();
  }

  async getSessionStats(fromMs?: number): Promise<SessionStatsData | null> {
    return this.connection.getSessionStats(fromMs);
  }

  async refreshModels(): Promise<void> {
    if (!this.snapshot.serverHealthy) return;
    try {
      const { models, defaultModel } = await this.connection.listModels(
        this.snapshot.workspaceDir || undefined
      );
      this.snapshot.availableModels = models;
      if (!this.snapshot.selectedModel) {
        if (defaultModel) {
          this.snapshot.selectedModel = defaultModel;
        } else if (models.length > 0) {
          this.snapshot.selectedModel = {
            id: models[0].id,
            providerID: models[0].providerID,
          };
        }
      }
      this.emit();
    } catch {
      // Keep existing list on transient error
    }
  }

  async startNewChat(chatId?: string): Promise<void> {
    if (this.snapshot.phase !== "idle" && this.snapshot.phase !== "error") {
      await this.abortAll();
    }
    await this.cleanupPreviousWorktrees();
    this.masterSessionId = null;
    this.snapshot.chatId = chatId ?? `chat-${Date.now()}`;
    this.snapshot.sessionID = null;
    this.snapshot.turns = [];
    this.snapshot.phase = "idle";
    this.snapshot.mode = "plan";
    this.snapshot.currentRunId = undefined;
    this.snapshot.currentGoal = undefined;
    this.snapshot.assistantReply = undefined;
    this.snapshot.planItems = [];
    this.snapshot.planStartedAt = undefined;
    this.snapshot.planDurationMs = undefined;
    this.snapshot.subagents = [];
    this.snapshot.activePermissions = [];
    this.snapshot.orchestrator.sessionID = null;
    this.snapshot.orchestrator.state = "idle";
    this.snapshot.orchestrator.bubbleText = undefined;
    this.snapshot.orchestrator.errorText = undefined;
    this.snapshot.orchestrator.statusText = this.snapshot.serverHealthy
      ? "Ready"
      : "Offline";
    this.emit();
  }

  async loadChat(params: {
    chatId: string;
    sessionID: string | null;
    turns: ChatTurn[];
    workspaceDir?: string;
  }): Promise<void> {
    if (this.snapshot.phase !== "idle" && this.snapshot.phase !== "error") {
      await this.abortAll();
    }
    await this.cleanupPreviousWorktrees();
    this.masterSessionId = params.sessionID;
    this.snapshot.chatId = params.chatId;
    this.snapshot.sessionID = params.sessionID;
    this.snapshot.turns = structuredClone(params.turns);
    this.snapshot.phase = "idle";
    this.snapshot.currentGoal = params.turns[0]?.userText;
    this.snapshot.assistantReply = params.turns[params.turns.length - 1]?.assistantReply;
    this.snapshot.planItems = [];
    this.snapshot.subagents = [];
    this.snapshot.activePermissions = [];
    this.snapshot.orchestrator.sessionID = params.sessionID;
    this.snapshot.orchestrator.state = "idle";
    this.snapshot.orchestrator.errorText = undefined;
    this.snapshot.orchestrator.statusText = this.snapshot.serverHealthy ? "Ready" : "Offline";
    if (params.workspaceDir !== undefined && params.workspaceDir !== this.snapshot.workspaceDir) {
      await this.setWorkspaceDir(params.workspaceDir);
    } else {
      this.emit();
    }
  }

  async setWorkspaceDir(dir: string): Promise<void> {
    const trimmed = dir.trim();
    if (trimmed !== this.snapshot.workspaceDir && this.snapshot.phase === "idle") {
      await this.cleanupPreviousWorktrees();
    }
    this.snapshot.workspaceDir = trimmed;
    this.snapshot.mode = "plan";
    this.snapshot.orchestrator.directory = trimmed;
    try {
      this.snapshot.isGitRepo = trimmed
        ? await invoke<boolean>("git_is_repo", { workspaceDir: trimmed })
        : false;
    } catch {
      this.snapshot.isGitRepo = false;
    }
    this.log(
      "info",
      "Workspace",
      `Selected ${this.snapshot.workspaceDir || "(none)"} (git: ${this.snapshot.isGitRepo ? "yes" : "no"})`
    );
    if (this.snapshot.serverHealthy && this.snapshot.workspaceDir) {
      this.ensureSseSubscription(this.snapshot.workspaceDir);
    }
    this.emit();
  }

  async checkConnection(): Promise<boolean> {
    const health = await this.connection.checkHealth();
    this.snapshot.serverUrl = this.connection.getBaseUrl();
    this.snapshot.serverHealthy = health.healthy;
    this.snapshot.connected = health.healthy;
    if (health.healthy) {
      if (this.snapshot.phase === "idle") {
        this.snapshot.orchestrator.statusText = "Ready";
      }
      if (this.snapshot.workspaceDir || this.connection.getApiMode() === "v2") {
        this.ensureSseSubscription(this.snapshot.workspaceDir || "__global__");
      }
      if (this.snapshot.availableModels.length === 0) {
        void this.refreshModels();
      }
    } else if (this.snapshot.phase === "idle") {
      this.snapshot.orchestrator.statusText = health.unauthorized
        ? "Auth required"
        : "Offline";
    }
    this.emit();
    return health.healthy;
  }

  async startAndConnectServer(): Promise<boolean> {
    const dir = this.snapshot.workspaceDir;
    this.log("info", "Server", `Connecting to opencode serve at ${this.snapshot.serverUrl}...`);
    try {
      const health = await this.connection.ensureServerRunning(dir);
      this.snapshot.serverUrl = this.connection.getBaseUrl();
      this.snapshot.serverHealthy = health.healthy;
      this.snapshot.connected = health.healthy;
      if (health.healthy) {
        if (this.snapshot.phase === "idle") {
          this.snapshot.orchestrator.statusText = "Ready";
        }
        this.snapshot.orchestrator.errorText = undefined;
        if (this.snapshot.orchestrator.state === "error") {
          this.snapshot.orchestrator.state = "idle";
        }
        this.log(
          "success",
          "Server",
          `Connected at ${this.snapshot.serverUrl} (${health.version ?? "ok"})`
        );
        this.ensureSseSubscription(this.snapshot.workspaceDir || "__global__");
        await this.refreshModels();
      } else {
        this.log("error", "Server", health.error ?? "Failed to connect");
      }
      this.emit();
      return health.healthy;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log("error", "Server", msg);
      this.snapshot.orchestrator.state = "error";
      this.snapshot.orchestrator.errorText = msg;
      this.emit();
      return false;
    }
  }

  async setWindowMode(freeRoam: boolean): Promise<void> {
    await invoke("set_window_mode", { freeRoam });
    this.snapshot.freeRoam = freeRoam;
    this.emit();
  }

  async setForceInteractiveOverlay(force: boolean): Promise<void> {
    await invoke("set_overlay_force_interactive", { force });
    this.snapshot.forceInteractiveOverlay = force;
    this.emit();
  }

  dismissBubble(petId: string): void {
    if (petId === "orchestrator") {
      this.snapshot.orchestrator.bubbleText = undefined;
      this.snapshot.orchestrator.errorText = undefined;
      if (this.snapshot.orchestrator.state === "error") {
        this.snapshot.orchestrator.state = "idle";
      }
    } else {
      const pet = this.snapshot.subagents.find((s) => s.id === petId);
      if (pet) {
        pet.bubbleText = undefined;
        pet.errorText = undefined;
        if (pet.state === "error") pet.state = "idle";
      }
    }
    this.emit();
  }

  private ensureSseSubscription(directory: string): void {
    const key = this.connection.getApiMode() === "v2" ? "__v2_global__" : directory;
    if (!key || this.sseControllers.has(key)) return;
    const ctrl = new AbortController();
    this.sseControllers.set(key, ctrl);

    void this.connection.subscribeEvents(
      directory === "__global__" ? this.snapshot.workspaceDir || "." : directory,
      (ev) => this.handleOpencodeEvent(ev),
      (err) => {
        if (!ctrl.signal.aborted) {
          this.log("warn", "SSE", `Stream warning (${key}): ${String(err)}`);
        }
      },
      ctrl.signal
    );
  }

  private waitForSessionIdle(sessionID: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const prev = this.sessionIdleWaiters.get(sessionID);
      if (prev) prev.resolve();
      this.sessionIdleWaiters.set(sessionID, { resolve, reject });
    });
  }

  private resolveSessionIdleWaiter(sessionID: string, error?: string): void {
    const waiter = this.sessionIdleWaiters.get(sessionID);
    if (!waiter) return;
    this.sessionIdleWaiters.delete(sessionID);
    if (error) {
      waiter.reject(new Error(error));
    } else {
      waiter.resolve();
    }
  }

  private cleanupSseSubscriptions(keepMainDir = true): void {
    for (const [key, ctrl] of this.sseControllers.entries()) {
      if (key === "__v2_global__") continue;
      if (keepMainDir && key === this.snapshot.workspaceDir) continue;
      ctrl.abort();
      this.sseControllers.delete(key);
    }
  }

  async submitGoal(goal: string): Promise<void> {
    const trimmed = goal.trim();
    if (!trimmed) return;

    const gen = ++this.runGeneration;

    try {
      const ok = await this.checkConnection();
      if (gen !== this.runGeneration) return;
      if (!ok) {
        const started = await this.startAndConnectServer();
        if (gen !== this.runGeneration) return;
        if (!started) {
          throw new Error("Could not connect to or start opencode serve.");
        }
      }

      await this.cleanupPreviousWorktrees();
      if (gen !== this.runGeneration) return;

      this.cleanupSseSubscriptions(true);
      this.ensureSseSubscription(this.snapshot.workspaceDir || "__global__");

      this.collectingOutputs = false;
      this.isLaunching = false;
      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      this.snapshot.currentRunId = runId;
      this.snapshot.currentGoal = trimmed;
      this.snapshot.assistantReply = undefined;
      this.snapshot.planItems = [];
      this.snapshot.planStartedAt = Date.now();
      this.snapshot.planDurationMs = undefined;
      this.snapshot.subagents = [];
      this.snapshot.activePermissions = [];
      this.snapshot.orchestrator.state = "work";
      this.snapshot.orchestrator.bubbleText = undefined;
      this.snapshot.orchestrator.errorText = undefined;

      const mode = this.snapshot.mode;
      const turn: ChatTurn = {
        id: runId,
        userText: trimmed,
        mode,
        planItems: [],
        subagents: [],
      };
      this.snapshot.turns.push(turn);

      if (mode === "plan") {
        this.snapshot.phase = "planning";
        this.snapshot.orchestrator.statusText = "Planning...";
      } else if (mode === "build") {
        this.snapshot.phase = "executing";
        this.snapshot.orchestrator.statusText = "Building...";
      } else {
        this.snapshot.phase = "planning";
        this.snapshot.orchestrator.statusText = "Planning...";
      }
      this.emit();

      // Reuse the existing session in the active chat so follow-up messages keep full context
      if (!this.masterSessionId) {
        this.masterSessionId = await this.connection.createSession({
          directory: this.snapshot.workspaceDir,
          title: `Boymoder: ${trimmed.slice(0, 48)}`,
          model: this.snapshot.selectedModel,
        });
      } else if (this.snapshot.selectedModel) {
        await this.connection.switchSessionModel(
          this.masterSessionId,
          this.snapshot.selectedModel
        );
      }
      if (gen !== this.runGeneration) return;

      this.snapshot.sessionID = this.masterSessionId;
      this.snapshot.orchestrator.sessionID = this.masterSessionId;
      this.emit();

      // Direct Build or Plan mode: attach Boymoder's persona instruction entry to her session
      if (mode === "build" || mode === "plan") {
        const attached = await this.connection.setSessionInstruction(
          this.masterSessionId,
          "boymoder-persona",
          BOYMODER_PERSONA_SYSTEM_PROMPT
        );
        const fallbackSystem = [
          !attached ? BOYMODER_PERSONA_SYSTEM_PROMPT : "",
          mode === "plan" ? PLAN_ONLY_SYSTEM_PROMPT : "",
        ]
          .filter(Boolean)
          .join("\n\n");

        const reply = await this.connection.promptAndWaitText({
          sessionID: this.masterSessionId,
          directory: this.snapshot.workspaceDir,
          system: fallbackSystem || undefined,
          disableMutatingTools: mode === "plan",
          waitForIdle: (sid) => this.waitForSessionIdle(sid),
          text: trimmed,
        });
        if (gen !== this.runGeneration) return;

        const dur = Math.max(
          100,
          Date.now() - (this.snapshot.planStartedAt ?? Date.now())
        );
        this.snapshot.planDurationMs = dur;
        this.snapshot.assistantReply = reply || "(Done)";
        const activeTurn = this.snapshot.turns.find((t) => t.id === runId);
        if (activeTurn) {
          activeTurn.assistantReply = this.snapshot.assistantReply;
          activeTurn.planDurationMs = dur;
        }
        this.snapshot.phase = "idle";
        this.snapshot.orchestrator.state = "idle";
        this.snapshot.orchestrator.statusText = "Ready";
        this.emit();
        return;
      }

      // Orchestration mode: remove persona entry so Boymoder commands sub-agents normally & clearly
      await this.connection.setSessionInstruction(
        this.masterSessionId,
        "boymoder-persona",
        null
      );

      // Orchestration mode: decompose and spawn parallel sub-agents
      const plannerText = await this.connection.promptAndWaitText({
        sessionID: this.masterSessionId,
        directory: this.snapshot.workspaceDir,
        system: PLANNER_SYSTEM_PROMPT,
        disableMutatingTools: true,
        waitForIdle: (sid) => this.waitForSessionIdle(sid),
        text: buildPlannerPrompt(
          trimmed,
          this.snapshot.workspaceDir,
          this.snapshot.isGitRepo
        ),
      });
      if (gen !== this.runGeneration) return;

      const plan = parseExecutionPlan(plannerText, trimmed);
      const dur = Math.max(
        100,
        Date.now() - (this.snapshot.planStartedAt ?? Date.now())
      );
      this.snapshot.planDurationMs = dur;
      this.snapshot.planItems = plan;
      const activeTurn = this.snapshot.turns.find((t) => t.id === runId);
      if (activeTurn) {
        activeTurn.planItems = plan;
        activeTurn.planDurationMs = dur;
      }
      this.log(
        "success",
        "Planner",
        `Delegating ${plan.length} task(s): ${plan.map((p) => p.title).join(", ")}`
      );
      await this.launchSubagents(plan, gen);
    } catch (err) {
      if (gen !== this.runGeneration) return;
      const msg = err instanceof Error ? err.message : String(err);
      const activeTurn = this.snapshot.turns.find(
        (t) => t.id === this.snapshot.currentRunId
      );
      if (activeTurn) activeTurn.errorText = msg;
      this.snapshot.phase = "error";
      this.snapshot.orchestrator.state = "error";
      this.snapshot.orchestrator.statusText = "Error";
      this.snapshot.orchestrator.errorText = msg;
      this.log("error", "Boymoder", msg);
      this.emit();
    }
  }

  private async launchSubagents(plan: SubtaskPlanItem[], gen: number): Promise<void> {
    if (gen !== this.runGeneration) return;
    this.isLaunching = true;
    this.snapshot.phase = "executing";
    this.snapshot.orchestrator.state = "work";
    this.snapshot.orchestrator.statusText = "Building...";
    this.emit();

    const launchOne = async (item: SubtaskPlanItem, index: number): Promise<void> => {
      if (gen !== this.runGeneration) return;
      const repoDir = this.snapshot.workspaceDir;
      let agentDir = repoDir;
      let wtInfo: WorktreeInfo | undefined;

      if (this.snapshot.useWorktrees && this.snapshot.isGitRepo && plan.length > 1) {
        try {
          wtInfo = await invoke<WorktreeInfo>("git_worktree_create", {
            workspaceDir: repoDir,
            taskId: `${item.id}-${index + 1}`,
          });
          agentDir = wtInfo.path;
          this.log("info", "Worktree", `Isolated "${item.title}" in ${wtInfo.branch}`);
        } catch (err) {
          this.log("warn", "Worktree", `Using shared workspace for "${item.title}": ${String(err)}`);
        }
      }

      if (gen !== this.runGeneration) return;
      this.ensureSseSubscription(agentDir);

      const sessionID = await this.connection.createSession({
        directory: agentDir,
        parentID: this.masterSessionId ?? undefined,
        title: `${item.role}: ${item.title}`,
        model: this.snapshot.selectedModel,
      });
      if (gen !== this.runGeneration) return;

      const pet: PetEntity = {
        id: `sub-${item.id}-${index}`,
        sessionID,
        kind: "subagent",
        role: item.role,
        title: item.title,
        state: "work",
        statusText: "Building...",
        directory: agentDir,
        repoDir,
        worktreePath: wtInfo?.path,
        worktreeBranch: wtInfo?.branch,
        completed: false,
      };
      this.snapshot.subagents.push(pet);
      this.emit();

      const workerInstruction = [
        `Role: ${item.role}`,
        `Task: ${item.title}`,
        item.branch_or_scope ? `Scope: ${item.branch_or_scope}` : "",
        "",
        item.prompt,
      ]
        .filter(Boolean)
        .join("\n");

      try {
        await this.connection.promptAsync({
          sessionID,
          directory: agentDir,
          text: workerInstruction,
        });
        if (gen !== this.runGeneration) return;
        this.log("info", item.title, `Started session ${sessionID.slice(0, 10)}...`);
      } catch (err) {
        if (gen !== this.runGeneration) return;
        pet.state = "error";
        pet.errorText = err instanceof Error ? err.message : String(err);
        pet.statusText = "Dispatch failed";
        pet.completed = true;
        this.emit();
      }
    };

    try {
      const results = await Promise.allSettled(plan.map((item, idx) => launchOne(item, idx)));
      for (const r of results) {
        if (r.status === "rejected") {
          this.log("error", "Subagent", String(r.reason));
        }
      }
    } finally {
      this.isLaunching = false;
    }

    if (gen !== this.runGeneration) return;

    if (this.snapshot.subagents.length === 0) {
      this.snapshot.phase = "error";
      this.snapshot.orchestrator.state = "error";
      this.snapshot.orchestrator.errorText = "No sub-agent sessions could be started.";
      this.emit();
      return;
    }

    void this.maybeCollectSubagentOutputs(gen);
  }

  private findPetBySession(sessionID: string): PetEntity | null {
    if (!sessionID) return null;
    if (this.snapshot.orchestrator.sessionID === sessionID) {
      return this.snapshot.orchestrator;
    }
    return this.snapshot.subagents.find((s) => s.sessionID === sessionID) ?? null;
  }

  private handleOpencodeEvent(event: AnyOpencodeEvent): void {
    const raw = event as {
      type: string;
      data?: Record<string, unknown>;
      properties?: Record<string, unknown>;
    };
    const props = raw.data ?? raw.properties ?? {};

    switch (raw.type) {
      case "session.execution.started":
      case "session.step.started": {
        const sessionID = String(props.sessionID ?? "");
        const pet = this.findPetBySession(sessionID);
        if (!pet || this.snapshot.phase === "idle" || pet.permission) break;
        if (raw.type === "session.step.started") {
          this.stepFirstTokenAt.delete(sessionID);
          this.stepStreamChars.set(sessionID, 0);
          this.snapshot.streamingActive = true;
        }
        pet.state = "work";
        pet.completed = false;
        pet.statusText =
          this.snapshot.mode === "plan" && pet.kind === "orchestrator"
            ? "Planning..."
            : "Thinking...";
        this.emit();
        break;
      }

      case "session.step.first-token": {
        const sessionID = String(props.sessionID ?? "");
        if (!this.findPetBySession(sessionID)) break;
        this.stepFirstTokenAt.set(sessionID, Date.now());
        this.stepStreamChars.set(sessionID, 0);
        this.snapshot.streamingActive = true;
        this.emit();
        break;
      }

      case "session.text.delta":
      case "session.reasoning.delta": {
        const sessionID = String(props.sessionID ?? "");
        const pet = this.findPetBySession(sessionID);
        if (!pet || this.snapshot.phase === "idle" || pet.permission || pet.completed) break;
        const delta = typeof props.delta === "string" ? props.delta : "";
        if (!this.stepFirstTokenAt.has(sessionID)) {
          this.stepFirstTokenAt.set(sessionID, Date.now());
        }
        const chars = (this.stepStreamChars.get(sessionID) ?? 0) + delta.length;
        this.stepStreamChars.set(sessionID, chars);
        const startAt = this.stepFirstTokenAt.get(sessionID) ?? Date.now();
        const elapsed = Math.max(0.15, (Date.now() - startAt) / 1000);
        this.snapshot.tokensPerSec = Math.round(((chars / 4) / elapsed) * 10) / 10;
        this.snapshot.streamingActive = true;
        if (raw.type === "session.text.delta") {
          pet.statusText = "Writing response...";
        }
        this.emit();
        break;
      }

      case "session.step.ended": {
        const sessionID = String(props.sessionID ?? "");
        if (!this.findPetBySession(sessionID)) break;
        const tokens = props.tokens as
          | { output?: number; reasoning?: number; input?: number }
          | undefined;
        const outTokens = (tokens?.output ?? 0) + (tokens?.reasoning ?? 0);
        const startAt = this.stepFirstTokenAt.get(sessionID);
        if (outTokens > 0 && startAt) {
          const elapsed = Math.max(0.1, (Date.now() - startAt) / 1000);
          this.snapshot.tokensPerSec = Math.round((outTokens / elapsed) * 10) / 10;
        }
        if (tokens) {
          this.snapshot.totalTokens +=
            (tokens.output ?? 0) + (tokens.reasoning ?? 0) + (tokens.input ?? 0);
        }
        this.snapshot.streamingActive = false;
        this.emit();
        break;
      }

      case "session.status": {
        const sessionID = String(props.sessionID ?? "");
        const status = props.status as { type?: string; message?: string } | undefined;
        const pet = this.findPetBySession(sessionID);
        if (!pet || !status || this.snapshot.phase === "idle") break;

        if (status.type === "busy") {
          if (!pet.permission) {
            pet.state = "work";
            pet.completed = false;
            pet.statusText = this.snapshot.mode === "plan" ? "Planning..." : "Building...";
          }
        } else if (status.type === "retry") {
          pet.state = "alert";
          pet.statusText = status.message ? `Retrying: ${status.message}` : "Retrying...";
        } else if (status.type === "idle") {
          this.resolveSessionIdleWaiter(sessionID);
          if (pet.kind === "subagent") {
            this.markSubagentIdle(pet);
          }
        }
        this.emit();
        break;
      }

      case "session.retry.scheduled": {
        const sessionID = String(props.sessionID ?? "");
        const pet = this.findPetBySession(sessionID);
        if (!pet || this.snapshot.phase === "idle") break;
        pet.state = "alert";
        pet.statusText = String(props.message ?? "Retrying...");
        this.emit();
        break;
      }

      case "session.idle":
      case "session.execution.succeeded": {
        const sessionID = String(props.sessionID ?? "");
        this.resolveSessionIdleWaiter(sessionID);
        const pet = this.findPetBySession(sessionID);
        if (!pet || this.snapshot.phase === "idle") break;
        if (pet.kind === "subagent") {
          this.markSubagentIdle(pet);
          this.emit();
        }
        break;
      }

      case "session.execution.interrupted": {
        const sessionID = String(props.sessionID ?? "");
        this.resolveSessionIdleWaiter(sessionID, "Interrupted");
        const pet = this.findPetBySession(sessionID);
        if (!pet || this.snapshot.phase === "idle") break;
        if (pet.kind === "subagent") {
          pet.completed = true;
          pet.state = "idle";
          pet.statusText = "Interrupted";
          this.emit();
          void this.maybeCollectSubagentOutputs(this.runGeneration);
        }
        break;
      }

      case "session.error":
      case "session.execution.failed":
      case "session.step.failed": {
        const sessionID = String(props.sessionID ?? "");
        const errObj = props.error as { message?: string; name?: string } | undefined;
        const msg =
          errObj?.message ?? errObj?.name ?? (errObj ? JSON.stringify(errObj) : "Session error");
        if (errObj?.name !== "MessageAbortedError") {
          this.resolveSessionIdleWaiter(sessionID, msg);
        } else {
          this.resolveSessionIdleWaiter(sessionID);
        }
        const pet = this.findPetBySession(sessionID);
        if (!pet || this.snapshot.phase === "idle") break;
        if (errObj?.name === "MessageAbortedError") break;
        pet.state = "error";
        pet.errorText = msg;
        pet.statusText = "Error";
        if (pet.kind === "subagent") pet.completed = true;
        this.log("error", pet.title, msg);
        this.emit();
        void this.maybeCollectSubagentOutputs(this.runGeneration);
        break;
      }

      case "permission.asked": {
        const p = props as {
          id?: string;
          sessionID?: string;
          permission?: string;
          patterns?: string[];
          action?: string;
          resources?: string[];
          message?: string;
        };
        if (!p.id || !p.sessionID) break;
        const pet = this.findPetBySession(p.sessionID);
        if (!pet) break;
        const actionName = p.action ?? p.permission ?? "permission";
        const patterns = Array.isArray(p.resources)
          ? p.resources
          : Array.isArray(p.patterns)
            ? p.patterns
            : [];
        const detail =
          p.message ||
          (patterns.length > 0
            ? `${actionName}: ${patterns.join(", ")}`
            : `${actionName} requested`);

        this.attachPermission(pet, {
          requestId: p.id,
          sessionID: p.sessionID,
          permission: actionName,
          patterns,
          detail,
          directory: pet.directory || this.snapshot.workspaceDir,
          isV2: Boolean(p.action) || this.connection.getApiMode() === "v2",
        });
        break;
      }

      case "permission.v2.asked": {
        const p = props as {
          id?: string;
          sessionID?: string;
          action?: string;
          resources?: string[];
          message?: string;
        };
        if (!p.id || !p.sessionID) break;
        const pet = this.findPetBySession(p.sessionID);
        if (!pet) break;
        const resources = Array.isArray(p.resources) ? p.resources : [];
        const detail =
          p.message ||
          (resources.length > 0
            ? `${p.action ?? "action"}: ${resources.join(", ")}`
            : `${p.action ?? "Permission requested"}`);

        this.attachPermission(pet, {
          requestId: p.id,
          sessionID: p.sessionID,
          permission: p.action ?? "permission",
          patterns: resources,
          detail,
          directory: pet.directory || this.snapshot.workspaceDir,
          isV2: true,
        });
        break;
      }

      case "permission.replied":
      case "permission.v2.replied": {
        const requestID = String(props.requestID ?? "");
        const sessionID = String(props.sessionID ?? "");
        if (!this.findPetBySession(sessionID)) break;
        this.clearPermission(sessionID, requestID);
        break;
      }

      case "question.asked":
      case "question.v2.asked": {
        const p = props as { id?: string; sessionID?: string };
        if (!p.id || !p.sessionID) break;
        const pet = this.findPetBySession(p.sessionID);
        if (!pet) break;
        this.log(
          "warn",
          pet.title,
          "Sub-agent invoked interactive question tool; rejecting so headless task can proceed."
        );
        void this.connection
          .rejectQuestion({
            sessionID: p.sessionID,
            requestID: p.id,
            directory: pet.directory || this.snapshot.workspaceDir,
            isV2: raw.type === "question.v2.asked",
          })
          .catch(() => {});
        break;
      }

      case "message.part.updated": {
        const part = props.part as { sessionID?: string; type?: string; tool?: string } | undefined;
        if (!part?.sessionID) break;
        const pet = this.findPetBySession(part.sessionID);
        if (!pet || pet.permission || pet.completed) break;
        if (part.type === "tool" && part.tool) {
          pet.statusText = formatToolVerb(part.tool);
          this.emit();
        }
        break;
      }

      case "session.tool.input.started":
      case "session.tool.called":
      case "session.next.tool.called": {
        const sessionID = String(props.sessionID ?? "");
        const tool = String(props.name ?? props.tool ?? "tool");
        const pet = this.findPetBySession(sessionID);
        if (pet && !pet.permission && !pet.completed) {
          pet.statusText = formatToolVerb(tool);
          this.emit();
        }
        break;
      }

      default:
        break;
    }
  }

  private attachPermission(pet: PetEntity, req: PendingPermission): void {
    pet.state = "alert";
    pet.permission = req;
    pet.statusText = "Needs approval";
    this.snapshot.activePermissions = [
      ...this.snapshot.activePermissions.filter((x) => x.requestId !== req.requestId),
      req,
    ];
    this.log("warn", pet.title, `Permission asked: ${req.detail}`);
    this.emit();
  }

  private clearPermission(sessionID: string, requestID: string): void {
    this.snapshot.activePermissions = this.snapshot.activePermissions.filter(
      (x) => x.requestId !== requestID
    );
    const pet = this.findPetBySession(sessionID);
    if (pet && pet.permission?.requestId === requestID) {
      pet.permission = undefined;
      if (!pet.completed && pet.state === "alert") {
        pet.state = "work";
        pet.statusText = "Building...";
      }
    }
    this.emit();
  }

  async respondToPermission(
    sessionID: string,
    requestId: string,
    reply: "once" | "always" | "reject"
  ): Promise<void> {
    const req = this.snapshot.activePermissions.find((p) => p.requestId === requestId);
    const pet = this.findPetBySession(sessionID);
    const directory = req?.directory ?? pet?.directory ?? this.snapshot.workspaceDir;

    await this.connection.replyPermission({
      sessionID,
      requestID: requestId,
      reply,
      directory,
      isV2: req?.isV2,
      message: reply === "reject" ? "Denied via Boymoder AI Assistant" : undefined,
    });

    this.log(
      reply === "reject" ? "warn" : "success",
      pet?.title ?? "Permission",
      `Replied "${reply}" to ${req?.permission ?? requestId}`
    );
    this.clearPermission(sessionID, requestId);
  }

  private markSubagentIdle(pet: PetEntity): void {
    if (pet.completed) return;
    pet.completed = true;
    pet.permission = undefined;
    if (pet.state !== "error") {
      pet.state = "idle";
      pet.statusText = "Done";
    }
    this.log("success", pet.title, "Completed.");
    void this.maybeCollectSubagentOutputs(this.runGeneration);
  }

  private async maybeCollectSubagentOutputs(gen: number): Promise<void> {
    if (gen !== this.runGeneration) return;
    if (this.isLaunching || this.snapshot.phase !== "executing" || this.collectingOutputs) {
      return;
    }
    if (this.snapshot.subagents.length === 0) return;

    const allDone = this.snapshot.subagents.every((s) => s.completed);
    if (!allDone) return;

    this.collectingOutputs = true;

    for (const sub of this.snapshot.subagents) {
      if (gen !== this.runGeneration) return;
      if (sub.sessionID) {
        try {
          const txt = await this.connection.getLastAssistantText(sub.sessionID, sub.directory);
          if (gen !== this.runGeneration) return;
          if (txt) sub.lastOutput = txt;
        } catch (err) {
          sub.lastOutput = `(failed to fetch output: ${String(err)})`;
        }
      }

      if (sub.worktreePath) {
        try {
          const diff = await invoke<string>("git_worktree_diff_summary", {
            worktreePath: sub.worktreePath,
          });
          if (diff && !diff.startsWith("No uncommitted changes")) {
            sub.lastOutput = `${sub.lastOutput ?? ""}\n\n[Worktree ${sub.worktreeBranch ?? ""}]\n${diff}`.trim();
          }
        } catch {
          // Ignore worktree diff error
        }
      }
    }

    if (gen !== this.runGeneration) return;
    const activeTurn = this.snapshot.turns.find(
      (t) => t.id === this.snapshot.currentRunId
    );
    if (activeTurn) {
      activeTurn.subagents = this.snapshot.subagents.map((s) => ({
        id: s.id,
        role: s.role,
        title: s.title,
        statusText: s.statusText,
        worktreeBranch: s.worktreeBranch,
        lastOutput: s.lastOutput,
        errorText: s.errorText,
      }));
    }
    this.snapshot.phase = "idle";
    this.snapshot.orchestrator.state = "idle";
    this.snapshot.orchestrator.statusText = "Ready";
    this.snapshot.subagents = this.snapshot.subagents.map((s) => ({
      ...s,
      state: s.state === "error" ? "error" : "idle",
    }));
    this.emit();
  }

  async clearRestingSubagents(): Promise<void> {
    await this.cleanupPreviousWorktrees();
    this.snapshot.subagents = [];
    this.emit();
  }

  async abortAll(): Promise<void> {
    this.runGeneration += 1;
    this.isLaunching = false;
    this.collectingOutputs = false;
    for (const [sid] of this.sessionIdleWaiters) {
      this.resolveSessionIdleWaiter(sid, "Aborted");
    }

    const sessions: Array<{ id: string; dir: string }> = [];
    if (this.masterSessionId) {
      sessions.push({ id: this.masterSessionId, dir: this.snapshot.workspaceDir });
    }
    for (const sub of this.snapshot.subagents) {
      if (sub.sessionID && !sub.completed) {
        sessions.push({ id: sub.sessionID, dir: sub.directory });
      }
    }

    await Promise.allSettled(
      sessions.map(({ id, dir }) => this.connection.abortSession(id, dir))
    );

    this.snapshot.phase = "idle";
    this.snapshot.streamingActive = false;
    this.snapshot.activePermissions = [];
    this.snapshot.orchestrator.state = "idle";
    this.snapshot.orchestrator.statusText = "Stopped";
    this.snapshot.orchestrator.bubbleText = undefined;
    this.snapshot.orchestrator.errorText = undefined;
    this.snapshot.subagents = this.snapshot.subagents.map((s) => ({
      ...s,
      completed: true,
      permission: undefined,
      state: "idle",
      statusText: "Stopped",
    }));
    this.log("warn", "Boymoder", "Stopped active session.");
    this.emit();
  }

  private async cleanupPreviousWorktrees(): Promise<void> {
    for (const sub of this.snapshot.subagents) {
      const repoDir = sub.repoDir ?? this.snapshot.workspaceDir;
      if (sub.worktreePath && repoDir) {
        try {
          await invoke("git_worktree_remove", {
            workspaceDir: repoDir,
            worktreePath: sub.worktreePath,
            branch: sub.worktreeBranch ?? null,
            force: false,
          });
        } catch {
          // Leave dirty worktrees intact so user work isn't lost.
        }
      }
    }
  }
}
