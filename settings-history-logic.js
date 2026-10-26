"use strict";

// Pure formatting / logic helpers for the Session History & Account tabs (US-018).
// No DOM or browser dependencies — tested directly by vitest.

/**
 * Format an ISO date string into a human-readable date.
 * e.g. "2026-03-08T14:30:00.000Z" -> "Mar 8, 2026"
 * @param {string} isoString
 * @returns {string}
 */
function formatDate(isoString) {
  if (!isoString) return "--";
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return "--";
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/**
 * Format an ISO date string into a time string.
 * e.g. "2026-03-08T14:30:00.000Z" -> "2:30 PM"
 * @param {string} isoString
 * @returns {string}
 */
function formatTime(isoString) {
  if (!isoString) return "--";
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return "--";
  let hours = d.getHours();
  const minutes = d.getMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const paddedMin = minutes < 10 ? "0" + minutes : "" + minutes;
  return `${hours}:${paddedMin} ${ampm}`;
}

/**
 * Format a duration in seconds into a human-readable string.
 * e.g. 3661 -> "1h 1m", 45 -> "0m 45s", 120 -> "2m 0s"
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  if (typeof seconds !== "number" || isNaN(seconds) || seconds < 0) return "--";
  const totalSec = Math.round(seconds);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

/**
 * Convert total minutes to a compact display string.
 * @param {number} minutes
 * @returns {string}
 */
function formatTotalMinutes(minutes) {
  if (typeof minutes !== "number" || isNaN(minutes) || minutes < 0) return "--";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m}m`;
}

/**
 * Compute a letter grade from zone time distribution.
 * Grading heuristic:
 *   - Score = (quiet% * 1.0) + (normal% * 0.8) + (loud% * 0.3) + (danger% * 0.0)
 *   - A: >= 0.85, B: >= 0.70, C: >= 0.55, D: >= 0.40, F: < 0.40
 * @param {{ silent?: number, quiet?: number, normal?: number, loud?: number }} zoneTime
 * @returns {{ letter: string, color: string, score: number }}
 */
function computeGrade(zoneTime) {
  if (!zoneTime || typeof zoneTime !== "object") {
    return { letter: "--", color: "tertiary", score: 0 };
  }

  const quiet = (zoneTime.silent || 0) + (zoneTime.quiet || 0);
  const normal = zoneTime.normal || 0;
  const loud = zoneTime.loud || 0;
  const danger = zoneTime.danger || 0;
  const total = quiet + normal + loud + danger;

  if (total === 0) {
    return { letter: "--", color: "tertiary", score: 0 };
  }

  const score =
    (quiet / total) * 1.0 +
    (normal / total) * 0.8 +
    (loud / total) * 0.3 +
    (danger / total) * 0.0;

  let letter, color;
  if (score >= 0.85) {
    letter = "A";
    color = "quiet";
  } else if (score >= 0.7) {
    letter = "B";
    color = "normal";
  } else if (score >= 0.55) {
    letter = "C";
    color = "loud";
  } else if (score >= 0.4) {
    letter = "D";
    color = "loud";
  } else {
    letter = "F";
    color = "danger";
  }

  return { letter, color, score: Math.round(score * 100) / 100 };
}

/**
 * Compute zone percentages from zoneTime object.
 * @param {{ silent?: number, quiet?: number, normal?: number, loud?: number, danger?: number }} zoneTime
 * @returns {{ quiet: number, normal: number, loud: number, danger: number }} percentages 0-100
 */
function computeZonePercentages(zoneTime) {
  if (!zoneTime || typeof zoneTime !== "object") {
    return { quiet: 0, normal: 0, loud: 0, danger: 0 };
  }

  const quiet = (zoneTime.silent || 0) + (zoneTime.quiet || 0);
  const normal = zoneTime.normal || 0;
  const loud = zoneTime.loud || 0;
  const danger = zoneTime.danger || 0;
  const total = quiet + normal + loud + danger;

  if (total === 0) {
    return { quiet: 0, normal: 0, loud: 0, danger: 0 };
  }

  return {
    quiet: Math.round((quiet / total) * 100),
    normal: Math.round((normal / total) * 100),
    loud: Math.round((loud / total) * 100),
    danger: Math.round((danger / total) * 100),
  };
}

/**
 * Sessions recorded before quietpls 2.1 used a different (score-based)
 * algorithm. They stay viewable, graded by their own rules, and are marked.
 * @param {Object} session
 * @returns {boolean}
 */
function isLegacySession(session) {
  return !session || !(session.algorithmVersion >= 2);
}

function letterFor(score) {
  if (score >= 0.85) return { letter: "A", color: "quiet" };
  if (score >= 0.7) return { letter: "B", color: "normal" };
  if (score >= 0.55) return { letter: "C", color: "loud" };
  if (score >= 0.4) return { letter: "D", color: "loud" };
  return { letter: "F", color: "danger" };
}

/**
 * Grade a session. 2.1+ sessions are graded over speaking time only:
 * score = (normal + 0.6 × getting-loud) / speaking; too-loud scores 0.
 * Pre-2.1 sessions use the legacy zone-time grade.
 * @param {Object} session
 * @returns {{ letter: string, color: string, score: number }}
 */
function computeSessionGrade(session) {
  if (isLegacySession(session))
    return computeGrade(session && session.zoneTime);
  const z = session.zoneTime || {};
  const speaking = (z.normal || 0) + (z.warning || 0) + (z.danger || 0);
  if (speaking <= 0) return { letter: "--", color: "tertiary", score: 0 };
  const score = ((z.normal || 0) + 0.6 * (z.warning || 0)) / speaking;
  return { ...letterFor(score), score: Math.round(score * 100) / 100 };
}

/**
 * Zone percentages for the history bars. 2.1+ sessions: share of speaking
 * time (quiet = 0, silence excluded). Pre-2.1: legacy percentages.
 * @param {Object} session
 * @returns {{ quiet: number, normal: number, loud: number, danger: number }}
 */
function computeSessionZonePercentages(session) {
  if (isLegacySession(session))
    return computeZonePercentages(session && session.zoneTime);
  const z = session.zoneTime || {};
  const speaking = (z.normal || 0) + (z.warning || 0) + (z.danger || 0);
  if (speaking <= 0) return { quiet: 0, normal: 0, loud: 0, danger: 0 };
  return {
    quiet: 0,
    normal: Math.round(((z.normal || 0) / speaking) * 100),
    loud: Math.round(((z.warning || 0) / speaking) * 100),
    danger: Math.round(((z.danger || 0) / speaking) * 100),
  };
}

/**
 * Compute an average grade letter from an array of sessions.
 * @param {Object[]} sessions - Array of session objects with zoneTime
 * @returns {string} Average grade letter
 */
function computeAverageGrade(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return "--";

  let totalScore = 0;
  let count = 0;
  for (const s of sessions) {
    const grade = computeSessionGrade(s);
    if (grade.letter !== "--") {
      totalScore += grade.score;
      count++;
    }
  }

  if (count === 0) return "--";
  const avgScore = totalScore / count;

  if (avgScore >= 0.85) return "A";
  if (avgScore >= 0.7) return "B";
  if (avgScore >= 0.55) return "C";
  if (avgScore >= 0.4) return "D";
  return "F";
}

const _settingsHistoryExports = {
  formatDate,
  formatTime,
  formatDuration,
  formatTotalMinutes,
  computeGrade,
  computeZonePercentages,
  computeAverageGrade,
  isLegacySession,
  computeSessionGrade,
  computeSessionZonePercentages,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = _settingsHistoryExports;
} else if (typeof window !== "undefined") {
  window.SettingsHistoryLogic = _settingsHistoryExports;
}
