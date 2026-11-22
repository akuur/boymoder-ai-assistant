import { OpenCodeConnection, type AnyOpencodeEvent } from "../engine/opencode-client.ts";
import type { SelectedModelRef } from "../engine/types.ts";
import type {
  AgentBackend,
  BackendAvailability,
  BackendPermissionReply,
  BackendPromptOptions,
  BackendSessionOptions,
  BackendSubagentOptions,
  NormalizedAgentEvent,
} from "./types.ts";

export interface OpenCodeBackendOptions {
  serverUrl?: string;
  connection?: OpenCodeConnection;
}

export function normalizeOpencodeEvent(event: AnyOpencodeEvent): NormalizedAgentEvent[] {
  const raw = event as {
    type?: string;
    data?: Record<string, unknown>;
    properties?: Record<string, unknown>;
  };
  const type = raw.type ?? "";
  const props = raw.data ?? raw.properties ?? {};
  const sessionID = typeof props.sessionID === "string" ? props.sessionID : "";

  switch (type) {
    case "session.text.delta": {
      const delta = typeof props.delta === "string" ? props.delta : "";
      if (!sessionID || !delta) return [];
      return [{ type: "text_delta", sessionID, delta }];
    }

    case "session.reasoning.delta": {
      const text = typeof props.delta === "string" ? props.delta : "";
      if (!sessionID || !text) return [];
      return [{ type: "thought", sessionID, text }];
    }

    case "session.step.ended": {
      if (!sessionID) return [];
      const tokens = props.tokens as
        | { input?: number; output?: number; reasoning?: number; cost?: number }
        | undefined;
      if (!tokens) return [];
      return [
        {
          type: "completed",
          sessionID,
          text: "",
          usage: {
            inputTokens: tokens.input,
            outputTokens: tokens.output,
            reasoningTokens: tokens.reasoning,
            cost: tokens.cost,
          },
        },
      ];
    }

    case "session.status": {
      if (!sessionID) return [];
      const status = props.status as { type?: string; message?: string } | undefined;
      if (status?.type === "idle") {
        return [{ type: "completed", sessionID, text: "" }];
      }
      if (status?.type === "retry") {
        return [
          {
            type: "error",
            sessionID,
            message: status.message ? `Retrying: ${status.message}` : "Retrying...",
            recoverable: true,
          },
        ];
      }
      return [];
    }

    case "session.idle":
    case "session.execution.succeeded": {
      if (!sessionID) return [];
      return [{ type: "completed", sessionID, text: "" }];
    }

    case "session.execution.interrupted": {
      if (!sessionID) return [];
      return [
        {
          type: "error",
          sessionID,
          message: "Interrupted",
          recoverable: true,
        },
      ];
    }

    case "session.error":
    case "session.execution.failed":
    case "session.step.failed": {
      if (!sessionID) return [];
      const errObj = props.error as { message?: string; name?: string } | undefined;
      if (errObj?.name === "MessageAbortedError") {
        return [];
      }
      const message =
        errObj?.message ??
        errObj?.name ??
        (errObj ? JSON.stringify(errObj) : "Session error");
      return [{ type: "error", sessionID, message, recoverable: false }];
    }

    case "permission.asked":
    case "permission.v2.asked": {
      const p = props as {
        id?: string;
        sessionID?: string;
        permission?: string;
        patterns?: string[];
        action?: string;
        resources?: string[];
        message?: string;
      };
      if (!p.id || !p.sessionID) return [];
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
      return [
        {
          type: "permission_request",
          sessionID: p.sessionID,
          requestId: p.id,
          permission: actionName,
          patterns,
          detail,
          isV2: type === "permission.v2.asked" || Boolean(p.action),
        },
      ];
    }

    case "message.part.updated": {
      const part = props.part as
        | {
            id?: string;
            callID?: string;
            sessionID?: string;
            type?: string;
            tool?: string;
            state?: { status?: string; output?: string; error?: string };
          }
        | undefined;
      if (!part?.sessionID) return [];
      if (part.type === "tool" && part.tool) {
        const status = part.state?.status;
        if (status === "completed" || status === "error") {
          return [
            {
              type: "tool_end",
              sessionID: part.sessionID,
              toolName: part.tool,
              toolId: part.callID ?? part.id,
              success: status !== "error",
              output: part.state?.output ?? part.state?.error,
            },
          ];
        }
        return [
          {
            type: "tool_start",
            sessionID: part.sessionID,
            toolName: part.tool,
            toolId: part.callID ?? part.id,
          },
        ];
      }
      return [];
    }

    case "session.tool.input.started":
    case "session.tool.called":
    case "session.next.tool.called": {
      if (!sessionID) return [];
      const toolName = String(props.name ?? props.tool ?? "tool");
      const toolId =
        typeof props.callID === "string"
          ? props.callID
          : typeof props.id === "string"
            ? props.id
            : undefined;
      return [{ type: "tool_start", sessionID, toolName, toolId }];
    }

    default:
      return [];
  }
}

export class OpenCodeBackend implements AgentBackend {
  readonly id = "opencode" as const;
  readonly label = "OpenCode";

  private connection: OpenCodeConnection;
  private listeners = new Set<(event: NormalizedAgentEvent) => void>();
  private sessionDirs = new Map<string, string>();
  private sseControllers = new Map<string, AbortController>();

