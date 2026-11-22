import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { OrchestratorSnapshot, OverlayAction, PetSpritePack } from "../engine/types";

export const EVENT_STATE_SYNC = "pet:state-sync";
export const EVENT_SPRITES_SYNC = "pet:sprites-sync";
export const EVENT_OVERLAY_ACTION = "pet:overlay-action";
export const EVENT_PET_DROP = "pet:drop-from";

export interface PetDropOrigin {
  x: number;
  bottomOffset: number;
}

export async function broadcastState(snapshot: OrchestratorSnapshot): Promise<void> {
  try {
    const { backendConfigs: _omitted, ...rest } = snapshot;
    const sanitized: OrchestratorSnapshot = rest;
    await emit(EVENT_STATE_SYNC, sanitized);
  } catch {
    // Ignore when running outside Tauri
  }
}

export async function broadcastSprites(pack: PetSpritePack): Promise<void> {
  try {
    await emit(EVENT_SPRITES_SYNC, pack);
  } catch {
    // Ignore when running outside Tauri
  }
}

export async function broadcastPetDrop(origin: PetDropOrigin): Promise<void> {
  try {
    await emit(EVENT_PET_DROP, origin);
  } catch {
    // Ignore when running outside Tauri
  }
}

export async function sendOverlayAction(action: OverlayAction): Promise<void> {
  try {
    await emit(EVENT_OVERLAY_ACTION, action);
  } catch {
    // Ignore when running outside Tauri
  }
}

export function onStateSync(handler: (snapshot: OrchestratorSnapshot) => void): Promise<UnlistenFn> {
  return listen<OrchestratorSnapshot>(EVENT_STATE_SYNC, (e) => handler(e.payload));
}

export function onSpritesSync(handler: (pack: PetSpritePack) => void): Promise<UnlistenFn> {
  return listen<PetSpritePack>(EVENT_SPRITES_SYNC, (e) => handler(e.payload));
}

export function onPetDrop(handler: (origin: PetDropOrigin) => void): Promise<UnlistenFn> {
  return listen<PetDropOrigin>(EVENT_PET_DROP, (e) => handler(e.payload));
}

export function onOverlayAction(handler: (action: OverlayAction) => void): Promise<UnlistenFn> {
  return listen<OverlayAction>(EVENT_OVERLAY_ACTION, (e) => handler(e.payload));
}
