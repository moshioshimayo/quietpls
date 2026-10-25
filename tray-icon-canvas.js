'use strict';

/**
 * tray-icon-canvas.js — Pure canvas drawing module for dynamic tray icons.
 *
 * Draws a mini waveform (vertical bars) visualizing recent volume history,
 * coloured by the current audio zone. Testable without Electron — only needs
 * a standard Canvas 2D rendering context.
 */

// Design-system zone colours
const ZONE_COLORS = {
  quiet:    '#f59e0b', // amber (speak up)
  normal:   '#06b6d4', // cyan (you're good)
  loud:     '#ef4444', // red
  danger:   '#dc2626', // dark red
  inactive: '#6b7280', // gray
};

const BAR_COUNT = 5;
const BAR_GAP_RATIO = 0.15;   // fraction of total width used as gaps
const MIN_BAR_HEIGHT_RATIO = 0.1; // minimum bar height as fraction of canvas height
const BAR_RADIUS_RATIO = 0.15; // rounded-corner radius as fraction of bar width

/**
 * Return the colour string for a given zone.
 * Falls back to inactive gray for unknown zones.
 *
 * @param {string} zone
 * @returns {string} hex colour
 */
function getColorForZone(zone) {
  return ZONE_COLORS[zone] || ZONE_COLORS.inactive;
}

/**
 * Draw the tray icon onto a canvas 2D context.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width   — canvas width in px
 * @param {number} height  — canvas height in px
 * @param {number} volumeLevel — current volume 0-100
 * @param {string} zone — one of quiet | normal | loud | danger | inactive
 * @param {number[]} volumeHistory — rolling array of recent volume samples (0-100)
 */
function drawTrayIcon(ctx, width, height, volumeLevel, zone, volumeHistory) {
  // Clear canvas
  ctx.clearRect(0, 0, width, height);

  const color = getColorForZone(zone);

  // Build the bar data from history, padding with zeros if needed
  const samples = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    if (volumeHistory && i < volumeHistory.length) {
      // Take the most recent BAR_COUNT samples; right-most = newest
      const startIdx = Math.max(0, volumeHistory.length - BAR_COUNT);
      samples.push(volumeHistory[startIdx + i] || 0);
    } else {
      samples.push(0);
    }
  }

  // Geometry
  const totalGap = width * BAR_GAP_RATIO;
  const gap = totalGap / (BAR_COUNT + 1);
  const barWidth = (width - totalGap) / BAR_COUNT;
  const minBarH = height * MIN_BAR_HEIGHT_RATIO;
  const maxBarH = height * 0.9; // leave a small top/bottom margin
  const radius = Math.max(1, barWidth * BAR_RADIUS_RATIO);

  ctx.fillStyle = color;

  for (let i = 0; i < BAR_COUNT; i++) {
    const vol = Math.max(0, Math.min(100, samples[i]));
    const barH = minBarH + (vol / 100) * (maxBarH - minBarH);
    const x = gap + i * (barWidth + gap);
    const y = (height - barH) / 2; // vertically centred

    // Draw rounded rect
    drawRoundedRect(ctx, x, y, barWidth, barH, radius);
  }
}

/**
 * Draw a filled rounded rectangle.
 */
function drawRoundedRect(ctx, x, y, w, h, r) {
  // Clamp radius so it doesn't exceed half the smallest dimension
  const maxR = Math.min(w / 2, h / 2);
  const cr = Math.min(r, maxR);

  ctx.beginPath();
  ctx.moveTo(x + cr, y);
  ctx.lineTo(x + w - cr, y);
  ctx.arcTo(x + w, y, x + w, y + cr, cr);
  ctx.lineTo(x + w, y + h - cr);
  ctx.arcTo(x + w, y + h, x + w - cr, y + h, cr);
  ctx.lineTo(x + cr, y + h);
  ctx.arcTo(x, y + h, x, y + h - cr, cr);
  ctx.lineTo(x, y + cr);
  ctx.arcTo(x, y, x + cr, y, cr);
  ctx.closePath();
  ctx.fill();
}

module.exports = {
  drawTrayIcon,
  getColorForZone,
  ZONE_COLORS,
  BAR_COUNT,
};
