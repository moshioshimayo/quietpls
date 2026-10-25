/**
 * US-008: FFT Spectrum Visualization Renderer
 *
 * Real-time frequency visualization using Canvas 2D.
 * Renders frequency bars at 60fps with zone-based color palettes,
 * rounded bar caps, gradient fills, and subtle glow effects.
 */

// ── Color Palettes (keyed by volume zone) ────────────────────────────
const COLOR_PALETTES = {
  quiet:  { primary: '#f59e0b', secondary: '#d97706', glow: 'rgba(245, 158, 11, 0.4)'  },
  normal: { primary: '#06b6d4', secondary: '#0ea5e9', glow: 'rgba(6, 182, 212, 0.4)' },
  loud:   { primary: '#ef4444', secondary: '#f97316', glow: 'rgba(239, 68, 68, 0.4)'   },
  danger: { primary: '#dc2626', secondary: '#b91c1c', glow: 'rgba(220, 38, 38, 0.5)'   },
};

// ── Rendering constants ──────────────────────────────────────────────
const BAR_COUNT        = 40;       // Number of bars to render
const BIN_STRIDE       = 6;        // Sample every 6th bin from 256 (covers ~240 bins)
const BAR_GAP_RATIO    = 0.3;      // Gap as fraction of bar slot width
const BAR_RADIUS       = 2;        // Border radius for rounded caps
const SHADOW_BLUR      = 10;       // Glow intensity
const FADE_DURATION_MS = 500;      // Fade-out duration when stopping
const LOUD_HEIGHT_MULT = 1.3;      // Extra height multiplier for loud/danger zones
const MIN_BAR_HEIGHT   = 2;        // Minimum bar height so bars are always visible

// ── Module state ─────────────────────────────────────────────────────
let _analyser     = null;
let _canvas       = null;
let _ctx          = null;
let _dataArray    = null;
let _animFrameId  = null;
let _currentZone  = 'quiet';
let _running      = false;
let _fadingOut    = false;
let _fadeStart    = 0;
let _lastData     = null;   // Holds last frame data for fade-out rendering

// ── Public API ───────────────────────────────────────────────────────

/**
 * Return the color palette for a given zone name.
 * Exported for unit-testing.
 */
function getColorPalette(zone) {
  return COLOR_PALETTES[zone] || COLOR_PALETTES.quiet;
}

/**
 * Linearly interpolate between two values.
 * Exported for unit-testing.
 */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Compute the height multiplier for a zone.
 * loud/danger get a boost.
 */
function getHeightMultiplier(zone) {
  return (zone === 'loud' || zone === 'danger') ? LOUD_HEIGHT_MULT : 1.0;
}

/**
 * Downsample 256 frequency bins into BAR_COUNT values by averaging groups.
 */
function downsampleBins(dataArray, barCount, binStride) {
  const bars = new Array(barCount);
  for (let i = 0; i < barCount; i++) {
    const startBin = i * binStride;
    let sum = 0;
    let count = 0;
    for (let b = startBin; b < startBin + binStride && b < dataArray.length; b++) {
      sum += dataArray[b];
      count++;
    }
    bars[i] = count > 0 ? sum / count : 0;
  }
  return bars;
}

/**
 * Start the visualization loop.
 * @param {AnalyserNode} analyserNode - Web Audio AnalyserNode
 * @param {HTMLCanvasElement} canvasElement - Target canvas
 */
function startVisualization(analyserNode, canvasElement) {
  if (!analyserNode || !canvasElement) return;

  _analyser  = analyserNode;
  _canvas    = canvasElement;
  _ctx       = canvasElement.getContext('2d');
  _dataArray = new Uint8Array(analyserNode.frequencyBinCount);
  _running   = true;
  _fadingOut = false;
  _lastData  = null;

  // Ensure canvas CSS has GPU hint
  canvasElement.style.willChange = 'transform';

  // Size canvas to its layout size
  resizeCanvas();

  // Begin render loop
  tick();
}

/**
 * Stop the visualization with a 500ms fade-out.
 */
function stopVisualization() {
  if (!_running && !_fadingOut) return;

  _running   = false;
  _fadingOut = true;
  _fadeStart = performance.now();

  // The render loop continues during fade; it will cancel itself after FADE_DURATION_MS
}

/**
 * Update the current volume zone for color selection.
 * @param {'quiet'|'normal'|'loud'|'danger'} zone
 */
function setVolumeZone(zone) {
  if (COLOR_PALETTES[zone]) {
    _currentZone = zone;
  }
}

// ── Internals ────────────────────────────────────────────────────────

function resizeCanvas() {
  if (!_canvas) return;
  const rect = _canvas.getBoundingClientRect();
  const dpr  = window.devicePixelRatio || 1;
  _canvas.width  = rect.width  * dpr;
  _canvas.height = rect.height * dpr;
  if (_ctx) {
    _ctx.scale(dpr, dpr);
  }
}

