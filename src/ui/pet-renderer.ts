import type { PetSpriteRegistry } from "../engine/pets";
import type { PetAnimState, PetEntity } from "../engine/types";

export interface PetRenderCallbacks {
  onPermissionReply: (
    sessionID: string,
    requestId: string,
    reply: "once" | "always" | "reject"
  ) => void;
  onDismissBubble: (petId: string) => void;
}

export function createOrUpdatePetElement(
  existing: HTMLElement | null,
  pet: PetEntity,
  sprites: PetSpriteRegistry,
  callbacks: PetRenderCallbacks,
  overrideState?: PetAnimState,
  facingLeft = false,
  extraAnimClass?: string,
  overrideStatusText?: string,
  nowMs?: number
): HTMLElement {
  const effectiveState = overrideState ?? pet.state;
  const el = existing ?? document.createElement("div");

  el.className = [
    "pet-node",
    "interactive-hitbox",
    `kind-${pet.kind}`,
    `state-${effectiveState}`,
    extraAnimClass ?? "",
    facingLeft ? "facing-left" : "",
  ]
    .filter(Boolean)
    .join(" ");
  el.dataset.petId = pet.id;

  // Speech bubble (above labels)
  const bubbleKey = pet.permission
    ? `perm:${pet.permission.requestId}`
    : pet.errorText
      ? `err:${pet.errorText}`
      : pet.bubbleText
        ? `msg:${pet.bubbleText}`
        : "";

  let bubbleEl = el.querySelector<HTMLElement>(":scope > .speech-bubble");
  if (!bubbleKey) {
    bubbleEl?.remove();
  } else if (bubbleEl?.dataset.bubbleKey !== bubbleKey) {
    bubbleEl?.remove();
    bubbleEl = buildSpeechBubble(pet, callbacks);
    bubbleEl.dataset.bubbleKey = bubbleKey;
    el.prepend(bubbleEl);
  }

  // Labels placed ABOVE the pet sprite so taskbar never covers them
  let labelsEl = el.querySelector<HTMLElement>(":scope > .pet-labels-above");
  if (!labelsEl) {
    labelsEl = document.createElement("div");
    labelsEl.className = "pet-labels-above";
    const tag = document.createElement("div");
    tag.className = "pet-tag";
    const sub = document.createElement("div");
    sub.className = "pet-status-sub";
    labelsEl.append(tag, sub);
    if (bubbleEl) {
      bubbleEl.after(labelsEl);
    } else {
      el.prepend(labelsEl);
    }
  }

  const tagEl = labelsEl.querySelector<HTMLElement>(".pet-tag")!;
  const tagLabel = pet.kind === "orchestrator" ? pet.title : pet.role;
  if (tagEl.textContent !== tagLabel) {
    tagEl.textContent = tagLabel;
  }

  const subEl = labelsEl.querySelector<HTMLElement>(".pet-status-sub")!;
  const statusLabel = overrideStatusText ?? pet.statusText;
  if (subEl.textContent !== statusLabel) {
    subEl.textContent = statusLabel;
  }

  let spriteWrap = el.querySelector<HTMLElement>(":scope > .pet-sprite-wrap");
  if (!spriteWrap) {
    spriteWrap = document.createElement("div");
    spriteWrap.className = "pet-sprite-wrap";
    const img = document.createElement("img");
    img.className = "pet-sprite";
    img.draggable = false;
    spriteWrap.appendChild(img);
    el.appendChild(spriteWrap);
  }

  const img = spriteWrap.querySelector<HTMLImageElement>("img.pet-sprite")!;
  const spriteRole = pet.spriteVariant || pet.role;
  const targetUrl = sprites.resolveAnimatedSpriteUrl(
    pet.kind,
    spriteRole,
    effectiveState,
    nowMs ?? performance.now()
  );
  if (img.getAttribute("src") !== targetUrl) {
    img.src = targetUrl;
  }
  img.alt = `${pet.title} (${effectiveState})`;

  return el;
}

function buildSpeechBubble(pet: PetEntity, callbacks: PetRenderCallbacks): HTMLElement {
  const bubble = document.createElement("div");
  bubble.className = "speech-bubble interactive-hitbox";

  const header = document.createElement("div");
  header.className = "bubble-header";
  const title = document.createElement("span");

  if (pet.permission) {
    bubble.classList.add("bubble-alert");
    title.textContent = `Approval: ${pet.permission.permission}`;
    header.appendChild(title);

    const detail = document.createElement("div");
    detail.className = "bubble-detail";
    detail.textContent = pet.permission.detail;

    const actions = document.createElement("div");
    actions.className = "bubble-actions";

    const setBusy = (busy: boolean) => {
      approveBtn.disabled = busy;
      alwaysBtn.disabled = busy;
      denyBtn.disabled = busy;
    };

    const approveBtn = document.createElement("button");
    approveBtn.type = "button";
    approveBtn.className = "bubble-btn approve";
    approveBtn.textContent = "Approve";
    approveBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setBusy(true);
      callbacks.onPermissionReply(
        pet.permission!.sessionID,
        pet.permission!.requestId,
        "once"
      );
    });

    const alwaysBtn = document.createElement("button");
    alwaysBtn.type = "button";
    alwaysBtn.className = "bubble-btn always";
    alwaysBtn.textContent = "Always";
    alwaysBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setBusy(true);
      callbacks.onPermissionReply(
        pet.permission!.sessionID,
        pet.permission!.requestId,
        "always"
      );
    });

    const denyBtn = document.createElement("button");
    denyBtn.type = "button";
    denyBtn.className = "bubble-btn deny";
    denyBtn.textContent = "Deny";
    denyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setBusy(true);
      callbacks.onPermissionReply(
        pet.permission!.sessionID,
        pet.permission!.requestId,
        "reject"
      );
    });

    actions.append(approveBtn, alwaysBtn, denyBtn);
    bubble.append(header, detail, actions);
    return bubble;
  }

  if (pet.errorText) {
    bubble.classList.add("bubble-error");
    title.textContent = "Error";
  } else {
    title.textContent = pet.title;
  }

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "bubble-close";
  closeBtn.textContent = "x";
  closeBtn.title = "Dismiss";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    callbacks.onDismissBubble(pet.id);
  });
  header.append(title, closeBtn);

  const body = document.createElement("div");
  body.className = "bubble-detail";
  body.textContent = pet.errorText ?? pet.bubbleText ?? "";

  bubble.append(header, body);
  return bubble;
}
