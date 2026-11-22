import type { PetSpriteRegistry } from "../engine/pets";
import type { OrchestratorSnapshot, PetAnimState, PetEntity } from "../engine/types";
import { createOrUpdatePetElement, type PetRenderCallbacks } from "./pet-renderer";

type IdleMood = "stand" | "wander" | "sit" | "hop" | "wiggle" | "nap" | "phone" | "chat";

interface StagePos {
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

interface StageDrag {
  petId: string;
  pointerId: number;
  startX: number;
  startY: number;
  origX: number;
  origBottom: number;
  targetX: number;
  targetBottom: number;
  samples: Array<{ x: number; y: number; t: number }>;
}

const GRAVITY = 1800;

export class DockedStageSimulator {
  private container: HTMLElement;
  private sprites: PetSpriteRegistry;
  private callbacks: PetRenderCallbacks;
  private snapshot: OrchestratorSnapshot | null = null;
  private positions = new Map<string, StagePos>();
  private drag: StageDrag | null = null;
  private rafId: number | null = null;
  private lastTs = performance.now();
  private active = false;

  constructor(
    container: HTMLElement,
    sprites: PetSpriteRegistry,
    callbacks: PetRenderCallbacks
  ) {
    this.container = container;
    this.sprites = sprites;
    this.callbacks = callbacks;
  }

  update(snap: OrchestratorSnapshot, visible: boolean): void {
    this.snapshot = snap;
    this.active = visible && !snap.freeRoam;
    if (!this.active) {
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      return;
    }

    this.step(performance.now());
    if (this.rafId === null) {
      this.lastTs = performance.now();
      this.rafId = requestAnimationFrame((now) => this.loop(now));
    }
  }

  dropFromTop(): void {
    const w = Math.max(240, this.container.clientWidth || 500);
    const all = this.snapshot
      ? [this.snapshot.orchestrator, ...this.snapshot.subagents]
      : [];
    all.forEach((pet, idx) => {
      const pos = this.getOrCreatePos(pet, idx, this.snapshot?.subagents.length ?? 0, w);
      pos.x = Math.max(16, Math.min(w - 130, w * 0.5 - 55 + idx * 32));
      pos.bottomOffset = 135;
      pos.vx = (idx % 2 === 0 ? 1 : -1) * (40 + idx * 25);
      pos.vy = 0;
      pos.airborne = true;
    });
  }

  private loop(now: number): void {
    if (!this.active) {
      this.rafId = null;
      return;
    }
    this.step(now);
    this.rafId = requestAnimationFrame((t) => this.loop(t));
  }

  private pickIdleMood(pos: StagePos, now: number): void {
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
      pos.vx = dir * (22 + Math.random() * 18);
      pos.facingLeft = dir < 0;
      pos.nextMoodAt = now + 2800 + Math.random() * 3500;
    } else if (chosen === "phone" || chosen === "chat") {
      pos.nextMoodAt = now + 5000 + Math.random() * 6000;
    } else {
      pos.nextMoodAt = now + 2200 + Math.random() * 3400;
    }
  }

  private getOrCreatePos(
    pet: PetEntity,
    index: number,
    totalSubs: number,
    stageWidth: number
  ): StagePos {
    let pos = this.positions.get(pet.id);
    if (pos) return pos;

    const now = performance.now();
    const maxX = Math.max(80, stageWidth - 125);
    const total = totalSubs + 1;
    const slotX = Math.max(16, Math.min(maxX, (stageWidth / (total + 1)) * (index + 1) - 48));
    const speed = 26 + (index % 3) * 8;
    pos = {
      x: slotX,
      bottomOffset: 0,
      vx: index % 2 === 0 ? speed : -speed,
      vy: 0,
      tiltDeg: 0,
      airborne: false,
      facingLeft: index % 2 !== 0,
      pauseUntil: 0,
      idleMood: "wander",
      nextMoodAt: now + 1800 + Math.random() * 2500,
    };
    this.positions.set(pet.id, pos);
    return pos;
  }

