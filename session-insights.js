/**
 * session-insights.js — Post-session plain-language insights (US-012)
 *
 * Pure-logic module. No Electron dependencies.
 * Dual export: CommonJS module.exports + window.SessionInsights
 */

function average(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function formatTimeSinceStart(timestamp, startTime) {
  const start = new Date(startTime).getTime();
  const peak = new Date(timestamp).getTime();
  const diffMs = peak - start;
  const totalSeconds = Math.max(0, Math.floor(diffMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function generateInsights(sessionData) {
  const insights = [];
  const { zoneTime, duration, volumeSamples, peakMoments, startTime } = sessionData || {};

  // Total zone time (including silent — all tracked time)
  const total = (zoneTime?.silent || 0) + (zoneTime?.quiet || 0) +
                (zoneTime?.normal || 0) + (zoneTime?.loud || 0);

  // 1. Loud zone percentage (always first priority)
  if (total > 0) {
    const loudPct = Math.round(((zoneTime.loud || 0) / total) * 100);
    if (loudPct > 0) {
      insights.push(`In your loud zone ${loudPct}% of the time`);
    } else {
      insights.push('You stayed out of the loud zone entirely');
    }
  }

  // 2. Volume trend: first half vs second half
  if (volumeSamples && volumeSamples.length > 20) {
    const mid = Math.floor(volumeSamples.length / 2);
    const firstHalfAvg = average(volumeSamples.slice(0, mid));
    const secondHalfAvg = average(volumeSamples.slice(mid));
    if (firstHalfAvg > 0) {
      const change = (secondHalfAvg - firstHalfAvg) / firstHalfAvg;
      if (change > 0.15) insights.push('You got louder in the second half');
      else if (change < -0.15) insights.push('You got quieter toward the end');
      else insights.push('Your volume was consistent throughout');
    }
  }

  // 3. Peak moment
  if (peakMoments && peakMoments.length > 0 && startTime) {
    const peakTime = formatTimeSinceStart(peakMoments[0].timestamp, startTime);
    insights.push(`Loudest at ${peakTime} into the call`);
  }

  // 4. Overall assessment (if room for one more)
  if (insights.length < 3 && total > 0) {
    const loudPct = ((zoneTime.loud || 0) / total) * 100;
    if (loudPct < 10) insights.push('Great job keeping it steady!');
    else if (loudPct >= 30) insights.push('Try to keep it down next time');
  }

  // Ensure at least 1 insight
  if (insights.length === 0) {
    insights.push('Keep monitoring to get more detailed insights');
  }

  return insights.slice(0, 3);
}

// Dual export: CommonJS + browser global
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { generateInsights };
} else if (typeof window !== 'undefined') {
  window.SessionInsights = { generateInsights };
}
