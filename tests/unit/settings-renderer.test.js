import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const vm = require('node:vm');
const fs = require('node:fs');
const {
  clampThreshold,
  validateThresholds,
  filterAudioInputDevices,
  getZoneForVolume
} = require('../../settings-logic');

describe('Capture entry routing', () => {
  it('opens the checklist until setup is complete, then opens settings', async () => {
    const events = {};
    const elements = Object.fromEntries(['captureEnabled', 'captureDescription', 'captureActions', 'captureSettingsBtn'].map(id => [id, { addEventListener(name, callback) { events[name] = callback; } }]));
    const opened = [];
    let summary = { enabled: true, setupDone: false };
    const context = vm.createContext({
      document: { getElementById: id => elements[id] }, Event: class {},
      window: { addEventListener(name, callback) { events[name] = callback; }, dispatchEvent() {}, electronAPI: {
        captureSummary: async () => summary,
        setCaptureEnabled: async () => summary,
        openTranscripts: tab => opened.push(tab),
      } },
    });
    vm.runInContext(fs.readFileSync(new URL('../../capture/settings-section.js', import.meta.url), 'utf8'), context);
    await Promise.resolve();
    elements.captureSettingsBtn.onclick();
    expect(opened).toEqual(['calls']);
    await events.change();
    expect(opened).toEqual(['calls', 'calls']);
    summary = { enabled: true, setupDone: true };
    await events.focus();
    elements.captureSettingsBtn.onclick();
    expect(opened).toEqual(['calls', 'calls', 'settings']);
  });
});

describe('Capture row truth', () => {
  it('says always-on is recording and follows capture changes without a focus event', async () => {
    const elements = Object.fromEntries(['captureEnabled', 'captureDescription', 'captureActions', 'captureSettingsBtn'].map(id => [id, { addEventListener() {} }]));
    let push = null;
    const context = vm.createContext({
      document: { getElementById: id => elements[id] }, Event: class {},
      window: { addEventListener() {}, dispatchEvent() {}, electronAPI: {
        captureSummary: async () => ({ enabled: false, ambient: false, setupDone: true }),
        setCaptureEnabled: async () => ({}),
        openTranscripts() {},
        onCaptureSummary: cb => { push = cb; },
      } },
    });
    vm.runInContext(fs.readFileSync(new URL('../../capture/settings-section.js', import.meta.url), 'utf8'), context);
    await Promise.resolve();
    expect(elements.captureDescription.textContent).toMatch(/^Call prompts off/);
    // Always-on starts in the Capture window; Settings is open but never refocused.
    expect(push).toBeTypeOf('function');
    push({ enabled: false, ambient: true, setupDone: true });
    expect(elements.captureDescription.textContent).toBe('Always-on recording is on.');
    expect(elements.captureActions.hidden).toBe(false);
  });
});

// ============================================================
// clampThreshold
// ============================================================

describe('clampThreshold', () => {
  it('returns the value when within range', () => {
    expect(clampThreshold(50, 1, 100)).toBe(50);
  });

  it('clamps to min when value is below range', () => {
    expect(clampThreshold(-5, 1, 100)).toBe(1);
    expect(clampThreshold(0, 1, 100)).toBe(1);
  });

  it('clamps to max when value is above range', () => {
    expect(clampThreshold(150, 1, 100)).toBe(100);
  });

  it('returns min for NaN', () => {
    expect(clampThreshold(NaN, 1, 100)).toBe(1);
  });

  it('returns min for non-number types', () => {
    expect(clampThreshold('abc', 1, 100)).toBe(1);
    expect(clampThreshold(undefined, 1, 100)).toBe(1);
    expect(clampThreshold(null, 1, 100)).toBe(1);
  });

  it('handles boundary values exactly', () => {
    expect(clampThreshold(1, 1, 100)).toBe(1);
    expect(clampThreshold(100, 1, 100)).toBe(100);
  });
});

// ============================================================
// validateThresholds
// ============================================================

