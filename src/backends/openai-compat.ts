import type {
  AgentBackend,
  BackendAvailability,
  BackendPermissionReply,
  BackendPromptOptions,
  BackendSessionOptions,
  BackendSubagentOptions,
  NormalizedAgentEvent,
} from "./types.ts";

export interface OpenAiCompatBackendOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  label?: string;
  fetchFn?: typeof fetch;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAiSessionState {
  directory: string;
  model?: string;
  system?: string;
  messages: ChatMessage[];
}

export interface ThinkTagPiece {
  kind: "thought" | "text";
  value: string;
}

const OPEN_THINK_TAG = "<think>";
const CLOSE_THINK_TAG = "</think>";

function partialTagSuffixLength(text: string, tag: string): number {
  const maxCheck = Math.min(text.length, tag.length - 1);
  for (let len = maxCheck; len > 0; len -= 1) {
    if (text.endsWith(tag.slice(0, len))) {
      return len;
    }
  }
  return 0;
}

export class ThinkTagStreamParser {
  private inThink = false;
  private buffer = "";

  push(chunk: string): ThinkTagPiece[] {
    if (!chunk) return [];
    this.buffer += chunk;
    const pieces: ThinkTagPiece[] = [];

    while (this.buffer.length > 0) {
      if (!this.inThink) {
        const openIdx = this.buffer.indexOf(OPEN_THINK_TAG);
        if (openIdx !== -1) {
          if (openIdx > 0) {
            pieces.push({ kind: "text", value: this.buffer.slice(0, openIdx) });
          }
          this.buffer = this.buffer.slice(openIdx + OPEN_THINK_TAG.length);
          this.inThink = true;
          continue;
        }
        const hold = partialTagSuffixLength(this.buffer, OPEN_THINK_TAG);
        const safeLen = this.buffer.length - hold;
        if (safeLen > 0) {
          pieces.push({ kind: "text", value: this.buffer.slice(0, safeLen) });
          this.buffer = this.buffer.slice(safeLen);
        }
        break;
      } else {
        const closeIdx = this.buffer.indexOf(CLOSE_THINK_TAG);
        if (closeIdx !== -1) {
          if (closeIdx > 0) {
            pieces.push({ kind: "thought", value: this.buffer.slice(0, closeIdx) });
          }
          this.buffer = this.buffer.slice(closeIdx + CLOSE_THINK_TAG.length);
          this.inThink = false;
          continue;
        }
        const hold = partialTagSuffixLength(this.buffer, CLOSE_THINK_TAG);
        const safeLen = this.buffer.length - hold;
        if (safeLen > 0) {
          pieces.push({ kind: "thought", value: this.buffer.slice(0, safeLen) });
          this.buffer = this.buffer.slice(safeLen);
        }
        break;
      }
    }

    return pieces;
  }

  flush(): ThinkTagPiece[] {
    if (!this.buffer) return [];
    const remaining = this.buffer;
    this.buffer = "";
    return [{ kind: this.inThink ? "thought" : "text", value: remaining }];
  }
}

function combineSignals(
  externalSignal: AbortSignal | undefined,
  internalController: AbortController
): () => void {
  if (!externalSignal) return () => {};
  if (externalSignal.aborted) {
    internalController.abort(externalSignal.reason);
    return () => {};
  }
  const onAbort = () => internalController.abort(externalSignal.reason);
  externalSignal.addEventListener("abort", onAbort, { once: true });
  return () => externalSignal.removeEventListener("abort", onAbort);
}

export class OpenAiCompatBackend implements AgentBackend {
  readonly id = "openai-compat" as const;
  readonly label: string;

  private baseUrl: string;
  private apiKey?: string;
  private model?: string;
  private fetchFn: typeof fetch;
  private listeners = new Set<(event: NormalizedAgentEvent) => void>();
  private sessions = new Map<string, OpenAiSessionState>();
  private activeControllers = new Map<string, Set<AbortController>>();
  private seq = 0;