  constructor(urlOrOptions?: string | OpenCodeBackendOptions) {
    if (typeof urlOrOptions === "string") {
      this.connection = new OpenCodeConnection(urlOrOptions);
    } else if (urlOrOptions?.connection) {
      this.connection = urlOrOptions.connection;
    } else {
      this.connection = new OpenCodeConnection(urlOrOptions?.serverUrl);
    }
  }

  getConnection(): OpenCodeConnection {
    return this.connection;
  }

  setServerUrl(serverUrl: string): void {
    this.connection.setBaseUrl(serverUrl);
  }

  private emit(event: NormalizedAgentEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  emitOpencodeEvent(event: AnyOpencodeEvent): void {
    for (const normalized of normalizeOpencodeEvent(event)) {
      this.emit(normalized);
    }
  }

  subscribe(onEvent: (event: NormalizedAgentEvent) => void): () => void {
    this.listeners.add(onEvent);
    return () => {
      this.listeners.delete(onEvent);
    };
  }

  startEventStream(directory: string, onRawEvent?: (event: AnyOpencodeEvent) => void): () => void {
    const key = this.connection.getApiMode() === "v2" ? "__v2_global__" : directory || "__global__";
    if (!this.sseControllers.has(key)) {
      const ctrl = new AbortController();
      this.sseControllers.set(key, ctrl);
      void this.connection.subscribeEvents(
        directory || ".",
        (ev) => {
          onRawEvent?.(ev);
          this.emitOpencodeEvent(ev);
        },
        (err) => {
          if (!ctrl.signal.aborted) {
            this.emit({
              type: "error",
              sessionID: "",
              message: err instanceof Error ? err.message : String(err),
              recoverable: true,
            });
          }
        },
        ctrl.signal
      );
    }
    return () => {
      const ctrl = this.sseControllers.get(key);
      if (ctrl) {
        ctrl.abort();
        this.sseControllers.delete(key);
      }
    };
  }

  async checkAvailability(): Promise<BackendAvailability> {
    const health = await this.connection.checkHealth();
    return {
      backend: "opencode",
      available: health.healthy,
      label: this.label,
      version: health.version,
      error: health.error,
    };
  }

  async createSession(opts: BackendSessionOptions): Promise<string> {
    let model: SelectedModelRef | undefined;
    if (opts.model && typeof opts.model === "object") {
      model = opts.model;
    } else if (typeof opts.model === "string" && opts.model.includes("/")) {
      const [providerID, ...rest] = opts.model.split("/");
      const id = rest.join("/");
      if (providerID && id) {
        model = { providerID, id };
      }
    }

    const sessionID = await this.connection.createSession({
      directory: opts.directory,
      parentID: opts.parentID,
      title: opts.title,
      model,
    });
    this.sessionDirs.set(sessionID, opts.directory ?? "");
    return sessionID;
  }

  async sendPrompt(opts: BackendPromptOptions): Promise<string> {
    if (opts.directory) {
      this.sessionDirs.set(opts.sessionID, opts.directory);
    }
    try {
      const text = await this.connection.promptAndWaitText({
        sessionID: opts.sessionID,
        directory: opts.directory,
        text: opts.text,
        system: opts.system,
        disableMutatingTools: opts.disableMutatingTools,
        waitForIdle: opts.waitForIdle,
      });
      this.emit({
        type: "completed",
        sessionID: opts.sessionID,
        text,
        petId: opts.petId,
      });
      return text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({
        type: "error",
        sessionID: opts.sessionID,
        message,
        petId: opts.petId,
      });
      throw err;
    }
  }

  async spawnSubagent(opts: BackendSubagentOptions): Promise<string> {
    const sessionID =
      opts.sessionID ??
      (await this.createSession({
        directory: opts.directory,
        parentID: opts.parentID,
        title: `${opts.role}: ${opts.title}`,
        model: opts.model,
      }));
    this.sessionDirs.set(sessionID, opts.directory);

    this.emit({
      type: "subagent_spawn",
      sessionID,
      subagentId: opts.subagentId,
      role: opts.role,
      title: opts.title,
      directory: opts.directory,
    });

    try {
      const text = await this.connection.promptAndWaitText({
        sessionID,
        directory: opts.directory,
        text: opts.prompt,
        system: opts.system,
        disableMutatingTools: opts.disableMutatingTools,
      });
      this.emit({
        type: "subagent_update",
        sessionID,
        subagentId: opts.subagentId,
        state: "idle",
        statusText: "Done",
      });
      this.emit({
        type: "completed",
        sessionID,
        text,
        petId: opts.subagentId,
      });
      return text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({
        type: "subagent_update",
        sessionID,
        subagentId: opts.subagentId,
        state: "error",
        statusText: "Error",
        detail: message,
      });
      this.emit({
        type: "error",
        sessionID,
        message,
        petId: opts.subagentId,
      });
      throw err;
    }
  }

  async respondToPermission(reply: BackendPermissionReply): Promise<void> {
    await this.connection.replyPermission({
      sessionID: reply.sessionID,
      requestID: reply.requestId,
      reply: reply.reply,
      directory: reply.directory,
      isV2: reply.isV2,
      message: reply.message,
    });
  }

  async abort(sessionID?: string): Promise<void> {
    if (sessionID) {
      const dir = this.sessionDirs.get(sessionID) ?? "";
      await this.connection.abortSession(sessionID, dir);
      return;
    }

    const entries = [...this.sessionDirs.entries()];
    await Promise.allSettled(
      entries.map(([sid, dir]) => this.connection.abortSession(sid, dir))
    );
  }
}
