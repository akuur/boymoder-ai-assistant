import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow, primaryMonitor } from "@tauri-apps/api/window";
import {
  broadcastPetDrop,
  broadcastSprites,
  broadcastState,
  onOverlayAction,
  type PetDropOrigin,
} from "../bridge/state-sync";
import { PetOrchestratorEngine } from "../engine/orchestrator";
import { PetSpriteRegistry } from "../engine/pets";
import type {
  BackendConfig,
  BackendId,
  ChatTurn,
  ExecutionMode,
  ModelOption,
  OrchestratorSnapshot,
  SelectedModelRef,
  SessionStatsData,
  SubtaskPlanItem,
} from "../engine/types";
import { type PetRenderCallbacks } from "./pet-renderer";
import { renderMarkdown } from "./markdown";
import { DockedStageSimulator } from "./stage-sim";
import {
  loadLocalTelemetry,
  recordCompletedRunTelemetry,
  recordTpsTelemetry,
  renderStatsPage,
} from "./stats";

interface RunHistoryItem {
  id: string;
  goal: string;
  customTitle?: boolean;
  isDraft?: boolean;
  pinned?: boolean;
  mode: ExecutionMode;
  workspaceDir: string;
  sessionID?: string | null;
  turns?: ChatTurn[];
  createdAt: number;
  planItems: SubtaskPlanItem[];
  planDurationMs?: number;
  assistantReply?: string;
  subagents: Array<{
    role: string;
    title: string;
    statusText: string;
    lastOutput?: string;
    spriteVariant?: string;
  }>;
}

const THEME_STORAGE_KEY = "akuur_theme";
const HISTORY_STORAGE_KEY = "akuur_history_v1";
const PROJECTS_STORAGE_KEY = "akuur_projects_v1";
const PINNED_PROJECTS_KEY = "akuur_pinned_projects_v1";
const PROJECT_NAMES_KEY = "akuur_project_names_v1";
const MODEL_STORAGE_KEY = "akuur_selected_model";
const AUTO_PETS_KEY = "akuur_auto_pets";
const PET_SCALE_KEY = "akuur_pet_scale";
const ACTIVE_BACKEND_KEY = "akuur_active_backend";
const BACKEND_CONFIGS_KEY = "akuur_backend_configs_v1";

const sprites = new PetSpriteRegistry();
const engine = new PetOrchestratorEngine("http://127.0.0.1:4096", {
  pickSubagentVariant: (role, idx) => sprites.pickSubagentVariant(role, idx),
});

const shellEl = document.getElementById("app")!;
const welcomeSprite = document.getElementById("welcome-sprite") as HTMLImageElement;
const btnCollapseSidebar = document.getElementById("btn-collapse-sidebar") as HTMLButtonElement;
const btnExpandSidebar = document.getElementById("btn-expand-sidebar") as HTMLButtonElement;
const sidebarBackdrop = document.getElementById("sidebar-backdrop")!;
const btnSearchToggle = document.getElementById("btn-search-toggle") as HTMLButtonElement;
const sidebarSearchWrap = document.getElementById("sidebar-search-wrap")!;
const sidebarSearchInput = document.getElementById("sidebar-search-input") as HTMLInputElement;
const btnNewChat = document.getElementById("btn-new-chat") as HTMLButtonElement;
const btnOpenStats = document.getElementById("btn-open-stats") as HTMLButtonElement;

const tabProjects = document.getElementById("tab-projects") as HTMLButtonElement;
const tabChats = document.getElementById("tab-chats") as HTMLButtonElement;
const panelProjects = document.getElementById("panel-projects")!;
const panelChats = document.getElementById("panel-chats")!;
const btnAddProject = document.getElementById("btn-add-project") as HTMLButtonElement;
const projectsTree = document.getElementById("projects-tree")!;
const projectsEmpty = document.getElementById("projects-empty")!;

const activeThreadsGroup = document.getElementById("active-threads-group")!;
const activeSubagentNav = document.getElementById("active-subagent-nav")!;
const recentsList = document.getElementById("recents-list")!;
const historyEmpty = document.getElementById("history-empty")!;

const connDot = document.getElementById("conn-dot")!;
const btnToggleRoam = document.getElementById("btn-toggle-roam") as HTMLButtonElement;
const agentsBadge = document.getElementById("agents-badge")!;
const btnOpenSettings = document.getElementById("btn-open-settings") as HTMLButtonElement;

const topbarTitle = document.getElementById("topbar-title")!;
const topbarWorkspace = document.getElementById("topbar-workspace")!;
const backendPicker = document.getElementById("backend-picker")!;
const backendStatusDot = document.getElementById("backend-status-dot")!;
const backendSelect = document.getElementById("backend-select") as HTMLSelectElement;
const tpsBadge = document.getElementById("tps-badge")!;
const phaseBadge = document.getElementById("phase-badge")!;
const btnClearResting = document.getElementById("btn-clear-resting") as HTMLButtonElement;

const welcomeState = document.getElementById("welcome-state")!;
const threadState = document.getElementById("thread-state")!;
const turnsList = document.getElementById("turns-list")!;
const statsView = document.getElementById("stats-view")!;
const composerOuter = document.getElementById("composer-outer")!;
const planAccordion = document.getElementById("plan-accordion") as HTMLDetailsElement;
const thoughtTitle = document.getElementById("thought-title")!;
const thoughtTimer = document.getElementById("thought-timer")!;
const planItemsList = document.getElementById("plan-items-list")!;
const logList = document.getElementById("log-list")!;

const stageCard = document.getElementById("stage-card")!;
const dockedStage = document.getElementById("docked-stage")!;

const permissionsPanel = document.getElementById("permissions-panel")!;
const permissionsList = document.getElementById("permissions-list")!;

const goalInput = document.getElementById("goal-input") as HTMLTextAreaElement;
const modeGroup = document.getElementById("mode-group")!;
const modeThumb = document.getElementById("mode-thumb")!;
const modelPicker = document.getElementById("model-picker")!;
const btnModelTrigger = document.getElementById("btn-model-trigger") as HTMLButtonElement;
const modelTriggerLabel = document.getElementById("model-trigger-label")!;
const modelPopover = document.getElementById("model-popover")!;
const modelSearchInput = document.getElementById("model-search-input") as HTMLInputElement;
const modelListEl = document.getElementById("model-list")!;
const variantPicker = document.getElementById("variant-picker")!;
const btnVariantTrigger = document.getElementById("btn-variant-trigger") as HTMLButtonElement;
const variantTriggerLabel = document.getElementById("variant-trigger-label")!;
const variantPopover = document.getElementById("variant-popover")!;
const variantListEl = document.getElementById("variant-list")!;
const btnPillWorktree = document.getElementById("btn-pill-worktree") as HTMLButtonElement;
const btnSendStop = document.getElementById("btn-send-stop") as HTMLButtonElement;
const iconSend = document.getElementById("icon-send")!;
const iconStop = document.getElementById("icon-stop")!;
const labelStop = document.getElementById("label-stop")!;

// Settings Modal Elements
const settingsModal = document.getElementById("settings-modal")!;
const btnCloseSettings = document.getElementById("btn-close-settings") as HTMLButtonElement;
const setThemeSelect = document.getElementById("set-theme") as HTMLSelectElement;
const setWorkspaceInput = document.getElementById("set-workspace-input") as HTMLInputElement;
const btnSetBrowse = document.getElementById("btn-set-browse") as HTMLButtonElement;
const chkSetWorktrees = document.getElementById("chk-set-worktrees") as HTMLInputElement;
const chkSetOverlay = document.getElementById("chk-set-overlay") as HTMLInputElement;
const chkSetAutoLaunch = document.getElementById("chk-set-autolaunch") as HTMLInputElement;
const chkSetOnTop = document.getElementById("chk-set-ontop") as HTMLInputElement;
const rangeSetScale = document.getElementById("range-set-scale") as HTMLInputElement;
const setScaleLabel = document.getElementById("set-scale-label")!;
const chkForceInteractive = document.getElementById("chk-force-interactive") as HTMLInputElement;
const btnReloadSprites = document.getElementById("btn-reload-sprites") as HTMLButtonElement;
const setActiveBackend = document.getElementById("set-active-backend") as HTMLSelectElement;
const setBackendStatusBadge = document.getElementById("set-backend-status-badge")!;
const backendPanelOpencode = document.getElementById("backend-panel-opencode")!;
const backendPanelCli = document.getElementById("backend-panel-cli")!;
const backendPanelOpenai = document.getElementById("backend-panel-openai")!;
const setOpencodeUrl = document.getElementById("set-opencode-url") as HTMLInputElement;
const setServerUrl = document.getElementById("set-server-url")!;
const btnSetReconnect = document.getElementById("btn-set-reconnect") as HTMLButtonElement;
const setCliStatusDesc = document.getElementById("set-cli-status-desc")!;
const btnRecheckCli = document.getElementById("btn-recheck-cli") as HTMLButtonElement;
const setCliModel = document.getElementById("set-cli-model") as HTMLInputElement;
const setCliPath = document.getElementById("set-cli-path") as HTMLInputElement;
const setOpenaiBaseUrl = document.getElementById("set-openai-base-url") as HTMLInputElement;
const setOpenaiApiKey = document.getElementById("set-openai-api-key") as HTMLInputElement;
const setOpenaiModel = document.getElementById("set-openai-model") as HTMLInputElement;
const setOpenaiStatusDesc = document.getElementById("set-openai-status-desc")!;
const btnTestOpenai = document.getElementById("btn-test-openai") as HTMLButtonElement;
const btnClearHistory = document.getElementById("btn-clear-history") as HTMLButtonElement;
const chatContextMenu = document.getElementById("chat-context-menu")!;