  private wireDrag(slot: HTMLElement, petId: string): void {
    if (slot.dataset.dragWired === "1") return;
    slot.dataset.dragWired = "1";

    slot.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      const target = ev.target as HTMLElement | null;
      if (target?.closest(".speech-bubble") || target?.closest("button")) return;

      const pos = this.positions.get(petId);
      if (!pos) return;
      ev.preventDefault();
      pos.airborne = false;
      pos.vx = 0;
      pos.vy = 0;

      this.drag = {
        petId,
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        origX: pos.x,
        origBottom: pos.bottomOffset,
        targetX: pos.x,
        targetBottom: pos.bottomOffset,
        samples: [{ x: ev.clientX, y: ev.clientY, t: performance.now() }],
      };
      slot.classList.add("dragging");
      try {
        slot.setPointerCapture(ev.pointerId);
      } catch {
        // Ignore
      }
    });

    slot.addEventListener("pointermove", (ev) => {
      if (!this.drag || this.drag.petId !== petId || this.drag.pointerId !== ev.pointerId) {
        return;
      }
      const w = Math.max(160, this.container.clientWidth || 500);
      const maxX = Math.max(60, w - 120);
      const dx = ev.clientX - this.drag.startX;
      const dy = ev.clientY - this.drag.startY;
      this.drag.targetX = Math.max(6, Math.min(maxX, this.drag.origX + dx));
      this.drag.targetBottom = Math.max(0, Math.min(140, this.drag.origBottom - dy));

      const now = performance.now();
      this.drag.samples.push({ x: ev.clientX, y: ev.clientY, t: now });
      while (
        this.drag.samples.length > 8 ||
        (this.drag.samples.length > 2 && now - this.drag.samples[0].t > 90)
      ) {
        this.drag.samples.shift();
      }
    });

    const release = (ev: PointerEvent) => {
      if (!this.drag || this.drag.petId !== petId || this.drag.pointerId !== ev.pointerId) {
        return;
      }
      const pos = this.positions.get(petId);
      if (pos) {
        const s = this.drag.samples;
        let tvx = 0;
        let tvy = 0;
        if (s.length >= 2) {
          const span = Math.max(0.016, (s[s.length - 1].t - s[0].t) / 1000);
          tvx = Math.max(-1600, Math.min(1600, (s[s.length - 1].x - s[0].x) / span));
          tvy = Math.max(-1600, Math.min(1600, (s[s.length - 1].y - s[0].y) / span));
        }
        pos.vx = tvx;
        pos.vy = tvy;
        pos.airborne = pos.bottomOffset > 0 || Math.abs(tvx) > 45 || tvy < -45;
        if (Math.abs(tvx) > 20) pos.facingLeft = tvx < 0;
        pos.pauseUntil = performance.now() + 2000;
        pos.idleMood = "stand";
        pos.nextMoodAt = performance.now() + 2500;
      }
      this.drag = null;
      slot.classList.remove("dragging");
      try {
        slot.releasePointerCapture(ev.pointerId);
      } catch {
        // Ignore
      }
    };

    slot.addEventListener("pointerup", release);
    slot.addEventListener("pointercancel", release);
  }

  private step(now: number): void {
    if (!this.snapshot) return;
    const w = Math.max(240, this.container.clientWidth || 500);
    const minX = 10;
    const maxX = Math.max(100, w - 125);
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastTs) / 1000));
    this.lastTs = now;

    const allPets = [this.snapshot.orchestrator, ...this.snapshot.subagents];
    const activeIds = new Set(allPets.map((p) => p.id));

    for (const id of this.positions.keys()) {
      if (!activeIds.has(id)) this.positions.delete(id);
    }
    for (const child of Array.from(this.container.children)) {
      const id = (child as HTMLElement).dataset.slotId;
      if (!id || !activeIds.has(id)) child.remove();
    }

    allPets.forEach((pet, idx) => {
      let slot = this.container.querySelector<HTMLElement>(
        `:scope > .stage-pet-slot[data-slot-id="${CSS.escape(pet.id)}"]`
      );
      if (!slot) {
        slot = document.createElement("div");
        slot.className = "stage-pet-slot";
        slot.dataset.slotId = pet.id;
        this.container.appendChild(slot);
      }
      this.wireDrag(slot, pet.id);

      const pos = this.getOrCreatePos(pet, idx, this.snapshot!.subagents.length, w);
      const isDragged = this.drag?.petId === pet.id;
      let animState: PetAnimState = pet.state;
      let extraAnim = "";

      if (isDragged && this.drag) {
        const lag = 1 - Math.exp(-22 * dt);
        const prevX = pos.x;
        pos.x += (this.drag.targetX - pos.x) * lag;
        pos.bottomOffset += (this.drag.targetBottom - pos.bottomOffset) * lag;
        const ivx = (pos.x - prevX) / dt;
        const tTilt = Math.max(-18, Math.min(18, ivx * 0.03));
        pos.tiltDeg += (tTilt - pos.tiltDeg) * (1 - Math.exp(-16 * dt));
        if (Math.abs(ivx) > 20) pos.facingLeft = ivx < 0;
        if (pos.bottomOffset > 12) {
          animState = "fall";
        }
      } else if (pos.airborne || pos.bottomOffset > 0) {
        animState = "fall";
        pos.vy += GRAVITY * dt;
        pos.x += pos.vx * dt;
        pos.bottomOffset -= pos.vy * dt;
        pos.vx *= Math.pow(0.99, dt * 60);

        if (pos.x <= minX) {
          pos.x = minX;
          pos.vx = Math.abs(pos.vx) * 0.72;
          pos.facingLeft = false;
        } else if (pos.x >= maxX) {
          pos.x = maxX;
          pos.vx = -Math.abs(pos.vx) * 0.72;
          pos.facingLeft = true;
        }

        if (pos.bottomOffset >= 130) {
          pos.bottomOffset = 130;
          if (pos.vy < 0) pos.vy = -pos.vy * 0.5;
        }

        if (pos.bottomOffset <= 0) {
          pos.bottomOffset = 0;
          if (pos.vy > 220) {
            pos.vy = -pos.vy * 0.45;
            pos.vx *= 0.75;
          } else {
            pos.vy = 0;
            pos.vx *= 0.8;
            if (Math.abs(pos.vx) < 25) {
              pos.vx = (pos.facingLeft ? -1 : 1) * 26;
              pos.airborne = false;
            }
          }
        }

        const flyTilt = Math.max(-20, Math.min(20, pos.vx * 0.025));
        pos.tiltDeg += (flyTilt - pos.tiltDeg) * (1 - Math.exp(-12 * dt));
      } else {
        pos.tiltDeg += (0 - pos.tiltDeg) * (1 - Math.exp(-14 * dt));

        if (pet.state === "work" && !pet.permission) {
          if (now > pos.pauseUntil) {
            pos.x += pos.vx * dt;
            if (pos.x <= minX) {
              pos.x = minX;
              pos.vx = Math.abs(pos.vx);
              pos.facingLeft = false;
              pos.pauseUntil = now + 1100;
            } else if (pos.x >= maxX) {
              pos.x = maxX;
              pos.vx = -Math.abs(pos.vx);
              pos.facingLeft = true;
              pos.pauseUntil = now + 1100;
            }
            animState = "walk";
          } else {
            animState = "work";
          }
        } else if (pet.state === "idle" && !pet.permission && !pet.errorText) {
          if (now >= pos.nextMoodAt) {
            this.pickIdleMood(pos, now);
          }
          if (pos.idleMood === "wander") {
            pos.x += pos.vx * dt;
            if (pos.x <= minX) {
              pos.x = minX;
              pos.vx = Math.abs(pos.vx);
              pos.facingLeft = false;
            } else if (pos.x >= maxX) {
              pos.x = maxX;
              pos.vx = -Math.abs(pos.vx);
              pos.facingLeft = true;
            }
            animState = "walk";
          } else if (pos.idleMood === "sit") {
            animState = "sit";
            extraAnim = "idle-sit";
          } else if (pos.idleMood === "hop") {
            animState = "happy";
            extraAnim = "idle-hop";
          } else if (pos.idleMood === "wiggle") {
            animState = "happy";
            extraAnim = "idle-wiggle";
          } else if (pos.idleMood === "nap") {
            animState = "sleep";
            extraAnim = "idle-nap";
          } else if (pos.idleMood === "phone") {
            animState = "phone";
          } else if (pos.idleMood === "chat") {
            animState = "chat";
          }
        }
      }

      slot.style.transform = `translate3d(${Math.round(pos.x)}px, ${-Math.round(pos.bottomOffset)}px, 0) rotate(${pos.tiltDeg.toFixed(1)}deg)`;

      const existing = slot.querySelector<HTMLElement>(":scope > .pet-node");
      const updated = createOrUpdatePetElement(
        existing,
        pet,
        this.sprites,
        this.callbacks,
        animState,
        pos.facingLeft,
        extraAnim,
        undefined,
        now
      );
      if (!existing) slot.appendChild(updated);
    });
  }
}
