import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const {
  gradeSession,
  getLetterGrade,
  getArchetype,
  getInsights,
  getHeroStat,
} = require('../../session-grader');

// ---------------------------------------------------------------------------
// Helpers — build session objects for testing
// ---------------------------------------------------------------------------

function makeSession(overrides = {}) {
  return {
    id: 'test-session-1',
    startTime: '2026-01-01T10:00:00.000Z',
    endTime: '2026-01-01T10:30:00.000Z',
    duration: 1800, // 30 minutes
    volumeSamples: Array(100).fill(40),
    peakMoments: [
      { timestamp: '2026-01-01T10:05:00.000Z', value: 55 },
    ],
    zoneTime: { silent: 60, quiet: 300, normal: 1200, loud: 240 },
    silenceRatio: 0.033,
    speakingPace: 6,
    volumeVariance: 8,
    ...overrides,
  };
}

/** Ideal session — mostly normal, low variance, no loud. */
function makeIdealSession() {
  return makeSession({
    zoneTime: { silent: 30, quiet: 200, normal: 1500, loud: 0 },
    volumeVariance: 3,
    speakingPace: 6,
    peakMoments: [{ timestamp: '2026-01-01T10:05:00.000Z', value: 55 }],
  });
}

/** Average session — some loud time, moderate variance. */
function makeAverageSession() {
  return makeSession({
    zoneTime: { silent: 100, quiet: 200, normal: 800, loud: 400 },
    volumeVariance: 14,
    speakingPace: 10,
    peakMoments: [
      { timestamp: '2026-01-01T10:05:00.000Z', value: 78 },
      { timestamp: '2026-01-01T10:10:00.000Z', value: 75 },
      { timestamp: '2026-01-01T10:15:00.000Z', value: 72 },
    ],
  });
}

/** Poor session — very loud, high variance, many peaks. */
function makePoorSession() {
  return makeSession({
    zoneTime: { silent: 50, quiet: 50, normal: 200, loud: 1500 },
    volumeVariance: 25,
    speakingPace: 18,
    peakMoments: [
      { timestamp: '2026-01-01T10:05:00.000Z', value: 95 },
      { timestamp: '2026-01-01T10:10:00.000Z', value: 92 },
      { timestamp: '2026-01-01T10:15:00.000Z', value: 88 },
      { timestamp: '2026-01-01T10:20:00.000Z', value: 85 },
      { timestamp: '2026-01-01T10:25:00.000Z', value: 82 },
    ],
  });
}

// ===========================================================================
// gradeSession — overall integration
// ===========================================================================