let historyItems: RunHistoryItem[] = loadJson(HISTORY_STORAGE_KEY, []);
let savedProjects: string[] = loadJson(PROJECTS_STORAGE_KEY, []);
let pinnedProjects: string[] = loadJson(PINNED_PROJECTS_KEY, []);
let projectNames: Record<string, string> = loadJson(PROJECT_NAMES_KEY, {});
let selectedHistoryId: string | null = null;
let renamingChatId: string | null = null;
let renamingProjectDir: string | null = null;
let suppressNextChatClick = false;
let searchQuery = "";
let modelSearchQuery = "";
let lastCompletedTurnKey = "";
let lastRecordedTpsSample = "";
let showingStats = false;
let statsRangeDays: number | null = null;
let statsLoading = false;
let statsError: string | undefined;
let cachedStats: SessionStatsData | null = null;
let lastWelcomeSpot: PetDropOrigin | null = null;
let timerInterval: number | null = null;

async function captureWelcomeDropOrigin(): Promise<PetDropOrigin> {
  const rect = welcomeSprite.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    try {
      const win = getCurrentWindow();
      const [winPos, winSize, scale, monitor] = await Promise.all([
        win.innerPosition(),
        win.innerSize(),
        win.scaleFactor(),
        primaryMonitor(),
      ]);
      const s = Math.max(1, scale || 1);
      const work = monitor?.workArea;
      const monW = work ? work.size.width / s : window.screen.availWidth || 1280;
      const monH = work ? work.size.height / s : window.screen.availHeight || 720;
      const monX = work ? work.position.x / s : 0;
      const monY = work ? work.position.y / s : 0;

      // On Wayland innerPosition() can return (0,0); estimate centered window placement
      const winLeft =
        winPos.x !== 0 || winPos.y !== 0
          ? winPos.x / s
          : monX + (monW - winSize.width / s) * 0.5;
      const winTop =
        winPos.x !== 0 || winPos.y !== 0
          ? winPos.y / s
          : monY + (monH - winSize.height / s) * 0.5;

      const spriteCenterX = winLeft - monX + rect.left + rect.width * 0.5;
      const spriteBottomY = winTop - monY + rect.bottom;
      const origin: PetDropOrigin = {
        x: Math.max(24, Math.round(spriteCenterX - 65)),
        bottomOffset: Math.max(40, Math.round(monH - spriteBottomY)),
      };
      lastWelcomeSpot = origin;
      return origin;
    } catch {
      // Fallback below
    }
  }
  return lastWelcomeSpot ?? { x: Math.round((window.screen.availWidth || 1280) * 0.52), bottomOffset: 360 };
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota errors
  }
}

function registerProjectDir(dir: string): void {
  const cleaned = dir.trim();
  if (!cleaned) return;
  if (!savedProjects.includes(cleaned)) {
    savedProjects = [cleaned, ...savedProjects].slice(0, 20);
    saveJson(PROJECTS_STORAGE_KEY, savedProjects);
  }
}

function applyTheme(theme: "dark" | "light"): void {
  document.documentElement.setAttribute("data-theme", theme);
  setThemeSelect.value = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore
  }
}

function setSidebarCollapsed(collapsed: boolean): void {
  shellEl.classList.toggle("sidebar-collapsed", collapsed);
  const isNarrow = window.innerWidth <= 720;
  sidebarBackdrop.hidden = collapsed || !isNarrow;
}

function switchSidebarTab(tab: "projects" | "chats"): void {
  tabProjects.classList.toggle("active", tab === "projects");
  tabProjects.setAttribute("aria-selected", String(tab === "projects"));
  tabChats.classList.toggle("active", tab === "chats");
  tabChats.setAttribute("aria-selected", String(tab === "chats"));
  panelProjects.hidden = tab !== "projects";
  panelChats.hidden = tab !== "chats";
}

function positionModeThumb(mode: ExecutionMode): void {
  modeGroup.dataset.active = mode;
  const activeBtn = modeGroup.querySelector<HTMLButtonElement>(
    `.ds-mode-seg[data-mode="${mode}"]`
  );
  if (!activeBtn) return;
  const groupRect = modeGroup.getBoundingClientRect();
  const btnRect = activeBtn.getBoundingClientRect();
  if (btnRect.width <= 0) return;
  const offsetX = btnRect.left - groupRect.left - 3;
  modeThumb.style.width = `${btnRect.width}px`;
  modeThumb.style.transform = `translateX(${offsetX}px)`;
}

const handlePermissionReply = (
  sessionID: string,
  requestId: string,
  reply: "once" | "always" | "reject"
) => {
  void engine.respondToPermission(sessionID, requestId, reply).catch((err) => {
    engine.log("error", "Permission", `Failed to send reply: ${String(err)}`);
  });
};

const petCallbacks: PetRenderCallbacks = {
  onPermissionReply: handlePermissionReply,
  onDismissBubble: (petId) => {
    engine.dismissBubble(petId);
  },
};

const stageSim = new DockedStageSimulator(dockedStage, sprites, petCallbacks);

function createOrFocusNewChat(workspaceDir: string): string {
  const existingDraft = historyItems.find((h) => h.isDraft);
  if (existingDraft) {
    existingDraft.workspaceDir = workspaceDir;
    existingDraft.createdAt = Date.now();
    selectedHistoryId = existingDraft.id;
    saveJson(HISTORY_STORAGE_KEY, historyItems);
    return existingDraft.id;
  }

  const id = `chat-${Date.now()}`;
  const draft: RunHistoryItem = {
    id,
    goal: "New chat",
    isDraft: true,
    mode: engine.getSnapshot().mode,
    workspaceDir,
    sessionID: null,
    turns: [],
    createdAt: Date.now(),
    planItems: [],
    subagents: [],
  };
  historyItems = [draft, ...historyItems].slice(0, 40);
  selectedHistoryId = draft.id;
  saveJson(HISTORY_STORAGE_KEY, historyItems);
  return id;
}

function syncActiveChatHistory(snap: OrchestratorSnapshot): void {
  if (snap.turns.length === 0) return;

  if (snap.phase === "idle" && snap.currentRunId && snap.currentRunId !== lastCompletedTurnKey) {
    const lastTurn = snap.turns[snap.turns.length - 1];
    if (lastTurn && (lastTurn.assistantReply || lastTurn.subagents.length > 0)) {
      lastCompletedTurnKey = snap.currentRunId;
      recordCompletedRunTelemetry(lastTurn.subagents.length);
    }
  }

  registerProjectDir(snap.workspaceDir);

  const existing =
    historyItems.find((h) => h.id === snap.chatId) ??
    historyItems.find((h) => h.isDraft);

  const firstTitle = snap.turns[0]?.userText ?? snap.currentGoal ?? "New chat";
  if (existing) {
    existing.id = snap.chatId;
    if (!existing.customTitle) {
      existing.goal = firstTitle;
    }
    existing.isDraft = false;
    existing.mode = snap.mode;
    existing.workspaceDir = snap.workspaceDir;
    existing.sessionID = snap.sessionID;
    existing.turns = structuredClone(snap.turns);
    existing.planItems = snap.planItems;
    existing.planDurationMs = snap.planDurationMs;
    existing.assistantReply = snap.assistantReply;
    existing.subagents = snap.subagents.map((s) => ({
      role: s.role,
      title: s.title,
      statusText: s.statusText,
      lastOutput: s.lastOutput,
      spriteVariant: s.spriteVariant,
    }));
    selectedHistoryId = existing.id;
    historyItems = sortPinnedFirst(historyItems);
    saveJson(HISTORY_STORAGE_KEY, historyItems);
    return;
  }

  const item: RunHistoryItem = {
    id: snap.chatId,
    goal: firstTitle,
    isDraft: false,
    mode: snap.mode,
    workspaceDir: snap.workspaceDir,
    sessionID: snap.sessionID,
    turns: structuredClone(snap.turns),
    createdAt: Date.now(),
    planItems: snap.planItems,
    planDurationMs: snap.planDurationMs,
    assistantReply: snap.assistantReply,
    subagents: snap.subagents.map((s) => ({
      role: s.role,
      title: s.title,
      statusText: s.statusText,
      lastOutput: s.lastOutput,
      spriteVariant: s.spriteVariant,
    })),
  };

  historyItems = sortPinnedFirst([item, ...historyItems]).slice(0, 40);
  selectedHistoryId = item.id;
  saveJson(HISTORY_STORAGE_KEY, historyItems);
}

function sortPinnedFirst(items: RunHistoryItem[]): RunHistoryItem[] {
  const pinned = items.filter((i) => i.pinned);
  const unpinned = items.filter((i) => !i.pinned);
  return [...pinned, ...unpinned];
}

function getProjectDisplayName(dir: string): string {
  return projectNames[dir] || (dir.split(/[\\/]/).filter(Boolean).pop() ?? dir);
}

function getAllKnownProjectDirs(currentWorkspaceDir: string): string[] {
  const unique = Array.from(
    new Set([
      ...(currentWorkspaceDir ? [currentWorkspaceDir] : []),
      ...savedProjects,
      ...historyItems.map((h) => h.workspaceDir).filter(Boolean),
    ])
  );
  const pinnedSet = new Set(pinnedProjects);
  return [
    ...unique.filter((d) => pinnedSet.has(d)),
    ...unique.filter((d) => !pinnedSet.has(d)),
  ];
}