  constructor(options?: OpenAiCompatBackendOptions) {
    this.baseUrl = (options?.baseUrl ?? "").trim().replace(/\/+$/, "");
    this.apiKey = options?.apiKey?.trim() || undefined;
    this.model = options?.model?.trim() || undefined;
    this.label = options?.label ?? "OpenAI-Compatible";
    this.fetchFn = options?.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  setConfig(config: { baseUrl?: string; apiKey?: string; model?: string }): void {
    if (config.baseUrl !== undefined) {
      this.baseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    }
    if (config.apiKey !== undefined) {
      this.apiKey = config.apiKey.trim() || undefined;
    }
    if (config.model !== undefined) {
      this.model = config.model.trim() || undefined;
    }
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

  private buildHeaders(includeJson = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (includeJson) {
      headers["Content-Type"] = "application/json";
    }
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  async checkAvailability(): Promise<BackendAvailability> {
    if (!this.baseUrl) {
      return {
        backend: "openai-compat",
        available: false,
        label: this.label,
        error: "Base URL is not configured",
      };
    }

    try {
      const res = await this.fetchFn(`${this.baseUrl}/models`, {
        method: "GET",
        headers: this.buildHeaders(false),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return {
          backend: "openai-compat",
          available: false,
          label: this.label,
          error: `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
        };
      }
      return {
        backend: "openai-compat",
        available: true,
        label: this.label,
      };
    } catch (err) {
      return {
        backend: "openai-compat",
        available: false,
        label: this.label,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async createSession(opts: BackendSessionOptions): Promise<string> {
    this.seq += 1;
    const sessionID = `openai-${Date.now()}-${this.seq}`;
    const model =
      typeof opts.model === "string"
        ? opts.model
        : opts.model?.id;
    this.sessions.set(sessionID, {
      directory: opts.directory ?? "",
      model,
      system: opts.system,
      messages: [],
    });
    return sessionID;
  }

  private registerController(sessionID: string, controller: AbortController): void {
    let set = this.activeControllers.get(sessionID);
    if (!set) {
      set = new Set();
      this.activeControllers.set(sessionID, set);
    }
    set.add(controller);
  }

  private unregisterController(sessionID: string, controller: AbortController): void {
    const set = this.activeControllers.get(sessionID);
    if (!set) return;
    set.delete(controller);
    if (set.size === 0) {
      this.activeControllers.delete(sessionID);
    }
  }

  private async runChatCompletion(params: {
    sessionID: string;
    text: string;
    system?: string;
    model?: string;
    signal?: AbortSignal;
    petId?: string;
    subagentId?: string;
  }): Promise<string> {
    if (!this.baseUrl) {
      const message = "OpenAI-compatible baseUrl is not configured";
      this.emit({
        type: "error",
        sessionID: params.sessionID,
        message,
        petId: params.petId,
      });
      if (params.subagentId) {
        this.emit({
          type: "subagent_update",
          sessionID: params.sessionID,
          subagentId: params.subagentId,
          state: "error",
          statusText: "Error",
          detail: message,
        });
      }
      throw new Error(message);
    }

    const session = this.sessions.get(params.sessionID);
    const effectiveModel = params.model ?? session?.model ?? this.model ?? "default";
    const effectiveSystem = params.system ?? session?.system;

    const messages: ChatMessage[] = [];
    if (effectiveSystem) {
      messages.push({ role: "system", content: effectiveSystem });
    }
    if (session) {
      messages.push(...session.messages);
    }
    messages.push({ role: "user", content: params.text });

    const controller = new AbortController();
    const detachExternal = combineSignals(params.signal, controller);
    this.registerController(params.sessionID, controller);

    try {
      const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.buildHeaders(true),
        body: JSON.stringify({
          model: effectiveModel,
          stream: true,
          messages,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        let detail = "";
        try {
          detail = (await res.text()).trim();
        } catch {
          // Ignore body read error
        }
        const message = detail
          ? `HTTP ${res.status}: ${detail}`
          : `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
        throw new Error(message);
      }

      const thinkParser = new ThinkTagStreamParser();
      let visibleText = "";
      let usage:
        | { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cost?: number }
        | undefined;

      const emitPieces = (pieces: ThinkTagPiece[]) => {
        for (const piece of pieces) {
          if (!piece.value) continue;
          if (piece.kind === "thought") {
            this.emit({
              type: "thought",
              sessionID: params.sessionID,
              text: piece.value,
              petId: params.petId,
            });
            if (params.subagentId) {
              this.emit({
                type: "subagent_update",
                sessionID: params.sessionID,
                subagentId: params.subagentId,
                state: "work",
                statusText: "Thinking...",
              });
            }
          } else {
            visibleText += piece.value;
            this.emit({
              type: "text_delta",
              sessionID: params.sessionID,
              delta: piece.value,
              petId: params.petId,
            });
            if (params.subagentId) {
              this.emit({
                type: "subagent_update",
                sessionID: params.sessionID,
                subagentId: params.subagentId,
                state: "work",
                statusText: "Writing response...",
              });
            }
          }
        }
      };

      const processSsePayload = (payload: string): boolean => {
        if (payload === "[DONE]") {
          return true;
        }

        let obj: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(payload);
          if (!parsed || typeof parsed !== "object") return false;
          obj = parsed as Record<string, unknown>;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.emit({
            type: "error",
            sessionID: params.sessionID,
            message: `Malformed SSE JSON chunk: ${msg}`,
            recoverable: true,
            petId: params.petId,
          });
          return false;
        }

        if (obj.error) {
          const errObj = obj.error as { message?: string };
          throw new Error(
            typeof errObj?.message === "string" ? errObj.message : JSON.stringify(obj.error)
          );
        }

        if (obj.usage && typeof obj.usage === "object") {
          const u = obj.usage as Record<string, unknown>;
          const details =
            u.completion_tokens_details && typeof u.completion_tokens_details === "object"
              ? (u.completion_tokens_details as Record<string, unknown>)
              : undefined;
          usage = {
            inputTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined,
            outputTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : undefined,
            reasoningTokens:
              typeof details?.reasoning_tokens === "number" ? details.reasoning_tokens : undefined,
          };
        }

        const choices = Array.isArray(obj.choices) ? obj.choices : [];
        const first = choices[0] as Record<string, unknown> | undefined;
        const delta =
          first?.delta && typeof first.delta === "object"
            ? (first.delta as Record<string, unknown>)
            : first?.message && typeof first.message === "object"
              ? (first.message as Record<string, unknown>)
              : undefined;

        if (delta) {
          const reasoning =
            typeof delta.reasoning_content === "string"
              ? delta.reasoning_content
              : typeof delta.reasoning === "string"
                ? delta.reasoning
                : undefined;
          if (reasoning) {
            this.emit({
              type: "thought",
              sessionID: params.sessionID,
              text: reasoning,
              petId: params.petId,
            });
          }

          if (typeof delta.content === "string" && delta.content.length > 0) {
            emitPieces(thinkParser.push(delta.content));
          }
        }

        return false;
      };

      const contentType = res.headers.get("content-type") ?? "";
      if (!res.body || contentType.includes("application/json")) {
        const jsonText = await res.text();
        if (jsonText.trim()) {
          processSsePayload(jsonText.trim());
        }
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let lineBuffer = "";
        let dataLines: string[] = [];
        let sawDone = false;

        const flushEvent = (): boolean => {
          if (dataLines.length === 0) return false;
          const payload = dataLines.join("\n").trim();
          dataLines = [];
          if (!payload) return false;
          return processSsePayload(payload);
        };

        try {
          while (!sawDone) {
            const { value, done } = await reader.read();
            if (done) {
              lineBuffer += decoder.decode();
              break;
            }
            lineBuffer += decoder.decode(value, { stream: true });

            let nlIdx = lineBuffer.indexOf("\n");
            while (nlIdx !== -1) {
              const rawLine = lineBuffer.slice(0, nlIdx).replace(/\r$/, "");
              lineBuffer = lineBuffer.slice(nlIdx + 1);

              if (rawLine === "") {
                if (flushEvent()) {
                  sawDone = true;
                  break;
                }
              } else if (rawLine.startsWith("data:")) {
                dataLines.push(rawLine.slice(5).trimStart());
              }

              nlIdx = lineBuffer.indexOf("\n");
            }
          }

          if (!sawDone) {
            const trailing = lineBuffer.replace(/\r$/, "");
            if (trailing.startsWith("data:")) {
              dataLines.push(trailing.slice(5).trimStart());
            }
            flushEvent();
          }
        } finally {
          if (sawDone) {
            await reader.cancel().catch(() => {});
          }
          reader.releaseLock();
        }
      }

      emitPieces(thinkParser.flush());

      if (session) {
        session.messages.push({ role: "user", content: params.text });
        session.messages.push({ role: "assistant", content: visibleText });
      }

      this.emit({
        type: "completed",
        sessionID: params.sessionID,
        text: visibleText,
        usage,
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

      return visibleText;
    } catch (err) {
      const isAbort =
        controller.signal.aborted ||
        (err instanceof Error && err.name === "AbortError");
      const message = isAbort
        ? "Aborted"
        : err instanceof Error
          ? err.message
          : String(err);

      this.emit({
        type: "error",
        sessionID: params.sessionID,
        message,
        recoverable: isAbort,
        petId: params.petId,
      });

      if (params.subagentId) {
        this.emit({
          type: "subagent_update",
          sessionID: params.sessionID,
          subagentId: params.subagentId,
          state: isAbort ? "idle" : "error",
          statusText: isAbort ? "Stopped" : "Error",
          detail: message,
        });
      }

      throw isAbort ? new Error("Aborted") : err instanceof Error ? err : new Error(message);
    } finally {
      detachExternal();
      this.unregisterController(params.sessionID, controller);
    }
  }

  async sendPrompt(opts: BackendPromptOptions): Promise<string> {
    return this.runChatCompletion({
      sessionID: opts.sessionID,
      text: opts.text,
      system: opts.system,
      model: opts.model,
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

    return this.runChatCompletion({
      sessionID,
      text: opts.prompt,
      system: opts.system,
      model: opts.model,
      signal: opts.signal,
      petId: opts.subagentId,
      subagentId: opts.subagentId,
    });
  }

  async respondToPermission(_reply: BackendPermissionReply): Promise<void> {
    // Direct OpenAI-compatible HTTP chat completions do not execute local tools or ask permissions.
  }

  async abort(sessionID?: string): Promise<void> {
    if (sessionID) {
      const set = this.activeControllers.get(sessionID);
      if (set) {
        for (const ctrl of set) {
          ctrl.abort();
        }
      }
      return;
    }

    for (const set of this.activeControllers.values()) {
      for (const ctrl of set) {
        ctrl.abort();
      }
    }
  }
}
