import {
  createOpencodeClient,
  type Event as OpencodeEvent,
  type OpencodeClient,
  type SessionMessageAssistant,
  type V2Event,
} from "@opencode-ai/sdk/v2/client";
import { invoke } from "@tauri-apps/api/core";
import { extractTextFromParts, extractTextFromV2Content } from "./planner";
import type { ModelOption, SelectedModelRef, SessionStatsData } from "./types";

export type ApiMode = "v2" | "v1";

export interface HealthStatus {
  healthy: boolean;
  version?: string;
  apiMode?: ApiMode;
  unauthorized?: boolean;
  error?: string;
}

interface SpawnServeResult {
  started: boolean;
  pid?: number;
  url: string;
  password?: string | null;
  message: string;
}

export type AnyOpencodeEvent = OpencodeEvent | V2Event;

export class OpenCodeConnection {
  private baseUrl: string;
  private password: string | null = null;
  private apiMode: ApiMode = "v2";
  private client: OpencodeClient;

  constructor(baseUrl = "http://127.0.0.1:4096") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.client = this.buildClient();
  }

  private buildHeaders(): Record<string, string> {
    if (!this.password) return {};
    return {
      Authorization: `Basic ${btoa(`opencode:${this.password}`)}`,
    };
  }

  private buildClient(directory?: string): OpencodeClient {
    return createOpencodeClient({
      baseUrl: this.baseUrl,
      directory,
      headers: this.buildHeaders(),
    });
  }

  setBaseUrl(baseUrl: string): void {
    const cleaned = baseUrl.replace(/\/+$/, "");
    if (cleaned === this.baseUrl) return;
    this.baseUrl = cleaned;
    this.client = this.buildClient();
  }

  setPassword(password: string | null): void {
    this.password = password;
    this.client = this.buildClient();
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getApiMode(): ApiMode {
    return this.apiMode;
  }

  getClient(directory?: string): OpencodeClient {
    if (!directory) return this.client;
    return this.buildClient(directory);
  }

  async checkHealth(): Promise<HealthStatus> {
    const headers = this.buildHeaders();
    try {
      const infoRes = await fetch(`${this.baseUrl}/api/info`, { headers });
      if (infoRes.status === 401) {
        return {
          healthy: false,
          unauthorized: true,
          error:
            "Server returned 401 Unauthorized (managed spawn will use a dedicated authenticated server).",
        };
      }
      const ct = infoRes.headers.get("content-type") ?? "";
      if (infoRes.ok && ct.includes("application/json")) {
        const data = (await infoRes.json()) as { version?: string };
        this.apiMode = "v2";
        return {
          healthy: true,
          version: data.version ?? "v2",
          apiMode: "v2",
        };
      }
    } catch (err) {
      return {
        healthy: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Fallback for older V1 servers
    try {
      const legacyRes = await fetch(`${this.baseUrl}/global/health`, { headers });
      const ct = legacyRes.headers.get("content-type") ?? "";
      if (legacyRes.ok && ct.includes("application/json")) {
        const data = (await legacyRes.json()) as { healthy?: boolean; version?: string };
        if (data.healthy) {
          this.apiMode = "v1";
          return {
            healthy: true,
            version: data.version ?? "v1",
            apiMode: "v1",
          };
        }
      }
    } catch {
      // Ignore fallback error
    }

    return {
      healthy: false,
      error: `No compatible OpenCode API responded on ${this.baseUrl}`,
    };
  }

  async ensureServerRunning(workspaceDir: string): Promise<HealthStatus> {
    const current = await this.checkHealth();
    if (current.healthy) return current;

    let port = 4096;
    try {
      const parsed = new URL(this.baseUrl);
      if (parsed.port) port = Number(parsed.port);
    } catch {
      port = 4096;
    }

    const spawned = await invoke<SpawnServeResult>("spawn_opencode_serve", {
      workspaceDir,
      port,
    });

    if (spawned.url) {
      this.setBaseUrl(spawned.url);
    }
    this.setPassword(spawned.password ?? null);

    const deadline = Date.now() + 10_000;
    let lastStatus: HealthStatus = { healthy: false };
    while (Date.now() < deadline) {
      lastStatus = await this.checkHealth();
      if (lastStatus.healthy) return lastStatus;
      await new Promise((r) => setTimeout(r, 250));
    }

    return {
      healthy: false,
      error:
        lastStatus.error ??
        `Timed out waiting for opencode serve to respond on ${this.baseUrl}`,
    };
  }

  async subscribeEvents(
    directory: string,
    onEvent: (event: AnyOpencodeEvent) => void,
    onError: (err: unknown) => void,
    signal: AbortSignal
  ): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      try {
        const client = this.getClient(directory);
        const { stream } =
          this.apiMode === "v2"
            ? await client.v2.event.subscribe({ signal, sseMaxRetryAttempts: 0 })
            : await client.event.subscribe({ directory }, { signal, sseMaxRetryAttempts: 0 });
        attempt = 0;
        for await (const raw of stream) {
          if (signal.aborted) break;
          if (raw && typeof raw === "object" && "type" in raw) {
            onEvent(raw as AnyOpencodeEvent);
          }
        }
      } catch (err) {
        if (signal.aborted) break;
        onError(err);
      }

      if (signal.aborted) break;
      attempt += 1;
      const delay = Math.min(5000, 500 * attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  async listModels(directory?: string): Promise<{
    models: ModelOption[];
    defaultModel?: SelectedModelRef;
  }> {
    if (this.apiMode !== "v2") {
      return { models: [] };
    }
    const headers = this.buildHeaders();
    const qs = directory ? `?location[directory]=${encodeURIComponent(directory)}` : "";

    const [listRes, defRes, provRes] = await Promise.allSettled([
      fetch(`${this.baseUrl}/api/model${qs}`, { headers }),
      fetch(`${this.baseUrl}/api/model/default${qs}`, { headers }),
      fetch(`${this.baseUrl}/api/provider${qs}`, { headers }),
    ]);

    const providerNames = new Map<string, string>();
    if (provRes.status === "fulfilled" && provRes.value.ok) {
      const pJson = (await provRes.value.json()) as {
        data?: Array<{ id: string; name?: string }>;
      };
      for (const p of pJson.data ?? []) {
        if (p.id) providerNames.set(p.id, p.name ?? p.id);
      }
    }

    const models: ModelOption[] = [];
    if (listRes.status === "fulfilled" && listRes.value.ok) {
      const json = (await listRes.value.json()) as {
        data?: Array<{
          id: string;
          providerID: string;
          name?: string;
          type?: string;
          enabled?: boolean;
          variants?: Array<{ id: string }>;
        }>;
      };
      for (const m of json.data ?? []) {
        if (m.enabled === false) continue;
        if (m.type && m.type !== "chat") continue;
        models.push({
          id: m.id,
          providerID: m.providerID,
          providerName: providerNames.get(m.providerID) ?? m.providerID,
          name: m.name ?? m.id,
          variants: Array.isArray(m.variants) ? m.variants.map((v) => v.id) : [],
        });
      }
    }

    let defaultModel: SelectedModelRef | undefined;
    if (defRes.status === "fulfilled" && defRes.value.ok) {
      const json = (await defRes.value.json()) as {
        data?: { id?: string; providerID?: string };
      };
      if (json.data?.id && json.data?.providerID) {
        defaultModel = { id: json.data.id, providerID: json.data.providerID };
      }
    }

    return { models, defaultModel };
  }

  async getSessionStats(fromMs?: number): Promise<SessionStatsData | null> {
    if (this.apiMode !== "v2") return null;
    const headers = this.buildHeaders();
    const params = new URLSearchParams({ tools: "summary" });
    if (fromMs !== undefined) {
      params.set("from", String(fromMs));
    }
    const res = await fetch(
      `${this.baseUrl}/api/experimental/session/stats?${params.toString()}`,
      { headers }
    );
    if (!res.ok) {
      throw new Error(`Stats request failed (HTTP ${res.status})`);
    }
    const json = (await res.json()) as { data?: SessionStatsData };
    return json.data ?? null;
  }

  async createSession(params: {
    directory?: string;
    parentID?: string;
    title: string;
    model?: SelectedModelRef;
  }): Promise<string> {
    const dir = params.directory?.trim() || undefined;
    const client = this.getClient(dir);
    if (this.apiMode === "v2") {
      const res = await client.v2.session.create({
        location: dir ? { directory: dir } : undefined,
        model: params.model,
      });
      if (res.error || !res.data?.data?.id) {
        throw new Error(`Failed to create V2 session: ${JSON.stringify(res.error)}`);
      }
      return res.data.data.id;
    }

    const res = await client.session.create({
      directory: dir,
      parentID: params.parentID,
      title: params.title,
      model: params.model,
    });
    if (res.error || !res.data?.id) {
      throw new Error(`Failed to create session: ${JSON.stringify(res.error)}`);
    }
    return res.data.id;
  }

  async switchSessionModel(sessionID: string, model: SelectedModelRef): Promise<void> {
    if (this.apiMode !== "v2") return;
    try {
      await fetch(
        `${this.baseUrl}/api/session/${encodeURIComponent(sessionID)}/model`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.buildHeaders(),
          },
          body: JSON.stringify({ model }),
        }
      );
    } catch {
      // Non-fatal if server ignores model switch
    }
  }

  async setSessionInstruction(
    sessionID: string,
    key: string,
    value: string | null
  ): Promise<boolean> {
    if (this.apiMode !== "v2") return false;
    try {
      const url = `${this.baseUrl}/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries/${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method: value === null ? "DELETE" : "PUT",
        headers: {
          ...(value === null ? {} : { "Content-Type": "application/json" }),
          ...this.buildHeaders(),
        },
        body: value === null ? undefined : JSON.stringify({ value }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async postV2Prompt(sessionID: string, text: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/session/${encodeURIComponent(sessionID)}/prompt`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.buildHeaders(),
        },
        body: JSON.stringify({ text }),
      }
    );

    if (res.ok) return;

    const errBody = await res.text();
    // Compatibility fallback if server uses SDK's nested { prompt: { text } } schema
    if (res.status === 400 && errBody.includes('"prompt"')) {
      const sdkRes = await this.client.v2.session.prompt({
        sessionID,
        prompt: { text },
      });
      if (!sdkRes.error) return;
      throw new Error(`Prompt failed: ${JSON.stringify(sdkRes.error)}`);
    }

    throw new Error(`Prompt failed: ${errBody || `HTTP ${res.status}`}`);
  }

  private async isV2SessionActive(sessionID: string): Promise<boolean> {
    try {
      const res = await this.client.v2.session.active();
      const activeData: unknown = res.data?.data;
      if (Array.isArray(activeData)) {
        return activeData.some((s: { id?: string }) => s?.id === sessionID);
      }
      if (activeData && typeof activeData === "object") {
        return Object.prototype.hasOwnProperty.call(activeData, sessionID);
      }
    } catch {
      // Ignore transient poll errors
    }
    return false;
  }

  async promptAndWaitText(params: {
    sessionID: string;
    directory: string;
    text: string;
    system?: string;
    disableMutatingTools?: boolean;
    waitForIdle?: (sessionID: string) => Promise<void>;
  }): Promise<string> {
    const client = this.getClient(params.directory);
    if (this.apiMode === "v2") {
      const combined = params.system
        ? `${params.system}\n\n---\n\n${params.text}`
        : params.text;

      const sentAt = Date.now();
      const idlePromise = params.waitForIdle ? params.waitForIdle(params.sessionID) : null;
      await this.postV2Prompt(params.sessionID, combined);

      // Race SSE idle signal against active-session / message-completion polling
      await Promise.race([
        ...(idlePromise ? [idlePromise] : []),
        (async () => {
          await new Promise((r) => setTimeout(r, 600));
          while (true) {
            const active = await this.isV2SessionActive(params.sessionID);
            if (!active) {
              const res = await this.client.v2.session.messages({
                sessionID: params.sessionID,
                limit: 8,
                order: "desc",
              });
              const items = res.data?.data ?? [];
              const done = items.some((m) => {
                const t = m.time?.created ?? 0;
                if ((m as { type?: string }).type === "idle" && t >= sentAt - 2000) return true;
                if (
                  m.type === "assistant" &&
                  ((m.time?.completed ?? 0) >= sentAt - 2000 || Boolean(m.error))
                ) {
                  return true;
                }
                return false;
              });
              if (done) return;
            }
            await new Promise((r) => setTimeout(r, 700));
          }
        })(),
      ]);

      return this.getLastAssistantText(params.sessionID, params.directory);
    }

    const promptRes = await client.session.prompt({
      sessionID: params.sessionID,
      directory: params.directory,
      system: params.system,
      tools: params.disableMutatingTools ? { bash: false, edit: false, write: false } : undefined,
      parts: [{ type: "text", text: params.text }],
    });
    if (promptRes.error || !promptRes.data) {
      throw new Error(`Prompt failed: ${JSON.stringify(promptRes.error)}`);
    }
    if (promptRes.data.info.error) {
      throw new Error(JSON.stringify(promptRes.data.info.error));
    }
    return extractTextFromParts(promptRes.data.parts);
  }

  async promptAsync(params: {
    sessionID: string;
    directory: string;
    text: string;
  }): Promise<void> {
    if (this.apiMode === "v2") {
      await this.postV2Prompt(params.sessionID, params.text);
      return;
    }

    const client = this.getClient(params.directory);
    const res = await client.session.promptAsync({
      sessionID: params.sessionID,
      directory: params.directory,
      parts: [{ type: "text", text: params.text }],
    });
    if (res.error) {
      throw new Error(JSON.stringify(res.error));
    }
  }

  private async getLatestV2AssistantMessage(
    sessionID: string
  ): Promise<SessionMessageAssistant | undefined> {
    const res = await this.client.v2.session.messages({
      sessionID,
      limit: 12,
      order: "desc",
    });
    if (res.error || !res.data?.data) {
      throw new Error(`Failed to fetch messages: ${JSON.stringify(res.error)}`);
    }
    const assistants = res.data.data
      .filter((m): m is SessionMessageAssistant => m.type === "assistant")
      .sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
    return assistants[0];
  }

  async getLastAssistantText(sessionID: string, directory: string): Promise<string> {
    if (this.apiMode === "v2") {
      const latest = await this.getLatestV2AssistantMessage(sessionID);
      if (!latest) return "";
      if (latest.error) {
        throw new Error(latest.error.message ?? JSON.stringify(latest.error));
      }
      return extractTextFromV2Content(latest.content);
    }

    const client = this.getClient(directory);
    const res = await client.session.messages({
      sessionID,
      directory,
      limit: 6,
    });
    const msgs = res.data ?? [];
    const lastAssistant = [...msgs].reverse().find((m) => m.info.role === "assistant");
    if (!lastAssistant) return "";
    if (lastAssistant.info.role === "assistant" && lastAssistant.info.error) {
      throw new Error(JSON.stringify(lastAssistant.info.error));
    }
    return extractTextFromParts(lastAssistant.parts);
  }

  async abortSession(sessionID: string, directory: string): Promise<void> {
    const client = this.getClient(directory);
    if (this.apiMode === "v2") {
      await client.v2.session.interrupt({ sessionID });
    } else {
      await client.session.abort({ sessionID, directory });
    }
  }

  async replyPermission(params: {
    sessionID: string;
    requestID: string;
    reply: "once" | "always" | "reject";
    directory: string;
    isV2?: boolean;
    message?: string;
  }): Promise<void> {
    const dirClient = this.getClient(params.directory);
    if (params.isV2 || this.apiMode === "v2") {
      const res = await fetch(
        `${this.baseUrl}/api/session/${encodeURIComponent(params.sessionID)}/permission/${encodeURIComponent(params.requestID)}/reply`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.buildHeaders(),
          },
          body: JSON.stringify({
            decision: params.reply,
            message: params.message,
          }),
        }
      );
      if (res.ok) return;

      const errTxt = await res.text();
      // Fallback for servers expecting { reply } instead of { decision }
      if (res.status === 400 && errTxt.includes('"reply"')) {
        const v2Res = await dirClient.v2.session.permission.reply({
          sessionID: params.sessionID,
          requestID: params.requestID,
          reply: params.reply,
          message: params.message,
        });
        if (!v2Res.error) return;
      }

      if (this.apiMode === "v2") {
        throw new Error(errTxt || `HTTP ${res.status}`);
      }
      const v1Fallback = await dirClient.permission.reply({
        requestID: params.requestID,
        directory: params.directory,
        reply: params.reply,
        message: params.message,
      });
      if (!v1Fallback.error) return;
      throw new Error(errTxt || `HTTP ${res.status}`);
    }

    const res = await dirClient.permission.reply({
      requestID: params.requestID,
      directory: params.directory,
      reply: params.reply,
      message: params.message,
    });
    if (!res.error) return;
    const errVal: unknown = res.error;
    throw new Error(typeof errVal === "string" ? errVal : JSON.stringify(errVal));
  }

  async rejectQuestion(params: {
    sessionID: string;
    requestID: string;
    directory: string;
    isV2?: boolean;
  }): Promise<void> {
    const dirClient = this.getClient(params.directory);
    if (params.isV2 || this.apiMode === "v2") {
      await dirClient.v2.session.question.reject({
        sessionID: params.sessionID,
        requestID: params.requestID,
      });
    } else {
      await dirClient.question.reject({
        requestID: params.requestID,
        directory: params.directory,
      });
    }
  }
}
