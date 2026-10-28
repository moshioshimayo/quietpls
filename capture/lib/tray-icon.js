"use strict";

// Menubar dot drawn at runtime (no image assets): a ring when idle/off, a filled
// colored dot otherwise. Returns a BGRA bitmap for nativeImage.createFromBitmap.
const COLORS = {
  off: null,
  idle: null,
  detected: null,
  asking: [10, 132, 255],
  recording: [255, 59, 48],
  ambient: [255, 59, 48],
  transcribing: [255, 159, 10],
  saved: [52, 199, 89],
  error: [255, 59, 48],
};

function dotBitmap(phase, size = 36) {
  const buf = Buffer.alloc(size * size * 4);
  const color = COLORS[phase];
  const c = (size - 1) / 2;
  const r = size * 0.36;
  const ring = size * 0.075;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      // anti-aliased coverage for the disc (filled) or ring (template)
      const outer = Math.min(1, Math.max(0, r + 0.5 - d));
      const inner = color ? 0 : Math.min(1, Math.max(0, r - ring + 0.5 - d));
      let a = Math.max(0, outer - inner);
      if (!color && phase === "detected")
        a = Math.max(a, Math.min(1, Math.max(0, r * 0.45 + 0.5 - d)));
      const [R, G, B] = color || [0, 0, 0];
      const i = (y * size + x) * 4;
      buf[i] = Math.round(B * a);
      buf[i + 1] = Math.round(G * a);
      buf[i + 2] = Math.round(R * a);
      buf[i + 3] = Math.round(255 * a * (phase === "off" ? 0.45 : 1));
    }
  }
  return { buf, size, template: !color };
}

module.exports = { dotBitmap };
