'use strict';

/**
 * Session grading algorithm (US-013).
 *
 * Pure scoring / grading module — no Electron imports.
 * Takes a finalized session object from session-tracker.js and produces
 * a grade report with score, letter grade, breakdown, insights, archetype,
 * and hero stat.
 *
 * Scoring weights:
 *   Volume control  — 40%
 *   Consistency     — 25%
 *   Peak management — 20%
 *   Pace            — 15%
 */

// ---------------------------------------------------------------------------
// Grade thresholds
// ---------------------------------------------------------------------------

const GRADE_THRESHOLDS = [
  { min: 95, grade: 'A+' },
  { min: 90, grade: 'A' },
  { min: 85, grade: 'A-' },
  { min: 80, grade: 'B+' },
  { min: 75, grade: 'B' },
  { min: 70, grade: 'B-' },
  { min: 65, grade: 'C+' },
  { min: 60, grade: 'C' },
  { min: 55, grade: 'C-' },
  { min: 40, grade: 'D' },
  { min: 0, grade: 'F' },
];

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/**
 * Clamp a value between 0 and 100.
 */
function clamp(value) {
  return Math.max(0, Math.min(100, value));
}

/**
 * Volume control score (0-100).
 * Rewards time in quiet + normal zones, penalises loud zone.
 */
function scoreVolumeControl(zoneTime) {
  const total =
    (zoneTime.silent || 0) +
    (zoneTime.quiet || 0) +
    (zoneTime.normal || 0) +
    (zoneTime.loud || 0);

  if (total === 0) return 50; // no data — neutral

  const goodTime = (zoneTime.quiet || 0) + (zoneTime.normal || 0);
  const goodRatio = goodTime / total;
  const loudRatio = (zoneTime.loud || 0) / total;

  // Base score from good-zone ratio (0-80), penalty from loud ratio (0-40)
  let score = goodRatio * 80 + 20 - loudRatio * 40;
  return clamp(Math.round(score * 100) / 100);
}

/**
 * Consistency score (0-100).
 * Lower volumeVariance = better.  Variance of 0 is perfect, 30+ is very bad.
 */
function scoreConsistency(volumeVariance) {
  if (volumeVariance == null) return 50;
  // Linear scale: 0 variance = 100, 30+ variance = 0
  const score = 100 - (volumeVariance / 30) * 100;
  return clamp(Math.round(score * 100) / 100);
}

/**
 * Peak management score (0-100).
 * Fewer peaks and lower peak values = better.
 */
function scorePeakManagement(peakMoments) {
  if (!peakMoments || peakMoments.length === 0) return 100;

  const maxPeak = peakMoments[0].value; // sorted descending
  const peakCount = peakMoments.length;

  // Peak value penalty: peaks above 70 are bad, above 90 is terrible
  let valuePenalty = 0;
  if (maxPeak > 70) {
    valuePenalty = Math.min(50, ((maxPeak - 70) / 30) * 50);
  }

  // Count penalty: more peaks = worse (up to 30 points for 5 peaks)
  const countPenalty = Math.min(30, (peakCount / 5) * 30);

  return clamp(Math.round((100 - valuePenalty - countPenalty) * 100) / 100);
}

/**
 * Pace score (0-100).
 * Moderate speaking pace (4-8 transitions/min) is ideal.
 * Too few = mostly silence; too many = chaotic.
 */
function scorePace(speakingPace) {
  if (speakingPace == null) return 50;

  // Ideal range: 4-8 transitions per minute
  const idealMin = 4;
  const idealMax = 8;

  if (speakingPace >= idealMin && speakingPace <= idealMax) {
    return 100;
  }

  // Below ideal — too silent
  if (speakingPace < idealMin) {
    const score = (speakingPace / idealMin) * 100;
    return clamp(Math.round(score * 100) / 100);
  }

  // Above ideal — too chaotic
  const excess = speakingPace - idealMax;
  const score = 100 - (excess / 12) * 100; // 20 transitions/min → 0
  return clamp(Math.round(score * 100) / 100);
}

