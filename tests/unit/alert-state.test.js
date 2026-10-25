'use strict';

/**
 * US-010: Unit tests for alert state trigger/dismiss timing logic
 * (createAlertTracker, ALERT_THRESHOLDS) extracted from renderer.js
 */

const { createAlertTracker, ALERT_THRESHOLDS } = require('../../renderer');

describe('ALERT_THRESHOLDS', () => {
  it('defines LOUD_TRIGGER_MS as 3000ms', () => {
    expect(ALERT_THRESHOLDS.LOUD_TRIGGER_MS).toBe(3000);
  });

  it('defines QUIET_DISMISS_MS as 5000ms', () => {
    expect(ALERT_THRESHOLDS.QUIET_DISMISS_MS).toBe(5000);
  });

  it('is frozen (immutable)', () => {
    expect(Object.isFrozen(ALERT_THRESHOLDS)).toBe(true);
  });
});

describe('createAlertTracker', () => {
  let tracker;
  let now;

  beforeEach(() => {
    tracker = createAlertTracker();
    now = 10000; // arbitrary start time
  });

  describe('trigger-alert', () => {
    it('returns "none" when loud for less than 3 seconds', () => {
      expect(tracker.update('warning', now)).toBe('none');
      expect(tracker.update('warning', now + 1000)).toBe('none');
      expect(tracker.update('danger', now + 2000)).toBe('none');
      expect(tracker.update('warning', now + 2999)).toBe('none');
    });

    it('returns "trigger-alert" after 3 continuous seconds in warning zone', () => {
      tracker.update('warning', now);
      tracker.update('warning', now + 1000);
      tracker.update('warning', now + 2000);
      const result = tracker.update('warning', now + 3000);
      expect(result).toBe('trigger-alert');
    });

    it('returns "trigger-alert" after 3 continuous seconds in danger zone', () => {
      tracker.update('danger', now);
      tracker.update('danger', now + 1500);
      const result = tracker.update('danger', now + 3000);
      expect(result).toBe('trigger-alert');
    });

    it('triggers with mixed warning/danger zones (both are "loud")', () => {
      tracker.update('warning', now);
      tracker.update('danger', now + 1000);
      tracker.update('warning', now + 2000);
      const result = tracker.update('danger', now + 3000);
      expect(result).toBe('trigger-alert');
    });

    it('resets loud streak when volume drops to normal', () => {
      tracker.update('warning', now);
      tracker.update('warning', now + 2000);
      // Drop to normal — resets streak
      tracker.update('normal', now + 2500);
      // Start being loud again
      tracker.update('warning', now + 3000);
      // Should NOT trigger at now+5500 (only 2.5s since new streak)
      expect(tracker.update('warning', now + 5500)).toBe('none');
      // Should trigger at now+6000 (3s since new streak at now+3000)
      expect(tracker.update('warning', now + 6000)).toBe('trigger-alert');
    });

    it('resets loud streak when volume drops to quiet', () => {
      tracker.update('danger', now);
      tracker.update('quiet', now + 1000);
      tracker.update('danger', now + 2000);
      expect(tracker.update('danger', now + 4999)).toBe('none');
      expect(tracker.update('danger', now + 5000)).toBe('trigger-alert');
    });

    it('does not trigger again once already in alert state', () => {
      // Trigger alert
      tracker.update('danger', now);
      expect(tracker.update('danger', now + 3000)).toBe('trigger-alert');
      // Continue being loud — should not trigger again
      expect(tracker.update('danger', now + 4000)).toBe('none');
      expect(tracker.update('danger', now + 6000)).toBe('none');
    });
  });

  describe('dismiss-alert', () => {
    beforeEach(() => {
      // Get into alert state first
      tracker.update('danger', now);
      tracker.update('danger', now + 3000); // triggers alert
    });

    it('returns "none" when quiet for less than 5 seconds during alert', () => {
      expect(tracker.update('quiet', now + 4000)).toBe('none');
      expect(tracker.update('normal', now + 5000)).toBe('none');
      expect(tracker.update('quiet', now + 8999)).toBe('none');
    });

    it('returns "dismiss-alert" after 5 continuous seconds below loud during alert', () => {
      tracker.update('normal', now + 4000);
      tracker.update('quiet', now + 6000);
      const result = tracker.update('normal', now + 9000);
      expect(result).toBe('dismiss-alert');
    });

    it('resets quiet streak if volume goes loud again during alert', () => {
      tracker.update('quiet', now + 4000);
      tracker.update('quiet', now + 6000);
      // Volume goes loud again — resets quiet streak
      tracker.update('warning', now + 7000);
      tracker.update('quiet', now + 8000);
      // Only 2s since new quiet streak at now+8000
      expect(tracker.update('quiet', now + 10000)).toBe('none');
      // 5s since new quiet streak
      expect(tracker.update('quiet', now + 13000)).toBe('dismiss-alert');
    });

    it('allows re-triggering after dismiss', () => {
      // Auto-dismiss
      tracker.update('quiet', now + 4000);
      tracker.update('quiet', now + 9000); // dismiss
      // Get loud again
      tracker.update('danger', now + 10000);
      const result = tracker.update('danger', now + 13000);
      expect(result).toBe('trigger-alert');
    });
  });

  describe('manual dismiss()', () => {
    it('exits alert state immediately', () => {
      tracker.update('danger', now);
      tracker.update('danger', now + 3000); // triggers alert
      expect(tracker.getIsInAlert()).toBe(true);

      tracker.dismiss();
      expect(tracker.getIsInAlert()).toBe(false);
    });

    it('allows re-triggering after manual dismiss', () => {
      tracker.update('danger', now);
      tracker.update('danger', now + 3000); // triggers alert
      tracker.dismiss();

      // Get loud again
      tracker.update('danger', now + 5000);
      const result = tracker.update('danger', now + 8000);
      expect(result).toBe('trigger-alert');
    });
  });

  describe('reset()', () => {
    it('clears all state', () => {
      tracker.update('danger', now);
      tracker.update('danger', now + 3000); // triggers alert
      expect(tracker.getIsInAlert()).toBe(true);

      tracker.reset();
      expect(tracker.getIsInAlert()).toBe(false);

      // Loud streak should be reset too
      tracker.update('danger', now + 5000);
      expect(tracker.update('danger', now + 7999)).toBe('none');
      expect(tracker.update('danger', now + 8000)).toBe('trigger-alert');
    });
  });

  describe('getIsInAlert()', () => {
    it('returns false initially', () => {
      expect(tracker.getIsInAlert()).toBe(false);
    });

    it('returns true after alert triggers', () => {
      tracker.update('danger', now);
      tracker.update('danger', now + 3000);
      expect(tracker.getIsInAlert()).toBe(true);
    });

    it('returns false after auto-dismiss', () => {
      tracker.update('danger', now);
      tracker.update('danger', now + 3000);
      tracker.update('quiet', now + 4000);
      tracker.update('quiet', now + 9000);
      expect(tracker.getIsInAlert()).toBe(false);
    });
  });

  describe('custom thresholds', () => {
    it('respects custom loudTriggerMs', () => {
      const custom = createAlertTracker({ loudTriggerMs: 1000 });
      custom.update('danger', now);
      expect(custom.update('danger', now + 999)).toBe('none');
      expect(custom.update('danger', now + 1000)).toBe('trigger-alert');
    });

    it('respects custom quietDismissMs', () => {
      const custom = createAlertTracker({ quietDismissMs: 2000 });
      custom.update('danger', now);
      custom.update('danger', now + 3000); // trigger
      custom.update('quiet', now + 4000);
      expect(custom.update('quiet', now + 5999)).toBe('none');
      expect(custom.update('quiet', now + 6000)).toBe('dismiss-alert');
    });
  });
});
