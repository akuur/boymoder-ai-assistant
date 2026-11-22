import {
  TauriCliRunner,
  type AgentBackend,
  type BackendAvailability,
  type BackendPermissionReply,
  type BackendPromptOptions,
  type BackendSessionOptions,
  type BackendSubagentOptions,
  type CliRunner,
  type NormalizedAgentEvent,
} from "./types.ts";

export interface CodexCliBackendOptions {
  model?: string;
  cliPath?: string;
  runner?: CliRunner;
}

interface CodexSessionState {
  directory: string;
  model?: string;
  system?: string;
  threadId?: string;
}

interface ActiveRun {
  runId: string;
  sessionID: string;
  abort: () => Promise<void>;
}

export interface CodexStreamParserState {
  threadId?: string;
  turnActive: boolean;
  accumulatedText: string;
  turnError?: string;
  completedEmitted: boolean;
  seenReasoningById: Map<string, string>;
  seenMessagesById: Map<string, string>;
}

export interface CodexStreamParser {
  readonly state: CodexStreamParserState;
  feedLine(line: string): NormalizedAgentEvent[];
}

function summarizeInput(input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === "string") return input.slice(0, 140);
  if (typeof input !== "object") return String(input);
  try {
    const json = JSON.stringify(input);
    return json.length > 140 ? `${json.slice(0, 137)}...` : json;
  } catch {
    return undefined;
  }
}

function summarizeFileChanges(changes: unknown): string | undefined {
  if (!Array.isArray(changes) || changes.length === 0) return undefined;
  const labels = changes
    .map((c) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object") {
        const rec = c as Record<string, unknown>;
        const path = typeof rec.path === "string" ? rec.path : typeof rec.file === "string" ? rec.file : "";
        const kind = typeof rec.kind === "string" ? rec.kind : "";
        return kind && path ? `${kind}: ${path}` : path || kind;
      }
      return "";
    })
    .filter(Boolean);
  if (labels.length === 0) return undefined;
  const joined = labels.join(", ");
  return joined.length > 140 ? `${joined.slice(0, 137)}...` : joined;
}

function extractCodexErrorMessage(obj: Record<string, unknown>): string {
  if (obj.error && typeof obj.error === "object") {
    const errRec = obj.error as Record<string, unknown>;
    if (typeof errRec.message === "string" && errRec.message.trim()) {
      return errRec.message.trim();
    }
  }
  if (typeof obj.error === "string" && obj.error.trim()) return obj.error.trim();
  if (typeof obj.message === "string" && obj.message.trim()) return obj.message.trim();
  return "Codex CLI error";
}

function formatToolVerb(toolName: string): string {
  const t = toolName.toLowerCase();
  if (t.includes("file") || t.includes("edit") || t.includes("write") || t.includes("patch")) {
    return "Building...";
  }
  if (t.includes("bash") || t.includes("shell") || t.includes("command")) {
    return "Debugging...";
  }
  if (t.includes("search") || t.includes("read") || t.includes("find")) {
    return "Inspecting...";
  }
  return `Running ${toolName}...`;
}

function computeTextDelta(
  seenMap: Map<string, string>,
  itemId: string | undefined,
  fullOrDeltaText: string
): string {
  if (!fullOrDeltaText) return "";
  if (!itemId) return fullOrDeltaText;
  const prev = seenMap.get(itemId);
  seenMap.set(itemId, fullOrDeltaText);
  if (prev === undefined) return fullOrDeltaText;
  if (fullOrDeltaText.startsWith(prev)) {
    return fullOrDeltaText.slice(prev.length);
  }
  return fullOrDeltaText;
}

export function buildCodexCliArgs(params: {
  prompt: string;
  model?: string;
  disableMutatingTools?: boolean;
  threadId?: string;
}): string[] {
  if (params.threadId) {
    return [
      "exec",
      "resume",
      "--json",
      ...(params.disableMutatingTools ? ["-s", "read-only"] : []),
      ...(params.model ? ["-m", params.model] : []),
      params.threadId,
      "--",
      params.prompt,
    ];
  }
  return [
    "exec",
    "--json",
    ...(params.disableMutatingTools ? ["-s", "read-only"] : []),
    ...(params.model ? ["-m", params.model] : []),
    "--",
    params.prompt,
  ];
}