// ---------------------------------------------------------------------------
// Letter grade
// ---------------------------------------------------------------------------

/**
 * Convert a numeric score (0-100) to a letter grade.
 */
function getLetterGrade(score) {
  for (const { min, grade } of GRADE_THRESHOLDS) {
    if (score >= min) return grade;
  }
  return 'F';
}

// ---------------------------------------------------------------------------
// Archetype
// ---------------------------------------------------------------------------

/**
 * Assign a fun archetype label based on session patterns.
 */
function getArchetype(sessionData) {
  const { zoneTime, volumeVariance, speakingPace } = sessionData;

  const total =
    (zoneTime.silent || 0) +
    (zoneTime.quiet || 0) +
    (zoneTime.normal || 0) +
    (zoneTime.loud || 0);

  if (total === 0) return 'The Professional';

  const quietRatio = ((zoneTime.silent || 0) + (zoneTime.quiet || 0)) / total;
  const normalRatio = (zoneTime.normal || 0) / total;
  const loudRatio = (zoneTime.loud || 0) / total;

  // High variance → Rollercoaster
  if (volumeVariance != null && volumeVariance > 18) {
    return 'The Rollercoaster';
  }

  // Mostly loud → Megaphone
  if (loudRatio > 0.5) {
    return 'The Megaphone';
  }

  // Lots of loud but with recovery (loud between 15-50%, moderate variance)
  if (loudRatio > 0.15 && volumeVariance != null && volumeVariance > 8) {
    return 'The Enthusiast';
  }

  // Mostly quiet/silent
  if (quietRatio > 0.6) {
    return 'The Whisperer';
  }

  // Mostly normal with low variance → Professional
  return 'The Professional';
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

/**
 * Generate 2-4 human-readable insights about the session.
 */
function getInsights(sessionData) {
  const insights = [];
  const { zoneTime, volumeVariance, speakingPace, peakMoments, duration } =
    sessionData;

  const total =
    (zoneTime.silent || 0) +
    (zoneTime.quiet || 0) +
    (zoneTime.normal || 0) +
    (zoneTime.loud || 0);

  if (total > 0) {
    // Good-zone insight
    const goodRatio =
      ((zoneTime.quiet || 0) + (zoneTime.normal || 0)) / total;
    const goodPct = Math.round(goodRatio * 100);
    if (goodPct >= 70) {
      insights.push(
        `You spent ${goodPct}% of the session at a comfortable volume — nice!`
      );
    } else if (goodPct < 40) {
      insights.push(
        `Only ${goodPct}% of your session was at a comfortable volume — there's room to improve.`
      );
    }

    // Loud-zone insight
    const loudSec = zoneTime.loud || 0;
    const loudPct = Math.round((loudSec / total) * 100);
    if (loudSec > 0) {
      const loudMin = Math.round(loudSec / 60);
      if (loudMin >= 1) {
        insights.push(
          `You were in the loud zone for ${loudMin} minute${loudMin !== 1 ? 's' : ''} — that's louder than a lawn mower!`
        );
      } else if (loudPct > 10) {
        insights.push(
          `${loudPct}% of your session was in the loud zone — try to keep it down.`
        );
      }
    }

    // Silence insight
    const silentRatio = (zoneTime.silent || 0) / total;
    if (silentRatio > 0.5) {
      insights.push(
        'You were silent for most of the session — were you on mute?'
      );
    }
  }

  // Peak insight
  if (peakMoments && peakMoments.length > 0) {
    const maxPeak = peakMoments[0].value;
    const peakCount = peakMoments.length;
    if (maxPeak > 80) {
      insights.push(
        `Your volume spiked above 80 dB ${peakCount} time${peakCount !== 1 ? 's' : ''} — try to stay more consistent.`
      );
    }
  }

  // Variance insight
  if (volumeVariance != null && volumeVariance < 5 && total > 0) {
    insights.push(
      'Your volume was remarkably steady — great consistency!'
    );
  }

  // Pace insight
  if (speakingPace != null && speakingPace >= 4 && speakingPace <= 8) {
    insights.push('Your speaking rhythm was well-paced and natural.');
  }

  // Ensure 2-4 insights
  if (insights.length < 2) {
    if (duration != null) {
      const mins = Math.round(duration / 60);
      if (mins >= 1) {
        insights.push(`Session lasted ${mins} minute${mins !== 1 ? 's' : ''}.`);
      } else {
        insights.push('This was a short session.');
      }
    }
  }
  if (insights.length < 2) {
    insights.push('Keep monitoring to see your trends over time!');
  }

  // Cap at 4
  return insights.slice(0, 4);
}

// ---------------------------------------------------------------------------
// Hero stat
// ---------------------------------------------------------------------------

/**
 * Pick the most interesting / shareable single stat from the session.
 */
function getHeroStat(sessionData) {
  const { zoneTime, peakMoments, duration } = sessionData;

  const total =
    (zoneTime.silent || 0) +
    (zoneTime.quiet || 0) +
    (zoneTime.normal || 0) +
    (zoneTime.loud || 0);

  // Candidate stats, ranked by shareability
  const candidates = [];

  if (total > 0) {
    const goodRatio =
      ((zoneTime.quiet || 0) + (zoneTime.normal || 0)) / total;
    const goodPct = Math.round(goodRatio * 100);
    candidates.push({
      label: 'Perfect Volume',
      value: `${goodPct}%`,
      priority: goodPct >= 70 ? 3 : 1,
    });

    const normalMin = Math.round((zoneTime.normal || 0) / 60);
    if (normalMin >= 1) {
      candidates.push({
        label: 'In the Zone',
        value: `${normalMin} minute${normalMin !== 1 ? 's' : ''}`,
        priority: normalMin >= 5 ? 2 : 1,
      });
    }
  }

  if (peakMoments && peakMoments.length > 0) {
    const maxPeak = Math.round(peakMoments[0].value);
    candidates.push({
      label: 'Peak Volume',
      value: `${maxPeak} dB`,
      priority: maxPeak > 85 ? 2 : 1,
    });
  }

  if (duration != null) {
    const mins = Math.round(duration / 60);
    if (mins >= 1) {
      candidates.push({
        label: 'Session Length',
        value: `${mins} minute${mins !== 1 ? 's' : ''}`,
        priority: mins >= 30 ? 2 : 0,
      });
    }
  }

  // Pick highest priority
  candidates.sort((a, b) => b.priority - a.priority);
  if (candidates.length > 0) {
    const best = candidates[0];
    return { label: best.label, value: best.value };
  }

  return { label: 'Session Tracked', value: 'Complete' };
}

// ---------------------------------------------------------------------------
// Main grading function
// ---------------------------------------------------------------------------

/**
 * Grade a finalized session.
 *
 * @param {Object} sessionData — output of session-tracker.js finalize()
 * @returns {{ score: number, letterGrade: string, breakdown: Object,
 *             insights: string[], archetype: string, heroStat: { label: string, value: string } }}
 */
function gradeSession(sessionData) {
  const volumeControl = scoreVolumeControl(sessionData.zoneTime || {});
  const consistency = scoreConsistency(sessionData.volumeVariance);
  const peakManagement = scorePeakManagement(sessionData.peakMoments);
  const pace = scorePace(sessionData.speakingPace);

  const score = Math.round(
    (volumeControl * 0.4 +
      consistency * 0.25 +
      peakManagement * 0.2 +
      pace * 0.15) *
      100
  ) / 100;

  const letterGrade = getLetterGrade(score);
  const insights = getInsights(sessionData);
  const archetype = getArchetype(sessionData);
  const heroStat = getHeroStat(sessionData);

  return {
    score,
    letterGrade,
    breakdown: {
      volumeControl,
      consistency,
      peakManagement,
      pace,
    },
    insights,
    archetype,
    heroStat,
  };
}

module.exports = {
  gradeSession,
  getLetterGrade,
  getArchetype,
  getInsights,
  getHeroStat,
};
