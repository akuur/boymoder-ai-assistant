import type { SessionStatsData } from "../engine/types";

export interface LocalTelemetry {
  peakTps: number;
  peakModel: string;
  peakAt: number;
  tpsSum: number;
  tpsCount: number;
  petsSpawned: number;
  runsCompleted: number;
}

const LOCAL_STATS_KEY = "akuur_local_stats_v1";

export function loadLocalTelemetry(): LocalTelemetry {
  try {
    const raw = localStorage.getItem(LOCAL_STATS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<LocalTelemetry>;
      return {
        peakTps: typeof p.peakTps === "number" ? p.peakTps : 0,
        peakModel: typeof p.peakModel === "string" ? p.peakModel : "",
        peakAt: typeof p.peakAt === "number" ? p.peakAt : 0,
        tpsSum: typeof p.tpsSum === "number" ? p.tpsSum : 0,
        tpsCount: typeof p.tpsCount === "number" ? p.tpsCount : 0,
        petsSpawned: typeof p.petsSpawned === "number" ? p.petsSpawned : 0,
        runsCompleted: typeof p.runsCompleted === "number" ? p.runsCompleted : 0,
      };
    }
  } catch {
    // Ignore
  }
  return {
    peakTps: 0,
    peakModel: "",
    peakAt: 0,
    tpsSum: 0,
    tpsCount: 0,
    petsSpawned: 0,
    runsCompleted: 0,
  };
}

function saveLocalTelemetry(t: LocalTelemetry): void {
  try {
    localStorage.setItem(LOCAL_STATS_KEY, JSON.stringify(t));
  } catch {
    // Ignore
  }
}

export function recordTpsTelemetry(tps: number, modelName?: string): LocalTelemetry {
  const t = loadLocalTelemetry();
  if (!Number.isFinite(tps) || tps <= 0 || tps > 5000) return t;
  if (tps > t.peakTps) {
    t.peakTps = Math.round(tps * 10) / 10;
    t.peakModel = modelName || "Unknown";
    t.peakAt = Date.now();
  }
  t.tpsSum += tps;
  t.tpsCount += 1;
  saveLocalTelemetry(t);
  return t;
}

export function recordCompletedRunTelemetry(subagentCount: number): LocalTelemetry {
  const t = loadLocalTelemetry();
  t.runsCompleted += 1;
  t.petsSpawned += Math.max(0, subagentCount);
  saveLocalTelemetry(t);
  return t;
}

