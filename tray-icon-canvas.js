"use strict";

// Static three-bar mark. macOS tints the template except for Ease your voice.
const ZONE_COLORS = { quiet: "#000000", normal: "#000000", loud: "#000000", danger: "#d92d20", inactive: "#000000" };
const BAR_COUNT = 3;
function getColorForZone(zone) { return ZONE_COLORS[zone] || ZONE_COLORS.inactive; }
function drawTrayIcon(ctx, width, height, volumeLevel, zone) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = getColorForZone(zone);
  ctx.globalAlpha = zone === "inactive" ? 0.45 : 1;
  [0.28, 0.72, 0.4].forEach((ratio, i) => {
    const w = width * 0.15, h = height * ratio;
    const x = width * (0.16 + i * 0.27), y = (height - h) / 2;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, w / 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
}
module.exports = { drawTrayIcon, getColorForZone, ZONE_COLORS, BAR_COUNT };