function positionAndShowContextMenu(items: HTMLElement[], clientX: number, clientY: number): void {
  chatContextMenu.replaceChildren(...items);
  chatContextMenu.hidden = false;

  const rect = chatContextMenu.getBoundingClientRect();
  const x = Math.min(clientX, Math.max(8, window.innerWidth - rect.width - 10));
  const y = Math.min(clientY, Math.max(8, window.innerHeight - rect.height - 10));
  chatContextMenu.style.left = `${x}px`;
  chatContextMenu.style.top = `${y}px`;
  const subMenu = chatContextMenu.querySelector<HTMLElement>(".ds-ctx-submenu");
  if (subMenu && x + rect.width + 185 > window.innerWidth) {
    subMenu.classList.add("flip-left");
  }
}

function makeCtxButton(
  label: string,
  iconSvg: string,
  onClick: () => void,
  danger = false
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `ds-ctx-item${danger ? " ds-ctx-danger" : ""}`;
  const left = document.createElement("span");
  left.className = "ds-ctx-item-left";
  left.innerHTML = iconSvg;
  const text = document.createElement("span");
  text.textContent = label;
  left.appendChild(text);
  btn.appendChild(left);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeChatContextMenu();
    onClick();
  });
  return btn;
}

const PIN_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`;
const RENAME_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;
const REMOVE_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;

function openProjectContextMenu(dir: string, clientX: number, clientY: number): void {
  const isPinned = pinnedProjects.includes(dir);
  const items: HTMLElement[] = [];

  items.push(
    makeCtxButton(isPinned ? "Unpin" : "Pin", PIN_ICON_SVG, () => {
      if (isPinned) {
        pinnedProjects = pinnedProjects.filter((p) => p !== dir);
      } else {
        pinnedProjects = [dir, ...pinnedProjects];
      }
      saveJson(PINNED_PROJECTS_KEY, pinnedProjects);
      render(engine.getSnapshot());
    })
  );

  items.push(
    makeCtxButton("Rename", RENAME_ICON_SVG, () => {
      renamingProjectDir = dir;
      render(engine.getSnapshot());
    })
  );

  const sep = document.createElement("div");
  sep.className = "ds-ctx-sep";
  items.push(sep);

  items.push(
    makeCtxButton(
      "Remove",
      REMOVE_ICON_SVG,
      () => {
        savedProjects = savedProjects.filter((p) => p !== dir);
        pinnedProjects = pinnedProjects.filter((p) => p !== dir);
        delete projectNames[dir];
        for (const h of historyItems) {
          if (h.workspaceDir === dir) h.workspaceDir = "";
        }
        saveJson(PROJECTS_STORAGE_KEY, savedProjects);
        saveJson(PINNED_PROJECTS_KEY, pinnedProjects);
        saveJson(PROJECT_NAMES_KEY, projectNames);
        saveJson(HISTORY_STORAGE_KEY, historyItems);
        if (engine.getSnapshot().workspaceDir === dir) {
          void engine.setWorkspaceDir("");
        } else {
          render(engine.getSnapshot());
        }
      },
      true
    )
  );

  positionAndShowContextMenu(items, clientX, clientY);
}

function closeChatContextMenu(): void {
  chatContextMenu.hidden = true;
  chatContextMenu.replaceChildren();
}

function openChatContextMenu(item: RunHistoryItem, clientX: number, clientY: number): void {
  const items: HTMLElement[] = [];

  const mkMenuItem = (label: string, iconSvg: string, onClick: () => void, danger = false) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `ds-ctx-item${danger ? " ds-ctx-danger" : ""}`;
    const left = document.createElement("span");
    left.className = "ds-ctx-item-left";
    left.innerHTML = iconSvg;
    const text = document.createElement("span");
    text.textContent = label;
    left.appendChild(text);
    btn.appendChild(left);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeChatContextMenu();
      onClick();
    });
    return btn;
  };

  // Pin / Unpin
  items.push(
    mkMenuItem(
      item.pinned ? "Unpin" : "Pin",
      `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`,
      () => {
        item.pinned = !item.pinned;
        historyItems = sortPinnedFirst(historyItems);
        saveJson(HISTORY_STORAGE_KEY, historyItems);
        render(engine.getSnapshot());
      }
    )
  );

  // Rename
  items.push(
    mkMenuItem(
      "Rename",
      `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
      () => {
        renamingChatId = item.id;
        render(engine.getSnapshot());
      }
    )
  );

  // Move to project submenu
  const subWrap = document.createElement("div");
  subWrap.className = "ds-ctx-submenu-wrap";

  const moveTrigger = document.createElement("button");
  moveTrigger.type = "button";
  moveTrigger.className = "ds-ctx-item";
  const moveLeft = document.createElement("span");
  moveLeft.className = "ds-ctx-item-left";
  moveLeft.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
  const moveText = document.createElement("span");
  moveText.textContent = "Move to project";
  moveLeft.appendChild(moveText);
  const arrow = document.createElement("span");
  arrow.textContent = "▸";
  moveTrigger.append(moveLeft, arrow);
  moveTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    subWrap.classList.toggle("open");
  });

  const subMenu = document.createElement("div");
  subMenu.className = "ds-ctx-submenu";
  const projectDirs = getAllKnownProjectDirs(engine.getSnapshot().workspaceDir);

  const addMoveTarget = (label: string, targetDir: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ds-ctx-item";
    const span = document.createElement("span");
    span.className = "ds-nav-title";
    span.textContent = label;
    b.appendChild(span);
    if (item.workspaceDir === targetDir) {
      const check = document.createElement("span");
      check.className = "ds-model-check";
      check.textContent = "✓";
      b.appendChild(check);
    }
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      item.workspaceDir = targetDir;
      if (targetDir) registerProjectDir(targetDir);
      saveJson(HISTORY_STORAGE_KEY, historyItems);
      closeChatContextMenu();
      render(engine.getSnapshot());
    });
    subMenu.appendChild(b);
  };

  for (const dir of projectDirs) {
    addMoveTarget(getProjectDisplayName(dir), dir);
  }
  addMoveTarget("No project", "");

  subWrap.append(moveTrigger, subMenu);
  items.push(subWrap);

  const sep = document.createElement("div");
  sep.className = "ds-ctx-sep";
  items.push(sep);

  // Remove
  items.push(
    mkMenuItem(
      "Remove",
      REMOVE_ICON_SVG,
      () => {
        historyItems = historyItems.filter((h) => h.id !== item.id);
        saveJson(HISTORY_STORAGE_KEY, historyItems);
        if (selectedHistoryId === item.id) {
          selectedHistoryId = null;
          void engine.startNewChat();
        }
        render(engine.getSnapshot());
      },
      true
    )
  );

  positionAndShowContextMenu(items, clientX, clientY);
}

function attachChatWeightedDrag(btn: HTMLElement, item: RunHistoryItem): void {
  btn.addEventListener("pointerdown", (startEv) => {
    if (startEv.button !== 0 || renamingChatId === item.id) return;
    const startX = startEv.clientX;
    const startY = startEv.clientY;
    const origRect = btn.getBoundingClientRect();
    const grabOffsetX = startX - origRect.left;
    const grabOffsetY = startY - origRect.top;

    let dragging = false;
    let ghost: HTMLElement | null = null;
    let targetX = origRect.left;
    let targetY = origRect.top;
    let curX = origRect.left;
    let curY = origRect.top;
    let curAngle = 0;
    let lastClientX = startX;
    let lastClientY = startY;
    let rafHandle: number | null = null;
    let hoveredFolder: HTMLElement | null = null;
    let hoveredChat: HTMLElement | null = null;
    let dropPlacement: "above" | "below" = "below";

    const clearDropIndicators = () => {
      hoveredFolder?.classList.remove("drop-target");
      hoveredFolder = null;
      hoveredChat?.classList.remove("drop-above", "drop-below");
      hoveredChat = null;
    };

    const tickPhysics = () => {
      if (!dragging || !ghost) {
        rafHandle = null;
        return;
      }
      // Weighted spring lag + velocity tilt
      const dx = targetX - curX;
      const dy = targetY - curY;
      curX += dx * 0.34;
      curY += dy * 0.34;
      const desiredAngle = Math.max(-7, Math.min(7, dx * 0.35 + (curX - targetX) * -0.05));
      curAngle += (desiredAngle - curAngle) * 0.25;

      ghost.style.transform = `translate3d(${curX.toFixed(1)}px, ${curY.toFixed(1)}px, 0) scale(1.04) rotate(${curAngle.toFixed(2)}deg)`;
      rafHandle = requestAnimationFrame(tickPhysics);
    };

    const onMove = (ev: PointerEvent) => {
      const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
      if (!dragging && dist < 6) return;

      if (!dragging) {
        dragging = true;
        suppressNextChatClick = true;
        closeChatContextMenu();
        btn.classList.add("drag-origin");

        ghost = document.createElement("div");
        ghost.className = "ds-drag-ghost";
        ghost.style.width = `${Math.round(origRect.width)}px`;
        const gTitle = document.createElement("span");
        gTitle.className = "ds-nav-title";
        gTitle.textContent = item.goal;
        ghost.appendChild(gTitle);
        document.body.appendChild(ghost);

        rafHandle = requestAnimationFrame(tickPhysics);
      }

      targetX = ev.clientX - grabOffsetX;
      targetY = ev.clientY - grabOffsetY;
      lastClientX = ev.clientX;
      lastClientY = ev.clientY;

      clearDropIndicators();
      const els = document.elementsFromPoint(ev.clientX, ev.clientY);
      const folderEl = els.find((el) => el.classList?.contains("ds-project-folder")) as
        | HTMLElement
        | undefined;
      if (folderEl && folderEl.dataset.projectDir !== undefined) {
        hoveredFolder = folderEl;
        hoveredFolder.classList.add("drop-target");
        return;
      }

      const chatEl = els.find(
        (el) => el.classList?.contains("ds-nav-item") && (el as HTMLElement).dataset.chatId !== item.id
      ) as HTMLElement | undefined;
      if (chatEl) {
        const r = chatEl.getBoundingClientRect();
        dropPlacement = ev.clientY < r.top + r.height / 2 ? "above" : "below";
        hoveredChat = chatEl;
        hoveredChat.classList.add(dropPlacement === "above" ? "drop-above" : "drop-below");
      }
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);

      if (!dragging) return;
      if (rafHandle !== null) cancelAnimationFrame(rafHandle);

      btn.classList.remove("drag-origin");

      if (hoveredFolder && hoveredFolder.dataset.projectDir !== undefined) {
        const destDir = hoveredFolder.dataset.projectDir;
        item.workspaceDir = destDir;
        if (destDir) registerProjectDir(destDir);
        saveJson(HISTORY_STORAGE_KEY, historyItems);
      } else if (hoveredChat && hoveredChat.dataset.chatId) {
        const targetId = hoveredChat.dataset.chatId;
        const fromIdx = historyItems.findIndex((h) => h.id === item.id);
        const toIdx = historyItems.findIndex((h) => h.id === targetId);
        if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
          const [moved] = historyItems.splice(fromIdx, 1);
          const adjustedIdx = historyItems.findIndex((h) => h.id === targetId);
          const insertIdx = dropPlacement === "above" ? adjustedIdx : adjustedIdx + 1;
          historyItems.splice(insertIdx, 0, moved);
          historyItems = sortPinnedFirst(historyItems);
          saveJson(HISTORY_STORAGE_KEY, historyItems);
        }
      }

      clearDropIndicators();

      if (ghost) {
        const g = ghost;
        g.classList.add("settling");
        g.style.transform = `translate3d(${(lastClientX - grabOffsetX).toFixed(1)}px, ${(lastClientY - grabOffsetY).toFixed(1)}px, 0) scale(0.96) rotate(0deg)`;
        setTimeout(() => g.remove(), 220);
      }

      setTimeout(() => {
        suppressNextChatClick = false;
      }, 40);
      render(engine.getSnapshot());
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });
}