describe('session-grader', () => {
  describe('gradeSession() return shape', () => {
    it('should return all required fields', () => {
      const result = gradeSession(makeSession());

      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('letterGrade');
      expect(result).toHaveProperty('breakdown');
      expect(result).toHaveProperty('insights');
      expect(result).toHaveProperty('archetype');
      expect(result).toHaveProperty('heroStat');

      expect(typeof result.score).toBe('number');
      expect(typeof result.letterGrade).toBe('string');
      expect(typeof result.breakdown).toBe('object');
      expect(Array.isArray(result.insights)).toBe(true);
      expect(typeof result.archetype).toBe('string');
      expect(result.heroStat).toHaveProperty('label');
      expect(result.heroStat).toHaveProperty('value');
    });

    it('should return breakdown with all four components', () => {
      const result = gradeSession(makeSession());
      const { breakdown } = result;

      expect(breakdown).toHaveProperty('volumeControl');
      expect(breakdown).toHaveProperty('consistency');
      expect(breakdown).toHaveProperty('peakManagement');
      expect(breakdown).toHaveProperty('pace');

      // All scores should be 0-100
      for (const key of Object.keys(breakdown)) {
        expect(breakdown[key]).toBeGreaterThanOrEqual(0);
        expect(breakdown[key]).toBeLessThanOrEqual(100);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Grade tiers
  // -------------------------------------------------------------------------

  describe('grade tiers', () => {
    it('should grade an ideal session as A or A+', () => {
      const result = gradeSession(makeIdealSession());
      expect(result.score).toBeGreaterThanOrEqual(85);
      expect(['A+', 'A', 'A-']).toContain(result.letterGrade);
    });

    it('should grade an average session in the B/C range', () => {
      const result = gradeSession(makeAverageSession());
      expect(result.score).toBeGreaterThanOrEqual(40);
      expect(result.score).toBeLessThan(85);
      expect(['B+', 'B', 'B-', 'C+', 'C', 'C-']).toContain(
        result.letterGrade
      );
    });

    it('should grade a poor session as D or F', () => {
      const result = gradeSession(makePoorSession());
      expect(result.score).toBeLessThan(55);
      expect(['D', 'F']).toContain(result.letterGrade);
    });
  });

  // -------------------------------------------------------------------------
  // Scoring weights — verify weighted contribution
  // -------------------------------------------------------------------------

  describe('scoring weights', () => {
    it('should weight volume control at 40%', () => {
      // Perfect volume control, zero everything else
      const session = makeSession({
        zoneTime: { silent: 0, quiet: 0, normal: 1800, loud: 0 },
        volumeVariance: 30,   // 0 consistency
        peakMoments: [],
        speakingPace: 0,      // 0 pace
      });
      const result = gradeSession(session);
      // volumeControl should be ~100, contributing ~40 to overall
      // consistency ~0 contributing 0, peaks ~100 contributing 20, pace 0 contributing 0
      // Expected ~60
      expect(result.breakdown.volumeControl).toBeGreaterThanOrEqual(90);
      expect(result.score).toBeGreaterThanOrEqual(50);
      expect(result.score).toBeLessThanOrEqual(70);
    });

    it('should weight consistency at 25%', () => {
      // Perfect consistency with poor everything else
      const session = makeSession({
        zoneTime: { silent: 0, quiet: 0, normal: 0, loud: 1800 },
        volumeVariance: 0,
        peakMoments: [
          { timestamp: '2026-01-01T10:05:00.000Z', value: 95 },
          { timestamp: '2026-01-01T10:10:00.000Z', value: 92 },
          { timestamp: '2026-01-01T10:15:00.000Z', value: 88 },
          { timestamp: '2026-01-01T10:20:00.000Z', value: 85 },
          { timestamp: '2026-01-01T10:25:00.000Z', value: 82 },
        ],
        speakingPace: 0,
      });
      const result = gradeSession(session);
      expect(result.breakdown.consistency).toBe(100);
    });

    it('should weight peak management at 20%', () => {
      const sessionNoPeaks = makeSession({
        peakMoments: [],
      });
      const sessionBadPeaks = makeSession({
        peakMoments: [
          { timestamp: '2026-01-01T10:05:00.000Z', value: 98 },
          { timestamp: '2026-01-01T10:10:00.000Z', value: 95 },
          { timestamp: '2026-01-01T10:15:00.000Z', value: 92 },
          { timestamp: '2026-01-01T10:20:00.000Z', value: 90 },
          { timestamp: '2026-01-01T10:25:00.000Z', value: 88 },
        ],
      });

      const good = gradeSession(sessionNoPeaks);
      const bad = gradeSession(sessionBadPeaks);

      // Difference should come from peak management (20% weight)
      const diff = good.score - bad.score;
      expect(diff).toBeGreaterThan(5);
      expect(diff).toBeLessThanOrEqual(25);
    });

    it('should weight pace at 15%', () => {
      const idealPace = makeSession({ speakingPace: 6 });
      const badPace = makeSession({ speakingPace: 20 });

      const good = gradeSession(idealPace);
      const bad = gradeSession(badPace);

      const diff = good.score - bad.score;
      expect(diff).toBeGreaterThan(5);
      expect(diff).toBeLessThanOrEqual(20);
    });
  });

  // -------------------------------------------------------------------------
  // Volume control scoring
  // -------------------------------------------------------------------------

  describe('volume control scoring', () => {
    it('should give high score for all-normal session', () => {
      const result = gradeSession(
        makeSession({
          zoneTime: { silent: 0, quiet: 0, normal: 1800, loud: 0 },
        })
      );
      expect(result.breakdown.volumeControl).toBeGreaterThanOrEqual(90);
    });

    it('should penalise heavy loud-zone usage', () => {
      const result = gradeSession(
        makeSession({
          zoneTime: { silent: 0, quiet: 0, normal: 0, loud: 1800 },
        })
      );
      expect(result.breakdown.volumeControl).toBeLessThanOrEqual(20);
    });

    it('should return neutral score for empty zone time', () => {
      const result = gradeSession(
        makeSession({
          zoneTime: { silent: 0, quiet: 0, normal: 0, loud: 0 },
        })
      );
      expect(result.breakdown.volumeControl).toBe(50);
    });
  });

  // -------------------------------------------------------------------------
  // Consistency scoring
  // -------------------------------------------------------------------------

  describe('consistency scoring', () => {
    it('should give 100 for zero variance', () => {
      const result = gradeSession(makeSession({ volumeVariance: 0 }));
      expect(result.breakdown.consistency).toBe(100);
    });

    it('should give 0 for variance of 30+', () => {
      const result = gradeSession(makeSession({ volumeVariance: 30 }));
      expect(result.breakdown.consistency).toBe(0);
    });

    it('should give ~50 for variance of 15', () => {
      const result = gradeSession(makeSession({ volumeVariance: 15 }));
      expect(result.breakdown.consistency).toBe(50);
    });

    it('should handle null variance gracefully', () => {
      const result = gradeSession(makeSession({ volumeVariance: null }));
      expect(result.breakdown.consistency).toBe(50);
    });
  });

  // -------------------------------------------------------------------------
  // Peak management scoring
  // -------------------------------------------------------------------------

  describe('peak management scoring', () => {
    it('should give 100 for no peaks', () => {
      const result = gradeSession(makeSession({ peakMoments: [] }));
      expect(result.breakdown.peakManagement).toBe(100);
    });

    it('should penalise high peak values', () => {
      const result = gradeSession(
        makeSession({
          peakMoments: [
            { timestamp: '2026-01-01T10:05:00.000Z', value: 95 },
          ],
        })
      );
      expect(result.breakdown.peakManagement).toBeLessThan(80);
    });

    it('should penalise more peaks', () => {
      const onePeak = gradeSession(
        makeSession({
          peakMoments: [
            { timestamp: '2026-01-01T10:05:00.000Z', value: 75 },
          ],
        })
      );
      const fivePeaks = gradeSession(
        makeSession({
          peakMoments: [
            { timestamp: '2026-01-01T10:05:00.000Z', value: 75 },
            { timestamp: '2026-01-01T10:10:00.000Z', value: 73 },
            { timestamp: '2026-01-01T10:15:00.000Z', value: 72 },
            { timestamp: '2026-01-01T10:20:00.000Z', value: 71 },
            { timestamp: '2026-01-01T10:25:00.000Z', value: 70 },
          ],
        })
      );
      expect(onePeak.breakdown.peakManagement).toBeGreaterThan(
        fivePeaks.breakdown.peakManagement
      );
    });
  });

  // -------------------------------------------------------------------------
  // Pace scoring
  // -------------------------------------------------------------------------

  describe('pace scoring', () => {
    it('should give 100 for ideal pace (4-8)', () => {
      for (const pace of [4, 6, 8]) {
        const result = gradeSession(makeSession({ speakingPace: pace }));
        expect(result.breakdown.pace).toBe(100);
      }
    });

    it('should penalise very low pace', () => {
      const result = gradeSession(makeSession({ speakingPace: 0 }));
      expect(result.breakdown.pace).toBe(0);
    });

    it('should penalise very high pace', () => {
      const result = gradeSession(makeSession({ speakingPace: 20 }));
      expect(result.breakdown.pace).toBe(0);
    });

    it('should give partial score for pace of 2', () => {
      const result = gradeSession(makeSession({ speakingPace: 2 }));
      expect(result.breakdown.pace).toBe(50);
    });

    it('should handle null pace gracefully', () => {
      const result = gradeSession(makeSession({ speakingPace: null }));
      expect(result.breakdown.pace).toBe(50);
    });
  });

  // -------------------------------------------------------------------------
  // Letter grade thresholds
  // -------------------------------------------------------------------------

  describe('getLetterGrade() — boundary values', () => {
    const cases = [
      [100, 'A+'],
      [95, 'A+'],
      [94.9, 'A'],
      [90, 'A'],
      [89.9, 'A-'],
      [85, 'A-'],
      [84.9, 'B+'],
      [80, 'B+'],
      [79.9, 'B'],
      [75, 'B'],
      [74.9, 'B-'],
      [70, 'B-'],
      [69.9, 'C+'],
      [65, 'C+'],
      [64.9, 'C'],
      [60, 'C'],
      [59.9, 'C-'],
      [55, 'C-'],
      [54.9, 'D'],
      [40, 'D'],
      [39.9, 'F'],
      [0, 'F'],
    ];

    for (const [score, expected] of cases) {
      it(`should return ${expected} for score ${score}`, () => {
        expect(getLetterGrade(score)).toBe(expected);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Archetypes
  // -------------------------------------------------------------------------

  describe('getArchetype()', () => {
    it('should return "The Whisperer" for mostly quiet sessions', () => {
      const session = makeSession({
        zoneTime: { silent: 600, quiet: 1000, normal: 200, loud: 0 },
        volumeVariance: 5,
      });
      expect(getArchetype(session)).toBe('The Whisperer');
    });

    it('should return "The Professional" for balanced normal sessions', () => {
      const session = makeSession({
        zoneTime: { silent: 100, quiet: 200, normal: 1400, loud: 100 },
        volumeVariance: 6,
      });
      expect(getArchetype(session)).toBe('The Professional');
    });

    it('should return "The Enthusiast" for loud with recovery', () => {
      const session = makeSession({
        zoneTime: { silent: 100, quiet: 200, normal: 800, loud: 400 },
        volumeVariance: 12,
      });
      expect(getArchetype(session)).toBe('The Enthusiast');
    });

    it('should return "The Megaphone" for consistently loud', () => {
      const session = makeSession({
        zoneTime: { silent: 0, quiet: 50, normal: 300, loud: 1450 },
        volumeVariance: 5,
      });
      expect(getArchetype(session)).toBe('The Megaphone');
    });

    it('should return "The Rollercoaster" for high variance', () => {
      const session = makeSession({
        zoneTime: { silent: 300, quiet: 300, normal: 600, loud: 600 },
        volumeVariance: 22,
      });
      expect(getArchetype(session)).toBe('The Rollercoaster');
    });
  });

  // -------------------------------------------------------------------------
  // Insights
  // -------------------------------------------------------------------------

  describe('getInsights()', () => {
    it('should return 2-4 insights', () => {
      const insights = getInsights(makeSession());
      expect(insights.length).toBeGreaterThanOrEqual(2);
      expect(insights.length).toBeLessThanOrEqual(4);
    });

    it('should return all strings', () => {
      const insights = getInsights(makeSession());
      for (const insight of insights) {
        expect(typeof insight).toBe('string');
        expect(insight.length).toBeGreaterThan(0);
      }
    });

    it('should mention comfortable volume for good sessions', () => {
      const session = makeSession({
        zoneTime: { silent: 50, quiet: 300, normal: 1400, loud: 50 },
      });
      const insights = getInsights(session);
      expect(insights.some((i) => i.includes('comfortable volume'))).toBe(
        true
      );
    });

    it('should mention loud zone for loud sessions', () => {
      const session = makeSession({
        zoneTime: { silent: 0, quiet: 0, normal: 200, loud: 1600 },
      });
      const insights = getInsights(session);
      expect(insights.some((i) => i.includes('loud'))).toBe(true);
    });

    it('should mention peaks above 80 dB', () => {
      const session = makeSession({
        peakMoments: [
          { timestamp: '2026-01-01T10:05:00.000Z', value: 88 },
          { timestamp: '2026-01-01T10:10:00.000Z', value: 82 },
        ],
      });
      const insights = getInsights(session);
      expect(insights.some((i) => i.includes('spiked above 80 dB'))).toBe(
        true
      );
    });

    it('should mention consistency for low variance', () => {
      const session = makeSession({ volumeVariance: 3 });
      const insights = getInsights(session);
      expect(insights.some((i) => i.includes('steady') || i.includes('consistency'))).toBe(
        true
      );
    });

    it('should produce at least 2 insights even for minimal sessions', () => {
      const session = makeSession({
        zoneTime: { silent: 0, quiet: 0, normal: 0, loud: 0 },
        peakMoments: [],
        volumeVariance: 10,
        speakingPace: 0,
        duration: 30,
      });
      const insights = getInsights(session);
      expect(insights.length).toBeGreaterThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------------
  // Hero stat
  // -------------------------------------------------------------------------

  describe('getHeroStat()', () => {
    it('should return label and value', () => {
      const stat = getHeroStat(makeSession());
      expect(stat).toHaveProperty('label');
      expect(stat).toHaveProperty('value');
      expect(typeof stat.label).toBe('string');
      expect(typeof stat.value).toBe('string');
    });

    it('should pick Perfect Volume for good sessions', () => {
      const session = makeSession({
        zoneTime: { silent: 0, quiet: 200, normal: 1600, loud: 0 },
      });
      const stat = getHeroStat(session);
      expect(stat.label).toBe('Perfect Volume');
      expect(stat.value).toBe('100%');
    });

    it('should pick Peak Volume for sessions with extreme peaks and little normal time', () => {
      const session = makeSession({
        zoneTime: { silent: 600, quiet: 400, normal: 100, loud: 700 },
        peakMoments: [
          { timestamp: '2026-01-01T10:05:00.000Z', value: 96 },
        ],
        duration: 120, // 2 min — not enough for session length priority
      });
      const stat = getHeroStat(session);
      // Peak is >85 so gets priority 2; normal time is <5 min so In the Zone gets priority 1
      expect(stat.label).toBe('Peak Volume');
      expect(stat.value).toBe('96 dB');
    });

    it('should return fallback for empty session', () => {
      const session = makeSession({
        zoneTime: { silent: 0, quiet: 0, normal: 0, loud: 0 },
        peakMoments: [],
        duration: 0,
      });
      const stat = getHeroStat(session);
      expect(stat.label).toBe('Session Tracked');
      expect(stat.value).toBe('Complete');
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should handle very short session', () => {
      const session = makeSession({
        duration: 5,
        zoneTime: { silent: 0, quiet: 1, normal: 4, loud: 0 },
        volumeSamples: [40, 42, 38],
        peakMoments: [],
        volumeVariance: 2,
        speakingPace: 3,
      });
      const result = gradeSession(session);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.letterGrade).toBeTruthy();
    });

    it('should handle all-quiet session', () => {
      const session = makeSession({
        zoneTime: { silent: 900, quiet: 900, normal: 0, loud: 0 },
        volumeVariance: 2,
        speakingPace: 0,
        peakMoments: [],
      });
      const result = gradeSession(session);
      expect(result.archetype).toBe('The Whisperer');
      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it('should handle all-loud session', () => {
      const session = makeSession({
        zoneTime: { silent: 0, quiet: 0, normal: 0, loud: 1800 },
        volumeVariance: 5,
        speakingPace: 2,
        peakMoments: [
          { timestamp: '2026-01-01T10:05:00.000Z', value: 92 },
        ],
      });
      const result = gradeSession(session);
      expect(result.archetype).toBe('The Megaphone');
      expect(result.letterGrade).not.toBe('A+');
    });

    it('should handle zero variance', () => {
      const session = makeSession({ volumeVariance: 0 });
      const result = gradeSession(session);
      expect(result.breakdown.consistency).toBe(100);
    });

    it('should handle missing optional fields gracefully', () => {
      const minimal = {
        zoneTime: { silent: 0, quiet: 0, normal: 100, loud: 0 },
      };
      const result = gradeSession(minimal);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.letterGrade).toBeTruthy();
      expect(result.insights.length).toBeGreaterThanOrEqual(2);
    });

    it('should clamp scores between 0 and 100', () => {
      // Extreme values that could cause overflow
      const session = makeSession({
        zoneTime: { silent: 0, quiet: 0, normal: 0, loud: 99999 },
        volumeVariance: 999,
        speakingPace: 999,
        peakMoments: [
          { timestamp: '2026-01-01T10:05:00.000Z', value: 200 },
          { timestamp: '2026-01-01T10:10:00.000Z', value: 195 },
          { timestamp: '2026-01-01T10:15:00.000Z', value: 190 },
          { timestamp: '2026-01-01T10:20:00.000Z', value: 185 },
          { timestamp: '2026-01-01T10:25:00.000Z', value: 180 },
        ],
      });
      const result = gradeSession(session);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      for (const key of Object.keys(result.breakdown)) {
        expect(result.breakdown[key]).toBeGreaterThanOrEqual(0);
        expect(result.breakdown[key]).toBeLessThanOrEqual(100);
      }
    });
  });
});
