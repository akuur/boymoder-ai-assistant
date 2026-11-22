import { invoke } from "@tauri-apps/api/core";
import {
  onPetDrop,
  onSpritesSync,
  onStateSync,
  sendOverlayAction,
  type PetDropOrigin,
} from "../bridge/state-sync";
import { PetSpriteRegistry } from "../engine/pets";
import type { OrchestratorSnapshot, PetAnimState, PetEntity } from "../engine/types";
import { createOrUpdatePetElement, type PetRenderCallbacks } from "./pet-renderer";

interface HitboxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type IdleMood = "stand" | "wander" | "sit" | "hop" | "wiggle" | "nap" | "phone" | "chat";

interface PetPosition {
  x: number;
  bottomOffset: number;
  vx: number;
  vy: number;
  tiltDeg: number;
  airborne: boolean;
  facingLeft: boolean;
  pauseUntil: number;
  idleMood: IdleMood;
  nextMoodAt: number;
}

interface DragSample {
  x: number;
  y: number;
  t: number;
}

interface DragState {
  petId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  origX: number;
  origBottom: number;
  targetX: number;
  targetBottom: number;
  samples: DragSample[];
}

const ORCH_POS_KEY = "akuur_orch_overlay_pos";
const GRAVITY_PX_PER_SEC2 = 2100;

const sprites = new PetSpriteRegistry();
const overlayStage = document.getElementById("overlay-stage")!;

let currentSnapshot: OrchestratorSnapshot | null = null;
const positions = new Map<string, PetPosition>();
let lastHitboxPush = 0;
let lastFrameTs = performance.now();
let localIgnoreState = true;
let rafId: number | null = null;
let spritesSynced = false;
let activeDrag: DragState | null = null;
let lastDropOrigin: PetDropOrigin | null = null;

const petCallbacks: PetRenderCallbacks = {
  onPermissionReply: (sessionID, requestId, reply) => {
    void sendOverlayAction({
      type: "permission-reply",
      sessionID,
      requestId,
      reply,
    });
  },
  onDismissBubble: (petId) => {
    void sendOverlayAction({ type: "dismiss-bubble", petId });
  },
};

function loadOrchSavedPos(): { x: number; bottomOffset: number } | null {
  try {
    const raw = localStorage.getItem(ORCH_POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { x?: number; bottomOffset?: number };
    if (typeof parsed.x === "number" && typeof parsed.bottomOffset === "number") {
      return { x: parsed.x, bottomOffset: parsed.bottomOffset };
    }
  } catch {
    // Ignore
  }
  return null;
}

function saveOrchPos(x: number, bottomOffset: number): void {
  try {
    localStorage.setItem(ORCH_POS_KEY, JSON.stringify({ x, bottomOffset }));
  } catch {
    // Ignore
  }
}

function pickRandomIdleMood(pos: PetPosition, now: number): void {
  const moods: IdleMood[] = ["wander", "phone", "chat", "sit", "nap", "hop", "wiggle", "stand"];
  const weights = [0.24, 0.2, 0.18, 0.12, 0.1, 0.06, 0.05, 0.05];
  let r = Math.random();
  let chosen: IdleMood = "wander";
  for (let i = 0; i < moods.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      chosen = moods[i];
      break;
    }
  }
  pos.idleMood = chosen;
  if (chosen === "wander") {
    const dir = Math.random() < 0.5 ? -1 : 1;
    pos.vx = dir * (24 + Math.random() * 20);
    pos.facingLeft = dir < 0;
    pos.nextMoodAt = now + 3500 + Math.random() * 4500;
  } else if (chosen === "phone" || chosen === "chat") {
    pos.nextMoodAt = now + 5500 + Math.random() * 6500;
  } else {
    pos.nextMoodAt = now + 2600 + Math.random() * 4200;
  }
}