function buildNestedChatBtn(item: RunHistoryItem): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `ds-nav-item${selectedHistoryId === item.id ? " active" : ""}${item.pinned ? " pinned" : ""}`;
  btn.dataset.chatId = item.id;
  btn.title = item.goal;

  if (item.pinned) {
    const pin = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    pin.setAttribute("class", "ds-pin-icon");
    pin.setAttribute("width", "12");
    pin.setAttribute("height", "12");
    pin.setAttribute("viewBox", "0 0 24 24");
    pin.setAttribute("fill", "none");
    pin.setAttribute("stroke", "currentColor");
    pin.setAttribute("stroke-width", "2.2");
    pin.setAttribute("stroke-linecap", "round");
    pin.setAttribute("stroke-linejoin", "round");
    const p1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p1.setAttribute("d", "M12 17v5");
    const p2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p2.setAttribute("d", "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z");
    pin.append(p1, p2);
    btn.appendChild(pin);
  }

  if (renamingChatId === item.id) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ds-nav-rename-input";
    input.value = item.goal;

    let committed = false;
    const commit = (save: boolean) => {
      if (committed) return;
      committed = true;
      renamingChatId = null;
      const val = input.value.trim();
      if (save && val) {
        item.goal = val;
        item.customTitle = true;
        item.isDraft = false;
        saveJson(HISTORY_STORAGE_KEY, historyItems);
      }
      render(engine.getSnapshot());
    };

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        commit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        commit(false);
      }
    });
    input.addEventListener("blur", () => commit(true));
    input.addEventListener("click", (e) => e.stopPropagation());
    btn.appendChild(input);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return btn;
  }

  const span = document.createElement("span");
  span.className = "ds-nav-title";
  span.textContent = item.goal;
  btn.appendChild(span);

  btn.addEventListener("click", () => {
    if (suppressNextChatClick) return;
    showingStats = false;
    selectedHistoryId = item.id;
    if (item.isDraft) {
      void engine.startNewChat(item.id);
    } else {
      const legacyTurns: ChatTurn[] =
        item.turns && item.turns.length > 0
          ? item.turns
          : [
              {
                id: item.id,
                userText: item.goal,
                mode: item.mode,
                assistantReply: item.assistantReply,
                planItems: item.planItems,
                planDurationMs: item.planDurationMs,
                subagents: item.subagents.map((s, idx) => ({
                  id: `sub-${idx}`,
                  role: s.role,
                  title: s.title,
                  statusText: s.statusText,
                  lastOutput: s.lastOutput,
                  spriteVariant: s.spriteVariant,
                })),
              },
            ];
      void engine.loadChat({
        chatId: item.id,
        sessionID: item.sessionID ?? null,
        turns: legacyTurns,
        workspaceDir: item.workspaceDir,
      });
    }
    if (window.innerWidth <= 720) setSidebarCollapsed(true);
    render(engine.getSnapshot());
  });

  btn.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openChatContextMenu(item, e.clientX, e.clientY);
  });

  attachChatWeightedDrag(btn, item);
  return btn;
}

function renderWelcomeSprite(snap: OrchestratorSnapshot): void {
  const orchAvatarUrl = sprites.resolveAnimatedSpriteUrl(
    "orchestrator",
    "orchestrator",
    snap.orchestrator.state,
    performance.now()
  );
  if (welcomeSprite.src !== orchAvatarUrl) welcomeSprite.src = orchAvatarUrl;
}

function renderSidebar(snap: OrchestratorSnapshot): void {
  renderWelcomeSprite(snap);

  const q = searchQuery.trim().toLowerCase();

  // Projects Tab (ChatGPT nested folder style)
  const allProjectDirs = getAllKnownProjectDirs(snap.workspaceDir);
  const pinnedProjectSet = new Set(pinnedProjects);

  const filteredProjects = allProjectDirs.filter((dir) => {
    if (!q) return true;
    const base = getProjectDisplayName(dir).toLowerCase();
    const hasMatchingChat = historyItems.some(
      (h) => h.workspaceDir === dir && h.goal.toLowerCase().includes(q)
    );
    return base.includes(q) || dir.toLowerCase().includes(q) || hasMatchingChat;
  });

  if (filteredProjects.length === 0) {
    projectsTree.replaceChildren();
    projectsEmpty.hidden = false;
  } else {
    projectsEmpty.hidden = true;
    const blocks = filteredProjects.map((dir) => {
      const block = document.createElement("div");
      block.className = "ds-project-block";

      const isPinned = pinnedProjectSet.has(dir);
      const folderBtn = document.createElement("button");
      folderBtn.type = "button";
      folderBtn.className = `ds-project-folder${snap.workspaceDir === dir ? " active" : ""}${isPinned ? " pinned" : ""}`;
      folderBtn.dataset.projectDir = dir;
      folderBtn.title = dir;

      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "15");
      svg.setAttribute("height", "15");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "1.9");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute(
        "d",
        "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
      );
      svg.appendChild(path);
      folderBtn.appendChild(svg);

      if (isPinned) {
        const pin = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        pin.setAttribute("class", "ds-pin-icon");
        pin.setAttribute("width", "11");
        pin.setAttribute("height", "11");
        pin.setAttribute("viewBox", "0 0 24 24");
        pin.setAttribute("fill", "none");
        pin.setAttribute("stroke", "currentColor");
        pin.setAttribute("stroke-width", "2.2");
        pin.setAttribute("stroke-linecap", "round");
        pin.setAttribute("stroke-linejoin", "round");
        const p1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p1.setAttribute("d", "M12 17v5");
        const p2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p2.setAttribute(
          "d",
          "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"
        );
        pin.append(p1, p2);
        folderBtn.appendChild(pin);
      }

      if (renamingProjectDir === dir) {
        const input = document.createElement("input");
        input.type = "text";
        input.className = "ds-nav-rename-input";
        input.value = getProjectDisplayName(dir);

        let committed = false;
        const commit = (save: boolean) => {
          if (committed) return;
          committed = true;
          renamingProjectDir = null;
          const val = input.value.trim();
          if (save && val) {
            projectNames[dir] = val;
            saveJson(PROJECT_NAMES_KEY, projectNames);
          }
          render(engine.getSnapshot());
        };

        input.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commit(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            commit(false);
          }
        });
        input.addEventListener("blur", () => commit(true));
        input.addEventListener("click", (e) => e.stopPropagation());
        folderBtn.appendChild(input);
        requestAnimationFrame(() => {
          input.focus();
          input.select();
        });
      } else {
        const label = document.createElement("span");
        label.className = "ds-nav-title";
        label.textContent = getProjectDisplayName(dir);
        folderBtn.appendChild(label);

        folderBtn.addEventListener("click", () => {
          selectedHistoryId = null;
          void engine.setWorkspaceDir(dir);
        });
      }

      folderBtn.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openProjectContextMenu(dir, e.clientX, e.clientY);
      });

      block.appendChild(folderBtn);

      const nestedChats = historyItems.filter(
        (h) => h.workspaceDir === dir && (!q || h.goal.toLowerCase().includes(q))
      );
      if (nestedChats.length > 0) {
        const childWrap = document.createElement("div");
        childWrap.className = "ds-project-children";
        for (const chat of nestedChats.slice(0, 6)) {
          childWrap.appendChild(buildNestedChatBtn(chat));
        }
        block.appendChild(childWrap);
      }

      return block;
    });
    projectsTree.replaceChildren(...blocks);
  }

  // Chats Tab (Active Pets + Recents)
  if (snap.subagents.length > 0 && !selectedHistoryId) {
    activeThreadsGroup.hidden = false;
    const rows = snap.subagents.map((sub) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ds-nav-item active";

      const dot = document.createElement("span");
      dot.className = `ds-dot ${sub.permission ? "alert" : sub.state}`;

      const title = document.createElement("span");
      title.className = "ds-nav-title";
      title.textContent = `${sub.role} · ${sub.title}`;
      btn.title = sub.statusText;

      btn.append(dot, title);
      return btn;
    });
    activeSubagentNav.replaceChildren(...rows);
  } else {
    activeThreadsGroup.hidden = true;
    activeSubagentNav.replaceChildren();
  }

  const filteredChats = historyItems.filter((h) => !q || h.goal.toLowerCase().includes(q));
  recentsList.replaceChildren(...filteredChats.map(buildNestedChatBtn));
  historyEmpty.hidden = filteredChats.length > 0 || snap.subagents.length > 0;

  connDot.classList.toggle("online", snap.serverHealthy);

  btnToggleRoam.classList.toggle("active", snap.freeRoam);
  btnToggleRoam.textContent = snap.freeRoam ? "Pets On" : "Pets Off";

  const activeAgents =
    snap.subagents.length > 0
      ? snap.subagents.filter((s) => !s.completed).length || snap.subagents.length
      : snap.phase !== "idle"
        ? 1
        : 0;
  agentsBadge.textContent = `${activeAgents} ${activeAgents === 1 ? "agent" : "agents"}`;
  agentsBadge.classList.toggle("has-agents", activeAgents > 0);
}

