#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = process.cwd();
const PETS_DIR = path.join(ROOT, "assets", "pets");
const ICONS_DIR = path.join(ROOT, "src-tauri", "icons");

// --- Minimal PNG Encoder (RGBA8) ---
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter None
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Tiny 2D Anti-Aliased Canvas ---
class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.buf = Buffer.alloc(width * height * 4, 0);
  }

  blendPixel(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || a <= 0) return;
    const idx = (y * this.width + x) * 4;
    const sa = Math.min(1, Math.max(0, a));
    const da = this.buf[idx + 3] / 255;
    const outA = sa + da * (1 - sa);
    if (outA <= 0.0001) return;
    this.buf[idx] = Math.round((r * sa + this.buf[idx] * da * (1 - sa)) / outA);
    this.buf[idx + 1] = Math.round((g * sa + this.buf[idx + 1] * da * (1 - sa)) / outA);
    this.buf[idx + 2] = Math.round((b * sa + this.buf[idx + 2] * da * (1 - sa)) / outA);
    this.buf[idx + 3] = Math.round(outA * 255);
  }

  fillCircle(cx, cy, radius, color) {
    const [r, g, b, a = 255] = color;
    const minX = Math.max(0, Math.floor(cx - radius - 2));
    const maxX = Math.min(this.width - 1, Math.ceil(cx + radius + 2));
    const minY = Math.max(0, Math.floor(cy - radius - 2));
    const maxY = Math.min(this.height - 1, Math.ceil(cy + radius + 2));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - radius;
        const cov = Math.min(1, Math.max(0, 0.5 - d));
        if (cov > 0) this.blendPixel(x, y, r, g, b, (a / 255) * cov);
      }
    }
  }

  fillRoundRect(x, y, w, h, radius, color) {
    const [r, g, b, a = 255] = color;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const hw = w / 2 - radius;
    const hh = h / 2 - radius;
    const minX = Math.max(0, Math.floor(x - 2));
    const maxX = Math.min(this.width - 1, Math.ceil(x + w + 2));
    const minY = Math.max(0, Math.floor(y - 2));
    const maxY = Math.min(this.height - 1, Math.ceil(y + h + 2));
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const dx = Math.max(Math.abs(px + 0.5 - cx) - hw, 0);
        const dy = Math.max(Math.abs(py + 0.5 - cy) - hh, 0);
        const d = Math.hypot(dx, dy) - radius;
        const cov = Math.min(1, Math.max(0, 0.5 - d));
        if (cov > 0) this.blendPixel(px, py, r, g, b, (a / 255) * cov);
      }
    }
  }

  fillTriangle(x1, y1, x2, y2, x3, y3, color) {
    const [r, g, b, a = 255] = color;
    const minX = Math.max(0, Math.floor(Math.min(x1, x2, x3) - 1));
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(x1, x2, x3) + 1));
    const minY = Math.max(0, Math.floor(Math.min(y1, y2, y3) - 1));
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(y1, y2, y3) + 1));
    const sign = (px, py, ax, ay, bx, by) => (px - bx) * (ay - by) - (ax - bx) * (py - by);
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const x = px + 0.5;
        const y = py + 0.5;
        const d1 = sign(x, y, x1, y1, x2, y2);
        const d2 = sign(x, y, x2, y2, x3, y3);
        const d3 = sign(x, y, x3, y3, x1, y1);
        const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
        const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
        if (!(hasNeg && hasPos)) {
          this.blendPixel(px, py, r, g, b, a / 255);
        }
      }
    }
  }

  strokeLine(x1, y1, x2, y2, thickness, color) {
    const [r, g, b, a = 255] = color;
    const rad = thickness / 2;
    const minX = Math.max(0, Math.floor(Math.min(x1, x2) - rad - 2));
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(x1, x2) + rad + 2));
    const minY = Math.max(0, Math.floor(Math.min(y1, y2) - rad - 2));
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(y1, y2) + rad + 2));
    const vx = x2 - x1;
    const vy = y2 - y1;
    const lenSq = vx * vx + vy * vy || 1;
    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const wx = px + 0.5 - x1;
        const wy = py + 0.5 - y1;
        const t = Math.min(1, Math.max(0, (wx * vx + wy * vy) / lenSq));
        const d = Math.hypot(wx - t * vx, wy - t * vy) - rad;
        const cov = Math.min(1, Math.max(0, 0.5 - d));
        if (cov > 0) this.blendPixel(px, py, r, g, b, (a / 255) * cov);
      }
    }
  }

  addStickerOutline(outlineWidth = 5, outlineColor = [255, 255, 255, 255]) {
    const out = new Canvas(this.width, this.height);
    const [or, og, ob, oa] = outlineColor;
    const rCeil = Math.ceil(outlineWidth);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const idx = (y * this.width + x) * 4;
        if (this.buf[idx + 3] > 20) continue;
        let maxNear = 0;
        for (let dy = -rCeil; dy <= rCeil; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= this.height) continue;
          for (let dx = -rCeil; dx <= rCeil; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= this.width) continue;
            const dist = Math.hypot(dx, dy);
            if (dist <= outlineWidth) {
              const na = this.buf[(ny * this.width + nx) * 4 + 3] / 255;
              if (na > 0.1) {
                const w = na * Math.min(1, Math.max(0, outlineWidth + 0.6 - dist));
                if (w > maxNear) maxNear = w;
              }
            }
          }
        }
        if (maxNear > 0) {
          out.blendPixel(x, y, or, og, ob, (oa / 255) * maxNear);
        }
      }
    }
    // Composite original on top of outline
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const idx = (y * this.width + x) * 4;
        const a = this.buf[idx + 3] / 255;
        if (a > 0) {
          out.blendPixel(x, y, this.buf[idx], this.buf[idx + 1], this.buf[idx + 2], a);
        }
      }
    }
    this.buf = out.buf;
  }
}

