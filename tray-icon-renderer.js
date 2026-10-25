'use strict';

/**
 * tray-icon-renderer.js — Dynamic tray icon generator using nativeImage.
 *
 * Maintains a rolling volume history and renders a mini-waveform icon
 * at 2x resolution for Retina displays. Falls back to static icons on error.
 */

const { nativeImage } = require('electron');
const { createCanvas } = require('canvas');
const { drawTrayIcon, BAR_COUNT } = require('./tray-icon-canvas');

// Icon dimensions (logical px — doubled for @2x Retina)
const ICON_SIZE = 22;
const SCALE = 2;
const PIXEL_SIZE = ICON_SIZE * SCALE; // 44x44

// Rolling volume history — keeps last BAR_COUNT + 3 samples for smoothness
const MAX_HISTORY = BAR_COUNT + 3;
let volumeHistory = [];

/**
 * Push a new volume sample into the rolling history.
 *
 * @param {number} volumeLevel 0-100
 */
function pushVolumeSample(volumeLevel) {
  volumeHistory.push(Math.max(0, Math.min(100, volumeLevel)));
  if (volumeHistory.length > MAX_HISTORY) {
    volumeHistory.shift();
  }
}

/**
 * Reset the volume history (e.g. when monitoring stops).
 */
function resetVolumeHistory() {
  volumeHistory = [];
}

/**
 * Get current volume history (for testing / inspection).
 *
 * @returns {number[]}
 */
function getVolumeHistory() {
  return [...volumeHistory];
}

/**
 * Create a dynamic tray icon as an Electron nativeImage.
 *
 * @param {number} volumeLevel — current volume 0-100
 * @param {string} zone — quiet | normal | loud | danger | inactive
 * @returns {Electron.NativeImage|null} — nativeImage or null on failure
 */
function createTrayIcon(volumeLevel, zone) {
  try {
    const canvas = createCanvas(PIXEL_SIZE, PIXEL_SIZE);
    const ctx = canvas.getContext('2d');

    // Push the latest sample
    pushVolumeSample(volumeLevel);

    // Draw at 2x resolution
    drawTrayIcon(ctx, PIXEL_SIZE, PIXEL_SIZE, volumeLevel, zone, volumeHistory);

    // Convert canvas to PNG buffer then to nativeImage
    const buffer = canvas.toBuffer('image/png');
    const image = nativeImage.createFromBuffer(buffer, {
      width: ICON_SIZE,
      height: ICON_SIZE,
      scaleFactor: SCALE,
    });

    // Mark as template image for macOS dark/light menu bar adaptation
    image.setTemplateImage(false); // We use custom colours, not template tinting

    return image;
  } catch (err) {
    console.error('[tray-icon-renderer] Failed to create dynamic icon:', err);
    return null;
  }
}

module.exports = {
  createTrayIcon,
  pushVolumeSample,
  resetVolumeHistory,
  getVolumeHistory,
  ICON_SIZE,
  PIXEL_SIZE,
};