function getBackendStatusLabel(snap: OrchestratorSnapshot, id: BackendId): {
  ready: boolean;
  label: string;
} {
  const avail = snap.backendAvailability?.[id];
  const ready = avail ? avail.available : id === (snap.activeBackend ?? "opencode") && snap.serverHealthy;
  if (ready) return { ready: true, label: "Ready" };
  if (id === "claude-code" || id === "codex-cli") {
    return { ready: false, label: "Not installed" };
  }
  return { ready: false, label: "Offline" };
}

function renderBackendControls(snap: OrchestratorSnapshot): void {
  const active = snap.activeBackend ?? "opencode";
  const avail = snap.backendAvailability?.[active];
  const { ready, label } = getBackendStatusLabel(snap, active);

  if (document.activeElement !== backendSelect) {
    backendSelect.value = active;
  }
  backendStatusDot.classList.toggle("online", ready);
  backendStatusDot.classList.toggle("offline", !ready);
  backendPicker.title = `${avail?.label ?? active}: ${label}${avail?.error ? ` (${avail.error})` : ""}`;
}

function renderModelControls(snap: OrchestratorSnapshot): void {
  const activeBackend = snap.activeBackend ?? "opencode";
  if (activeBackend !== "opencode") {
    modelPopover.hidden = true;
    variantPopover.hidden = true;
    variantPicker.hidden = true;
    const cfgModel = snap.backendConfigs?.[activeBackend]?.model?.trim();
    modelTriggerLabel.textContent = cfgModel || "Default model";
    btnModelTrigger.title = "Configure model in Settings → AI Backends";
    return;
  }

  variantPicker.hidden = false;
  btnModelTrigger.title = "Select AI model by subscription";

  const models = snap.availableModels;
  const activeModel = models.find(
    (m) =>
      snap.selectedModel &&
      m.providerID === snap.selectedModel.providerID &&
      m.id === snap.selectedModel.id
  );

  modelTriggerLabel.textContent = activeModel
    ? activeModel.name
    : snap.selectedModel?.id ?? "Default model";

  // Populate searchable grouped-by-subscription model popover
  const q = modelSearchQuery.trim().toLowerCase();
  const filtered = models.filter(
    (m) =>
      !q ||
      m.name.toLowerCase().includes(q) ||
      m.id.toLowerCase().includes(q) ||
      m.providerName.toLowerCase().includes(q) ||
      m.providerID.toLowerCase().includes(q)
  );

  const grouped = new Map<string, ModelOption[]>();
  for (const m of filtered) {
    const groupKey = m.providerName || m.providerID;
    const list = grouped.get(groupKey) ?? [];
    list.push(m);
    grouped.set(groupKey, list);
  }

  const nodes: HTMLElement[] = [];
  if (grouped.size === 0) {
    const empty = document.createElement("div");
    empty.className = "ds-model-empty";
    empty.textContent = models.length === 0 ? "Connecting to OpenCode..." : "No matching models.";
    nodes.push(empty);
  } else {
    for (const [providerLabel, items] of grouped.entries()) {
      const groupWrap = document.createElement("div");
      groupWrap.className = "ds-model-group";

      const header = document.createElement("div");
      header.className = "ds-model-group-header";

      const titleSpan = document.createElement("span");
      titleSpan.className = "ds-model-group-title";
      titleSpan.textContent = providerLabel;

      const countSpan = document.createElement("span");
      countSpan.className = "ds-model-group-count";
      countSpan.textContent = String(items.length);

      header.append(titleSpan, countSpan);
      groupWrap.appendChild(header);

      for (const m of items) {
        const isSelected =
          snap.selectedModel?.providerID === m.providerID && snap.selectedModel?.id === m.id;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `ds-model-item${isSelected ? " active" : ""}`;

        const main = document.createElement("div");
        main.className = "ds-model-item-main";
        const nameSpan = document.createElement("span");
        nameSpan.className = "ds-model-item-name";
        nameSpan.textContent = m.name;
        main.appendChild(nameSpan);

        if (m.variants.length > 0) {
          const badge = document.createElement("span");
          badge.className = "ds-model-tag";
          badge.textContent = m.variants.join("/");
          main.appendChild(badge);
        }

        btn.appendChild(main);
        if (isSelected) {
          const check = document.createElement("span");
          check.className = "ds-model-check";
          check.textContent = "✓";
          btn.appendChild(check);
        }

        btn.addEventListener("click", () => {
          const ref: SelectedModelRef = {
            providerID: m.providerID,
            id: m.id,
            variant:
              snap.selectedModel?.variant && m.variants.includes(snap.selectedModel.variant)
                ? snap.selectedModel.variant
                : undefined,
          };
          engine.setSelectedModel(ref);
          saveJson(MODEL_STORAGE_KEY, ref);
          modelPopover.hidden = true;
        });

        groupWrap.appendChild(btn);
      }

      nodes.push(groupWrap);
    }
  }
  modelListEl.replaceChildren(...nodes);

  // Thinking depth selector matching model selector
  const variants = activeModel?.variants ?? [];
  const curVar = snap.selectedModel?.variant ?? "";
  const activeVar = variants.includes(curVar) ? curVar : "";
  btnVariantTrigger.disabled = variants.length === 0;
  variantTriggerLabel.textContent =
    variants.length === 0 ? "n/a" : activeVar || "auto";

  const varChoices = variants.length > 0 ? ["", ...variants] : [];
  const varNodes: HTMLElement[] = varChoices.map((v) => {
    const isSel = v === activeVar;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `ds-model-item${isSel ? " active" : ""}`;
    const main = document.createElement("div");
    main.className = "ds-model-item-main";
    const span = document.createElement("span");
    span.className = "ds-model-item-name";
    span.textContent = v || "auto";
    main.appendChild(span);
    btn.appendChild(main);
    if (isSel) {
      const check = document.createElement("span");
      check.className = "ds-model-check";
      check.textContent = "✓";
      btn.appendChild(check);
    }
    btn.addEventListener("click", () => {
      const cur = engine.getSnapshot().selectedModel ?? (
        activeModel
          ? { providerID: activeModel.providerID, id: activeModel.id }
          : undefined
      );
      if (cur) {
        const ref: SelectedModelRef = {
          ...cur,
          variant: v || undefined,
        };
        engine.setSelectedModel(ref);
        saveJson(MODEL_STORAGE_KEY, ref);
      }
      variantPopover.hidden = true;
    });
    return btn;
  });
  variantListEl.replaceChildren(...varNodes);
}

function renderStage(snap: OrchestratorSnapshot): void {
  const visible = snap.turns.length > 0 && !snap.freeRoam && !showingStats;
  stageCard.hidden = !visible;
  stageSim.update(snap, visible);
}

function renderPermissions(snap: OrchestratorSnapshot): void {
  if (snap.activePermissions.length === 0) {
    permissionsPanel.hidden = true;
    permissionsList.replaceChildren();
    return;
  }

  permissionsPanel.hidden = false;
  const cards = snap.activePermissions.map((perm) => {
    const card = document.createElement("div");
    card.className = "ds-perm-card";

    const info = document.createElement("div");
    info.className = "ds-perm-info";
    const title = document.createElement("span");
    title.className = "ds-perm-title";
    title.textContent = `Tool Approval Required · ${perm.permission}`;
    const code = document.createElement("code");
    code.className = "ds-perm-code";
    code.textContent = perm.detail;
    info.append(title, code);

    const btns = document.createElement("div");
    btns.className = "ds-perm-btns";

    const mkBtn = (label: string, cls: string, reply: "once" | "always" | "reject") => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `bubble-btn ${cls}`;
      b.textContent = label;
      b.addEventListener("click", () => {
        for (const sibling of Array.from(btns.querySelectorAll("button"))) {
          sibling.disabled = true;
        }
        handlePermissionReply(perm.sessionID, perm.requestId, reply);
      });
      return b;
    };

    btns.append(
      mkBtn("Approve", "approve", "once"),
      mkBtn("Always", "always", "always"),
      mkBtn("Deny", "deny", "reject")
    );
    card.append(info, btns);
    return card;
  });
  permissionsList.replaceChildren(...cards);
}