function getOrCreatePos(pet: PetEntity, index: number, totalSubagents: number): PetPosition {
  let pos = positions.get(pet.id);
  if (pos) return pos;

  const vw = Math.max(640, window.innerWidth);
  const now = performance.now();
  if (pet.kind === "orchestrator") {
    const saved = loadOrchSavedPos();
    const defaultX = Math.max(40, Math.min(vw - 200, vw - 240));
    const startX = lastDropOrigin
      ? Math.max(16, Math.min(vw - 160, lastDropOrigin.x))
      : saved
        ? Math.max(16, Math.min(vw - 180, saved.x))
        : defaultX;
    const startBottom = lastDropOrigin ? Math.max(0, lastDropOrigin.bottomOffset) : 0;
    pos = {
      x: startX,
      bottomOffset: startBottom,
      vx: 26,
      vy: 0,
      tiltDeg: 0,
      airborne: startBottom > 0,
      facingLeft: false,
      pauseUntil: 0,
      idleMood: "stand",
      nextMoodAt: now + 2400 + Math.random() * 2500,
    };
  } else {
    const subIdx = Math.max(0, index - 1);
    const maxPatrolX = Math.max(160, vw - 220);
    const spread = Math.min(maxPatrolX - 40, 160 + totalSubagents * 110);
    const base = lastDropOrigin
      ? lastDropOrigin.x + (subIdx - (totalSubagents - 1) * 0.5) * 44
      : vw * 0.45 - spread * 0.5 + (subIdx + 1) * (spread / (totalSubagents + 1));
    const startBottom = lastDropOrigin ? Math.max(0, lastDropOrigin.bottomOffset) : 0;
    const speed = 34 + (subIdx % 3) * 10;
    pos = {
      x: Math.max(32, Math.min(maxPatrolX, base)),
      bottomOffset: startBottom,
      vx: subIdx % 2 === 0 ? speed : -speed,
      vy: 0,
      tiltDeg: 0,
      airborne: startBottom > 0,
      facingLeft: subIdx % 2 !== 0,
      pauseUntil: 0,
      idleMood: "stand",
      nextMoodAt: now + 2000 + Math.random() * 3000,
    };
  }

  positions.set(pet.id, pos);
  return pos;
}

function attachDragListeners(slot: HTMLElement, petId: string): void {
  if (slot.dataset.dragWired === "1") return;
  slot.dataset.dragWired = "1";

  slot.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const target = ev.target as HTMLElement | null;
    if (target?.closest(".speech-bubble") || target?.closest("button")) {
      return;
    }

    const pos = positions.get(petId);
    if (!pos) return;

    ev.preventDefault();
    ev.stopPropagation();
    const now = performance.now();
    pos.airborne = false;
    pos.vx = 0;
    pos.vy = 0;

    activeDrag = {
      petId,
      pointerId: ev.pointerId,
      startClientX: ev.clientX,
      startClientY: ev.clientY,
      origX: pos.x,
      origBottom: pos.bottomOffset,
      targetX: pos.x,
      targetBottom: pos.bottomOffset,
      samples: [{ x: ev.clientX, y: ev.clientY, t: now }],
    };
    slot.classList.add("dragging");
    try {
      slot.setPointerCapture(ev.pointerId);
    } catch {
      // Ignore capture fallback
    }
    void invoke("set_overlay_drag_capture", { dragging: true }).catch(() => {});
  });

  slot.addEventListener("pointermove", (ev) => {
    if (!activeDrag || activeDrag.petId !== petId || activeDrag.pointerId !== ev.pointerId) {
      return;
    }
    const maxW = Math.max(120, window.innerWidth - 130);
    const maxH = Math.max(120, window.innerHeight - 170);

    const dx = ev.clientX - activeDrag.startClientX;
    const dy = ev.clientY - activeDrag.startClientY;
    activeDrag.targetX = Math.max(0, Math.min(maxW, activeDrag.origX + dx));
    activeDrag.targetBottom = Math.max(0, Math.min(maxH, activeDrag.origBottom - dy));

    const now = performance.now();
    activeDrag.samples.push({ x: ev.clientX, y: ev.clientY, t: now });
    while (activeDrag.samples.length > 8 || (activeDrag.samples.length > 2 && now - activeDrag.samples[0].t > 90)) {
      activeDrag.samples.shift();
    }
  });

  const endDrag = (ev: PointerEvent) => {
    if (!activeDrag || activeDrag.petId !== petId || activeDrag.pointerId !== ev.pointerId) {
      return;
    }
    const pos = positions.get(petId);
    if (pos) {
      // Compute throw velocity from recent pointer samples
      const samples = activeDrag.samples;
      let throwVx = 0;
      let throwVy = 0; // positive = downward in screen coords
      if (samples.length >= 2) {
        const first = samples[0];
        const last = samples[samples.length - 1];
        const span = Math.max(0.016, (last.t - first.t) / 1000);
        throwVx = Math.max(-2200, Math.min(2200, (last.x - first.x) / span));
        throwVy = Math.max(-2200, Math.min(2200, (last.y - first.y) / span));
      }

      pos.vx = throwVx;
      pos.vy = throwVy;
      pos.airborne = pos.bottomOffset > 0 || Math.abs(throwVx) > 60 || throwVy < -60;
      if (Math.abs(throwVx) > 30) {
        pos.facingLeft = throwVx < 0;
      }
      pos.pauseUntil = performance.now() + 2600;
      pos.idleMood = "stand";
      pos.nextMoodAt = performance.now() + 3400;

      if (petId === "orchestrator") {
        saveOrchPos(pos.x, 0);
      }
    }

    activeDrag = null;
    slot.classList.remove("dragging");
    try {
      slot.releasePointerCapture(ev.pointerId);
    } catch {
      // Ignore
    }
    void invoke("set_overlay_drag_capture", { dragging: false }).catch(() => {});
    pushHitboxesToRust(true);
  };

  slot.addEventListener("pointerup", endDrag);
  slot.addEventListener("pointercancel", endDrag);
}