export function createStreamParser(
  sessionID: string,
  emit: (event: NormalizedAgentEvent) => void,
  petId?: string
): CodexStreamParser {
  const state: CodexStreamParserState = {
    turnActive: false,
    accumulatedText: "",
    completedEmitted: false,
    seenReasoningById: new Map(),
    seenMessagesById: new Map(),
  };

  const feedLine = (line: string): NormalizedAgentEvent[] => {
    const trimmed = line.trim();
    if (!trimmed) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const ev: NormalizedAgentEvent = {
        type: "error",
        sessionID,
        message: `Malformed Codex JSONL line: ${msg}`,
        recoverable: true,
        petId,
      };
      emit(ev);
      return [ev];
    }

    if (!parsed || typeof parsed !== "object") return [];
    const obj = parsed as Record<string, unknown>;
    const events: NormalizedAgentEvent[] = [];
    const push = (ev: NormalizedAgentEvent) => {
      events.push(ev);
      emit(ev);
    };

    switch (obj.type) {
      case "thread.started": {
        if (typeof obj.thread_id === "string") {
          state.threadId = obj.thread_id;
        }
        break;
      }

      case "turn.started": {
        state.turnActive = true;
        break;
      }

      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item =
          obj.item && typeof obj.item === "object"
            ? (obj.item as Record<string, unknown>)
            : undefined;
        if (!item) break;
        const itemId = typeof item.id === "string" ? item.id : undefined;
        const itemType = typeof item.type === "string" ? item.type : "";

        if (itemType === "reasoning") {
          const text = typeof item.text === "string" ? item.text : "";
          const delta = computeTextDelta(state.seenReasoningById, itemId, text);
          if (delta) {
            push({ type: "thought", sessionID, text: delta, petId });
          }
        } else if (itemType === "command_execution") {
          if (obj.type === "item.started") {
            push({
              type: "tool_start",
              sessionID,
              toolName: "bash",
              toolId: itemId,
              detail: typeof item.command === "string" ? item.command : undefined,
              petId,
            });
          } else if (obj.type === "item.completed") {
            const exitCode = typeof item.exit_code === "number" ? item.exit_code : 0;
            push({
              type: "tool_end",
              sessionID,
              toolName: "bash",
              toolId: itemId,
              success: exitCode === 0,
              output:
                typeof item.aggregated_output === "string" ? item.aggregated_output : undefined,
              petId,
            });
          }
        } else if (itemType === "file_change") {
          if (obj.type === "item.started") {
            push({
              type: "tool_start",
              sessionID,
              toolName: "file_change",
              toolId: itemId,
              detail: summarizeFileChanges(item.changes),
              petId,
            });
          } else if (obj.type === "item.completed") {
            push({
              type: "tool_end",
              sessionID,
              toolName: "file_change",
              toolId: itemId,
              success: item.status !== "failed",
              petId,
            });
          }
        } else if (itemType === "mcp_tool_call" || itemType === "web_search") {
          const toolName =
            itemType === "web_search"
              ? "web_search"
              : String(item.tool ?? item.name ?? "mcp_tool_call");
          if (obj.type === "item.started") {
            const detail =
              itemType === "web_search"
                ? typeof item.query === "string"
                  ? item.query
                  : undefined
                : summarizeInput(item.arguments ?? item.input);
            push({
              type: "tool_start",
              sessionID,
              toolName,
              toolId: itemId,
              detail,
              petId,
            });
          } else if (obj.type === "item.completed") {
            push({
              type: "tool_end",
              sessionID,
              toolName,
              toolId: itemId,
              success: item.status !== "failed" && !item.error,
              output:
                typeof item.result === "string"
                  ? item.result
                  : typeof item.output === "string"
                    ? item.output
                    : undefined,
              petId,
            });
          }
        } else if (itemType === "agent_message") {
          const text = typeof item.text === "string" ? item.text : "";
          const delta = computeTextDelta(state.seenMessagesById, itemId, text);
          if (delta) {
            state.accumulatedText += delta;
            push({ type: "text_delta", sessionID, delta, petId });
          }
        }
        break;
      }

      case "turn.completed": {
        state.turnActive = false;
        state.completedEmitted = true;
        const usageObj =
          obj.usage && typeof obj.usage === "object"
            ? (obj.usage as Record<string, unknown>)
            : undefined;
        const usage = usageObj
          ? {
              inputTokens:
                typeof usageObj.input_tokens === "number" ? usageObj.input_tokens : undefined,
              outputTokens:
                typeof usageObj.output_tokens === "number" ? usageObj.output_tokens : undefined,
            }
          : undefined;
        push({
          type: "completed",
          sessionID,
          text: state.accumulatedText,
          usage,
          petId,
        });
        break;
      }

      case "turn.failed":
      case "error": {
        state.turnActive = false;
        const message = extractCodexErrorMessage(obj);
        state.turnError = message;
        push({ type: "error", sessionID, message, recoverable: false, petId });
        break;
      }

      default:
        break;
    }

    return events;
  };

  return { state, feedLine };
}

export function parseJsonlLine(
  line: string,
  sessionID: string,
  petId?: string
): NormalizedAgentEvent[] {
  const events: NormalizedAgentEvent[] = [];
  const parser = createStreamParser(sessionID, (ev) => events.push(ev), petId);
  parser.feedLine(line);
  return events;
}