function drawMascot({ variant, state }) {
  const size = 256;
  const c = new Canvas(size, size);

  const isOrch = variant === "orchestrator";
  const palette = isOrch
    ? {
        hair: [88, 101, 242, 255],      // Indigo/Cobalt
        hairShade: [62, 72, 198, 255],
        body: [44, 49, 78, 255],
        accent: [56, 189, 248, 255],    // Cyan glow
        skin: [255, 232, 218, 255],
        blush: [255, 145, 165, 160],
        eye: [30, 41, 82, 255],
      }
    : {
        hair: [20, 184, 166, 255],      // Teal/Mint
        hairShade: [15, 138, 125, 255],
        body: [35, 58, 66, 255],
        accent: [251, 191, 36, 255],    // Amber badge
        skin: [255, 234, 222, 255],
        blush: [255, 150, 165, 150],
        eye: [24, 52, 62, 255],
      };

  const bobY =
    state === "walk"
      ? -6
      : state === "alert"
        ? -4
        : state === "sit"
          ? 16
          : state === "sleep"
            ? 14
            : state === "happy"
              ? -8
              : 0;

  // Soft ground shadow (omitted when airborne/falling)
  if (state !== "fall") {
    c.fillRoundRect(74, 226, 108, 14, 7, [15, 23, 42, 45]);
  }

  // Cat-ear / cyber-headphone antenna ears
  c.fillTriangle(72, 86 + bobY, 58, 34 + bobY, 106, 60 + bobY, palette.hairShade);
  c.fillTriangle(75, 76 + bobY, 66, 46 + bobY, 96, 62 + bobY, palette.accent);

  c.fillTriangle(184, 86 + bobY, 198, 34 + bobY, 150, 60 + bobY, palette.hairShade);
  c.fillTriangle(181, 76 + bobY, 190, 46 + bobY, 160, 62 + bobY, palette.accent);

  // Back hair / hood
  c.fillCircle(128, 106 + bobY, 60, palette.hairShade);

  // Legs
  if (state === "sit" || state === "sleep") {
    // Tucked sitting feet forward
    c.fillRoundRect(82, 200, 34, 22, 10, palette.body);
    c.fillRoundRect(140, 200, 34, 22, 10, palette.body);
    c.fillRoundRect(80, 210, 34, 12, 6, palette.accent);
    c.fillRoundRect(142, 210, 34, 12, 6, palette.accent);
  } else if (state === "fall") {
    // Kicking airborne legs
    c.fillRoundRect(88, 194, 24, 26, 10, palette.body);
    c.fillRoundRect(144, 204, 24, 26, 10, palette.body);
    c.fillRoundRect(86, 212, 28, 12, 6, palette.accent);
    c.fillRoundRect(142, 222, 28, 12, 6, palette.accent);
  } else {
    const leftLegY = state === "walk" ? 202 : 208;
    const rightLegY = state === "walk" ? 212 : 208;
    c.fillRoundRect(94, leftLegY - 10 + bobY, 24, 28, 10, palette.body);
    c.fillRoundRect(138, rightLegY - 10 + bobY, 24, 28, 10, palette.body);
    c.fillRoundRect(92, leftLegY + 8 + bobY, 28, 12, 6, palette.accent);
    c.fillRoundRect(136, rightLegY + 8 + bobY, 28, 12, 6, palette.accent);
  }

  // Chibi torso / coat
  c.fillRoundRect(82, 148 + bobY, 92, 64, 24, palette.body);
  c.fillRoundRect(102, 156 + bobY, 52, 48, 14, [245, 247, 255, 235]);
  // Core emblem
  const emblemColor =
    state === "error"
      ? [239, 68, 68, 255]
      : state === "alert"
        ? [245, 158, 11, 255]
        : state === "happy"
          ? [52, 211, 153, 255]
          : palette.accent;
  c.fillCircle(128, 178 + bobY, 10, emblemColor);

  // Arms
  if (state === "work") {
    // Raised typing arms
    c.fillRoundRect(64, 156 + bobY, 26, 18, 9, palette.body);
    c.fillRoundRect(166, 156 + bobY, 26, 18, 9, palette.body);
    c.fillCircle(66, 165 + bobY, 8, palette.skin);
    c.fillCircle(190, 165 + bobY, 8, palette.skin);
  } else if (state === "fall" || state === "happy") {
    // Both arms raised high!
    c.fillRoundRect(58, 126 + bobY, 24, 34, 10, palette.body);
    c.fillRoundRect(174, 126 + bobY, 24, 34, 10, palette.body);
    c.fillCircle(70, 124 + bobY, 8, palette.skin);
    c.fillCircle(186, 124 + bobY, 8, palette.skin);
  } else if (state === "alert") {
    // One hand raised
    c.fillRoundRect(66, 154 + bobY, 22, 34, 10, palette.body);
    c.fillRoundRect(168, 134 + bobY, 22, 34, 10, palette.body);
    c.fillCircle(179, 134 + bobY, 8, palette.skin);
  } else {
    c.fillRoundRect(66, 158 + bobY, 22, 34, 10, palette.body);
    c.fillRoundRect(168, 158 + bobY, 22, 34, 10, palette.body);
    c.fillCircle(77, 190 + bobY, 8, palette.skin);
    c.fillCircle(179, 190 + bobY, 8, palette.skin);
  }

  // Head & Face
  c.fillCircle(128, 108 + bobY, 52, palette.hair);
  c.fillRoundRect(82, 76 + bobY, 92, 74, 34, palette.skin);

  // Bangs
  c.fillTriangle(76, 94 + bobY, 106, 56 + bobY, 124, 92 + bobY, palette.hair);
  c.fillTriangle(110, 88 + bobY, 132, 54 + bobY, 150, 90 + bobY, palette.hair);
  c.fillTriangle(140, 90 + bobY, 162, 58 + bobY, 180, 96 + bobY, palette.hair);

  // Headphone band / halo for orchestrator
  if (isOrch) {
    c.fillRoundRect(110, 32 + bobY, 36, 10, 5, palette.accent);
  }
  c.fillRoundRect(70, 90 + bobY, 14, 36, 7, palette.accent);
  c.fillRoundRect(172, 90 + bobY, 14, 36, 7, palette.accent);

  // Blush
  c.fillCircle(98, 124 + bobY, 8, palette.blush);
  c.fillCircle(158, 124 + bobY, 8, palette.blush);

  // Eyes & Mouth by State
  if (state === "error") {
    // X_X eyes
    c.strokeLine(98, 106 + bobY, 112, 120 + bobY, 4.5, [220, 38, 38, 255]);
    c.strokeLine(112, 106 + bobY, 98, 120 + bobY, 4.5, [220, 38, 38, 255]);
    c.strokeLine(144, 106 + bobY, 158, 120 + bobY, 4.5, [220, 38, 38, 255]);
    c.strokeLine(158, 106 + bobY, 144, 120 + bobY, 4.5, [220, 38, 38, 255]);
    c.strokeLine(118, 134 + bobY, 128, 130 + bobY, 3.5, palette.eye);
    c.strokeLine(128, 130 + bobY, 138, 134 + bobY, 3.5, palette.eye);
  } else if (state === "sleep") {
    // Peaceful closed eyes -_-
    c.strokeLine(97, 113 + bobY, 115, 113 + bobY, 4, palette.eye);
    c.strokeLine(141, 113 + bobY, 159, 113 + bobY, 4, palette.eye);
    c.fillCircle(128, 131 + bobY, 4, [239, 108, 108, 255]);
  } else if (state === "happy" || state === "sit") {
    // Cheerful ^ ^ eyes
    c.strokeLine(97, 116 + bobY, 106, 106 + bobY, 4, palette.eye);
    c.strokeLine(106, 106 + bobY, 115, 116 + bobY, 4, palette.eye);
    c.strokeLine(141, 116 + bobY, 150, 106 + bobY, 4, palette.eye);
    c.strokeLine(150, 106 + bobY, 159, 116 + bobY, 4, palette.eye);
    c.strokeLine(120, 130 + bobY, 128, 136 + bobY, 3.5, palette.eye);
    c.strokeLine(128, 136 + bobY, 136, 130 + bobY, 3.5, palette.eye);
  } else if (state === "fall") {
    // Surprised O_O eyes + open mouth
    c.fillCircle(106, 112 + bobY, 10, [255, 255, 255, 255]);
    c.fillCircle(150, 112 + bobY, 10, [255, 255, 255, 255]);
    c.fillCircle(106, 112 + bobY, 5, palette.eye);
    c.fillCircle(150, 112 + bobY, 5, palette.eye);
    c.fillCircle(128, 133 + bobY, 6, [239, 108, 108, 255]);
  } else if (state === "alert") {
    c.fillCircle(106, 112 + bobY, 9, palette.eye);
    c.fillCircle(150, 112 + bobY, 9, palette.eye);
    c.fillCircle(103, 109 + bobY, 3, [255, 255, 255, 255]);
    c.fillCircle(147, 109 + bobY, 3, [255, 255, 255, 255]);
    c.fillCircle(128, 132 + bobY, 5, [239, 108, 108, 255]);
  } else if (state === "work") {
    c.fillRoundRect(92, 102 + bobY, 72, 20, 10, [15, 23, 42, 210]);
    c.fillCircle(108, 112 + bobY, 5, palette.accent);
    c.fillCircle(148, 112 + bobY, 5, palette.accent);
    c.strokeLine(120, 132 + bobY, 128, 136 + bobY, 3.5, palette.eye);
    c.strokeLine(128, 136 + bobY, 136, 132 + bobY, 3.5, palette.eye);
  } else {
    c.fillCircle(106, 112 + bobY, 8, palette.eye);
    c.fillCircle(150, 112 + bobY, 8, palette.eye);
    c.fillCircle(103, 109 + bobY, 3, [255, 255, 255, 255]);
    c.fillCircle(147, 109 + bobY, 3, [255, 255, 255, 255]);
    c.strokeLine(120, 130 + bobY, 128, 135 + bobY, 3.5, palette.eye);
    c.strokeLine(128, 135 + bobY, 136, 130 + bobY, 3.5, palette.eye);
  }

  // State props (drawn before sticker outline so outline wraps them!)
  if (state === "work") {
    c.fillRoundRect(88, 186 + bobY, 80, 44, 8, [30, 41, 59, 255]);
    c.fillRoundRect(94, 192 + bobY, 68, 30, 5, palette.accent);
    c.fillRoundRect(100, 198 + bobY, 34, 4, 2, [255, 255, 255, 230]);
    c.fillRoundRect(100, 206 + bobY, 48, 4, 2, [255, 255, 255, 190]);
  } else if (state === "alert") {
    c.fillCircle(200, 54, 22, [245, 158, 11, 255]);
    c.fillRoundRect(196, 38, 8, 18, 4, [255, 255, 255, 255]);
    c.fillCircle(200, 64, 4.5, [255, 255, 255, 255]);
  } else if (state === "error") {
    c.fillCircle(200, 54, 22, [239, 68, 68, 255]);
    c.strokeLine(191, 45, 209, 63, 5, [255, 255, 255, 255]);
    c.strokeLine(209, 45, 191, 63, 5, [255, 255, 255, 255]);
  } else if (state === "walk") {
    c.fillCircle(52, 214, 9, [226, 232, 240, 210]);
    c.fillCircle(40, 220, 6, [226, 232, 240, 180]);
  } else if (state === "fall") {
    // Upward wind speed lines
    c.strokeLine(42, 42, 42, 92, 4, [148, 163, 184, 200]);
    c.strokeLine(214, 36, 214, 86, 4, [148, 163, 184, 200]);
    c.strokeLine(56, 152, 56, 194, 3.5, [148, 163, 184, 170]);
    c.strokeLine(202, 146, 202, 188, 3.5, [148, 163, 184, 170]);
  } else if (state === "sleep") {
    // Cute Z bubble
    c.fillCircle(198, 62, 18, [99, 102, 241, 230]);
    c.strokeLine(191, 55, 205, 55, 3, [255, 255, 255, 255]);
    c.strokeLine(205, 55, 191, 69, 3, [255, 255, 255, 255]);
    c.strokeLine(191, 69, 205, 69, 3, [255, 255, 255, 255]);
  } else if (state === "happy") {
    // Sparkle star
    c.strokeLine(200, 38, 200, 66, 4, [250, 204, 21, 255]);
    c.strokeLine(186, 52, 214, 52, 4, [250, 204, 21, 255]);
  }

  c.addStickerOutline(5, [255, 255, 255, 255]);
  return encodePng(size, size, c.buf);
}

