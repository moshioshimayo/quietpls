import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);

const { createSessionStore, validateSession } = require('../../session-store');

// ---- Helpers ----

/** Create a temp directory for each test run. */
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-test-'));
}

/** Build a minimal valid session object matching session-tracker finalize() output. */
function makeSession(overrides = {}) {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    startTime: new Date('2025-06-01T10:00:00Z').toISOString(),
    endTime: new Date('2025-06-01T10:30:00Z').toISOString(),
    duration: 1800, // 30 minutes in seconds
    volumeSamples: [40, 50, 60, 55, 45],
    peakMoments: [{ timestamp: '2025-06-01T10:15:00Z', value: 60 }],
    zoneTime: { silent: 100, quiet: 300, normal: 800, loud: 600 },
    silenceRatio: 0.0556,
    speakingPace: 5.2,
    volumeVariance: 7.5,
    ...overrides,
  };
}

// ---- Tests ----

describe('session-store', () => {
  let tmpDir;
  let store;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = createSessionStore(tmpDir);
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ----------------------------------------------------------------
  // Save / Retrieve / Delete cycle
  // ----------------------------------------------------------------
  describe('save, retrieve, delete cycle', () => {
    it('should save a session and retrieve it by ID', () => {
      const session = makeSession();
      const saved = store.saveSession(session);

      expect(saved.id).toBe(session.id);
      expect(saved.savedAt).toBeDefined();

      const retrieved = store.getSession(saved.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved.id).toBe(saved.id);
      expect(retrieved.duration).toBe(1800);
    });

    it('should assign an ID if the session does not have one', () => {
      const session = makeSession();
      delete session.id;
      const saved = store.saveSession(session);

      expect(saved.id).toBeDefined();
      expect(typeof saved.id).toBe('string');
      expect(saved.id.length).toBeGreaterThan(0);
    });

    it('should persist sessions to disk (survives re-instantiation)', () => {
      const session = makeSession();
      store.saveSession(session);

      // Create a new store instance pointing at the same directory
      const store2 = createSessionStore(tmpDir);
      const retrieved = store2.getSession(session.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved.id).toBe(session.id);
    });

    it('should delete a session by ID and return true', () => {
      const session = makeSession();
      store.saveSession(session);

      const result = store.deleteSession(session.id);
      expect(result).toBe(true);

      const retrieved = store.getSession(session.id);
      expect(retrieved).toBeNull();
    });

    it('should return false when deleting a non-existent session', () => {
      const result = store.deleteSession('non-existent-id');
      expect(result).toBe(false);
    });

    it('should return null for a non-existent session ID', () => {
      const retrieved = store.getSession('does-not-exist');
      expect(retrieved).toBeNull();
    });
  });

  // ----------------------------------------------------------------
  // Validation
  // ----------------------------------------------------------------
  describe('validation', () => {
    it('should reject null session data', () => {
      expect(() => store.saveSession(null)).toThrow('Invalid session');
    });

    it('should reject session without startTime', () => {
      const session = makeSession();
      delete session.startTime;
      expect(() => store.saveSession(session)).toThrow('startTime');
    });

    it('should reject session without duration', () => {
      const session = makeSession();
      delete session.duration;
      expect(() => store.saveSession(session)).toThrow('duration');
    });

    it('should reject session with negative duration', () => {
      const session = makeSession({ duration: -1 });
      expect(() => store.saveSession(session)).toThrow('duration');
    });

    it('should reject session without zoneTime', () => {
      const session = makeSession();
      delete session.zoneTime;
      expect(() => store.saveSession(session)).toThrow('zoneTime');
    });

    it('should accept a valid minimal session', () => {
      const minimal = {
        startTime: new Date().toISOString(),
        duration: 60,
        zoneTime: { silent: 10, quiet: 20, normal: 20, loud: 10 },
        volumeVariance: 5.0,
      };
      const saved = store.saveSession(minimal);
      expect(saved.id).toBeDefined();
    });

    it('should reject a session without any volume metric', () => {
      const noVolume = {
        startTime: new Date().toISOString(),
        duration: 60,
        zoneTime: { silent: 10, quiet: 20, normal: 20, loud: 10 },
      };
      expect(() => store.saveSession(noVolume)).toThrow('missing volume metric');
    });
  });

  // ----------------------------------------------------------------
  // validateSession export
  // ----------------------------------------------------------------
  describe('validateSession()', () => {
    it('should return null for a valid session', () => {
      expect(validateSession(makeSession())).toBeNull();
    });

    it('should return error string for invalid input', () => {
      expect(validateSession(null)).toBe('session data must be a non-null object');
      expect(validateSession('string')).toBe('session data must be a non-null object');
    });
  });

  // ----------------------------------------------------------------
  // Pagination (limit, offset)
  // ----------------------------------------------------------------
  describe('pagination', () => {
    beforeEach(() => {
      // Insert 10 sessions with staggered start times
      for (let i = 0; i < 10; i++) {
        const startTime = new Date(Date.UTC(2025, 0, 1 + i, 10, 0, 0)).toISOString();
        store.saveSession(makeSession({ id: `s-${i}`, startTime }));
      }
    });

    it('should return all sessions when limit exceeds count', () => {
      const result = store.getSessions({ limit: 50 });
      expect(result.length).toBe(10);
    });

    it('should return sessions in newest-first order', () => {
      const result = store.getSessions();
      expect(result[0].id).toBe('s-9');
      expect(result[9].id).toBe('s-0');
    });

    it('should respect limit parameter', () => {
      const result = store.getSessions({ limit: 3 });
      expect(result.length).toBe(3);
      expect(result[0].id).toBe('s-9');
      expect(result[2].id).toBe('s-7');
    });

    it('should respect offset parameter', () => {
      const result = store.getSessions({ limit: 3, offset: 2 });
      expect(result.length).toBe(3);
      expect(result[0].id).toBe('s-7');
      expect(result[2].id).toBe('s-5');
    });

    it('should return empty array when offset exceeds count', () => {
      const result = store.getSessions({ offset: 20 });
      expect(result.length).toBe(0);
    });

    it('should default limit to 50', () => {
      // We only have 10, so this just checks it does not error
      const result = store.getSessions();
      expect(result.length).toBe(10);
    });
  });

  // ----------------------------------------------------------------
  // Date range filtering
  // ----------------------------------------------------------------
  describe('date range filtering', () => {
    beforeEach(() => {
      const dates = [
        '2025-01-01T10:00:00Z',
        '2025-03-15T10:00:00Z',
        '2025-06-01T10:00:00Z',
        '2025-09-01T10:00:00Z',
        '2025-12-01T10:00:00Z',
      ];
      dates.forEach((d, i) => {
        store.saveSession(makeSession({ id: `d-${i}`, startTime: d }));
      });
    });

    it('should filter sessions with from date', () => {
      const result = store.getSessions({ dateRange: { from: '2025-06-01T00:00:00Z' } });
      expect(result.length).toBe(3);
      expect(result.map((s) => s.id).sort()).toEqual(['d-2', 'd-3', 'd-4']);
    });

    it('should filter sessions with to date', () => {
      const result = store.getSessions({ dateRange: { to: '2025-06-01T12:00:00Z' } });
      expect(result.length).toBe(3);
      expect(result.map((s) => s.id).sort()).toEqual(['d-0', 'd-1', 'd-2']);
    });

    it('should filter sessions with both from and to', () => {
      const result = store.getSessions({
        dateRange: { from: '2025-03-01T00:00:00Z', to: '2025-09-30T00:00:00Z' },
      });
      expect(result.length).toBe(3);
      expect(result.map((s) => s.id).sort()).toEqual(['d-1', 'd-2', 'd-3']);
    });

    it('should return empty when no sessions match the date range', () => {
      const result = store.getSessions({
        dateRange: { from: '2026-01-01T00:00:00Z' },
      });
      expect(result.length).toBe(0);
    });
  });

  // ----------------------------------------------------------------
  // Pruning old sessions
  // ----------------------------------------------------------------
  describe('pruneOldSessions', () => {
    it('should remove sessions older than maxAgeDays', () => {
      const now = Date.now();
      const oldDate = new Date(now - 100 * 24 * 60 * 60 * 1000).toISOString(); // 100 days ago
      const recentDate = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago

      store.saveSession(makeSession({ id: 'old', startTime: oldDate }));
      store.saveSession(makeSession({ id: 'recent', startTime: recentDate }));

      const removed = store.pruneOldSessions(90);
      expect(removed).toBe(1);

      expect(store.getSession('old')).toBeNull();
      expect(store.getSession('recent')).not.toBeNull();
    });

    it('should return 0 when no sessions are old enough to prune', () => {
      const recentDate = new Date().toISOString();
      store.saveSession(makeSession({ id: 'fresh', startTime: recentDate }));

      const removed = store.pruneOldSessions(90);
      expect(removed).toBe(0);
    });

    it('should default to 90 days', () => {
      const now = Date.now();
      const oldDate = new Date(now - 91 * 24 * 60 * 60 * 1000).toISOString();
      store.saveSession(makeSession({ id: 'old91', startTime: oldDate }));

      const removed = store.pruneOldSessions();
      expect(removed).toBe(1);
    });

    it('should handle empty store gracefully', () => {
      const removed = store.pruneOldSessions(30);
      expect(removed).toBe(0);
    });
  });

  // ----------------------------------------------------------------
  // Aggregate stats
  // ----------------------------------------------------------------
  describe('getStats', () => {
    it('should return zero stats for empty store', () => {
      const stats = store.getStats();
      expect(stats.totalSessions).toBe(0);
      expect(stats.totalMinutes).toBe(0);
      expect(stats.avgSessionMinutes).toBe(0);
      expect(stats.avgVolume).toBe(0);
    });

    it('should compute correct aggregate stats', () => {
      // Session 1: 30 min, samples [40, 50, 60]
      store.saveSession(makeSession({
        id: 'stat-1',
        duration: 1800,
        volumeSamples: [40, 50, 60],
      }));
      // Session 2: 15 min, samples [30, 70]
      store.saveSession(makeSession({
        id: 'stat-2',
        duration: 900,
        volumeSamples: [30, 70],
      }));

      const stats = store.getStats();
      expect(stats.totalSessions).toBe(2);
      expect(stats.totalMinutes).toBe(45); // (1800 + 900) / 60
      expect(stats.avgSessionMinutes).toBe(22.5); // 45 / 2
      // avgVolume = (40+50+60+30+70) / 5 = 50
      expect(stats.avgVolume).toBe(50);
    });

    it('should handle sessions without volumeSamples', () => {
      store.saveSession(makeSession({
        id: 'no-samples',
        duration: 600,
        volumeSamples: [],
      }));

      const stats = store.getStats();
      expect(stats.totalSessions).toBe(1);
      expect(stats.totalMinutes).toBe(10);
      expect(stats.avgVolume).toBe(0);
    });
  });

  // ----------------------------------------------------------------
  // Edge cases
  // ----------------------------------------------------------------
  describe('edge cases', () => {
    it('should handle corrupted JSON file gracefully', () => {
      // Write garbage to the sessions file
      const filePath = path.join(tmpDir, 'sessions.json');
      fs.writeFileSync(filePath, 'not valid json!!!', 'utf8');

      // Should not throw, should treat as empty
      const sessions = store.getSessions();
      expect(sessions).toEqual([]);
    });

    it('should handle missing sessions file gracefully', () => {
      // tmpDir exists but no sessions.json — getSessions should return []
      const sessions = store.getSessions();
      expect(sessions).toEqual([]);
    });

    it('should throw when storePath is not provided and electron is not available', () => {
      expect(() => createSessionStore(undefined)).toThrow('storePath is required');
    });

    it('should save multiple sessions and retrieve them all', () => {
      for (let i = 0; i < 5; i++) {
        store.saveSession(makeSession({ id: `multi-${i}` }));
      }
      const all = store.getSessions({ limit: 100 });
      expect(all.length).toBe(5);
    });
  });
});
