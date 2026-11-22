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

function formatTimeSinceStart(timestamp, startTime) {
  const start = new Date(startTime).getTime();
  const peak = new Date(timestamp).getTime();
  const totalSeconds = Math.max(0, Math.floor((peak - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
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
    return ["No speech detected this session"];
  }

  // 1. Ease your voice (red) share of speaking time
  const redPct = Math.round(((zoneTime.danger || 0) / speaking) * 100);
  const yellowPct = Math.round(((zoneTime.warning || 0) / speaking) * 100);
  if (redPct > 0) {
    insights.push(`Ease your voice for ${redPct}% of your speaking time`);
  } else {
    insights.push("You never needed to ease your voice");
  }

  // 2. Getting loud (yellow) share, if any
  if (yellowPct > 0) {
    insights.push(`Getting loud for ${yellowPct}% of your speaking time`);
  }

  // 3. Trend: first half vs second half of speech, in dB
  const samples = s.volumeSamples;
  if (insights.length < 3 && samples && samples.length > 20) {
    const mid = Math.floor(samples.length / 2);
    const change = average(samples.slice(mid)) - average(samples.slice(0, mid));
    if (change > TREND_DB) insights.push("You got louder in the second half");
    else if (change < -TREND_DB)
      insights.push("You got quieter toward the end");
    else insights.push("Your level was consistent throughout");
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
    const at = formatTimeSinceStart(peaks[0].timestamp, s.startTime);
    insights.push(
      `Loudest at ${at}: +${Math.round(peaks[0].value)} dB above your normal`,
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
