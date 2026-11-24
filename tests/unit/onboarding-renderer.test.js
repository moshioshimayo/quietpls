import { describe, it, expect } from 'vitest';

// The renderer exposes pure helpers via globalThis.__onboardingHelpers.
// The DOMContentLoaded wiring does not run in Node; the window flow is
// covered by tests/e2e/setup-window.spec.js.
require('../../onboarding-renderer.js');

const {
  panelForStatus, resolveInitialPanel, statusAnnouncement, micNote,
  computeRmsVolume, updateHearing,
} = globalThis.__onboardingHelpers;

describe('resolveInitialPanel (B3)', () => {
  it('a real first run always starts at Welcome, even with access granted', () => {
    for (const status of [null, 'granted', 'denied', 'restricted', 'not-determined']) {
      expect(resolveInitialPanel(status, null)).toBe('welcome');
    }
  });

  it('Voice Setup… opens the mic check, or what blocks it', () => {
    expect(resolveInitialPanel('granted', 'check')).toBe('check');
    expect(resolveInitialPanel('denied', 'check')).toBe('off');
    expect(resolveInitialPanel('restricted', 'check')).toBe('managed');
    expect(resolveInitialPanel('not-determined', 'check')).toBe('ask');
  });
});

describe('panelForStatus (B2/B4)', () => {
  it('skips the pre-permission step when access is granted', () => {
    expect(panelForStatus('granted')).toBe('check');
  });

  it('asks only while undetermined', () => {
    expect(panelForStatus('not-determined')).toBe('ask');
  });

  it('keeps access off and managed as recoverable states', () => {
    expect(panelForStatus('denied')).toBe('off');
    expect(panelForStatus('restricted')).toBe('managed');
  });

  it('an unreadable status offers Check again', () => {
    expect(panelForStatus('error')).toBe('error');
    expect(panelForStatus(undefined)).toBe('error');
  });
});

describe('statusAnnouncement', () => {
  it('announces each coarse access change once, in reviewed copy', () => {
    expect(statusAnnouncement('granted')).toBe('Microphone ready');
    expect(statusAnnouncement('denied')).toBe('Microphone access is off.');
    expect(statusAnnouncement('restricted')).toBe('Microphone access is managed by your organization.');
    expect(statusAnnouncement('not-determined')).toBe('');
    expect(statusAnnouncement('error')).toBe('Couldn’t check microphone access. Try again.');
  });
});

describe('micNote (AC-O4)', () => {
  const builtIn = { deviceId: 'b', label: 'MacBook Pro Microphone', reason: 'avoid-bluetooth' };
  it('explains when Automatic avoids AirPods', () => {
    expect(micNote(builtIn, [{ label: 'AirPods Pro' }, { label: 'MacBook Pro Microphone' }]))
      .toBe('Automatic keeps AirPods audio clear by using this mic.');
  });

  it('names Bluetooth generically for other headsets, and says nothing otherwise', () => {
    expect(micNote(builtIn, [{ label: 'WH-1000XM6' }])).toBe('Automatic keeps Bluetooth audio clear by using this mic.');
    expect(micNote({ ...builtIn, reason: 'default' }, [{ label: 'AirPods Pro' }])).toBe('');
    expect(micNote({ ...builtIn, reason: 'explicit' }, [])).toBe('');
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