function tick() {
  // Handle fade-out completion first (even when hidden, so fade can finish)
  if (_fadingOut) {
    const elapsed = performance.now() - _fadeStart;
    if (elapsed >= FADE_DURATION_MS) {
      // Fade complete — clear canvas and stop
      clearCanvas();
      _fadingOut    = false;
      _animFrameId  = null;
      return;
    }
  }

  // Skip rendering when tab/window is not visible (but let fade-out check above run)
  if (typeof document !== 'undefined' && document.hidden) {
    _animFrameId = requestAnimationFrame(tick);
    return;
  }

  // Read frequency data (only when actively monitoring)
  if (_running && _analyser && _dataArray) {
    _analyser.getByteFrequencyData(_dataArray);
    _lastData = downsampleBins(_dataArray, BAR_COUNT, BIN_STRIDE);
  }

  renderFrame();

  _animFrameId = requestAnimationFrame(tick);
}

function clearCanvas() {
  if (!_ctx || !_canvas) return;
  const rect = _canvas.getBoundingClientRect();
  _ctx.clearRect(0, 0, rect.width, rect.height);
}

function renderFrame() {
  if (!_ctx || !_canvas || !_lastData) return;

  const rect    = _canvas.getBoundingClientRect();
  const width   = rect.width;
  const height  = rect.height;
  const palette = getColorPalette(_currentZone);
  const hMult   = getHeightMultiplier(_currentZone);

  // Compute global opacity for fade-out
  let globalAlpha = 1;
  if (_fadingOut) {
    const elapsed = performance.now() - _fadeStart;
    globalAlpha = Math.max(0, 1 - elapsed / FADE_DURATION_MS);
  }

  // Clear
  _ctx.clearRect(0, 0, width, height);
  _ctx.globalAlpha = globalAlpha;

  // Bar geometry
  const slotWidth = width / BAR_COUNT;
  const barWidth  = slotWidth * (1 - BAR_GAP_RATIO);
  const gap       = slotWidth * BAR_GAP_RATIO;
  const baseline  = height * 0.85; // Bars grow upward from 85% of canvas height
  const maxBarH   = height * 0.75;

  // Glow
  _ctx.shadowColor = palette.glow;
  _ctx.shadowBlur  = SHADOW_BLUR;

  for (let i = 0; i < BAR_COUNT; i++) {
    const amplitude = _lastData[i] / 255; // 0..1
    let barHeight   = Math.max(MIN_BAR_HEIGHT, amplitude * maxBarH * hMult);
    const x         = i * slotWidth + gap / 2;
    const y         = baseline - barHeight;

    // Create gradient fill top-to-bottom
    const grad = _ctx.createLinearGradient(x, y, x, baseline);
    grad.addColorStop(0, palette.secondary);
    grad.addColorStop(1, palette.primary);
    _ctx.fillStyle = grad;

    // Draw rounded-top bar using a path
    drawRoundedBar(_ctx, x, y, barWidth, barHeight, BAR_RADIUS);
  }

  // Reset
  _ctx.globalAlpha = 1;
  _ctx.shadowColor = 'transparent';
  _ctx.shadowBlur  = 0;
}

/**
 * Draw a rectangle with rounded top corners and flat bottom.
 */
function drawRoundedBar(ctx, x, y, w, h, r) {
  // Clamp radius so it never exceeds half the width or total height
  const radius = Math.min(r, w / 2, h);

  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  // Top edge
  ctx.lineTo(x + w - radius, y);
  // Top-right arc
  ctx.arc(x + w - radius, y + radius, radius, -Math.PI / 2, 0);
  // Right edge down to bottom
  ctx.lineTo(x + w, y + h);
  // Bottom edge (flat)
  ctx.lineTo(x, y + h);
  // Left edge up to top-left arc
  ctx.lineTo(x, y + radius);
  // Top-left arc
  ctx.arc(x + radius, y + radius, radius, Math.PI, -Math.PI / 2);
  ctx.closePath();
  ctx.fill();
}

// ── Export for renderer.js and tests ─────────────────────────────────
// In Electron renderer, `window` is the global, so attach to it.
if (typeof window !== 'undefined') {
  window.FFTVisualizer = {
    startVisualization,
    stopVisualization,
    setVolumeZone,
    // Exposed for unit testing
    getColorPalette,
    lerp,
    getHeightMultiplier,
    downsampleBins,
    COLOR_PALETTES,
    BAR_COUNT,
    BIN_STRIDE,
    FADE_DURATION_MS,
    MIN_BAR_HEIGHT,
    LOUD_HEIGHT_MULT,
  };
}

// For Node.js / vitest
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    startVisualization,
    stopVisualization,
    setVolumeZone,
    getColorPalette,
    lerp,
    getHeightMultiplier,
    downsampleBins,
    COLOR_PALETTES,
    BAR_COUNT,
    BIN_STRIDE,
    FADE_DURATION_MS,
    MIN_BAR_HEIGHT,
    LOUD_HEIGHT_MULT,
  };
}
