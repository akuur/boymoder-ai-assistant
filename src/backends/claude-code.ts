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

export interface ClaudeCodeBackendOptions {
  model?: string;
  cliPath?: string;
  runner?: CliRunner;
}

interface ClaudeSessionState {
  directory: string;
  model?: string;
  system?: string;
  cliSessionId?: string;
}

interface ActiveRun {
  runId: string;
  sessionID: string;
  abort: () => Promise<void>;
}

export interface ClaudeStreamParserState {
  cliSessionId?: string;
  model?: string;
  committedText: string;
  turnStreamedText: string;
  resultText?: string;
  resultError?: string;
  completedEmitted: boolean;
}

export interface ClaudeStreamParser {
  readonly state: ClaudeStreamParserState;
  feedLine(line: string): NormalizedAgentEvent[];
}

function summarizeInput(input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === "string") return input.slice(0, 140);
  if (typeof input !== "object") return String(input);
  const rec = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "description"]) {
    const val = rec[key];
    if (typeof val === "string" && val.trim()) {
      return val.trim().slice(0, 140);
    }
  }
  try {
    const json = JSON.stringify(rec);
    return json.length > 140 ? `${json.slice(0, 137)}...` : json;
  } catch {
    return undefined;
  }
}

function extractToolResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
    } else if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      if (rec.type === "text" && typeof rec.text === "string") {
        parts.push(rec.text);
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function extractClaudeError(obj: Record<string, unknown>): string {
  if (typeof obj.result === "string" && obj.result.trim()) return obj.result.trim();
  if (typeof obj.error === "string" && obj.error.trim()) return obj.error.trim();
  if (obj.error && typeof obj.error === "object") {
    const errObj = obj.error as Record<string, unknown>;
    if (typeof errObj.message === "string" && errObj.message.trim()) return errObj.message.trim();
  }
  if (Array.isArray(obj.errors) && obj.errors.length > 0) {
    const first = obj.errors[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && typeof (first as { message?: unknown }).message === "string") {
      return String((first as { message: string }).message);
    }
  }
  if (typeof obj.message === "string" && obj.message.trim()) return obj.message.trim();
  return "Claude Code execution failed";
}

function extractClaudeUsage(
  obj: Record<string, unknown>
): { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cost?: number } | undefined {
  const usage = obj.usage && typeof obj.usage === "object" ? (obj.usage as Record<string, unknown>) : undefined;
  const cost =
    typeof obj.total_cost_usd === "number"
      ? obj.total_cost_usd
      : typeof obj.cost_usd === "number"
        ? obj.cost_usd
        : undefined;
  if (!usage && cost === undefined) return undefined;
  return {
    inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : undefined,
    outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : undefined,
    reasoningTokens: typeof usage?.reasoning_tokens === "number" ? usage.reasoning_tokens : undefined,
    cost,
  };
}

function formatToolVerb(toolName: string): string {
  const t = toolName.toLowerCase();
  if (t.includes("edit") || t.includes("write") || t.includes("patch")) return "Building...";
  if (t.includes("bash") || t.includes("shell") || t.includes("test") || t.includes("run")) return "Debugging...";
  if (t.includes("read") || t.includes("grep") || t.includes("glob") || t.includes("find")) return "Inspecting...";
  return `Running ${toolName}...`;
}

export function buildClaudeCliArgs(params: {
  prompt: string;
  system?: string;
  disableMutatingTools?: boolean;
  model?: string;
  resumeSessionId?: string;
}): string[] {
  return [
    "-p",
    params.prompt,
    "--verbose",
    "--output-format",
    "stream-json",
    ...(params.resumeSessionId ? ["--resume", params.resumeSessionId] : []),
    ...(params.system ? ["--append-system-prompt", params.system] : []),
    ...(params.disableMutatingTools ? ["--permission-mode", "plan"] : []),
    ...(params.model ? ["--model", params.model] : []),
  ];
}

export function createStreamParser(
  sessionID: string,
  emit: (event: NormalizedAgentEvent) => void,
  petId?: string
): ClaudeStreamParser {
  const state: ClaudeStreamParserState = {
    committedText: "",
    turnStreamedText: "",
    completedEmitted: false,
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
        message: `Malformed Claude stream-json line: ${msg}`,
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
      case "system": {
        if (obj.subtype === "init" || typeof obj.session_id === "string") {
          if (typeof obj.session_id === "string") state.cliSessionId = obj.session_id;
          if (typeof obj.model === "string") state.model = obj.model;
        }
        break;
      }

      case "assistant": {
        const message =
          obj.message && typeof obj.message === "object"
            ? (obj.message as Record<string, unknown>)
            : undefined;
        const content = Array.isArray(message?.content) ? message.content : [];
        for (const rawBlock of content) {
          if (!rawBlock || typeof rawBlock !== "object") continue;
          const block = rawBlock as Record<string, unknown>;
          if (block.type === "thinking" && typeof block.thinking === "string") {
            push({ type: "thought", sessionID, text: block.thinking, petId });
          } else if (block.type === "text" && typeof block.text === "string") {
            state.committedText += block.text;
            state.turnStreamedText = "";
            push({ type: "text_delta", sessionID, delta: block.text, petId });
          } else if (block.type === "tool_use") {
            push({
              type: "tool_start",
              sessionID,
              toolName: String(block.name ?? "tool"),
              toolId: typeof block.id === "string" ? block.id : undefined,
              detail: summarizeInput(block.input),
              petId,
            });
          }
        }
        break;
      }

      case "stream_event": {
        const ev =
          obj.event && typeof obj.event === "object"
            ? (obj.event as Record<string, unknown>)
            : obj;
        if (ev.type === "content_block_delta" && ev.delta && typeof ev.delta === "object") {
          const delta = ev.delta as Record<string, unknown>;
          if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
            push({ type: "thought", sessionID, text: delta.thinking, petId });
          } else if (delta.type === "text_delta" && typeof delta.text === "string") {
            state.turnStreamedText += delta.text;
            push({ type: "text_delta", sessionID, delta: delta.text, petId });
          }
        } else if (
          ev.type === "content_block_start" &&
          ev.content_block &&
          typeof ev.content_block === "object"
        ) {
          const cb = ev.content_block as Record<string, unknown>;
          if (cb.type === "tool_use") {
            push({
              type: "tool_start",
              sessionID,
              toolName: String(cb.name ?? "tool"),
              toolId: typeof cb.id === "string" ? cb.id : undefined,
              detail: summarizeInput(cb.input),
              petId,
            });
          }
        }
        break;
      }

      case "user": {
        const message =
          obj.message && typeof obj.message === "object"
            ? (obj.message as Record<string, unknown>)
            : undefined;
        const content = Array.isArray(message?.content) ? message.content : [];
        for (const rawBlock of content) {
          if (!rawBlock || typeof rawBlock !== "object") continue;
          const block = rawBlock as Record<string, unknown>;
          if (block.type === "tool_result") {
            push({
              type: "tool_end",
              sessionID,
              toolId: typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
              success: !block.is_error,
              output: extractToolResultText(block.content),
              petId,
            });
          }
        }
        break;
      }

      case "permission_request":
      case "control_request": {
        const req =
          obj.request && typeof obj.request === "object"
            ? (obj.request as Record<string, unknown>)
            : undefined;
        const isPermission =
          obj.type === "permission_request" ||
          req?.subtype === "can_use_tool" ||
          typeof req?.tool_name === "string" ||
          typeof req?.permission === "string";
        if (!isPermission) break;

        const requestId = String(
          obj.request_id ?? obj.id ?? req?.request_id ?? `perm-${Date.now()}`
        );
        const permission = String(
          obj.permission ?? req?.tool_name ?? req?.permission ?? "permission"
        );
        let patterns: string[] = [];
        if (Array.isArray(obj.patterns)) {
          patterns = obj.patterns.map(String);
        } else if (Array.isArray(req?.patterns)) {
          patterns = req.patterns.map(String);
        } else if (req?.input !== undefined) {
          const summary = summarizeInput(req.input);
          if (summary) patterns = [summary];
        }
        const detail = String(
          obj.detail ??
            obj.message ??
            req?.detail ??
            req?.message ??
            (patterns.length > 0 ? `${permission}: ${patterns.join(", ")}` : `${permission} requested`)
        );
        push({
          type: "permission_request",
          sessionID,
          requestId,
          permission,
          patterns,
          detail,
          petId,
        });
        break;
      }

      case "result": {
        if (obj.is_error) {
          const message = extractClaudeError(obj);
          state.resultError = message;
          push({ type: "error", sessionID, message, recoverable: false, petId });
        } else {
          const accumulated = `${state.committedText}${state.turnStreamedText}`;
          const finalText = typeof obj.result === "string" ? obj.result : accumulated;
          state.resultText = finalText;
          state.completedEmitted = true;
          push({
            type: "completed",
            sessionID,
            text: finalText,
            usage: extractClaudeUsage(obj),
            petId,
          });
        }
        break;
      }

      case "error": {
        const message = extractClaudeError(obj);
        state.resultError = message;
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

export function parseStreamJsonLine(
  line: string,
  sessionID: string,
  petId?: string
): NormalizedAgentEvent[] {
  const events: NormalizedAgentEvent[] = [];
  const parser = createStreamParser(sessionID, (ev) => events.push(ev), petId);
  parser.feedLine(line);
  return events;
}

export class ClaudeCodeBackend implements AgentBackend {
  readonly id = "claude-code" as const;
  readonly label = "Claude Code";

  private model?: string;
  private cliPath?: string;
  private runner: CliRunner;
  private listeners = new Set<(event: NormalizedAgentEvent) => void>();
  private sessions = new Map<string, ClaudeSessionState>();
  private activeRuns = new Map<string, ActiveRun>();
  private seq = 0;

  constructor(options?: ClaudeCodeBackendOptions) {
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
      const res = await this.runner.checkAvailability("claude", this.cliPath);
      return {
        backend: "claude-code",
        available: Boolean(res.available),
        label: this.label,
        binary: "claude",
        path: res.path ?? null,
        version: res.version,
        error: res.error,
      };
    } catch (err) {
      return {
        backend: "claude-code",
        available: false,
        label: this.label,
        binary: "claude",
        path: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async createSession(opts: BackendSessionOptions): Promise<string> {
    this.seq += 1;
    const sessionID = `claude-${Date.now()}-${this.seq}`;
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
    prompt: string;
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
    const runId = `claude-run-${Date.now()}-${this.seq}`;
    const args = buildClaudeCliArgs({
      prompt: params.prompt,
      system: effectiveSystem,
      disableMutatingTools: params.disableMutatingTools,
      model: effectiveModel,
      resumeSessionId: session?.cliSessionId,
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
            binary: "claude",
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
              if (parser.state.cliSessionId && session) {
                session.cliSessionId = parser.state.cliSessionId;
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
                  parser.state.resultError ||
                  payload.error ||
                  stderrLines.join("\n").trim() ||
                  `Claude Code exited with code ${exitCode}`;
                // Only emit error if parser did not already emit a fatal error from result/error JSON
                finishReject(new Error(msg), !parser.state.resultError);
                return;
              }

              if (parser.state.resultError) {
                finishReject(new Error(parser.state.resultError), false);
                return;
              }

              settled = true;
              cleanup();
              const finalText =
                parser.state.resultText ??
                `${parser.state.committedText}${parser.state.turnStreamedText}`;
              if (!parser.state.completedEmitted) {
                this.emit({
                  type: "completed",
                  sessionID: params.sessionID,
                  text: finalText,
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
              resolve(finalText);
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
      case "permission_request":
        this.emit({
          type: "subagent_update",
          sessionID,
          subagentId,
          state: "alert",
          statusText: "Needs approval",
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
      prompt: opts.text,
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
      prompt: opts.prompt,
      system: opts.system,
      model: opts.model,
      disableMutatingTools: opts.disableMutatingTools,
      signal: opts.signal,
      petId: opts.subagentId,
      subagentId: opts.subagentId,
    });
  }

  async respondToPermission(_reply: BackendPermissionReply): Promise<void> {
    // Headless `claude -p` runs without interactive stdin control channel in this runner.
  }

  async abort(sessionID?: string): Promise<void> {
    const matching = [...this.activeRuns.values()].filter(
      (run) => !sessionID || run.sessionID === sessionID
    );
    await Promise.allSettled(matching.map((run) => run.abort()));
  }
}
