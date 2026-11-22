import { invoke } from "@tauri-apps/api/core";
import {
  ClaudeCodeBackend,
  CodexCliBackend,
  OpenAiCompatBackend,
  OpenCodeBackend,
  type AgentBackend,
  type NormalizedAgentEvent,
} from "../backends/index.ts";
import { OpenCodeConnection, type AnyOpencodeEvent } from "./opencode-client.ts";
import {
  buildPlannerPrompt,
  parseExecutionPlan,
  PLANNER_SYSTEM_PROMPT,
} from "./planner.ts";
import type {
  BackendAvailability,
  BackendConfig,
  BackendId,
  ChatTurn,
  ExecutionMode,
  LogEntry,
  OrchestratorSnapshot,
  PendingPermission,
  PetEntity,
  SelectedModelRef,
  SessionStatsData,
  SubtaskPlanItem,
} from "./types.ts";

interface WorktreeInfo {
  path: string;
  branch: string;
}

export interface OrchestratorEngineDeps {
  backends?: Partial<Record<BackendId, AgentBackend>>;
  invokeFn?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  pickSubagentVariant?: (role: string, index: number) => string;
}

const DEFAULT_BACKEND_AVAILABILITY: Record<BackendId, BackendAvailability> = {
  opencode: {
    backend: "opencode",
    available: false,
    label: "OpenCode",
  },
  "claude-code": {
    backend: "claude-code",
    available: false,
    label: "Claude Code",
    binary: "claude",
  },
  "codex-cli": {
    backend: "codex-cli",
    available: false,
    label: "Codex CLI",
    binary: "codex",
  },
  "openai-compat": {
    backend: "openai-compat",
    available: false,
    label: "Hermes / OpenAI API",
  },
};

