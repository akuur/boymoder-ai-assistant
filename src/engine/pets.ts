import { invoke } from "@tauri-apps/api/core";
import type { PetAnimState, PetRoleKind, PetSpritePack } from "./types";

function makeSvgFallback(label: string, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><circle cx="80" cy="80" r="64" fill="${color}" stroke="#ffffff" stroke-width="6"/><text x="80" y="88" font-family="sans-serif" font-size="22" font-weight="bold" fill="#ffffff" text-anchor="middle">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const DEFAULT_FALLBACK_PACK: PetSpritePack = {
  rootPath: "assets/pets",
  orchestrator: {
    idle: makeSvgFallback("AI", "#6366f1"),
    work: makeSvgFallback("WORK", "#4f46e5"),
    alert: makeSvgFallback("!", "#f59e0b"),
    error: makeSvgFallback("ERR", "#ef4444"),
  },
  subagents: {
    default: {
      idle: makeSvgFallback("SUB", "#14b8a6"),
      walk: makeSvgFallback("WALK", "#0d9488"),
      work: makeSvgFallback("DEV", "#0f766e"),
      alert: makeSvgFallback("!", "#f59e0b"),
    },
  },
};

export class PetSpriteRegistry {
  private pack: PetSpritePack = DEFAULT_FALLBACK_PACK;

  async load(): Promise<PetSpritePack> {
    try {
      const loaded = await invoke<PetSpritePack>("scan_pet_sprites");
      if (
        loaded &&
        (Object.keys(loaded.orchestrator).length > 0 ||
          Object.keys(loaded.subagents).length > 0)
      ) {
        this.pack = loaded;
        return this.pack;
      }
    } catch {
      // Fallback for non-Tauri preview or missing assets folder
    }
    this.pack = DEFAULT_FALLBACK_PACK;
    return this.pack;
  }

  getPack(): PetSpritePack {
    return this.pack;
  }

  setPack(pack: PetSpritePack): void {
    this.pack = pack;
  }

  resolveSpriteFrames(kind: PetRoleKind, role: string, state: PetAnimState): string[] {
    let roleMap: Record<string, string> | undefined;
    if (kind === "orchestrator") {
      roleMap = this.pack.orchestrator;
    } else {
      const normalizedRole = role.trim().toLowerCase();
      const subagents = this.pack.subagents;
      roleMap = normalizedRole ? subagents[normalizedRole] : undefined;
      if (!roleMap && normalizedRole) {
        const matchedKey = Object.keys(subagents).find(
          (key) =>
            key !== "default" &&
            (normalizedRole.includes(key) || key.includes(normalizedRole))
        );
        roleMap = matchedKey ? subagents[matchedKey] : subagents["default"];
      }
      if (!roleMap) {
        roleMap = subagents["default"] ?? DEFAULT_FALLBACK_PACK.subagents.default;
      }
    }

    const prefix = `${state}_`;
    const numbered = Object.keys(roleMap)
      .filter((k) => k.startsWith(prefix) && /^\d+$/.test(k.slice(prefix.length)))
      .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)))
      .map((k) => roleMap![k]);

    if (numbered.length > 0) {
      return numbered;
    }
    return [this.resolveSpriteUrl(kind, role, state)];
  }

  resolveAnimatedSpriteUrl(
    kind: PetRoleKind,
    role: string,
    state: PetAnimState,
    nowMs = Date.now()
  ): string {
    const frames = this.resolveSpriteFrames(kind, role, state);
    if (frames.length <= 1) return frames[0];

    // Natural variable blink/head-tilt timing for 3-frame idle
    if (state === "idle" && frames.length >= 3) {
      const cycle = nowMs % 6480;
      if (cycle < 2600) return frames[0];
      if (cycle < 2780) return frames[1]; // quick blink
      if (cycle < 4580) return frames[0];
      return frames[2]; // cozy head tilt
    }

    if (state === "walk") {
      if (frames.length >= 4) {
        // True 4-frame walk cycle: Contact R -> Pass R -> Contact L -> Pass L
        const idx = Math.floor(nowMs / 155) % 4;
        return frames[idx];
      }
      if (frames.length >= 3) {
        const seq = [0, 1, 2, 1];
        const idx = Math.floor(nowMs / 190) % seq.length;
        return frames[seq[idx]];
      }
    }

    if (state === "work" && frames.length >= 3) {
      const seq = [0, 1, 2, 1];
      const idx = Math.floor(nowMs / 650) % seq.length;
      return frames[seq[idx]];
    }

    if (state === "chat" && frames.length >= 3) {
      const seq = [0, 1, 2, 1];
      const idx = Math.floor(nowMs / 950) % seq.length;
      return frames[seq[idx]];
    }

    const intervalMs =
      state === "fall"
        ? 140
        : state === "phone"
          ? 1200
          : state === "sit"
            ? 2200
            : state === "sleep"
              ? 1100
              : 450;
    const idx = Math.floor(nowMs / intervalMs) % frames.length;
    return frames[idx];
  }

  resolveSpriteUrl(kind: PetRoleKind, role: string, state: PetAnimState): string {
    if (kind === "orchestrator") {
      const map = this.pack.orchestrator;
      if (map[state]) return map[state];
      if (state === "fall") return map["alert"] ?? map["idle"] ?? DEFAULT_FALLBACK_PACK.orchestrator.idle;
      if (state === "sit" || state === "sleep" || state === "happy" || state === "phone") {
        return map["idle"] ?? DEFAULT_FALLBACK_PACK.orchestrator.idle;
      }
      if (state === "chat") {
        return map["sit"] ?? map["work"] ?? map["idle"] ?? DEFAULT_FALLBACK_PACK.orchestrator.idle;
      }
      if (state === "walk") return map["work"] ?? map["idle"] ?? DEFAULT_FALLBACK_PACK.orchestrator.idle;
      return map["idle"] ?? DEFAULT_FALLBACK_PACK.orchestrator.idle;
    }

    const normalizedRole = role.trim().toLowerCase();
    const subagents = this.pack.subagents;
    let roleMap = normalizedRole ? subagents[normalizedRole] : undefined;
    if (!roleMap && normalizedRole) {
      const matchedKey = Object.keys(subagents).find(
        (key) =>
          key !== "default" &&
          (normalizedRole.includes(key) || key.includes(normalizedRole))
      );
      roleMap = matchedKey ? subagents[matchedKey] : subagents["default"];
    }
    if (!roleMap) {
      roleMap = subagents["default"] ?? DEFAULT_FALLBACK_PACK.subagents.default;
    }

    if (roleMap[state]) return roleMap[state];
    if (state === "error") return roleMap["error"] ?? roleMap["alert"] ?? roleMap["idle"];
    if (state === "fall") return roleMap["alert"] ?? roleMap["idle"];
    if (state === "sit" || state === "sleep" || state === "happy" || state === "phone") {
      return roleMap["idle"];
    }
    if (state === "chat") {
      return roleMap["sit"] ?? roleMap["work"] ?? roleMap["idle"];
    }
    if (state === "walk") return roleMap["work"] ?? roleMap["idle"];
    if (state === "work") return roleMap["walk"] ?? roleMap["idle"];
    return (
      roleMap["idle"] ??
      Object.values(roleMap)[0] ??
      DEFAULT_FALLBACK_PACK.subagents.default.idle
    );
  }
}
