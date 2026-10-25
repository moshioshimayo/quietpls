'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

/**
 * Session storage module (US-012).
 *
 * Persists finalized session objects to a JSON file on disk.
 * Factory function accepts a storage directory path; defaults to
 * electron app.getPath('userData') when available.
 *
 * Session data contract (matches session-tracker.js finalize() output):
 *   - id:              string (UUID)
 *   - startTime:       string (ISO 8601)
 *   - endTime:         string (ISO 8601)
 *   - duration:        number (seconds)
 *   - volumeSamples:   number[]
 *   - peakMoments:     { timestamp: string, value: number }[]
 *   - zoneTime:        { silent, quiet, normal, loud } (seconds)
 *   - silenceRatio:    number
 *   - speakingPace:    number
 *   - volumeVariance:  number
 *
 * The store adds a `savedAt` timestamp on persist.
 */

const SESSIONS_FILE = 'sessions.json';

/**
 * Validate that the session object has the minimum required fields.
 * Returns null if valid, or an error string describing what is missing.
 */
function validateSession(data) {
  if (!data || typeof data !== 'object') {
    return 'session data must be a non-null object';
  }
  if (typeof data.startTime !== 'string') {
    return 'missing or invalid startTime (string expected)';
  }
  if (typeof data.duration !== 'number' || data.duration < 0) {
    return 'missing or invalid duration (non-negative number expected)';
  }
  if (typeof data.avgDb !== 'number' && typeof data.volumeVariance !== 'number') {
    return 'missing volume metric (avgDb or volumeVariance required)';
  }
  if (!data.zoneTime || typeof data.zoneTime !== 'object') {
    return 'missing or invalid zoneTime (object expected)';
  }
  return null;
}

function createSessionStore(storePath) {
  // Resolve default path: try electron app.getPath, fall back to provided path
  if (!storePath) {
    try {
      const { app } = require('electron');
      storePath = app.getPath('userData');
    } catch (_e) {
      throw new Error('storePath is required when electron app is not available');
    }
  }

  const filePath = path.join(storePath, SESSIONS_FILE);

  // ---- Internal helpers ----

  function readSessions() {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_e) {
      return [];
    }
  }

  function writeSessions(sessions) {
    // Ensure directory exists
    fs.mkdirSync(storePath, { recursive: true });
    // Atomic write: write to temp file first, then rename
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(sessions, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  // ---- Public API ----

  /**
   * Validate and persist a finalized session.
   * Adds a unique `id` (if not present) and `savedAt` timestamp.
   * Returns the saved session object.
   * Throws if validation fails.
   */
  function saveSession(sessionData) {
    const error = validateSession(sessionData);
    if (error) {
      throw new Error(`Invalid session: ${error}`);
    }

    const session = {
      ...sessionData,
      id: sessionData.id || randomUUID(),
      savedAt: new Date().toISOString(),
    };

    const sessions = readSessions();
    sessions.push(session);
    writeSessions(sessions);

    return session;
  }

  /**
   * Retrieve stored sessions with optional filtering.
   * @param {Object} [options]
   * @param {number} [options.limit=50]    Max sessions to return.
   * @param {number} [options.offset=0]    Skip first N sessions (newest-first).
   * @param {Object} [options.dateRange]   { from?: string, to?: string } ISO dates.
   * @returns {Object[]} Array of session objects, newest first.
   */
  function getSessions(options = {}) {
    const { limit = 50, offset = 0, dateRange } = options;

    let sessions = readSessions();

    // Filter by date range if provided
    if (dateRange) {
      const from = dateRange.from ? new Date(dateRange.from).getTime() : 0;
      const to = dateRange.to ? new Date(dateRange.to).getTime() : Infinity;
      sessions = sessions.filter((s) => {
        const t = new Date(s.startTime).getTime();
        return t >= from && t <= to;
      });
    }

    // Sort newest first
    sessions.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());

    // Paginate
    return sessions.slice(offset, offset + limit);
  }

  /**
   * Get a single session by ID.
   * @param {string} id
   * @returns {Object|null}
   */
  function getSession(id) {
    const sessions = readSessions();
    return sessions.find((s) => s.id === id) || null;
  }

  /**
   * Delete a session by ID.
   * @param {string} id
   * @returns {boolean} true if a session was deleted.
   */
  function deleteSession(id) {
    const sessions = readSessions();
    const index = sessions.findIndex((s) => s.id === id);
    if (index === -1) return false;
    sessions.splice(index, 1);
    writeSessions(sessions);
    return true;
  }

  /**
   * Remove sessions older than `maxAgeDays` days.
   * @param {number} [maxAgeDays=90]
   * @returns {number} Number of sessions removed.
   */
  function pruneOldSessions(maxAgeDays = 90) {
    const sessions = readSessions();
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const kept = sessions.filter((s) => new Date(s.startTime).getTime() >= cutoff);
    const removed = sessions.length - kept.length;
    if (removed > 0) {
      writeSessions(kept);
    }
    return removed;
  }

  /**
   * Compute aggregate statistics across all stored sessions.
   * @returns {{ totalSessions: number, totalMinutes: number, avgSessionMinutes: number, avgVolume: number }}
   */
  function getStats() {
    const sessions = readSessions();
    const totalSessions = sessions.length;

    if (totalSessions === 0) {
      return { totalSessions: 0, totalMinutes: 0, avgSessionMinutes: 0, avgVolume: 0 };
    }

    let totalDurationSec = 0;
    let volumeSum = 0;
    let volumeCount = 0;

    for (const s of sessions) {
      totalDurationSec += s.duration || 0;
      // Compute average dB from volumeSamples if available
      if (Array.isArray(s.volumeSamples) && s.volumeSamples.length > 0) {
        for (const v of s.volumeSamples) {
          volumeSum += v;
          volumeCount++;
        }
      }
    }

    const totalMinutes = Math.round((totalDurationSec / 60) * 100) / 100;
    const avgSessionMinutes = Math.round((totalDurationSec / 60 / totalSessions) * 100) / 100;
    const avgVolume = volumeCount > 0 ? Math.round((volumeSum / volumeCount) * 100) / 100 : 0;

    return { totalSessions, totalMinutes, avgSessionMinutes, avgVolume };
  }

  return {
    saveSession,
    getSessions,
    getSession,
    deleteSession,
    pruneOldSessions,
    getStats,
  };
}

module.exports = { createSessionStore, validateSession };