const ALL_BACKEND_IDS: BackendId[] = [
  "opencode",
  "claude-code",
  "codex-cli",
  "openai-compat",
];

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
  private backends: Record<BackendId, AgentBackend>;
  private invokeFn: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  private pickSubagentVariant?: (role: string, index: number) => string;
  private backendUnsubscribers: Array<() => void> = [];
  private runAbortController: AbortController | null = null;
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

  constructor(initialUrl = "http://127.0.0.1:4096", deps?: OrchestratorEngineDeps) {
    this.invokeFn = deps?.invokeFn ?? invoke;
    this.pickSubagentVariant = deps?.pickSubagentVariant;

    const opencodeBackend =
      deps?.backends?.opencode ?? new OpenCodeBackend({ serverUrl: initialUrl });
    this.backends = {
      opencode: opencodeBackend,
      "claude-code": deps?.backends?.["claude-code"] ?? new ClaudeCodeBackend(),
      "codex-cli": deps?.backends?.["codex-cli"] ?? new CodexCliBackend(),
      "openai-compat":
        deps?.backends?.["openai-compat"] ??
        new OpenAiCompatBackend({ baseUrl: "http://127.0.0.1:8000/v1" }),
    };

    this.connection =
      opencodeBackend instanceof OpenCodeBackend
        ? opencodeBackend.getConnection()
        : new OpenCodeConnection(initialUrl);

    this.snapshot = {
      connected: false,
      serverHealthy: false,
      serverUrl: this.connection.getBaseUrl(),
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
      activeBackend: "opencode",
      backendAvailability: structuredClone(DEFAULT_BACKEND_AVAILABILITY),
      backendConfigs: {
        opencode: { serverUrl: this.connection.getBaseUrl() },
        "claude-code": {},
        "codex-cli": {},
        "openai-compat": { baseUrl: "http://127.0.0.1:8000/v1" },
      },
    };

    for (const id of ALL_BACKEND_IDS) {
      if (id === "opencode" && opencodeBackend instanceof OpenCodeBackend) {
        continue;
      }
      const backend = this.backends[id];
      if (typeof backend.subscribe === "function") {
        const unsub = backend.subscribe((ev) => {
          this.handleNormalizedEvent(id, ev);
        });
        this.backendUnsubscribers.push(unsub);
      }
    }
  }

  private async safeInvoke<T>(
    cmd: string,
    args?: Record<string, unknown>
  ): Promise<T | undefined> {
    try {
      return await this.invokeFn<T>(cmd, args);
    } catch {
      return undefined;
    }
  }

  private isNativeOpencode(): boolean {
    return (
      this.getActiveBackendId() === "opencode" &&
      this.backends.opencode instanceof OpenCodeBackend
    );
  }

  private getUnavailableStatusText(
    id: BackendId,
    avail?: BackendAvailability
  ): string {
    if (id === "claude-code" || id === "codex-cli") {
      return "Not installed";
    }
    if (id === "opencode" && avail?.error?.includes("401")) {
      return "Auth required";
    }
    return "Offline";
  }

  setSubagentVariantPicker(
    fn: ((role: string, index: number) => string) | undefined
  ): void {
    this.pickSubagentVariant = fn;
  }

  getActiveBackendId(): BackendId {
    return this.snapshot.activeBackend ?? "opencode";
  }

  async setBackend(id: BackendId): Promise<void> {
    if (this.snapshot.phase !== "idle" && this.snapshot.phase !== "error") {
      await this.abortAll();
    }
    this.snapshot.activeBackend = id;
    this.masterSessionId = null;
    this.snapshot.sessionID = null;
    this.snapshot.orchestrator.sessionID = null;
    if (this.snapshot.phase === "idle" || this.snapshot.phase === "error") {
      this.snapshot.phase = "idle";
      this.snapshot.orchestrator.errorText = undefined;
      this.snapshot.orchestrator.bubbleText = undefined;
      if (
        this.snapshot.orchestrator.state === "error" ||
        this.snapshot.orchestrator.state === "happy"
      ) {
        this.snapshot.orchestrator.state = "idle";
      }
    }
    await this.checkConnection();
  }

  updateBackendConfig(id: BackendId, patch: Partial<BackendConfig>): void {
    if (!this.snapshot.backendConfigs) {
      this.snapshot.backendConfigs = {
        opencode: { serverUrl: this.connection.getBaseUrl() },
        "claude-code": {},
        "codex-cli": {},
        "openai-compat": { baseUrl: "http://127.0.0.1:8000/v1" },
      };
    }
    const next: BackendConfig = {
      ...(this.snapshot.backendConfigs[id] ?? {}),
      ...patch,
    };
    this.snapshot.backendConfigs[id] = next;

    if (id === "opencode") {
      if (patch.serverUrl !== undefined && patch.serverUrl.trim()) {
        const cleaned = patch.serverUrl.trim();
        this.connection.setBaseUrl(cleaned);
        if (this.backends.opencode instanceof OpenCodeBackend) {
          this.backends.opencode.setServerUrl(cleaned);
        }
        this.snapshot.serverUrl = this.connection.getBaseUrl();
        next.serverUrl = this.snapshot.serverUrl;
      }
    } else if (id === "claude-code") {
      const b = this.backends["claude-code"] as {
        setModel?: (m?: string) => void;
        setCliPath?: (p?: string) => void;
      };
      if (patch.model !== undefined && typeof b.setModel === "function") {
        b.setModel(next.model?.trim() || undefined);
      }
      if (patch.cliPath !== undefined && typeof b.setCliPath === "function") {
        b.setCliPath(next.cliPath?.trim() || undefined);
      }
    } else if (id === "codex-cli") {
      const b = this.backends["codex-cli"] as {
        setModel?: (m?: string) => void;
        setCliPath?: (p?: string) => void;
      };
      if (patch.model !== undefined && typeof b.setModel === "function") {
        b.setModel(next.model?.trim() || undefined);
      }
      if (patch.cliPath !== undefined && typeof b.setCliPath === "function") {
        b.setCliPath(next.cliPath?.trim() || undefined);
      }
    } else if (id === "openai-compat") {
      const b = this.backends["openai-compat"] as {
        setConfig?: (cfg: { baseUrl?: string; apiKey?: string; model?: string }) => void;
      };
      if (typeof b.setConfig === "function") {
        b.setConfig({
          baseUrl: next.baseUrl,
          apiKey: next.apiKey,
          model: next.model,
        });
      }
    }

    this.emit();
  }

  async checkAllBackends(): Promise<Record<BackendId, BackendAvailability>> {
    if (!this.snapshot.backendAvailability) {
      this.snapshot.backendAvailability = structuredClone(DEFAULT_BACKEND_AVAILABILITY);
    }

    const results = await Promise.allSettled(
      ALL_BACKEND_IDS.map(async (id) => {
        const avail = await this.backends[id].checkAvailability();
        return { id, avail };
      })
    );

    for (let i = 0; i < ALL_BACKEND_IDS.length; i++) {
      const id = ALL_BACKEND_IDS[i];
      const res = results[i];
      if (res.status === "fulfilled") {
        this.snapshot.backendAvailability[id] = res.value.avail;
      } else {
        this.snapshot.backendAvailability[id] = {
          ...(this.snapshot.backendAvailability[id] ?? DEFAULT_BACKEND_AVAILABILITY[id]),
          available: false,
          error:
            res.reason instanceof Error ? res.reason.message : String(res.reason),
        };
      }
    }

    const active = this.getActiveBackendId();
    const activeAvail = this.snapshot.backendAvailability[active];
    this.snapshot.connected = activeAvail.available;
    this.snapshot.serverHealthy = activeAvail.available;
    if (this.snapshot.phase === "idle") {
      this.snapshot.orchestrator.statusText = activeAvail.available
        ? "Ready"
        : this.getUnavailableStatusText(active, activeAvail);
    }

    this.emit();
    return structuredClone(this.snapshot.backendAvailability);
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
    this.updateBackendConfig("opencode", { serverUrl: url });
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
    await this.safeInvoke("set_overlay_always_on_top", { alwaysOnTop });
    this.emit();
  }

  async getSessionStats(fromMs?: number): Promise<SessionStatsData | null> {
    if (!this.isNativeOpencode()) return null;
    return this.connection.getSessionStats(fromMs);
  }

  async refreshModels(): Promise<void> {
    if (!this.isNativeOpencode() || !this.snapshot.serverHealthy) return;
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
    this.snapshot.orchestrator.permission = undefined;
    const active = this.getActiveBackendId();
    this.snapshot.orchestrator.statusText = this.snapshot.serverHealthy
      ? "Ready"
      : this.getUnavailableStatusText(
          active,
          this.snapshot.backendAvailability?.[active]
        );
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
    this.snapshot.orchestrator.permission = undefined;
    const active = this.getActiveBackendId();
    this.snapshot.orchestrator.statusText = this.snapshot.serverHealthy
      ? "Ready"
      : this.getUnavailableStatusText(
          active,
          this.snapshot.backendAvailability?.[active]
        );
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
    this.snapshot.isGitRepo = trimmed
      ? Boolean(await this.safeInvoke<boolean>("git_is_repo", { workspaceDir: trimmed }))
      : false;
    this.log(
      "info",
      "Workspace",
      `Selected ${this.snapshot.workspaceDir || "(none)"} (git: ${this.snapshot.isGitRepo ? "yes" : "no"})`
    );
    if (this.isNativeOpencode() && this.snapshot.serverHealthy && this.snapshot.workspaceDir) {
      this.ensureSseSubscription(this.snapshot.workspaceDir);
    }
    this.emit();
  }

  async checkConnection(): Promise<boolean> {
    const active = this.getActiveBackendId();
    if (!this.snapshot.backendAvailability) {
      this.snapshot.backendAvailability = structuredClone(DEFAULT_BACKEND_AVAILABILITY);
    }

    if (this.isNativeOpencode()) {
      const health = await this.connection.checkHealth();
      this.snapshot.serverUrl = this.connection.getBaseUrl();
      this.snapshot.serverHealthy = health.healthy;
      this.snapshot.connected = health.healthy;
      this.snapshot.backendAvailability.opencode = {
        backend: "opencode",
        available: health.healthy,
        label: "OpenCode",
        version: health.version,
        error: health.error,
      };
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

    const backend = this.backends[active];
    let avail: BackendAvailability;
    try {
      avail = await backend.checkAvailability();
    } catch (err) {
      avail = {
        ...(this.snapshot.backendAvailability[active] ?? DEFAULT_BACKEND_AVAILABILITY[active]),
        available: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    this.snapshot.backendAvailability[active] = avail;
    this.snapshot.connected = avail.available;
    this.snapshot.serverHealthy = avail.available;
    if (this.snapshot.phase === "idle") {
      this.snapshot.orchestrator.statusText = avail.available
        ? "Ready"
        : this.getUnavailableStatusText(active, avail);
    }
    this.emit();
    return avail.available;
  }

  async startAndConnectServer(): Promise<boolean> {
    if (!this.isNativeOpencode()) {
      return this.checkConnection();
    }
    const dir = this.snapshot.workspaceDir;
    this.log("info", "Server", `Connecting to opencode serve at ${this.snapshot.serverUrl}...`);
    try {
      const health = await this.connection.ensureServerRunning(dir);
      this.snapshot.serverUrl = this.connection.getBaseUrl();
      this.snapshot.serverHealthy = health.healthy;
      this.snapshot.connected = health.healthy;
      if (this.snapshot.backendAvailability) {
        this.snapshot.backendAvailability.opencode = {
          backend: "opencode",
          available: health.healthy,
          label: "OpenCode",
          version: health.version,
          error: health.error,
        };
      }
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
    try {
      await this.invokeFn("set_window_mode", { freeRoam });
    } catch (err) {
      if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
        throw err;
      }
    }
    this.snapshot.freeRoam = freeRoam;
    this.emit();
  }

  async setForceInteractiveOverlay(force: boolean): Promise<void> {
    try {
      await this.invokeFn("set_overlay_force_interactive", { force });
    } catch (err) {
      if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
        throw err;
      }
    }
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
    this.runAbortController?.abort();
    const runController = new AbortController();
    this.runAbortController = runController;

    try {
      const nativeOpencode = this.isNativeOpencode();
      if (nativeOpencode) {
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
      } else {
        const active = this.getActiveBackendId();
        const ok = await this.checkConnection();
        if (gen !== this.runGeneration) return;
        if (!ok) {
          const avail = this.snapshot.backendAvailability?.[active];
          throw new Error(
            avail?.error ||
              (active === "openai-compat"
                ? "OpenAI-compatible endpoint is offline or unreachable."
                : `${avail?.label ?? active} CLI is not installed or unavailable.`)
          );
        }

        await this.cleanupPreviousWorktrees();
        if (gen !== this.runGeneration) return;
      }

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
      this.snapshot.orchestrator.permission = undefined;

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

      if (!nativeOpencode) {
        await this.submitBackendGoal(trimmed, runId, gen, runController);
        return;
      }

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
        this.clearPetPermission(this.snapshot.orchestrator);
        this.snapshot.phase = "idle";
        this.snapshot.orchestrator.state = "happy";
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
      this.clearPetPermission(this.snapshot.orchestrator);
      this.snapshot.phase = "error";
      this.snapshot.streamingActive = false;
      this.snapshot.orchestrator.state = "error";
      this.snapshot.orchestrator.statusText = "Error";
      this.snapshot.orchestrator.errorText = msg;
      this.log("error", "Boymoder", msg);
      this.emit();
    } finally {
      if (this.runAbortController === runController) {
        this.runAbortController = null;
      }
    }
  }

  private async submitBackendGoal(
    trimmed: string,
    runId: string,
    gen: number,
    runController: AbortController
  ): Promise<void> {
    const active = this.getActiveBackendId();
    const backend = this.backends[active];
    const config = this.snapshot.backendConfigs?.[active];
    const model = config?.model?.trim() || undefined;
    const mode = this.snapshot.mode;

    if (!this.masterSessionId) {
      this.masterSessionId = await backend.createSession({
        directory: this.snapshot.workspaceDir,
        title: `Boymoder: ${trimmed.slice(0, 48)}`,
        model,
      });
    }
    if (gen !== this.runGeneration) return;

    this.snapshot.sessionID = this.masterSessionId;
    this.snapshot.orchestrator.sessionID = this.masterSessionId;
    this.emit();

    if (mode === "build" || mode === "plan") {
      const system =
        mode === "plan"
          ? `${BOYMODER_PERSONA_SYSTEM_PROMPT}\n\n${PLAN_ONLY_SYSTEM_PROMPT}`
          : BOYMODER_PERSONA_SYSTEM_PROMPT;

      const reply = await backend.sendPrompt({
        sessionID: this.masterSessionId,
        directory: this.snapshot.workspaceDir,
        text: trimmed,
        system,
        disableMutatingTools: mode === "plan",
        model,
        signal: runController.signal,
        petId: "orchestrator",
      });
      if (gen !== this.runGeneration) return;

      const dur = Math.max(
        100,
        Date.now() - (this.snapshot.planStartedAt ?? Date.now())
      );
      this.snapshot.planDurationMs = dur;
      this.snapshot.streamingActive = false;
      this.snapshot.assistantReply = reply || "(Done)";
      const activeTurn = this.snapshot.turns.find((t) => t.id === runId);
      if (activeTurn) {
        activeTurn.assistantReply = this.snapshot.assistantReply;
        activeTurn.planDurationMs = dur;
      }
      this.clearPetPermission(this.snapshot.orchestrator);
      this.snapshot.phase = "idle";
      this.snapshot.orchestrator.state = "happy";
      this.snapshot.orchestrator.statusText = "Ready";
      this.emit();
      return;
    }

    const plannerText = await backend.sendPrompt({
      sessionID: this.masterSessionId,
      directory: this.snapshot.workspaceDir,
      system: PLANNER_SYSTEM_PROMPT,
      disableMutatingTools: true,
      model,
      signal: runController.signal,
      petId: "orchestrator",
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

    await this.launchBackendSubagents(backend, plan, gen, runController.signal);
  }

  private async launchBackendSubagents(
    backend: AgentBackend,
    plan: SubtaskPlanItem[],
    gen: number,
    signal: AbortSignal
  ): Promise<void> {
    if (gen !== this.runGeneration) return;
    const active = this.getActiveBackendId();
    const model = this.snapshot.backendConfigs?.[active]?.model?.trim() || undefined;

    this.isLaunching = true;
    this.snapshot.phase = "executing";
    this.snapshot.orchestrator.state = "work";
    this.snapshot.orchestrator.statusText = "Building...";
    this.emit();

    const runOne = async (item: SubtaskPlanItem, index: number): Promise<void> => {
      if (gen !== this.runGeneration) return;
      const repoDir = this.snapshot.workspaceDir;
      let agentDir = repoDir;
      let wtInfo: WorktreeInfo | undefined;

      if (this.snapshot.useWorktrees && this.snapshot.isGitRepo && plan.length > 1) {
        try {
          wtInfo = await this.invokeFn<WorktreeInfo>("git_worktree_create", {
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

      const subagentId = `sub-${item.id}-${index}`;
      const pet: PetEntity = {
        id: subagentId,
        sessionID: null,
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
        spriteVariant: this.pickSubagentVariant?.(item.role, index),
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
        const output = await backend.spawnSubagent({
          parentID: this.masterSessionId ?? undefined,
          subagentId,
          role: item.role,
          title: item.title,
          directory: agentDir,
          prompt: workerInstruction,
          model,
          signal,
        });
        if (gen !== this.runGeneration) return;

        pet.completed = true;
        this.clearPetPermission(pet);
        if (pet.state !== "error") {
          pet.state = "happy";
          pet.statusText = "Done";
        }
        if (output) {
          pet.lastOutput = output;
        }
        if (pet.worktreePath) {
          const diff = await this.safeInvoke<string>("git_worktree_diff_summary", {
            worktreePath: pet.worktreePath,
          });
          if (diff && !diff.startsWith("No uncommitted changes")) {
            pet.lastOutput = `${pet.lastOutput ?? ""}\n\n[Worktree ${pet.worktreeBranch ?? ""}]\n${diff}`.trim();
          }
        }
        this.log("success", pet.title, "Completed.");
        this.emit();
      } catch (err) {
        if (gen !== this.runGeneration) return;
        const msg = err instanceof Error ? err.message : String(err);
        pet.state = "error";
        pet.errorText = msg;
        pet.statusText = "Error";
        pet.completed = true;
        this.clearPetPermission(pet);
        this.log("error", pet.title, msg);
        this.emit();
      }
    };

    try {
      await Promise.allSettled(plan.map((item, idx) => runOne(item, idx)));
    } finally {
      this.isLaunching = false;
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
        spriteVariant: s.spriteVariant,
      }));
    }

    const allFailed =
      this.snapshot.subagents.length > 0 &&
      this.snapshot.subagents.every((s) => s.state === "error");

    this.clearPetPermission(this.snapshot.orchestrator);
    this.snapshot.streamingActive = false;
    if (allFailed) {
      this.snapshot.phase = "error";
      this.snapshot.orchestrator.state = "error";
      this.snapshot.orchestrator.statusText = "Error";
      this.snapshot.orchestrator.errorText =
        this.snapshot.subagents[0]?.errorText ?? "All subagents failed.";
    } else {
      this.snapshot.phase = "idle";
      this.snapshot.orchestrator.state = "happy";
      this.snapshot.orchestrator.statusText = "Ready";
    }
    this.emit();
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
          wtInfo = await this.invokeFn<WorktreeInfo>("git_worktree_create", {
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
        spriteVariant: this.pickSubagentVariant?.(item.role, index),
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
        this.clearPetPermission(pet);
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
      this.clearPetPermission(this.snapshot.orchestrator);
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

  private findPetForNormalizedEvent(ev: {
    sessionID?: string;
    petId?: string;
  }): PetEntity | null {
    if (ev.petId) {
      if (ev.petId === "orchestrator") return this.snapshot.orchestrator;
      const byId = this.snapshot.subagents.find((s) => s.id === ev.petId);
      if (byId) return byId;
    }
    if (ev.sessionID) {
      return this.findPetBySession(ev.sessionID);
    }
    return null;
  }

  private handleNormalizedEvent(
    backendId: BackendId,
    ev: NormalizedAgentEvent
  ): void {
    if (this.getActiveBackendId() !== backendId) return;
    if (this.snapshot.phase === "idle") return;

    switch (ev.type) {
      case "thought": {
        const pet = this.findPetForNormalizedEvent(ev);
        if (!pet || pet.permission || pet.completed) break;
        const tokKey = ev.sessionID || pet.id;
        if (!this.stepFirstTokenAt.has(tokKey)) {
          this.stepFirstTokenAt.set(tokKey, Date.now());
        }
        const chars = (this.stepStreamChars.get(tokKey) ?? 0) + ev.text.length;
        this.stepStreamChars.set(tokKey, chars);
        const startAt = this.stepFirstTokenAt.get(tokKey) ?? Date.now();
        const elapsed = Math.max(0.15, (Date.now() - startAt) / 1000);
        this.snapshot.tokensPerSec = Math.round(((chars / 4) / elapsed) * 10) / 10;
        this.snapshot.streamingActive = true;
        pet.state = "work";
        pet.statusText = "Thinking...";
        this.emit();
        break;
      }

      case "text_delta": {
        const pet = this.findPetForNormalizedEvent(ev);
        if (!pet || pet.permission || pet.completed) break;
        const tokKey = ev.sessionID || pet.id;
        if (!this.stepFirstTokenAt.has(tokKey)) {
          this.stepFirstTokenAt.set(tokKey, Date.now());
        }
        const chars = (this.stepStreamChars.get(tokKey) ?? 0) + ev.delta.length;
        this.stepStreamChars.set(tokKey, chars);
        const startAt = this.stepFirstTokenAt.get(tokKey) ?? Date.now();
        const elapsed = Math.max(0.15, (Date.now() - startAt) / 1000);
        this.snapshot.tokensPerSec = Math.round(((chars / 4) / elapsed) * 10) / 10;
        this.snapshot.streamingActive = true;
        pet.state = "work";
        pet.statusText = "Writing response...";
        this.emit();
        break;
      }

      case "tool_start": {
        const pet = this.findPetForNormalizedEvent(ev);
        if (!pet || pet.permission || pet.completed) break;
        pet.state = "work";
        pet.statusText = formatToolVerb(ev.toolName);
        this.emit();
        break;
      }

      case "tool_end": {
        const pet = this.findPetForNormalizedEvent(ev);
        if (!pet || pet.permission || pet.completed) break;
        pet.statusText = "Thinking...";
        this.emit();
        break;
      }

      case "permission_request": {
        const pet =
          this.findPetForNormalizedEvent(ev) ?? this.snapshot.orchestrator;
        this.attachPermission(pet, {
          requestId: ev.requestId,
          sessionID: ev.sessionID || pet.sessionID || "",
          permission: ev.permission,
          patterns: ev.patterns,
          detail: ev.detail,
          directory: ev.directory || pet.directory || this.snapshot.workspaceDir,
          isV2: ev.isV2,
        });
        break;
      }

      case "subagent_spawn": {
        const existing = this.snapshot.subagents.find(
          (s) => s.id === ev.subagentId
        );
        if (existing) {
          if (!existing.sessionID && ev.sessionID) {
            existing.sessionID = ev.sessionID;
          }
          if (ev.directory && !existing.directory) {
            existing.directory = ev.directory;
          }
          this.emit();
        } else {
          const pet: PetEntity = {
            id: ev.subagentId,
            sessionID: ev.sessionID || null,
            kind: "subagent",
            role: ev.role,
            title: ev.title,
            state: "work",
            statusText: "Building...",
            directory: ev.directory ?? this.snapshot.workspaceDir,
            completed: false,
            spriteVariant: this.pickSubagentVariant?.(
              ev.role,
              this.snapshot.subagents.length
            ),
          };
          this.snapshot.subagents.push(pet);
          this.emit();
        }
        break;
      }

      case "subagent_update": {
        const sub =
          this.snapshot.subagents.find((s) => s.id === ev.subagentId) ??
          (ev.sessionID
            ? this.snapshot.subagents.find((s) => s.sessionID === ev.sessionID)
            : undefined);
        if (!sub) break;
        if (ev.state === "error") {
          sub.state = "error";
          sub.statusText = ev.statusText || "Error";
          sub.errorText = ev.detail || ev.statusText || "Error";
          sub.completed = true;
          this.clearPetPermission(sub);
        } else if (ev.state === "alert") {
          sub.state = "alert";
          if (ev.statusText) sub.statusText = ev.statusText;
        } else if (!sub.permission) {
          if (
            ev.state === "happy" ||
            (ev.state === "idle" && (ev.statusText === "Done" || sub.completed))
          ) {
            sub.state = "happy";
            sub.statusText = ev.statusText || "Done";
            sub.completed = true;
            this.clearPetPermission(sub);
          } else if (ev.state) {
            sub.state = ev.state;
            if (ev.statusText) sub.statusText = ev.statusText;
          } else if (ev.statusText) {
            sub.statusText = ev.statusText;
          }
        }
        this.emit();
        break;
      }

      case "completed": {
        this.snapshot.streamingActive = false;
        const tokKey = ev.sessionID || ev.petId || "";
        const startAt = tokKey ? this.stepFirstTokenAt.get(tokKey) : undefined;
        if (ev.usage) {
          const outTokens =
            (ev.usage.outputTokens ?? 0) + (ev.usage.reasoningTokens ?? 0);
          if (outTokens > 0 && startAt) {
            const elapsed = Math.max(0.1, (Date.now() - startAt) / 1000);
            this.snapshot.tokensPerSec = Math.round((outTokens / elapsed) * 10) / 10;
          }
          this.snapshot.totalTokens +=
            (ev.usage.inputTokens ?? 0) +
            (ev.usage.outputTokens ?? 0) +
            (ev.usage.reasoningTokens ?? 0);
        }
        if (tokKey) {
          this.stepFirstTokenAt.delete(tokKey);
          this.stepStreamChars.delete(tokKey);
        }

        const pet = this.findPetForNormalizedEvent(ev);
        if (pet) {
          this.clearPetPermission(pet);
          if (pet.kind === "subagent") {
            pet.completed = true;
            if (pet.state !== "error") {
              pet.state = "happy";
              pet.statusText = "Done";
            }
            if (ev.text) {
              pet.lastOutput = ev.text;
            }
          }
        }
        this.emit();
        break;
      }

      case "error": {
        const pet = this.findPetForNormalizedEvent(ev);
        if (!ev.recoverable) {
          const tokKey = ev.sessionID || ev.petId || pet?.id || "";
          if (tokKey) {
            this.stepFirstTokenAt.delete(tokKey);
            this.stepStreamChars.delete(tokKey);
          }
          if (pet) {
            pet.state = "error";
            pet.errorText = ev.message;
            pet.statusText = "Error";
            this.clearPetPermission(pet);
            if (pet.kind === "subagent") {
              pet.completed = true;
            } else if (this.snapshot.mode !== "orchestration") {
              this.snapshot.phase = "error";
            }
          }
          this.snapshot.streamingActive = false;
          this.log("error", pet?.title ?? backendId, ev.message);
          this.emit();
        } else {
          this.log("warn", pet?.title ?? backendId, ev.message);
        }
        break;
      }
    }
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
          this.clearPetPermission(pet);
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
        this.clearPetPermission(pet);
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

  private clearPetPermission(pet: PetEntity): void {
    const reqId = pet.permission?.requestId;
    const sid = pet.sessionID;
    pet.permission = undefined;
    if (!reqId && !sid) return;
    this.snapshot.activePermissions = this.snapshot.activePermissions.filter(
      (p) => (!reqId || p.requestId !== reqId) && (!sid || p.sessionID !== sid)
    );
  }

  private clearPermission(sessionID: string, requestID: string): void {
    this.snapshot.activePermissions = this.snapshot.activePermissions.filter(
      (x) => x.requestId !== requestID
    );
    const pet =
      this.findPetBySession(sessionID) ??
      (this.snapshot.orchestrator.permission?.requestId === requestID
        ? this.snapshot.orchestrator
        : this.snapshot.subagents.find(
            (s) => s.permission?.requestId === requestID
          ) ?? null);
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
    const pet =
      this.findPetBySession(sessionID) ??
      (this.snapshot.orchestrator.permission?.requestId === requestId
        ? this.snapshot.orchestrator
        : this.snapshot.subagents.find(
            (s) => s.permission?.requestId === requestId
          ) ?? null);
    const directory = req?.directory ?? pet?.directory ?? this.snapshot.workspaceDir;

    if (this.isNativeOpencode()) {
      await this.connection.replyPermission({
        sessionID,
        requestID: requestId,
        reply,
        directory,
        isV2: req?.isV2,
        message: reply === "reject" ? "Denied via Boymoder AI Assistant" : undefined,
      });
    } else {
      const backend = this.backends[this.getActiveBackendId()];
      await backend.respondToPermission({
        sessionID,
        requestId,
        reply,
        directory,
        isV2: req?.isV2,
        message: reply === "reject" ? "Denied via Boymoder AI Assistant" : undefined,
      });
    }

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
    this.clearPetPermission(pet);
    if (pet.state !== "error") {
      pet.state = "happy";
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
        const diff = await this.safeInvoke<string>("git_worktree_diff_summary", {
          worktreePath: sub.worktreePath,
        });
        if (diff && !diff.startsWith("No uncommitted changes")) {
          sub.lastOutput = `${sub.lastOutput ?? ""}\n\n[Worktree ${sub.worktreeBranch ?? ""}]\n${diff}`.trim();
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
        spriteVariant: s.spriteVariant,
      }));
    }
    const allFailed =
      this.snapshot.subagents.length > 0 &&
      this.snapshot.subagents.every((s) => s.state === "error");

    this.clearPetPermission(this.snapshot.orchestrator);
    if (allFailed) {
      this.snapshot.phase = "error";
      this.snapshot.orchestrator.state = "error";
      this.snapshot.orchestrator.statusText = "Error";
      this.snapshot.orchestrator.errorText =
        this.snapshot.subagents[0]?.errorText ?? "All subagents failed.";
    } else {
      this.snapshot.phase = "idle";
      this.snapshot.orchestrator.state = "happy";
      this.snapshot.orchestrator.statusText = "Ready";
    }
    this.snapshot.subagents = this.snapshot.subagents.map((s) => ({
      ...s,
      state: s.state === "error" ? "error" : "happy",
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
    this.runAbortController?.abort();
    this.runAbortController = null;

    for (const [sid] of this.sessionIdleWaiters) {
      this.resolveSessionIdleWaiter(sid, "Aborted");
    }

    if (this.isNativeOpencode()) {
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
    } else {
      const backend = this.backends[this.getActiveBackendId()];
      await Promise.allSettled([backend.abort()]);
    }

    this.snapshot.phase = "idle";
    this.snapshot.streamingActive = false;
    this.snapshot.activePermissions = [];
    this.snapshot.orchestrator.state = "idle";
    this.snapshot.orchestrator.statusText = "Stopped";
    this.snapshot.orchestrator.bubbleText = undefined;
    this.snapshot.orchestrator.errorText = undefined;
    this.snapshot.orchestrator.permission = undefined;
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
        await this.safeInvoke("git_worktree_remove", {
          workspaceDir: repoDir,
          worktreePath: sub.worktreePath,
          branch: sub.worktreeBranch ?? null,
          force: false,
        });
      }
    }
  }
}