function drawAppIcon(size) {
  const c = new Canvas(size, size);
  const scale = size / 256;
  const cx = size / 2;
  const cy = size / 2;
  c.fillRoundRect(16 * scale, 16 * scale, 224 * scale, 224 * scale, 52 * scale, [79, 70, 229, 255]);
  c.fillCircle(cx, cy, 74 * scale, [255, 234, 222, 255]);
  c.fillCircle(cx - 26 * scale, cy - 6 * scale, 11 * scale, [30, 41, 82, 255]);
  c.fillCircle(cx + 26 * scale, cy - 6 * scale, 11 * scale, [30, 41, 82, 255]);
  c.strokeLine(cx - 12 * scale, cy + 20 * scale, cx, cy + 28 * scale, 5 * scale, [30, 41, 82, 255]);
  c.strokeLine(cx, cy + 28 * scale, cx + 12 * scale, cy + 20 * scale, 5 * scale, [30, 41, 82, 255]);
  return encodePng(size, size, c.buf);
}

function ensureWrite(filePath, buf, force = false) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!force && fs.existsSync(filePath)) {
    console.log(`skip (exists): ${path.relative(ROOT, filePath)}`);
    return;
  }
  fs.writeFileSync(filePath, buf);
  console.log(`wrote: ${path.relative(ROOT, filePath)}`);
}

const force = process.argv.includes("--force");

const ALL_STATES = ["idle", "walk", "work", "fall", "sit", "sleep", "happy", "alert", "error"];

const targets = [
  { dir: path.join(PETS_DIR, "orchestrator"), variant: "orchestrator", states: ALL_STATES },
  { dir: path.join(PETS_DIR, "subagents", "default"), variant: "subagent", states: ALL_STATES },
];

for (const target of targets) {
  for (const state of target.states) {
    const out = path.join(target.dir, `${state}.png`);
    ensureWrite(out, drawMascot({ variant: target.variant, state }), force);
  }
}

// Generate Tauri bundle icons so cargo/tauri build has valid RGBA PNG icons
ensureWrite(path.join(ICONS_DIR, "32x32.png"), drawAppIcon(32), force);
ensureWrite(path.join(ICONS_DIR, "128x128.png"), drawAppIcon(128), force);
ensureWrite(path.join(ICONS_DIR, "128x128@2x.png"), drawAppIcon(256), force);
ensureWrite(path.join(ICONS_DIR, "icon.png"), drawAppIcon(256), force);