describe('validateThresholds', () => {
  it('returns valid thresholds unchanged', () => {
    const result = validateThresholds({
      quietThreshold: 20,
      normalThreshold: 33,
      warningThreshold: 66
    });
    expect(result.quietThreshold).toBe(20);
    expect(result.normalThreshold).toBe(33);
    expect(result.warningThreshold).toBe(66);
  });

  it('enforces strict ordering when quiet >= normal', () => {
    const result = validateThresholds({
      quietThreshold: 50,
      normalThreshold: 50,
      warningThreshold: 80
    });
    expect(result.quietThreshold).toBeLessThan(result.normalThreshold);
    expect(result.normalThreshold).toBeLessThan(result.warningThreshold);
  });

  it('enforces strict ordering when normal >= warning', () => {
    const result = validateThresholds({
      quietThreshold: 20,
      normalThreshold: 90,
      warningThreshold: 90
    });
    expect(result.quietThreshold).toBeLessThan(result.normalThreshold);
    expect(result.normalThreshold).toBeLessThan(result.warningThreshold);
  });

  it('clamps values to valid ranges', () => {
    const result = validateThresholds({
      quietThreshold: -10,
      normalThreshold: 200,
      warningThreshold: 300
    });
    expect(result.quietThreshold).toBeGreaterThanOrEqual(1);
    expect(result.quietThreshold).toBeLessThanOrEqual(98);
    expect(result.normalThreshold).toBeGreaterThanOrEqual(2);
    expect(result.normalThreshold).toBeLessThanOrEqual(99);
    expect(result.warningThreshold).toBeGreaterThanOrEqual(3);
    expect(result.warningThreshold).toBeLessThanOrEqual(100);
  });

  it('handles all equal values', () => {
    const result = validateThresholds({
      quietThreshold: 50,
      normalThreshold: 50,
      warningThreshold: 50
    });
    expect(result.quietThreshold).toBeLessThan(result.normalThreshold);
    expect(result.normalThreshold).toBeLessThan(result.warningThreshold);
  });

  it('handles NaN inputs by using minimum values', () => {
    const result = validateThresholds({
      quietThreshold: NaN,
      normalThreshold: NaN,
      warningThreshold: NaN
    });
    expect(result.quietThreshold).toBeGreaterThanOrEqual(1);
    expect(result.normalThreshold).toBeGreaterThanOrEqual(2);
    expect(result.warningThreshold).toBeGreaterThanOrEqual(3);
    expect(result.quietThreshold).toBeLessThan(result.normalThreshold);
    expect(result.normalThreshold).toBeLessThan(result.warningThreshold);
  });
});

// ============================================================
// filterAudioInputDevices
// ============================================================

describe('filterAudioInputDevices', () => {
  it('filters only audioinput devices', () => {
    const devices = [
      { kind: 'audioinput', deviceId: 'mic1', label: 'Built-in Microphone' },
      { kind: 'audiooutput', deviceId: 'out1', label: 'Speakers' },
      { kind: 'videoinput', deviceId: 'cam1', label: 'Camera' },
      { kind: 'audioinput', deviceId: 'mic2', label: 'External Mic' }
    ];
    const result = filterAudioInputDevices(devices);
    expect(result).toHaveLength(2);
    expect(result[0].deviceId).toBe('mic1');
    expect(result[1].deviceId).toBe('mic2');
  });

  it('excludes the default device entry', () => {
    const devices = [
      { kind: 'audioinput', deviceId: 'default', label: 'Default' },
      { kind: 'audioinput', deviceId: 'mic1', label: 'Real Mic' }
    ];
    const result = filterAudioInputDevices(devices);
    expect(result).toHaveLength(1);
    expect(result[0].deviceId).toBe('mic1');
  });

  it('generates a label when label is empty', () => {
    const devices = [
      { kind: 'audioinput', deviceId: 'abcdefgh12345678', label: '' }
    ];
    const result = filterAudioInputDevices(devices);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Unnamed mic (abcdefgh)');
  });

  it('returns empty array for non-array input', () => {
    expect(filterAudioInputDevices(null)).toEqual([]);
    expect(filterAudioInputDevices(undefined)).toEqual([]);
    expect(filterAudioInputDevices('not-array')).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(filterAudioInputDevices([])).toEqual([]);
  });
});

// ============================================================
// getZoneForVolume
// ============================================================

describe('getZoneForVolume', () => {
  const thresholds = {
    quietThreshold: 20,
    normalThreshold: 40,
    warningThreshold: 70
  };

  it('returns quiet for volume below quietThreshold', () => {
    expect(getZoneForVolume(0, thresholds)).toBe('quiet');
    expect(getZoneForVolume(10, thresholds)).toBe('quiet');
    expect(getZoneForVolume(19, thresholds)).toBe('quiet');
  });

  it('returns normal for volume at quietThreshold up to normalThreshold', () => {
    expect(getZoneForVolume(20, thresholds)).toBe('normal');
    expect(getZoneForVolume(30, thresholds)).toBe('normal');
    expect(getZoneForVolume(39, thresholds)).toBe('normal');
  });

  it('returns loud for volume at normalThreshold up to warningThreshold', () => {
    expect(getZoneForVolume(40, thresholds)).toBe('loud');
    expect(getZoneForVolume(55, thresholds)).toBe('loud');
    expect(getZoneForVolume(69, thresholds)).toBe('loud');
  });

  it('returns danger for volume at or above warningThreshold', () => {
    expect(getZoneForVolume(70, thresholds)).toBe('danger');
    expect(getZoneForVolume(85, thresholds)).toBe('danger');
    expect(getZoneForVolume(100, thresholds)).toBe('danger');
  });

  it('handles exact boundary values', () => {
    expect(getZoneForVolume(20, thresholds)).toBe('normal');
    expect(getZoneForVolume(40, thresholds)).toBe('loud');
    expect(getZoneForVolume(70, thresholds)).toBe('danger');
  });
});
