'use strict';

/**
 * pill-waveform.js — Mini real-time waveform renderer for the compact pill.
 *
 * Renders a flowing bar-style waveform inside a small canvas (~80x24px).
 * Shows a gentle idle breathing animation when no volume data is present,
 * and responsive pulsing bars when monitoring is active.
 *
 * Browser: exposes window.PillWaveform (wrapped in IIFE to avoid globals)
 * Node:    exposes pure helper functions via module.exports (for testing)
 */

(function () {

// ---------------------------------------------------------------------------
// Design-system zone colours
// ---------------------------------------------------------------------------
var ZONE_COLORS = {
  quiet:  '#f59e0b', // amber (speak up)
  normal: '#06b6d4', // cyan (you're good)
  loud:   '#ef4444', // red (too loud)
  danger: '#dc2626', // deep red
};

var DEFAULT_COLOR = '#06b6d4';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
var BAR_COUNT      = 14;       // number of vertical bars
var BAR_GAP        = 1;        // px gap between bars
var BAR_RADIUS     = 1.5;      // rounded-top radius in px
var SMOOTHING      = 0.18;     // lerp factor for bar height interpolation
var FADE_SPEED     = 0.04;     // opacity delta per frame when fading out
var IDLE_SPEED     = 0.0012;   // breathing sine wave speed (radians per ms)
var IDLE_AMPLITUDE = 0.25;     // max amplitude of idle wave (fraction of height)
var IDLE_BASE      = 0.12;     // minimum bar height fraction during idle
var GLOW_BLUR      = 4;        // px shadow blur for glow effect

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------
var _canvas  = null;
var _ctx     = null;
var _rafId   = null;
var _running = false;
var _fading  = false;
var _opacity = 1;

var _currentZone   = 'quiet';
var _currentColor  = ZONE_COLORS.quiet;
var _targetColor   = ZONE_COLORS.quiet;

var _volume        = 0;          // latest volume (0-100)
var _smoothVolume  = 0;          // smoothed volume for display
var _barHeights    = [];         // current interpolated bar heights (0-1)
var _barTargets    = [];         // target bar heights from volume data
var _idlePhase     = 0;          // phase accumulator for idle breathing
var _lastTimestamp = 0;          // last rAF timestamp

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testing under Node)
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function getZoneColor(zone) {
  return ZONE_COLORS[zone] || DEFAULT_COLOR;
}

function hexToRgb(hex) {
  var h = hex.replace('#', '');
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  }
  var num = parseInt(h, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

function rgbToHex(rgb) {
  var r = Math.round(clamp(rgb.r, 0, 255));
  var g = Math.round(clamp(rgb.g, 0, 255));
  var b = Math.round(clamp(rgb.b, 0, 255));
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

function lerpColor(hexA, hexB, t) {
  var a = hexToRgb(hexA);
  var b = hexToRgb(hexB);
  return rgbToHex({
    r: lerp(a.r, b.r, t),
    g: lerp(a.g, b.g, t),
    b: lerp(a.b, b.b, t),
  });
}

function computeBarTargets(volume, time) {
  var normalized = clamp(volume / 100, 0, 1);
  var targets = [];
  var half = (BAR_COUNT - 1) / 2;

  for (var i = 0; i < BAR_COUNT; i++) {
    var distFromCenter = Math.abs(i - half) / half;
    var envelope = 1 - distFromCenter * 0.5;

    var wave1 = Math.sin(time * 0.003 + i * 0.7) * 0.3;
    var wave2 = Math.sin(time * 0.005 + i * 1.1) * 0.15;
    var wave3 = Math.sin(time * 0.002 + i * 0.4) * 0.1;

    var h = normalized * envelope + (wave1 + wave2 + wave3) * normalized;
    targets.push(clamp(h, 0.04, 1));
  }

  return targets;
}

function computeIdleBars(phase) {
  var bars = [];
  for (var i = 0; i < BAR_COUNT; i++) {
    var wave = Math.sin(phase + i * 0.45) * 0.5 + 0.5;
    bars.push(IDLE_BASE + wave * IDLE_AMPLITUDE);
  }
  return bars;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function drawRoundedBar(ctx, x, y, w, h, radius) {
  var r = Math.min(radius, w / 2, h / 2);
  if (h < 0.5) return;

  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
}

function render(timestamp) {
  if (!_canvas || !_ctx) return;

  var dt = _lastTimestamp ? timestamp - _lastTimestamp : 16;
  _lastTimestamp = timestamp;

  var w = _canvas.width;
  var h = _canvas.height;

  _idlePhase += IDLE_SPEED * dt;

  _currentColor = lerpColor(_currentColor, _targetColor, clamp(dt * 0.008, 0, 1));

  _smoothVolume = lerp(_smoothVolume, _volume, clamp(dt * 0.01, 0, 1));

  var targets;
  if (_smoothVolume < 1) {
    targets = computeIdleBars(_idlePhase);
  } else {
    targets = computeBarTargets(_smoothVolume, timestamp);
  }

  if (_barHeights.length !== BAR_COUNT) {
    _barHeights = [];
    _barTargets = [];
    for (var k = 0; k < BAR_COUNT; k++) {
      _barHeights.push(IDLE_BASE);
      _barTargets.push(IDLE_BASE);
    }
  }

  _barTargets = targets;

  var lerpFactor = clamp(SMOOTHING * (dt / 16), 0, 1);
  for (var i = 0; i < BAR_COUNT; i++) {
    _barHeights[i] = lerp(_barHeights[i], _barTargets[i], lerpFactor);
  }

  if (_fading) {
    _opacity -= FADE_SPEED;
    if (_opacity <= 0) {
      _opacity = 0;
      _fading = false;
      _running = false;
      _ctx.clearRect(0, 0, w, h);
      return;
    }
  }

  _ctx.clearRect(0, 0, w, h);

  var totalGap = BAR_GAP * (BAR_COUNT - 1);
  var barWidth = (w - totalGap) / BAR_COUNT;
  if (barWidth < 1) barWidth = 1;
  var maxBarHeight = h - 2;

  _ctx.save();
  _ctx.globalAlpha = _opacity;
  _ctx.shadowColor = _currentColor;
  _ctx.shadowBlur = GLOW_BLUR;

  var rgb = hexToRgb(_currentColor);
  var gradTop = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.95)';
  var gradBottom = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.5)';

  for (var j = 0; j < BAR_COUNT; j++) {
    var barH = Math.max(2, _barHeights[j] * maxBarHeight);
    var barX = j * (barWidth + BAR_GAP);
    var barY = h - 1 - barH;

    var grad = _ctx.createLinearGradient(barX, barY, barX, barY + barH);
    grad.addColorStop(0, gradTop);
    grad.addColorStop(1, gradBottom);
    _ctx.fillStyle = grad;

    drawRoundedBar(_ctx, barX, barY, barWidth, barH, BAR_RADIUS);
  }

  _ctx.restore();

  if (_running) {
    _rafId = requestAnimationFrame(render);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function start(canvasElement) {
  if (!canvasElement || typeof canvasElement.getContext !== 'function') {
    throw new Error('PillWaveform.start() requires a canvas element');
  }

  _canvas = canvasElement;
  _ctx = canvasElement.getContext('2d');
  _running = true;
  _fading = false;
  _opacity = 1;
  _volume = 0;
  _smoothVolume = 0;
  _lastTimestamp = 0;
  _barHeights = [];
  _barTargets = [];

  if (_rafId) {
    cancelAnimationFrame(_rafId);
  }

  _rafId = requestAnimationFrame(render);
}

function stop() {
  if (!_running) return;
  _fading = true;
  _volume = 0;
}

function updateVolume(volume) {
  _volume = clamp(typeof volume === 'number' ? volume : 0, 0, 100);
}

function setZone(zone) {
  _currentZone = zone;
  _targetColor = getZoneColor(zone);
}

// ---------------------------------------------------------------------------
// Dual export pattern
// ---------------------------------------------------------------------------
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    clamp: clamp,
    lerp: lerp,
    getZoneColor: getZoneColor,
    hexToRgb: hexToRgb,
    rgbToHex: rgbToHex,
    lerpColor: lerpColor,
    computeBarTargets: computeBarTargets,
    computeIdleBars: computeIdleBars,
    ZONE_COLORS: ZONE_COLORS,
    BAR_COUNT: BAR_COUNT,
  };
} else if (typeof window !== 'undefined') {
  window.PillWaveform = {
    start: start,
    stop: stop,
    updateVolume: updateVolume,
    setZone: setZone,
  };
}

})();