export class CodexCliBackend implements AgentBackend {
  readonly id = "codex-cli" as const;
  readonly label = "Codex CLI";

  private model?: string;
  private cliPath?: string;
  private runner: CliRunner;
  private listeners = new Set<(event: NormalizedAgentEvent) => void>();
  private sessions = new Map<string, CodexSessionState>();
  private activeRuns = new Map<string, ActiveRun>();
  private seq = 0;

  constructor(options?: CodexCliBackendOptions) {
    this.model = options?.model;
    this.cliPath = options?.cliPath;
    this.runner = options?.runner ?? new TauriCliRunner();
  }

  setModel(model?: string): void {
    this.model = model;
  }

  setCliPath(cliPath?: string): void {
    this.cliPath = cliPath;
  }

  subscribe(onEvent: (event: NormalizedAgentEvent) => void): () => void {
    this.listeners.add(onEvent);
    return () => {
      this.listeners.delete(onEvent);
    };
  }

  private emit(event: NormalizedAgentEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async checkAvailability(): Promise<BackendAvailability> {
    try {
      const res = await this.runner.checkAvailability("codex", this.cliPath);
      return {
        backend: "codex-cli",
        available: Boolean(res.available),
        label: this.label,
        binary: "codex",
        path: res.path ?? null,
        version: res.version,
        error: res.error,
      };
    } catch (err) {
      return {
        backend: "codex-cli",
        available: false,
        label: this.label,
        binary: "codex",
        path: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async createSession(opts: BackendSessionOptions): Promise<string> {
    this.seq += 1;
    const sessionID = `codex-${Date.now()}-${this.seq}`;
    const model =
      typeof opts.model === "string"
        ? opts.model
        : opts.model?.id;
    this.sessions.set(sessionID, {
      directory: opts.directory ?? "",
      model,
      system: opts.system,
    });
    return sessionID;
  }

  private runCliPrompt(params: {
    sessionID: string;
    directory: string;
    text: string;
    system?: string;
    model?: string;
    disableMutatingTools?: boolean;
    signal?: AbortSignal;
    petId?: string;
    subagentId?: string;
  }): Promise<string> {
    const session = this.sessions.get(params.sessionID);
    const effectiveDir = params.directory || session?.directory || "";
    const effectiveModel = params.model ?? session?.model ?? this.model;
    const effectiveSystem = params.system ?? session?.system;
    const combinedPrompt = effectiveSystem
      ? `${effectiveSystem}\n\n---\n\n${params.text}`
      : params.text;

    if (params.signal?.aborted) {
      const err = new Error("Aborted");
      this.emit({
        type: "error",
        sessionID: params.sessionID,
        message: "Aborted",
        recoverable: true,
        petId: params.petId,
      });
      return Promise.reject(err);
    }

    this.seq += 1;
    const runId = `codex-run-${Date.now()}-${this.seq}`;
    const args = buildCodexCliArgs({
      prompt: combinedPrompt,
      model: effectiveModel,
      disableMutatingTools: params.disableMutatingTools,
      threadId: session?.threadId,
    });

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let aborted = false;
      let unlisten: (() => void) | undefined;
      const stderrLines: string[] = [];

      const parser = createStreamParser(
        params.sessionID,
        (ev) => {
          this.emit(ev);
          if (params.subagentId) {
            this.emitSubagentProgress(params.sessionID, params.subagentId, ev);
          }
        },
        params.petId
      );

      const cleanup = () => {
        this.activeRuns.delete(runId);
        if (params.signal) {
          params.signal.removeEventListener("abort", onAbortSignal);
        }
        try {
          unlisten?.();
        } catch {
          // Ignore unlisten errors
        }
      };

      const finishReject = (err: Error, emitError = true) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (emitError) {
          this.emit({
            type: "error",
            sessionID: params.sessionID,
            message: err.message,
            recoverable: aborted,
            petId: params.petId,
          });
          if (params.subagentId) {
            this.emit({
              type: "subagent_update",
              sessionID: params.sessionID,
              subagentId: params.subagentId,
              state: aborted ? "idle" : "error",
              statusText: aborted ? "Stopped" : "Error",
              detail: err.message,
            });
          }
        }
        reject(err);
      };

      const abortRun = (): Promise<void> => {
        if (settled || aborted) return Promise.resolve();
        aborted = true;
        const killPromise = this.runner.kill(runId).catch(() => {});
        finishReject(new Error("Aborted"), true);
        return killPromise;
      };

      const onAbortSignal = () => {
        void abortRun();
      };

      this.activeRuns.set(runId, {
        runId,
        sessionID: params.sessionID,
        abort: abortRun,
      });

      if (params.signal) {
        params.signal.addEventListener("abort", onAbortSignal, { once: true });
      }

      void this.runner
        .spawn(
          {
            runId,
            binary: "codex",
            args,
            cwd: effectiveDir,
            cliPath: this.cliPath,
          },
          (payload) => {
            if (settled) return;
            if (payload.stream === "stdout") {
              for (const line of payload.line.split(/\r?\n/)) {
                if (line.trim()) {
                  parser.feedLine(line);
                }
              }
              if (parser.state.threadId && session) {
                session.threadId = parser.state.threadId;
              }
              return;
            }

            if (payload.stream === "stderr") {
              if (payload.line.trim()) {
                stderrLines.push(payload.line);
              }
              return;
            }

            if (payload.stream === "error") {
              finishReject(new Error(payload.error || "CLI stream error"), true);
              return;
            }

            if (payload.stream === "exit") {
              if (aborted) {
                finishReject(new Error("Aborted"), true);
                return;
              }

              const exitCode = payload.code;
              if ((exitCode !== null && exitCode !== 0) || payload.error) {
                const msg =
                  parser.state.turnError ||
                  payload.error ||
                  stderrLines.join("\n").trim() ||
                  `Codex CLI exited with code ${exitCode}`;
                finishReject(new Error(msg), !parser.state.turnError);
                return;
              }

              if (parser.state.turnError) {
                finishReject(new Error(parser.state.turnError), false);
                return;
              }

              settled = true;
              cleanup();
              if (!parser.state.completedEmitted) {
                this.emit({
                  type: "completed",
                  sessionID: params.sessionID,
                  text: parser.state.accumulatedText,
                  petId: params.petId,
                });
                if (params.subagentId) {
                  this.emit({
                    type: "subagent_update",
                    sessionID: params.sessionID,
                    subagentId: params.subagentId,
                    state: "idle",
                    statusText: "Done",
                  });
                }
              }
              resolve(parser.state.accumulatedText);
            }
          }
        )
        .then((fn) => {
          if (settled) {
            fn();
            if (aborted) {
              void this.runner.kill(runId).catch(() => {});
            }
          } else {
            unlisten = fn;
          }
        })
        .catch((err) => {
          finishReject(err instanceof Error ? err : new Error(String(err)), true);
        });
    });
  }

  private emitSubagentProgress(
    sessionID: string,
    subagentId: string,
    ev: NormalizedAgentEvent
  ): void {
    switch (ev.type) {
      case "thought":
        this.emit({
          type: "subagent_update",
          sessionID,
          subagentId,
          state: "work",
          statusText: "Thinking...",
        });
        break;
      case "tool_start":
        this.emit({
          type: "subagent_update",
          sessionID,
          subagentId,
          state: "work",
          statusText: formatToolVerb(ev.toolName),
          detail: ev.detail,
        });
        break;
      case "completed":
        this.emit({
          type: "subagent_update",
          sessionID,
          subagentId,
          state: "idle",
          statusText: "Done",
        });
        break;
      case "error":
        if (!ev.recoverable) {
          this.emit({
            type: "subagent_update",
            sessionID,
            subagentId,
            state: "error",
            statusText: "Error",
            detail: ev.message,
          });
        }
        break;
      default:
        break;
    }
  }

  async sendPrompt(opts: BackendPromptOptions): Promise<string> {
    return this.runCliPrompt({
      sessionID: opts.sessionID,
      directory: opts.directory,
      text: opts.text,
      system: opts.system,
      model: opts.model,
      disableMutatingTools: opts.disableMutatingTools,
      signal: opts.signal,
      petId: opts.petId,
    });
  }

  async spawnSubagent(opts: BackendSubagentOptions): Promise<string> {
    const sessionID =
      opts.sessionID ??
      (await this.createSession({
        directory: opts.directory,
        parentID: opts.parentID,
        title: `${opts.role}: ${opts.title}`,
        model: opts.model,
        system: opts.system,
      }));

    this.emit({
      type: "subagent_spawn",
      sessionID,
      subagentId: opts.subagentId,
      role: opts.role,
      title: opts.title,
      directory: opts.directory,
    });

    return this.runCliPrompt({
      sessionID,
      directory: opts.directory,
      text: opts.prompt,
      system: opts.system,
      model: opts.model,
      disableMutatingTools: opts.disableMutatingTools,
      signal: opts.signal,
      petId: opts.subagentId,
      subagentId: opts.subagentId,
    });
  }

  async respondToPermission(_reply: BackendPermissionReply): Promise<void> {
    // `codex exec` runs non-interactively without an interactive permission reply channel.
  }

  async abort(sessionID?: string): Promise<void> {
    const matching = [...this.activeRuns.values()].filter(
      (run) => !sessionID || run.sessionID === sessionID
    );
    await Promise.allSettled(matching.map((run) => run.abort()));
  }
}
