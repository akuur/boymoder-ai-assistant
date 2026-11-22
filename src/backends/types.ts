import type {
  BackendAvailability,
  BackendConfig,
  BackendId,
  SelectedModelRef,
} from "../engine/types.ts";

export type { BackendAvailability, BackendConfig, BackendId };

export type NormalizedAgentEvent =
  | { type: "thought"; sessionID: string; text: string; petId?: string }
  | { type: "text_delta"; sessionID: string; delta: string; petId?: string }
  | { type: "tool_start"; sessionID: string; toolName: string; detail?: string; toolId?: string; petId?: string }
  | { type: "tool_end"; sessionID: string; toolName?: string; toolId?: string; success?: boolean; output?: string; petId?: string }
  | {
      type: "permission_request";
      sessionID: string;
      requestId: string;
      permission: string;
      patterns: string[];
      detail: string;
      directory?: string;
      isV2?: boolean;
      petId?: string;
    }
  | { type: "subagent_spawn"; sessionID: string; subagentId: string; role: string; title: string; directory?: string }
  | {
      type: "subagent_update";
      sessionID: string;
      subagentId: string;
      state?: "work" | "alert" | "happy" | "error" | "idle";
      statusText?: string;
      detail?: string;
    }
  | {
      type: "completed";
      sessionID: string;
      text: string;
      usage?: { inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cost?: number };
      petId?: string;
    }
  | { type: "error"; sessionID: string; message: string; recoverable?: boolean; petId?: string };

export interface BackendSessionOptions {
  directory?: string;
  parentID?: string;
  title: string;
  model?: SelectedModelRef | string;
  system?: string;
}

export interface BackendPromptOptions {
  sessionID: string;
  directory: string;
  text: string;
  system?: string;
  model?: string;
  disableMutatingTools?: boolean;
  signal?: AbortSignal;
  petId?: string;
  waitForIdle?: (sessionID: string) => Promise<void>;
}

export interface BackendSubagentOptions {
  sessionID?: string;
  parentID?: string;
  subagentId: string;
  role: string;
  title: string;
  directory: string;
  prompt: string;
  system?: string;
  model?: string;
  disableMutatingTools?: boolean;
  signal?: AbortSignal;
}

export interface BackendPermissionReply {
  sessionID: string;
  requestId: string;
  reply: "once" | "always" | "reject";
  directory: string;
  isV2?: boolean;
  message?: string;
}

export interface AgentBackend {
  readonly id: BackendId;
  readonly label: string;
  checkAvailability(): Promise<BackendAvailability>;
  createSession(opts: BackendSessionOptions): Promise<string>;
  sendPrompt(opts: BackendPromptOptions): Promise<string>;
  spawnSubagent(opts: BackendSubagentOptions): Promise<string>;
  respondToPermission(reply: BackendPermissionReply): Promise<void>;
  abort(sessionID?: string): Promise<void>;
  subscribe?(onEvent: (event: NormalizedAgentEvent) => void): () => void;
}

export interface CliAvailabilityResult {
  available: boolean;
  binary: string;
  path?: string | null;
  version?: string;
  error?: string;
}

export interface CliSpawnOptions {
  runId: string;
  binary: string;
  args: string[];
  cwd: string;
  cliPath?: string;
  env?: Record<string, string>;
}

export type CliStreamPayload =
  | { stream: "stdout"; line: string }
  | { stream: "stderr"; line: string }
  | { stream: "exit"; code: number | null; signal?: string | null; error?: string }
  | { stream: "error"; error?: string | null };

export interface CliRunner {
  checkAvailability(binary: string, cliPath?: string): Promise<CliAvailabilityResult>;
  spawn(
    opts: CliSpawnOptions,
    onPayload: (payload: CliStreamPayload) => void
  ): Promise<() => void>;
  kill(runId: string): Promise<void>;
}

export class TauriCliRunner implements CliRunner {
  async checkAvailability(binary: string, cliPath?: string): Promise<CliAvailabilityResult> {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<CliAvailabilityResult>("check_agent_cli_availability", {
        binary,
        customDir: cliPath?.trim() || null,
      });
    } catch (err) {
      return {
        available: false,
        binary,
        path: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async spawn(
    opts: CliSpawnOptions,
    onPayload: (payload: CliStreamPayload) => void
  ): Promise<() => void> {
    const [{ invoke }, { listen }] = await Promise.all([
      import("@tauri-apps/api/core"),
      import("@tauri-apps/api/event"),
    ]);

    const unlisten = await listen<CliStreamPayload>(
      `cli-stream:${opts.runId}`,
      (event) => {
        if (event.payload) {
          onPayload(event.payload);
        }
      }
    );

    try {
      await invoke("spawn_agent_cli", {
        runId: opts.runId,
        binary: opts.binary,
        args: opts.args,
        cwd: opts.cwd,
        customDir: opts.cliPath?.trim() || null,
      });
    } catch (err) {
      unlisten();
      throw err;
    }

    return unlisten;
  }

  async kill(runId: string): Promise<void> {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("kill_agent_cli", { runId });
  }
}