function renderOverlayPets(now: number): void {
  if (!currentSnapshot) return;
  const vw = Math.max(640, window.innerWidth);
  const vh = Math.max(320, window.innerHeight);
  const scale = currentSnapshot.petScale || 1;
  const allPets = [currentSnapshot.orchestrator, ...currentSnapshot.subagents];
  const activeIds = new Set(allPets.map((p) => p.id));

  for (const id of positions.keys()) {
    if (!activeIds.has(id)) positions.delete(id);
  }

  for (const child of Array.from(overlayStage.children)) {
    const id = (child as HTMLElement).dataset.slotId;
    if (!id || !activeIds.has(id)) {
      child.remove();
    }
  }

  const dt = Math.min(0.05, Math.max(0.001, (now - lastFrameTs) / 1000));
  lastFrameTs = now;

  allPets.forEach((pet, idx) => {
    let slot = overlayStage.querySelector<HTMLElement>(
      `:scope > .overlay-pet-slot[data-slot-id="${CSS.escape(pet.id)}"]`
    );
    if (!slot) {
      slot = document.createElement("div");
      slot.className = "overlay-pet-slot";
      slot.dataset.slotId = pet.id;
      overlayStage.appendChild(slot);
    }
    attachDragListeners(slot, pet.id);

    const pos = getOrCreatePos(pet, idx, currentSnapshot!.subagents.length);
    const isBeingDragged = activeDrag?.petId === pet.id;
    let animState: PetAnimState = pet.state;
    let extraAnimClass = "";

    const minX = 12;
    const maxX = Math.max(140, vw - 150);
    const maxBottom = Math.max(100, vh - 170);

    if (isBeingDragged && activeDrag) {
      // Weighted lag follow + dynamic tilt while holding/swinging the pet
      const lag = 1 - Math.exp(-22 * dt);
      const prevX = pos.x;
      pos.x += (activeDrag.targetX - pos.x) * lag;
      pos.bottomOffset += (activeDrag.targetBottom - pos.bottomOffset) * lag;
      const instVx = (pos.x - prevX) / dt;
      const targetTilt = Math.max(-18, Math.min(18, instVx * 0.028));
      pos.tiltDeg += (targetTilt - pos.tiltDeg) * (1 - Math.exp(-16 * dt));
      if (Math.abs(instVx) > 20) pos.facingLeft = instVx < 0;
      if (pos.bottomOffset > 12) {
        animState = "fall";
      }
    } else if (pos.airborne || pos.bottomOffset > 0) {
      animState = "fall";
      // Throw & bounce physics
      pos.vy += GRAVITY_PX_PER_SEC2 * dt;
      pos.x += pos.vx * dt;
      pos.bottomOffset -= pos.vy * dt;

      // Air drag
      pos.vx *= Math.pow(0.992, dt * 60);

      // Left / right screen wall bounce
      if (pos.x <= minX) {
        pos.x = minX;
        pos.vx = Math.abs(pos.vx) * 0.72;
        pos.facingLeft = false;
      } else if (pos.x >= maxX) {
        pos.x = maxX;
        pos.vx = -Math.abs(pos.vx) * 0.72;
        pos.facingLeft = true;
      }

      // Top ceiling bounce
      if (pos.bottomOffset >= maxBottom) {
        pos.bottomOffset = maxBottom;
        if (pos.vy < 0) pos.vy = -pos.vy * 0.55;
      }

      // Floor / taskbar bounce
      if (pos.bottomOffset <= 0) {
        pos.bottomOffset = 0;
        if (pos.vy > 240) {
          pos.vy = -pos.vy * 0.45;
          pos.vx *= 0.76;
        } else {
          pos.vy = 0;
          pos.vx *= 0.82;
          if (Math.abs(pos.vx) < 28) {
            pos.vx = (pos.facingLeft ? -1 : 1) * 28;
            pos.airborne = false;
          }
        }
      }

      const flyTilt = Math.max(-22, Math.min(22, pos.vx * 0.025));
      pos.tiltDeg += (flyTilt - pos.tiltDeg) * (1 - Math.exp(-12 * dt));
      if (pet.kind === "orchestrator" && !pos.airborne) {
        saveOrchPos(pos.x, 0);
      }
    } else {
      // Settle tilt smoothly back to upright
      pos.tiltDeg += (0 - pos.tiltDeg) * (1 - Math.exp(-14 * dt));

      if (pet.state === "work" && !pet.permission) {
        if (pet.kind === "subagent") {
          if (now > pos.pauseUntil) {
            pos.x += pos.vx * dt;
            if (pos.x <= minX + 12) {
              pos.x = minX + 12;
              pos.vx = Math.abs(pos.vx);
              pos.facingLeft = false;
              pos.pauseUntil = now + 900;
            } else if (pos.x >= maxX - 10) {
              pos.x = maxX - 10;
              pos.vx = -Math.abs(pos.vx);
              pos.facingLeft = true;
              pos.pauseUntil = now + 900;
            }
            animState = "walk";
          } else {
            animState = "work";
          }
        }
      } else if (pet.state === "idle" && !pet.permission && !pet.errorText) {
        if (now >= pos.nextMoodAt) {
          pickRandomIdleMood(pos, now);
        }

        if (pos.idleMood === "wander") {
          pos.x += pos.vx * dt;
          if (pos.x <= minX + 12) {
            pos.x = minX + 12;
            pos.vx = Math.abs(pos.vx);
            pos.facingLeft = false;
          } else if (pos.x >= maxX - 20) {
            pos.x = maxX - 20;
            pos.vx = -Math.abs(pos.vx);
            pos.facingLeft = true;
          }
          if (pet.kind === "orchestrator") {
            saveOrchPos(pos.x, 0);
          }
          animState = "walk";
        } else if (pos.idleMood === "sit") {
          animState = "sit";
          extraAnimClass = "idle-sit";
        } else if (pos.idleMood === "hop") {
          animState = "happy";
          extraAnimClass = "idle-hop";
        } else if (pos.idleMood === "wiggle") {
          animState = "happy";
          extraAnimClass = "idle-wiggle";
        } else if (pos.idleMood === "nap") {
          animState = "sleep";
          extraAnimClass = "idle-nap";
        } else if (pos.idleMood === "phone") {
          animState = "phone";
        } else if (pos.idleMood === "chat") {
          animState = "chat";
        }
      }
    }

    slot.style.transform = `translate3d(${Math.round(pos.x)}px, ${-Math.round(pos.bottomOffset)}px, 0) rotate(${pos.tiltDeg.toFixed(1)}deg)`;

    const existingPet = slot.querySelector<HTMLElement>(":scope > .pet-node");
    const updatedPet = createOrUpdatePetElement(
      existingPet,
      pet,
      sprites,
      petCallbacks,
      animState,
      pos.facingLeft,
      extraAnimClass,
      undefined,
      now
    );
    updatedPet.style.zoom = String(scale);
    if (!existingPet) {
      slot.appendChild(updatedPet);
    }
  });
}

