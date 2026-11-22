import { describe, it, expect, beforeEach } from 'vitest';

// The renderer exposes pure helpers via globalThis.__onboardingHelpers.
// We load the file to populate them.
// Note: the DOMContentLoaded listener won't fire in Node, so only the
// pure-logic helpers are exercised here.
require('../../onboarding-renderer.js');

const {
  resolveInitialStep, resolveStepButtons, permissionStateToUI,
  computeRmsVolume, updateHearing,
} = globalThis.__onboardingHelpers;

// ---------------------------------------------------------------------------
// resolveInitialStep
// ---------------------------------------------------------------------------
describe('resolveInitialStep', () => {
  it('returns step 3 when permission is granted', () => {
    expect(resolveInitialStep('granted')).toBe(3);
  });

  it('returns step 1 when permission is denied', () => {
    expect(resolveInitialStep('denied')).toBe(1);
  });

  it('returns step 1 when permission is not-determined', () => {
    expect(resolveInitialStep('not-determined')).toBe(1);
  });

  it('returns step 1 when permission is restricted', () => {
    expect(resolveInitialStep('restricted')).toBe(1);
  });

  it('returns step 1 for unknown states', () => {
    expect(resolveInitialStep('unknown')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resolveStepButtons
// ---------------------------------------------------------------------------
describe('resolveStepButtons', () => {
  it('hides back button on step 1', () => {
    const result = resolveStepButtons(1, false);
    expect(result.back).toBe('hidden');
  });

  it('shows back button on step 2', () => {
    const result = resolveStepButtons(2, false);
    expect(result.back).toBe('visible');
  });

  it('shows back button on step 3', () => {
    const result = resolveStepButtons(3, false);
    expect(result.back).toBe('visible');
  });

  it('shows skip on steps 1 and 2', () => {
    expect(resolveStepButtons(1, false).skip).toBe('visible');
    expect(resolveStepButtons(2, false).skip).toBe('visible');
  });

  it('hides skip on step 3', () => {
    expect(resolveStepButtons(3, false).skip).toBe('hidden');
  });

  it('allowMic is true on step 2 without permission', () => {
    expect(resolveStepButtons(2, false).allowMic).toBe(true);
  });

  it('allowMic is false on step 2 with permission', () => {
    expect(resolveStepButtons(2, true).allowMic).toBe(false);
  });

  it('allowMic is false on step 1', () => {
    expect(resolveStepButtons(1, false).allowMic).toBe(false);
  });

  it('nextDisabled is true on step 2 without permission', () => {
    expect(resolveStepButtons(2, false).nextDisabled).toBe(true);
  });

  it('nextDisabled is false on step 2 with permission', () => {
    expect(resolveStepButtons(2, true).nextDisabled).toBe(false);
  });

  it('nextDisabled is false on step 1', () => {
    expect(resolveStepButtons(1, false).nextDisabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// permissionStateToUI
// ---------------------------------------------------------------------------
describe('permissionStateToUI', () => {
  it('returns success UI for granted', () => {
    const ui = permissionStateToUI('granted');
    expect(ui.cssClass).toBe('success');
    expect(ui.showDeniedHelp).toBe(false);
    expect(ui.message).toContain('granted');
  });

  it('returns error UI for denied', () => {
    const ui = permissionStateToUI('denied');
    expect(ui.cssClass).toBe('error');
    expect(ui.showDeniedHelp).toBe(true);
    expect(ui.message).toContain('denied');
  });

  it('returns error UI for restricted', () => {
    const ui = permissionStateToUI('restricted');
    expect(ui.cssClass).toBe('error');
    expect(ui.showDeniedHelp).toBe(true);
    expect(ui.message).toContain('restricted');
  });

  it('returns empty UI for not-determined', () => {
    const ui = permissionStateToUI('not-determined');
    expect(ui.cssClass).toBe('');
    expect(ui.message).toBe('');
    expect(ui.showDeniedHelp).toBe(false);
  });

  it('returns fallback error UI for unknown state', () => {
    const ui = permissionStateToUI('something-else');
    expect(ui.cssClass).toBe('error');
    expect(ui.showDeniedHelp).toBe(false);
    expect(ui.message).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// updateHearing — the demo only says whether the mic hears you (2.4.0)
// ---------------------------------------------------------------------------
describe('updateHearing', () => {
  it('waits until a voice-level signal arrives', () => {
    expect(updateHearing(0, 1000, null)).toEqual({ hearing: false, lastHeardAt: null });
  });

  it('hears a voice-level signal', () => {
    expect(updateHearing(40, 1000, null)).toEqual({ hearing: true, lastHeardAt: 1000 });
  });

  it('keeps hearing through a short gap, then waits again', () => {
    expect(updateHearing(0, 1500, 1000).hearing).toBe(true);
    expect(updateHearing(0, 2000, 1000).hearing).toBe(false);
  });

  it('no longer rates the voice (zones and coaching are gone)', () => {
    const h = globalThis.__onboardingHelpers;
    expect(h.getVolumeZone).toBeUndefined();
    expect(h.getCoachingMessage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// US-020: computeRmsVolume
// ---------------------------------------------------------------------------
describe('computeRmsVolume', () => {
  it('returns 0 for silence (all 128 values)', () => {
    const data = new Uint8Array(256).fill(128);
    expect(computeRmsVolume(data)).toBe(0);
  });

  it('returns 0 for empty array', () => {
    expect(computeRmsVolume(new Uint8Array(0))).toBe(0);
    expect(computeRmsVolume(null)).toBe(0);
  });

  it('returns a positive value for non-silent data', () => {
    const data = new Uint8Array(256);
    // Simulate some audio signal - values oscillating around 128
    for (let i = 0; i < 256; i++) {
      data[i] = 128 + Math.round(20 * Math.sin(i * 0.1));
    }
    const vol = computeRmsVolume(data);
    expect(vol).toBeGreaterThan(0);
    expect(vol).toBeLessThanOrEqual(100);
  });

  it('returns higher volume for louder signals', () => {
    const quiet = new Uint8Array(256);
    const loud = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      quiet[i] = 128 + Math.round(5 * Math.sin(i * 0.1));
      loud[i] = 128 + Math.round(80 * Math.sin(i * 0.1));
    }
    expect(computeRmsVolume(loud)).toBeGreaterThan(computeRmsVolume(quiet));
  });

  it('never exceeds 100', () => {
    // Max amplitude signal
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      data[i] = i % 2 === 0 ? 0 : 255;
    }
    expect(computeRmsVolume(data)).toBeLessThanOrEqual(100);
  });
});
