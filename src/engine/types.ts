export type BackendId = "opencode" | "claude-code" | "codex-cli" | "openai-compat";

export interface BackendAvailability {
  backend: BackendId;
  available: boolean;
  label: string;
  binary?: string;
  path?: string | null;
  version?: string;
  error?: string;
}

export interface BackendConfig {
  serverUrl?: string; // opencode
  baseUrl?: string;   // openai-compat (e.g. "http://127.0.0.1:8000/v1" or "http://127.0.0.1:11434/v1")
  apiKey?: string;    // openai-compat
  model?: string;     // claude-code / codex-cli / openai-compat
  cliPath?: string;   // optional custom directory or path hint
}

export type PetRoleKind = "orchestrator" | "subagent";

export type PetAnimState =
  | "idle"
  | "walk"
  | "work"
  | "fall"
  | "sit"
  | "sleep"
  | "happy"
  | "phone"
  | "chat"
  | "alert"
  | "error";

export type ExecutionMode = "build" | "plan" | "orchestration";

export type OrchestratorPhase =
  | "idle"
  | "planning"
  | "executing"
  | "error";

export interface SubtaskPlanItem {
  id: string;
  role: string;
  title: string;
  prompt: string;
  branch_or_scope?: string;
}

export interface PendingPermission {
  requestId: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  detail: string;
  directory: string;
  isV2?: boolean;
}

export interface PetEntity {
  id: string;
  sessionID: string | null;
  kind: PetRoleKind;
  role: string;
  title: string;
  state: PetAnimState;
  statusText: string;
  bubbleText?: string;
  errorText?: string;
  permission?: PendingPermission;
  directory: string;
  repoDir?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  completed?: boolean;
  lastOutput?: string;
  spriteVariant?: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: "info" | "warn" | "error" | "success";
  source: string;
  message: string;
}

export interface PetSpritePack {
  rootPath: string;
  orchestrator: Record<string, string>;
  subagents: Record<string, Record<string, string>>;
}

export interface ModelOption {
  id: string;
  providerID: string;
  providerName: string;
  name: string;
  variants: string[];
}

export interface SelectedModelRef {
  id: string;
  providerID: string;
  variant?: string;
}

export interface SessionStatsData {
  range?: { from: number; to: number };
  sessions: number;
  subagents: number;
  prompts: number;
  steps: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache?: { read: number; write: number };
  };
  cost: number;
  tools?: {
    totals?: {
      calls: number;
      succeeded: number;
      failed: number;
      unfinished: number;
    };
  };
  activeDays: number;
  streak: number;
  activity: Array<{ date: string; steps: number }>;
  models: Array<{
    model: { id: string; providerID: string; variant?: string };
    steps: number;
    tokens: {
      input: number;
      output: number;
      reasoning: number;
      cache?: { read: number; write: number };
    };
    cost: number;
  }>;
}

export interface ChatTurnSubagent {
  id: string;
  role: string;
  title: string;
  statusText: string;
  worktreeBranch?: string;
  lastOutput?: string;
  errorText?: string;
  spriteVariant?: string;
}

export interface ChatTurn {
  id: string;
  userText: string;
  mode: ExecutionMode;
  assistantReply?: string;
  errorText?: string;
  planItems: SubtaskPlanItem[];
  planDurationMs?: number;
  subagents: ChatTurnSubagent[];
}

export interface OrchestratorSnapshot {
  connected: boolean;
  serverHealthy: boolean;
  serverUrl: string;
  workspaceDir: string;
  isGitRepo: boolean;
  useWorktrees: boolean;
  mode: ExecutionMode;
  freeRoam: boolean;
  alwaysOnTop: boolean;
  petScale: number;
  forceInteractiveOverlay: boolean;
  availableModels: ModelOption[];
  selectedModel?: SelectedModelRef;
  tokensPerSec: number | null;
  totalTokens: number;
  streamingActive: boolean;
  phase: OrchestratorPhase;
  chatId: string;
  sessionID: string | null;
  turns: ChatTurn[];
  currentRunId?: string;
  currentGoal?: string;
  assistantReply?: string;
  planItems: SubtaskPlanItem[];
  planStartedAt?: number;
  planDurationMs?: number;
  orchestrator: PetEntity;
  subagents: PetEntity[];
  logs: LogEntry[];
  activePermissions: PendingPermission[];
  activeBackend?: BackendId;
  backendAvailability?: Record<BackendId, BackendAvailability>;
  backendConfigs?: Record<BackendId, BackendConfig>;
}

export type OverlayAction =
  | { type: "ready" }
  | { type: "recall" }
  | {
      type: "permission-reply";
      sessionID: string;
      requestId: string;
      reply: "once" | "always" | "reject";
    }
  | { type: "dismiss-bubble"; petId: string };