function buildAgentMessageBlock(opts: {
  avatarUrl: string;
  role: string;
  meta: string;
  text: string;
  tone?: "normal" | "muted" | "error";
}): HTMLElement {
  const block = document.createElement("div");
  block.className = "ds-agent-msg";

  const head = document.createElement("div");
  head.className = "ds-agent-msg-head";

  const img = document.createElement("img");
  img.className = "ds-mini-avatar";
  img.src = opts.avatarUrl;
  img.alt = opts.role;

  const role = document.createElement("span");
  role.className = "ds-role-badge";
  role.textContent = opts.role;

  const meta = document.createElement("span");
  meta.className = "ds-agent-meta";
  meta.textContent = opts.meta;

  head.append(img, role, meta);

  const body = document.createElement("div");
  body.className = `ds-agent-body${opts.tone && opts.tone !== "normal" ? ` ${opts.tone}` : ""}`;
  if (opts.tone === "normal" || !opts.tone) {
    renderMarkdown(body, opts.text);
  } else {
    body.textContent = opts.text;
  }

  block.append(head, body);
  return block;
}

function renderTurns(snap: OrchestratorSnapshot): void {
  const turnBlocks: HTMLElement[] = [];
  const lastIdx = snap.turns.length - 1;

  snap.turns.forEach((turn, idx) => {
    const isActiveTurn = idx === lastIdx && snap.phase !== "idle" && snap.currentRunId === turn.id;
    const block = document.createElement("div");
    block.className = "ds-turn-block";

    const userRow = document.createElement("div");
    userRow.className = "ds-user-row";
    const userBubble = document.createElement("div");
    userBubble.className = "ds-user-bubble";
    userBubble.textContent = turn.userText;
    userRow.appendChild(userBubble);
    block.appendChild(userRow);

    if (isActiveTurn) {
      if (snap.subagents.length > 0) {
        for (const sub of snap.subagents) {
          const text = sub.errorText ?? sub.lastOutput ?? sub.statusText;
          block.appendChild(
            buildAgentMessageBlock({
              avatarUrl: sprites.resolveSpriteUrl(
                "subagent",
                sub.spriteVariant || sub.role,
                sub.state
              ),
              role: `${sub.role} · ${sub.title}`,
              meta: sub.worktreeBranch ? `${sub.statusText} · ${sub.worktreeBranch}` : sub.statusText,
              text,
              tone: sub.errorText ? "error" : sub.lastOutput ? "normal" : "muted",
            })
          );
        }
      } else {
        block.appendChild(
          buildAgentMessageBlock({
            avatarUrl: sprites.resolveSpriteUrl(
              "orchestrator",
              "orchestrator",
              snap.orchestrator.state
            ),
            role: "Boymoder",
            meta: turn.mode,
            text: snap.orchestrator.statusText,
            tone: "muted",
          })
        );
      }
    } else if (turn.subagents.length > 0) {
      for (const sub of turn.subagents) {
        const text = sub.errorText ?? sub.lastOutput ?? sub.statusText;
        block.appendChild(
          buildAgentMessageBlock({
            avatarUrl: sprites.resolveSpriteUrl(
              "subagent",
              sub.spriteVariant || sub.role,
              sub.errorText ? "error" : "idle"
            ),
            role: `${sub.role} · ${sub.title}`,
            meta: sub.worktreeBranch ? `${sub.statusText} · ${sub.worktreeBranch}` : sub.statusText,
            text,
            tone: sub.errorText ? "error" : sub.lastOutput ? "normal" : "muted",
          })
        );
      }
    } else if (turn.errorText) {
      block.appendChild(
        buildAgentMessageBlock({
          avatarUrl: sprites.resolveSpriteUrl("orchestrator", "orchestrator", "error"),
          role: "Boymoder",
          meta: "Error",
          text: turn.errorText,
          tone: "error",
        })
      );
    } else if (turn.assistantReply) {
      block.appendChild(
        buildAgentMessageBlock({
          avatarUrl: sprites.resolveSpriteUrl("orchestrator", "orchestrator", "idle"),
          role: "Boymoder",
          meta: turn.mode,
          text: turn.assistantReply,
        })
      );
    }

    turnBlocks.push(block);
  });

  turnsList.replaceChildren(...turnBlocks);
}

function renderThoughtTimer(snap: OrchestratorSnapshot): void {
  if (snap.phase === "planning" && snap.planStartedAt) {
    const secs = ((Date.now() - snap.planStartedAt) / 1000).toFixed(1);
    thoughtTimer.textContent = `Planning... ${secs}s`;
  } else if (snap.planDurationMs !== undefined) {
    const secs = (snap.planDurationMs / 1000).toFixed(1);
    const count = snap.planItems.length;
    thoughtTimer.textContent =
      count > 0 ? `${count} pets · ${secs}s` : `${secs}s`;
  } else {
    thoughtTimer.textContent = snap.orchestrator.statusText;
  }
}

function renderSettingsModal(snap: OrchestratorSnapshot): void {
  if (document.activeElement !== setWorkspaceInput) {
    setWorkspaceInput.value = snap.workspaceDir;
  }
  chkSetWorktrees.checked = snap.useWorktrees;
  chkSetOverlay.checked = snap.freeRoam;
  chkSetOnTop.checked = snap.alwaysOnTop;
  chkForceInteractive.checked = snap.forceInteractiveOverlay;
  const pct = Math.round((snap.petScale || 1) * 100);
  rangeSetScale.value = String(pct);
  setScaleLabel.textContent = `${pct}%`;

  const active = snap.activeBackend ?? "opencode";
  const { ready, label } = getBackendStatusLabel(snap, active);
  if (document.activeElement !== setActiveBackend) {
    setActiveBackend.value = active;
  }
  setBackendStatusBadge.textContent = label;
  setBackendStatusBadge.classList.toggle("ready", ready);
  setBackendStatusBadge.classList.toggle("unavailable", !ready);

  backendPanelOpencode.hidden = active !== "opencode";
  backendPanelCli.hidden = active !== "claude-code" && active !== "codex-cli";
  backendPanelOpenai.hidden = active !== "openai-compat";

  const ocAvail = snap.backendAvailability?.opencode;
  const ocHealthy = ocAvail ? ocAvail.available : active === "opencode" && snap.serverHealthy;
  setServerUrl.textContent = ocHealthy
    ? `Connected at ${snap.serverUrl}`
    : `Disconnected (${snap.serverUrl})`;
  if (document.activeElement !== setOpencodeUrl) {
    setOpencodeUrl.value = snap.backendConfigs?.opencode?.serverUrl ?? snap.serverUrl;
  }

  if (active === "claude-code" || active === "codex-cli") {
    const cliAvail = snap.backendAvailability?.[active];
    const cliCfg = snap.backendConfigs?.[active];
    setCliStatusDesc.textContent = cliAvail?.available
      ? `Ready: ${cliAvail.binary ?? active}${cliAvail.version ? ` (${cliAvail.version})` : ""}${cliAvail.path ? ` · ${cliAvail.path}` : ""}`
      : `Not installed${cliAvail?.error ? ` · ${cliAvail.error}` : ""}`;
    if (document.activeElement !== setCliModel) {
      setCliModel.value = cliCfg?.model ?? "";
    }
    if (document.activeElement !== setCliPath) {
      setCliPath.value = cliCfg?.cliPath ?? "";
    }
  }

  const oaAvail = snap.backendAvailability?.["openai-compat"];
  const oaCfg = snap.backendConfigs?.["openai-compat"];
  if (document.activeElement !== setOpenaiBaseUrl) {
    setOpenaiBaseUrl.value = oaCfg?.baseUrl ?? "http://127.0.0.1:8000/v1";
  }
  if (document.activeElement !== setOpenaiApiKey) {
    setOpenaiApiKey.value = oaCfg?.apiKey ?? "";
  }
  if (document.activeElement !== setOpenaiModel) {
    setOpenaiModel.value = oaCfg?.model ?? "";
  }
  setOpenaiStatusDesc.textContent = oaAvail?.available
    ? `Ready (${oaCfg?.baseUrl || "connected"})`
    : `Offline${oaAvail?.error ? ` · ${oaAvail.error}` : ""}`;
}

function paintStatsView(): void {
  renderStatsPage(statsView, cachedStats, loadLocalTelemetry(), {
    rangeDays: statsRangeDays,
    loading: statsLoading,
    error: statsError,
    onChangeRange: (days) => {
      statsRangeDays = days;
      void fetchAndShowStats();
    },
    onRefresh: () => void fetchAndShowStats(),
    onBack: () => {
      showingStats = false;
      render(engine.getSnapshot());
    },
  });
}

async function fetchAndShowStats(): Promise<void> {
  statsLoading = true;
  statsError = undefined;
  paintStatsView();
  try {
    const fromMs =
      statsRangeDays !== null
        ? Date.now() - statsRangeDays * 86_400_000
        : undefined;
    cachedStats = await engine.getSessionStats(fromMs);
  } catch (err) {
    statsError = err instanceof Error ? err.message : String(err);
  } finally {
    statsLoading = false;
    if (showingStats) paintStatsView();
  }
}

