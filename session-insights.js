/**
 * session-insights.js — post-session plain-language insights.
 *
 * Pure-logic module. No Electron dependencies.
 * Percentages are over speaking time only; silence is never counted as
 * quiet or loud. Levels are relative to the user's calibrated normal.
 * Dual export: CommonJS module.exports + window.SessionInsights
 */

function average(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// Whole minutes into the session (at least 1), so it never reads as a clock time.
function minutesSinceStart(timestamp, startTime) {
  const ms = new Date(timestamp).getTime() - new Date(startTime).getTime();
  return Math.max(1, Math.round(ms / 60000));
}

const TREND_DB = 2; // half-to-half change that counts as a trend

function generateInsights(sessionData) {
  const insights = [];
  const s = sessionData || {};
  const zoneTime = s.zoneTime || {};
  // Stored speakingTime also covers speech heard before a verdict (warm-up):
  // the same denominator as the stored ratios and the history view.
  const speaking = Math.max(
    (zoneTime.normal || 0) + (zoneTime.warning || 0) + (zoneTime.danger || 0),
    Number(s.speakingTime) || 0,
  );

  if (speaking <= 0) {
    return ["No talking detected this session"];
  }

  // 1. Ease your voice (red) share of speaking time
  const redPct = Math.round(((zoneTime.danger || 0) / speaking) * 100);
  const yellowPct = Math.round(((zoneTime.warning || 0) / speaking) * 100);
  if (redPct > 0) {
    insights.push(`“Ease your voice” shown for ${redPct}% of talking time`);
  } else {
    insights.push("“Ease your voice” shown for under 1% of talking time");
  }

  // 2. Getting loud (yellow) share, if any
  if (yellowPct > 0) {
    insights.push(`“Getting loud” shown for ${yellowPct}% of talking time`);
  }

  // 3. Trend: first half vs second half of speech, in dB
  const samples = s.volumeSamples;
  if (insights.length < 3 && samples && samples.length > 20) {
    const mid = Math.floor(samples.length / 2);
    const change = average(samples.slice(mid)) - average(samples.slice(0, mid));
    if (change > TREND_DB) insights.push("Voice level was higher in the second half");
    else if (change < -TREND_DB)
      insights.push("Voice level was lower in the second half");
    else insights.push("Average voice level was similar in both halves");
  }

  // 4. Loudest moment
  const peaks = s.peakMoments;
  if (
    insights.length < 3 &&
    peaks &&
    peaks.length > 0 &&
    s.startTime &&
    peaks[0].value >= 1
  ) {
    const minutes = minutesSinceStart(peaks[0].timestamp, s.startTime);
    insights.push(
      `Peak ${minutes} min in · +${Math.round(peaks[0].value)} dB above normal`,
    );
  }

  return insights.slice(0, 3);
}

// Dual export: CommonJS + browser global
if (typeof module !== "undefined" && module.exports) {
  module.exports = { generateInsights };
} else if (typeof window !== "undefined") {
  window.SessionInsights = { generateInsights };
}