export function formatCompactNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function getSpeedRank(tps: number): string {
  if (tps <= 0) return "Warming up";
  if (tps < 25) return "Steady Walker";
  if (tps < 60) return "Swift Fox";
  if (tps < 110) return "Supersonic";
  if (tps < 200) return "Warp Core";
  return "Ludicrous Speed";
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderStatsPage(
  container: HTMLElement,
  stats: SessionStatsData | null,
  local: LocalTelemetry,
  opts: {
    rangeDays: number | null;
    loading: boolean;
    error?: string;
    onChangeRange: (days: number | null) => void;
    onRefresh: () => void;
    onBack: () => void;
  }
): void {
  const frag = document.createDocumentFragment();

  // Header
  const header = el("div", "ds-stats-header");
  const titleWrap = el("div", "ds-stats-title-wrap");
  titleWrap.append(
    el("h1", "ds-stats-title", "Usage & Statistics"),
    el("p", "ds-stats-sub", "OpenCode session telemetry and Boymoder AI Assistant performance records")
  );

  const controls = el("div", "ds-stats-controls");
  const ranges: Array<{ label: string; days: number | null }> = [
    { label: "All Time", days: null },
    { label: "30D", days: 30 },
    { label: "7D", days: 7 },
  ];
  const rangeGroup = el("div", "ds-stats-range-group");
  for (const r of ranges) {
    const b = el("button", `ds-stats-range-btn${opts.rangeDays === r.days ? " active" : ""}`, r.label);
    b.type = "button";
    b.addEventListener("click", () => opts.onChangeRange(r.days));
    rangeGroup.appendChild(b);
  }

  const refreshBtn = el("button", "ds-btn-secondary", opts.loading ? "Refreshing..." : "Refresh");
  refreshBtn.type = "button";
  refreshBtn.disabled = opts.loading;
  refreshBtn.addEventListener("click", opts.onRefresh);

  const backBtn = el("button", "ds-btn-secondary", "Back to Chat");
  backBtn.type = "button";
  backBtn.addEventListener("click", opts.onBack);

  controls.append(rangeGroup, refreshBtn, backBtn);
  header.append(titleWrap, controls);
  frag.appendChild(header);

  if (opts.error) {
    frag.appendChild(el("div", "ds-stats-error", opts.error));
  }

  const inputTok = stats?.tokens.input ?? 0;
  const outputTok = stats?.tokens.output ?? 0;
  const reasoningTok = stats?.tokens.reasoning ?? 0;
  const cacheRead = stats?.tokens.cache?.read ?? 0;
  const totalNonCache = inputTok + outputTok + reasoningTok;
  const activeDays = Math.max(1, stats?.activeDays ?? 0);
  const dailyAvg = stats ? totalNonCache / activeDays : 0;
  const cacheHitPct =
    inputTok + cacheRead > 0 ? Math.round((cacheRead / (inputTok + cacheRead)) * 100) : 0;
  const avgTps = local.tpsCount > 0 ? local.tpsSum / local.tpsCount : 0;

  // Hero KPI Cards
  const kpiGrid = el("div", "ds-stats-kpi-grid");

  const mkKpi = (label: string, value: string, sub: string, accentClass?: string) => {
    const card = el("div", `ds-kpi-card${accentClass ? ` ${accentClass}` : ""}`);
    card.append(
      el("div", "ds-kpi-label", label),
      el("div", "ds-kpi-value", value),
      el("div", "ds-kpi-sub", sub)
    );
    return card;
  };

  kpiGrid.append(
    mkKpi(
      "Max Speed Hit",
      `${local.peakTps.toFixed(1)} tok/s`,
      local.peakModel ? `${getSpeedRank(local.peakTps)} · ${local.peakModel}` : "Run a prompt to set record",
      "kpi-speed"
    ),
    mkKpi(
      "Daily Avg Tokens",
      formatCompactNumber(dailyAvg),
      stats ? `Across ${stats.activeDays} active day(s)` : "Waiting for OpenCode stats",
      "kpi-daily"
    ),
    mkKpi(
      "Total Tokens",
      formatCompactNumber(totalNonCache),
      `Out ${formatCompactNumber(outputTok)} · Think ${formatCompactNumber(reasoningTok)} · Cache ${cacheHitPct}%`,
      "kpi-tokens"
    ),
    mkKpi(
      "Streak & Sessions",
      `${stats?.streak ?? 0}d streak`,
      `${stats?.sessions ?? 0} sessions · ${stats?.prompts ?? 0} prompts · ${stats?.steps ?? 0} steps`,
      "kpi-streak"
    )
  );
  frag.appendChild(kpiGrid);

  // Activity Chart (OpenCode style daily steps bars)
  const actCard = el("div", "ds-stats-card");
  const actHead = el("div", "ds-stats-card-head");
  actHead.append(
    el("h2", "ds-stats-card-title", "Daily Activity"),
    el("span", "ds-stats-card-meta", `${stats?.activity.length ?? 0} active days logged`)
  );
  actCard.appendChild(actHead);

  const activity = stats?.activity ?? [];
  if (activity.length === 0) {
    actCard.appendChild(el("div", "ds-stats-empty", "No activity data in this range yet."));
  } else {
    const barsWrap = el("div", "ds-activity-bars");
    const recent = activity.slice(-24);
    const maxSteps = Math.max(1, ...recent.map((a) => a.steps));
    for (const day of recent) {
      const col = el("div", "ds-act-col");
      col.title = `${day.date}: ${day.steps} steps`;
      const pct = Math.max(8, Math.round((day.steps / maxSteps) * 100));
      const bar = el("div", "ds-act-bar");
      bar.style.height = `${pct}%`;
      const count = el("span", "ds-act-count", String(day.steps));
      const dateLbl = el("span", "ds-act-date", day.date.slice(5));
      col.append(count, bar, dateLbl);
      barsWrap.appendChild(col);
    }
    actCard.appendChild(barsWrap);
  }
  frag.appendChild(actCard);

  // Bottom 2-column grid: Model Breakdown + Fun & Tool Stats
  const twoCol = el("div", "ds-stats-two-col");

  // Model Usage Breakdown
  const modCard = el("div", "ds-stats-card");
  const modHead = el("div", "ds-stats-card-head");
  modHead.append(
    el("h2", "ds-stats-card-title", "Models Used"),
    el("span", "ds-stats-card-meta", `${stats?.models.length ?? 0} models`)
  );
  modCard.appendChild(modHead);

  const models = [...(stats?.models ?? [])].sort((a, b) => b.steps - a.steps);
  if (models.length === 0) {
    modCard.appendChild(el("div", "ds-stats-empty", "No model usage recorded yet."));
  } else {
    const totalModelSteps = Math.max(1, models.reduce((acc, m) => acc + m.steps, 0));
    const list = el("div", "ds-model-usage-list");
    for (const m of models.slice(0, 10)) {
      const row = el("div", "ds-model-usage-row");
      const top = el("div", "ds-model-usage-top");
      const nameWrap = el("div", "ds-model-usage-name");
      nameWrap.append(
        el("span", "ds-mu-id", `${m.model.providerID}/${m.model.id}`),
        ...(m.model.variant && m.model.variant !== "default"
          ? [el("span", "ds-model-tag", m.model.variant)]
          : [])
      );
      const tokSum = (m.tokens.output ?? 0) + (m.tokens.reasoning ?? 0);
      const meta = el(
        "span",
        "ds-mu-meta",
        `${m.steps} steps · ${formatCompactNumber(tokSum)} tok`
      );
      top.append(nameWrap, meta);

      const track = el("div", "ds-mu-track");
      const fill = el("div", "ds-mu-fill");
      const share = Math.max(3, Math.round((m.steps / totalModelSteps) * 100));
      fill.style.width = `${share}%`;
      track.appendChild(fill);

      row.append(top, track);
      list.appendChild(row);
    }
    modCard.appendChild(list);
  }
  twoCol.appendChild(modCard);

  // Fun Stats & Tool Reliability
  const funCard = el("div", "ds-stats-card");
  const funHead = el("div", "ds-stats-card-head");
  funHead.append(
    el("h2", "ds-stats-card-title", "Fun Stats & Tools"),
    el("span", "ds-stats-card-meta", "Boymoder highlights")
  );
  funCard.appendChild(funHead);

  const toolCalls = stats?.tools?.totals?.calls ?? 0;
  const toolOk = stats?.tools?.totals?.succeeded ?? 0;
  const toolSuccessPct = toolCalls > 0 ? ((toolOk / toolCalls) * 100).toFixed(1) : "100.0";
  const pagesWritten = Math.round(outputTok / 350);
  const thinkRatio = outputTok > 0 ? (reasoningTok / outputTok).toFixed(2) : "0.00";
  const totalSubagents = (stats?.subagents ?? 0) + local.petsSpawned;

  const funGrid = el("div", "ds-fun-grid");
  const mkFun = (title: string, val: string, hint: string) => {
    const box = el("div", "ds-fun-box");
    box.append(
      el("div", "ds-fun-val", val),
      el("div", "ds-fun-title", title),
      el("div", "ds-fun-hint", hint)
    );
    return box;
  };

  funGrid.append(
    mkFun("Average Speed", `${avgTps.toFixed(1)} tok/s`, `${local.tpsCount} measured turns`),
    mkFun("Book Pages Written", formatCompactNumber(pagesWritten), "~350 output tokens per page"),
    mkFun("Tool Reliability", `${toolSuccessPct}%`, `${toolOk} / ${toolCalls} calls succeeded`),
    mkFun("Think-to-Reply Ratio", `${thinkRatio}x`, `${formatCompactNumber(reasoningTok)} reasoning tokens`),
    mkFun("Cache Served", formatCompactNumber(cacheRead), `${cacheHitPct}% prompt tokens cached`),
    mkFun("Helper Pets Summoned", String(totalSubagents), `${local.runsCompleted} local Boymoder runs`)
  );

  funCard.appendChild(funGrid);
  twoCol.appendChild(funCard);
  frag.appendChild(twoCol);

  container.replaceChildren(frag);
}