function render(snap: OrchestratorSnapshot): void {
  if (snap.tokensPerSec && snap.tokensPerSec > 0 && !snap.streamingActive) {
    const sampleKey = `${snap.currentRunId ?? ""}::${snap.totalTokens}::${snap.tokensPerSec}`;
    if (sampleKey !== lastRecordedTpsSample) {
      lastRecordedTpsSample = sampleKey;
      recordTpsTelemetry(snap.tokensPerSec, snap.selectedModel?.id);
    }
  } else if (snap.tokensPerSec && snap.tokensPerSec > 0) {
    recordTpsTelemetry(snap.tokensPerSec, snap.selectedModel?.id);
  }

  syncActiveChatHistory(snap);
  renderSidebar(snap);
  renderBackendControls(snap);
  renderModelControls(snap);
  renderSettingsModal(snap);

  btnOpenStats.classList.toggle("active", showingStats);

  const selectedItem = selectedHistoryId
    ? historyItems.find((h) => h.id === selectedHistoryId)
    : undefined;

  const busy = snap.phase === "planning" || snap.phase === "executing";

  tpsBadge.textContent = `${(snap.tokensPerSec ?? 0).toFixed(1)} tok/s`;
  tpsBadge.classList.toggle("streaming", snap.streamingActive);

  phaseBadge.textContent = showingStats ? "Stats" : snap.orchestrator.statusText;
  phaseBadge.classList.toggle("working", !showingStats && busy);

  const hasResting =
    !showingStats && snap.phase === "idle" && snap.subagents.length > 0;
  btnClearResting.hidden = !hasResting;

  topbarTitle.textContent = showingStats
    ? "Statistics"
    : selectedItem?.goal ?? snap.turns[0]?.userText ?? "Boymoder AI Assistant";
  topbarWorkspace.textContent =
    !showingStats && snap.workspaceDir
      ? `· ${getProjectDisplayName(snap.workspaceDir)}`
      : "";

  if (showingStats) {
    welcomeState.hidden = true;
    threadState.hidden = true;
    composerOuter.hidden = true;
    statsView.hidden = false;
    paintStatsView();
    return;
  }

  statsView.hidden = true;
  composerOuter.hidden = false;

  const showThread = snap.turns.length > 0 || snap.subagents.length > 0;
  welcomeState.hidden = showThread;
  threadState.hidden = !showThread;

  if (showThread) {
    const planItems = snap.planItems;
    const showAccordion = snap.mode === "orchestration" || planItems.length > 0;
    planAccordion.hidden = !showAccordion;

    if (showAccordion) {
      thoughtTitle.textContent =
        snap.phase === "planning" ? "Planning tasks..." : "Execution Plan";
      renderThoughtTimer(snap);

      const planRows = planItems.map((item) => {
        const row = document.createElement("div");
        row.className = "ds-plan-row";
        const left = document.createElement("span");
        const badge = document.createElement("span");
        badge.className = "ds-plan-role";
        badge.textContent = item.role;
        left.append(badge, document.createTextNode(item.title));

        const right = document.createElement("span");
        right.className = "ds-plan-scope";
        right.textContent = item.branch_or_scope ?? "";

        row.append(left, right);
        return row;
      });
      planItemsList.replaceChildren(...planRows);

      const logEls = snap.logs.slice(0, 20).map((entry) => {
        const div = document.createElement("div");
        div.className = `log-line ${entry.level}`;
        div.textContent = `[${entry.timestamp}] [${entry.source}] ${entry.message}`;
        return div;
      });
      logList.replaceChildren(...logEls);
    }
  }

  renderTurns(snap);
  renderStage(snap);
  renderPermissions(snap);

  for (const btn of Array.from(modeGroup.querySelectorAll<HTMLButtonElement>(".ds-mode-seg"))) {
    btn.classList.toggle("active", btn.dataset.mode === snap.mode);
  }
  requestAnimationFrame(() => positionModeThumb(snap.mode));

  btnPillWorktree.hidden = snap.mode !== "orchestration";
  btnPillWorktree.classList.toggle("active", snap.useWorktrees);
  btnPillWorktree.setAttribute("aria-pressed", String(snap.useWorktrees));

  btnSendStop.classList.toggle("running", busy);
  iconSend.hidden = busy;
  iconStop.hidden = !busy;
  labelStop.hidden = !busy;
  btnSendStop.title = busy ? "Stop generating" : "Send message (Enter)";
  btnSendStop.disabled = !busy && goalInput.value.trim().length === 0;

  if (snap.phase === "planning" && timerInterval === null) {
    timerInterval = window.setInterval(() => renderThoughtTimer(engine.getSnapshot()), 200);
  } else if (snap.phase !== "planning" && timerInterval !== null) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function autoResizeTextarea(): void {
  goalInput.style.height = "auto";
  goalInput.style.height = `${Math.min(180, Math.max(24, goalInput.scrollHeight))}px`;
  const snap = engine.getSnapshot();
  const busy = snap.phase === "planning" || snap.phase === "executing";
  if (!busy) {
    btnSendStop.disabled = goalInput.value.trim().length === 0;
  }
}

async function browseAndSelectWorkspace(): Promise<void> {
  try {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Select Workspace Project Directory",
    });
    if (typeof selected === "string" && selected) {
      registerProjectDir(selected);
      await engine.setWorkspaceDir(selected);
    }
  } catch {
    settingsModal.hidden = false;
    setWorkspaceInput.focus();
  }
}

