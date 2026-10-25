'use strict';

/**
 * Snap Position Calculator (US-006)
 *
 * Calculates the nearest horizontal snap anchor for the widget pill.
 * Snap anchors are at 25%, 50%, and 75% of the screen width (left-center,
 * center, right-center), adjusted so the widget is centered on the anchor.
 */

/**
 * Return the three horizontal snap anchor X positions.
 * Each value is the top-left X the window should be placed at so the
 * window is centered on the anchor point.
 *
 * @param {number} screenWidth  — width of the work area in pixels
 * @param {number} windowWidth  — width of the widget window in pixels
 * @returns {{ leftCenter: number, center: number, rightCenter: number }}
 */
function getSnapAnchors(screenWidth, windowWidth) {
  return {
    leftCenter:  Math.round(screenWidth * 0.25 - windowWidth / 2),
    center:      Math.round(screenWidth * 0.50 - windowWidth / 2),
    rightCenter: Math.round(screenWidth * 0.75 - windowWidth / 2),
  };
}

/**
 * Given the current window X position, return the X coordinate of the
 * nearest snap anchor.
 *
 * @param {number} currentX     — current top-left X of the window
 * @param {number} screenWidth  — width of the work area
 * @param {number} windowWidth  — width of the widget window
 * @returns {number} the X coordinate the window should snap to
 */
function calculateSnapX(currentX, screenWidth, windowWidth) {
  const anchors = getSnapAnchors(screenWidth, windowWidth);
  const values = [anchors.leftCenter, anchors.center, anchors.rightCenter];

  // Centre of the window
  const windowCenterX = currentX + windowWidth / 2;

  let nearest = values[0];
  let nearestDist = Infinity;

  for (let i = 0; i < values.length; i++) {
    const anchorCenter = values[i] + windowWidth / 2;
    const dist = Math.abs(windowCenterX - anchorCenter);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = values[i];
    }
  }

  return nearest;
}

module.exports = { getSnapAnchors, calculateSnapX };