function pushHitboxesToRust(force = false): void {
  if (activeDrag) return;
  const now = performance.now();
  if (!force && now - lastHitboxPush < 65) return;
  lastHitboxPush = now;

  const rects: HitboxRect[] = [];
  const targets = document.querySelectorAll<HTMLElement>(".interactive-hitbox");
  for (const el of targets) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    rects.push({
      x: r.left,
      y: r.top,
      width: r.width,
      height: r.height,
    });
  }

  void invoke("update_overlay_hitboxes", { rects }).catch(() => {});
}

function animationLoop(now: number): void {
  if (!currentSnapshot?.freeRoam) {
    rafId = null;
    return;
  }
  renderOverlayPets(now);
  pushHitboxesToRust(false);
  rafId = requestAnimationFrame(animationLoop);
}

function ensureAnimationLoop(): void {
  if (rafId !== null) return;
  lastFrameTs = performance.now();
  rafId = requestAnimationFrame(animationLoop);
}

function setupPointerFallback(): void {
  window.addEventListener("mousemove", (ev) => {
    if (activeDrag) return;
    const target = ev.target as HTMLElement | null;
    const isInteractive = Boolean(target?.closest(".interactive-hitbox"));
    const shouldIgnore = !isInteractive;
    if (shouldIgnore !== localIgnoreState) {
      localIgnoreState = shouldIgnore;
      void invoke("set_overlay_ignore_cursor_events", { ignore: shouldIgnore }).catch(() => {});
    }
  });
}