async function init(): Promise<void> {
  try {
    const savedTheme = localStorage.getItem(THEME_STORAGE_KEY);
    if (savedTheme === "light" || savedTheme === "dark") applyTheme(savedTheme);
  } catch {
    applyTheme("dark");
  }

  const savedScale = Number(localStorage.getItem(PET_SCALE_KEY) || "1");
  if (!Number.isNaN(savedScale) && savedScale >= 0.7 && savedScale <= 1.4) {
    engine.setPetScale(savedScale);
  }

  const savedModel = loadJson<SelectedModelRef | undefined>(MODEL_STORAGE_KEY, undefined);
  if (savedModel?.id && savedModel?.providerID) {
    engine.setSelectedModel(savedModel);
  }

  const savedConfigs = loadJson<Partial<Record<BackendId, BackendConfig>>>(
    BACKEND_CONFIGS_KEY,
    {}
  );
  for (const id of ["opencode", "claude-code", "codex-cli", "openai-compat"] as BackendId[]) {
    const cfg = savedConfigs[id];
    if (cfg) {
      const { apiKey: _apiKey, ...safeCfg } = cfg;
      engine.updateBackendConfig(id, safeCfg);
    }
  }
  setOpenaiApiKey.placeholder = "sk-... (session only)";

  let initialBackend: BackendId = "opencode";
  try {
    const savedBackend = localStorage.getItem(ACTIVE_BACKEND_KEY);
    if (
      savedBackend === "opencode" ||
      savedBackend === "claude-code" ||
      savedBackend === "codex-cli" ||
      savedBackend === "openai-compat"
    ) {
      initialBackend = savedBackend;
    }
  } catch {
    // Ignore
  }

  // Pets are OFF by default unless user explicitly enabled startup auto-launch
  const autoLaunchPets = localStorage.getItem(AUTO_PETS_KEY) === "true";
  chkSetAutoLaunch.checked = autoLaunchPets;

  // Ensure an initial single "New chat" exists from the start and sync its ID with engine
  const initialChatId = createOrFocusNewChat(engine.getSnapshot().workspaceDir);
  void engine.startNewChat(initialChatId);

  if (window.innerWidth <= 720) {
    setSidebarCollapsed(true);
  }

  const pack = await sprites.load();
  await broadcastSprites(pack);

  engine.subscribe((snap) => {
    render(snap);
    void broadcastState(snap);
  });

  await onOverlayAction((action) => {
    if (action.type === "ready") {
      void broadcastSprites(sprites.getPack());
      void broadcastState(engine.getSnapshot());
    } else if (action.type === "recall") {
      void engine.setWindowMode(false).catch((err) => {
        engine.log("error", "Window", `Recall failed: ${String(err)}`);
      });
    } else if (action.type === "permission-reply") {
      handlePermissionReply(action.sessionID, action.requestId, action.reply);
    } else if (action.type === "dismiss-bubble") {
      engine.dismissBubble(action.petId);
    }
  });

  btnCollapseSidebar.addEventListener("click", () => setSidebarCollapsed(true));
  btnExpandSidebar.addEventListener("click", () => setSidebarCollapsed(false));
  sidebarBackdrop.addEventListener("click", () => setSidebarCollapsed(true));

  btnSearchToggle.addEventListener("click", () => {
    sidebarSearchWrap.hidden = !sidebarSearchWrap.hidden;
    if (!sidebarSearchWrap.hidden) {
      sidebarSearchInput.focus();
    } else {
      sidebarSearchInput.value = "";
      searchQuery = "";
      render(engine.getSnapshot());
    }
  });

  sidebarSearchInput.addEventListener("input", () => {
    searchQuery = sidebarSearchInput.value;
    render(engine.getSnapshot());
  });

  tabProjects.addEventListener("click", () => switchSidebarTab("projects"));
  tabChats.addEventListener("click", () => switchSidebarTab("chats"));
  btnAddProject.addEventListener("click", () => void browseAndSelectWorkspace());

  btnNewChat.addEventListener("click", () => {
    showingStats = false;
    const chatId = createOrFocusNewChat(engine.getSnapshot().workspaceDir);
    void engine.startNewChat(chatId);
    if (window.innerWidth <= 720) setSidebarCollapsed(true);
    goalInput.focus();
  });

  btnOpenStats.addEventListener("click", () => {
    showingStats = true;
    if (window.innerWidth <= 720) setSidebarCollapsed(true);
    render(engine.getSnapshot());
    void fetchAndShowStats();
  });

  const toggleDesktopPets = async (enable: boolean) => {
    const spot = enable ? await captureWelcomeDropOrigin() : null;
    await engine.setWindowMode(enable);
    if (enable && spot) {
      await broadcastPetDrop(spot);
      setTimeout(() => void broadcastPetDrop(spot), 180);
    }
  };

  btnToggleRoam.addEventListener("click", () => {
    const next = !engine.getSnapshot().freeRoam;
    void toggleDesktopPets(next).catch((err) => {
      engine.log("error", "Window", `Failed to toggle pets: ${String(err)}`);
    });
  });

  modeGroup.addEventListener("click", (e) => {
    const seg = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>(".ds-mode-seg");
    const mode = seg?.dataset.mode as ExecutionMode | undefined;
    if (mode === "build" || mode === "plan" || mode === "orchestration") {
      engine.setMode(mode);
    }
  });

  // Searchable Model & Thinking Depth Popovers
  btnModelTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const activeBackend = engine.getActiveBackendId();
    if (activeBackend !== "opencode") {
      modelPopover.hidden = true;
      variantPopover.hidden = true;
      settingsModal.hidden = false;
      if (activeBackend === "openai-compat") {
        setOpenaiModel.focus();
      } else {
        setCliModel.focus();
      }
      return;
    }
    variantPopover.hidden = true;
    modelPopover.hidden = !modelPopover.hidden;
    if (!modelPopover.hidden) {
      modelSearchQuery = "";
      modelSearchInput.value = "";
      renderModelControls(engine.getSnapshot());
      modelSearchInput.focus();
    }
  });

  btnVariantTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    modelPopover.hidden = true;
    variantPopover.hidden = !variantPopover.hidden;
  });

  modelSearchInput.addEventListener("input", () => {
    modelSearchQuery = modelSearchInput.value;
    renderModelControls(engine.getSnapshot());
  });

  document.addEventListener("click", (e) => {
    if (!modelPopover.hidden && !modelPicker.contains(e.target as Node)) {
      modelPopover.hidden = true;
    }
    if (!variantPopover.hidden && !variantPicker.contains(e.target as Node)) {
      variantPopover.hidden = true;
    }
    if (!chatContextMenu.hidden && !chatContextMenu.contains(e.target as Node)) {
      closeChatContextMenu();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      modelPopover.hidden = true;
      variantPopover.hidden = true;
      settingsModal.hidden = true;
      closeChatContextMenu();
    }
  });

  btnPillWorktree.addEventListener("click", () => {
    engine.setUseWorktrees(!engine.getSnapshot().useWorktrees);
  });

  btnClearResting.addEventListener("click", () => {
    void engine.clearRestingSubagents();
  });

  // Settings Modal wiring
  btnOpenSettings.addEventListener("click", () => {
    settingsModal.hidden = false;
  });
  btnCloseSettings.addEventListener("click", () => {
    settingsModal.hidden = true;
  });
  settingsModal.addEventListener("click", (e) => {
    if (e.target === settingsModal) settingsModal.hidden = true;
  });

  setThemeSelect.addEventListener("change", () => {
    applyTheme(setThemeSelect.value === "light" ? "light" : "dark");
  });
  btnSetBrowse.addEventListener("click", () => void browseAndSelectWorkspace());
  setWorkspaceInput.addEventListener("change", () => {
    const dir = setWorkspaceInput.value.trim();
    if (dir) registerProjectDir(dir);
    void engine.setWorkspaceDir(dir);
  });
  chkSetWorktrees.addEventListener("change", () => {
    engine.setUseWorktrees(chkSetWorktrees.checked);
  });
  chkSetOverlay.addEventListener("change", () => {
    void toggleDesktopPets(chkSetOverlay.checked);
  });
  chkSetAutoLaunch.addEventListener("change", () => {
    try {
      localStorage.setItem(AUTO_PETS_KEY, String(chkSetAutoLaunch.checked));
    } catch {
      // Ignore
    }
  });
  chkSetOnTop.addEventListener("change", () => {
    void engine.setAlwaysOnTop(chkSetOnTop.checked);
  });
  rangeSetScale.addEventListener("input", () => {
    const val = Number(rangeSetScale.value) / 100;
    engine.setPetScale(val);
    try {
      localStorage.setItem(PET_SCALE_KEY, String(val));
    } catch {
      // Ignore
    }
  });
  chkForceInteractive.addEventListener("change", () => {
    void engine.setForceInteractiveOverlay(chkForceInteractive.checked);
  });
  btnReloadSprites.addEventListener("click", async () => {
    const updated = await sprites.load();
    await broadcastSprites(updated);
    render(engine.getSnapshot());
  });
  const persistBackendConfigs = () => {
    const configs = engine.getSnapshot().backendConfigs;
    if (!configs) return;
    const toPersist: Partial<Record<BackendId, BackendConfig>> = {};
    for (const [id, cfg] of Object.entries(configs) as Array<[BackendId, BackendConfig]>) {
      const { apiKey: _apiKey, ...rest } = cfg;
      toPersist[id] = rest;
    }
    saveJson(BACKEND_CONFIGS_KEY, toPersist);
  };

  const switchBackend = async (next: BackendId) => {
    if (
      next !== "opencode" &&
      next !== "claude-code" &&
      next !== "codex-cli" &&
      next !== "openai-compat"
    ) {
      return;
    }
    try {
      localStorage.setItem(ACTIVE_BACKEND_KEY, next);
    } catch {
      // Ignore
    }
    await engine.setBackend(next);
  };

  backendSelect.addEventListener("change", () => {
    void switchBackend(backendSelect.value as BackendId);
  });
  setActiveBackend.addEventListener("change", () => {
    void switchBackend(setActiveBackend.value as BackendId);
  });

  setOpencodeUrl.addEventListener("change", () => {
    const url = setOpencodeUrl.value.trim();
    if (url) {
      engine.updateBackendConfig("opencode", { serverUrl: url });
      persistBackendConfigs();
    }
  });
  btnSetReconnect.addEventListener("click", () => {
    const url = setOpencodeUrl.value.trim();
    if (url) {
      engine.updateBackendConfig("opencode", { serverUrl: url });
      persistBackendConfigs();
    }
    void engine.startAndConnectServer();
  });

  setCliModel.addEventListener("input", () => {
    const active = engine.getActiveBackendId();
    if (active === "claude-code" || active === "codex-cli") {
      engine.updateBackendConfig(active, { model: setCliModel.value });
      persistBackendConfigs();
    }
  });
  setCliPath.addEventListener("change", () => {
    const active = engine.getActiveBackendId();
    if (active === "claude-code" || active === "codex-cli") {
      engine.updateBackendConfig(active, { cliPath: setCliPath.value.trim() });
      persistBackendConfigs();
      void engine.checkConnection();
    }
  });
  btnRecheckCli.addEventListener("click", () => {
    const active = engine.getActiveBackendId();
    if (active === "claude-code" || active === "codex-cli") {
      engine.updateBackendConfig(active, {
        cliPath: setCliPath.value.trim(),
        model: setCliModel.value,
      });
      persistBackendConfigs();
    }
    void engine.checkConnection();
  });

  const syncOpenAiConfig = () => {
    engine.updateBackendConfig("openai-compat", {
      baseUrl: setOpenaiBaseUrl.value,
      apiKey: setOpenaiApiKey.value,
      model: setOpenaiModel.value,
    });
    persistBackendConfigs();
  };
  setOpenaiBaseUrl.addEventListener("input", syncOpenAiConfig);
  setOpenaiApiKey.addEventListener("input", syncOpenAiConfig);
  setOpenaiModel.addEventListener("input", syncOpenAiConfig);
  btnTestOpenai.addEventListener("click", () => {
    syncOpenAiConfig();
    void engine.checkConnection();
  });

  btnClearHistory.addEventListener("click", () => {
    historyItems = [];
    saveJson(HISTORY_STORAGE_KEY, []);
    selectedHistoryId = null;
    const chatId = createOrFocusNewChat(engine.getSnapshot().workspaceDir);
    void engine.startNewChat(chatId);
    render(engine.getSnapshot());
  });

  const submitOrAbort = () => {
    const snap = engine.getSnapshot();
    const busy = snap.phase === "planning" || snap.phase === "executing";
    if (busy) {
      void engine.abortAll();
      return;
    }
    const goal = goalInput.value.trim();
    if (!goal) return;

    goalInput.value = "";
    autoResizeTextarea();

    void engine.submitGoal(goal).catch((err) => {
      engine.log("error", "Boymoder", `Submit error: ${String(err)}`);
    });
  };

  btnSendStop.addEventListener("click", submitOrAbort);
  goalInput.addEventListener("input", autoResizeTextarea);
  goalInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitOrAbort();
    }
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 720) {
      sidebarBackdrop.hidden = true;
    } else if (!shellEl.classList.contains("sidebar-collapsed")) {
      sidebarBackdrop.hidden = false;
    }
    positionModeThumb(engine.getSnapshot().mode);
  });

  requestAnimationFrame(() => positionModeThumb(engine.getSnapshot().mode));
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => positionModeThumb(engine.getSnapshot().mode)).observe(modeGroup);
  }
  void document.fonts?.ready.then(() => positionModeThumb(engine.getSnapshot().mode));

  if (autoLaunchPets) {
    void toggleDesktopPets(true).catch(() => {});
  }

  if (initialBackend === "opencode") {
    await engine.startAndConnectServer();
  } else {
    await engine.setBackend(initialBackend);
  }
  void engine.checkAllBackends();
  setInterval(() => {
    if (!welcomeState.hidden) {
      renderWelcomeSprite(engine.getSnapshot());
    }
  }, 180);
  setInterval(() => {
    if (!engine.getSnapshot().serverHealthy) {
      void engine.checkConnection();
    }
  }, 8000);
}

void init();