async function init(): Promise<void> {
  await onSpritesSync((pack) => {
    spritesSynced = true;
    sprites.setPack(pack);
    if (currentSnapshot?.freeRoam) {
      renderOverlayPets(performance.now());
      pushHitboxesToRust(true);
    }
  });

  await onPetDrop((origin) => {
    lastDropOrigin = origin;
    const vw = Math.max(640, window.innerWidth);
    const maxH = Math.max(120, window.innerHeight - 150);
    const clampedX = Math.max(16, Math.min(vw - 160, origin.x));
    const clampedBottom = Math.max(40, Math.min(maxH, origin.bottomOffset));
    const orch = positions.get("orchestrator");
    if (orch) {
      orch.x = clampedX;
      orch.bottomOffset = clampedBottom;
      orch.vx = 0;
      orch.vy = 0;
      orch.airborne = true;
    }
    if (currentSnapshot?.freeRoam) {
      renderOverlayPets(performance.now());
      pushHitboxesToRust(true);
      ensureAnimationLoop();
    }
  });

  await onStateSync((snap) => {
    const wasFreeRoam = Boolean(currentSnapshot?.freeRoam);
    currentSnapshot = snap;
    if (!wasFreeRoam && snap.freeRoam && lastDropOrigin) {
      positions.delete("orchestrator");
    }
    if (snap.freeRoam) {
      renderOverlayPets(performance.now());
      pushHitboxesToRust(true);
      ensureAnimationLoop();
    }
  });

  setupPointerFallback();
  await sendOverlayAction({ type: "ready" });

  setTimeout(() => {
    if (!spritesSynced) {
      void sprites.load();
    }
  }, 600);
}

void init();
