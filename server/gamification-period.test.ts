/**
 * Pinning tests for P14 (gamification leaderboards and rewards):
 *  - A windowed leaderboard (daily/weekly/monthly) ranks by what happened
 *    INSIDE the window: the period score is the window's total reduction, not
 *    the all-time overallScore. Ranking a daily board by lifetime score handed
 *    the daily reward to the highest lifetime scorer every day.
 *  - disbursePeriodRewards surfaces earned rewards loudly as 'pending_rail'
 *    because the platform has no payout rail: rewardPaid stays false and
 *    nothing is credited, rather than a fake payout or a silent drop.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

type Row = Record<string, unknown>;

interface Captured {
  entries: Row[];
  updates: Row[];
}

function mockDb(opts: { scores: Row[]; responses: Row[]; leaderboard: Row[] }, captured: Captured) {
  const db = {
    select: (fields?: Row) => {
      if (fields && 'overallScore' in fields) {
        // participantScores read, ordered by overallScore desc
        return { from: () => ({ orderBy: async () => opts.scores }) };
      }
      if (fields && 'actualReduction' in fields) {
        // drResponses read inside the period window
        return { from: () => ({ where: async () => opts.responses }) };
      }
      // leaderboardEntries read (disbursePeriodRewards)
      return { from: () => ({ where: () => ({ orderBy: async () => opts.leaderboard }) }) };
    },
    delete: () => ({ where: async () => undefined }),
    insert: () => ({
      values: async (values: Row) => {
        captured.entries.push(values);
      },
    }),
    update: () => ({
      set: (values: Row) => ({
        where: async () => {
          captured.updates.push(values);
        },
      }),
    }),
  };
  vi.doMock('./db', () => ({ getDb: async () => db }));
}

const scores: Row[] = [
  // user 3 has the highest lifetime score but did nothing this period
  { userId: 3, overallScore: 1000, reliabilityScore: 99, totalEventsParticipated: 50, averageReduction: 20, totalCompensationEarned: 9000 },
  { userId: 1, overallScore: 900, reliabilityScore: 50, totalEventsParticipated: 10, averageReduction: 5, totalCompensationEarned: 1000 },
  { userId: 2, overallScore: 100, reliabilityScore: 90, totalEventsParticipated: 2, averageReduction: 1, totalCompensationEarned: 100 },
];

const periodResponses: Row[] = [
  { userId: 2, actualReduction: 10, compensation: 100 },
  { userId: 2, actualReduction: 10, compensation: 100 },
  { userId: 2, actualReduction: 10, compensation: 100 },
  { userId: 1, actualReduction: 5, compensation: 50 },
];

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('./db');
});

describe('windowed leaderboard ranks by period activity (P14)', () => {
  it('daily rank follows the window total reduction, not the all-time score', async () => {
    const captured: Captured = { entries: [], updates: [] };
    mockDb({ scores, responses: periodResponses, leaderboard: [] }, captured);
    const { GamificationEngine } = await import('./gamification');

    const created = await GamificationEngine.updateLeaderboard('daily');

    expect(created).toBe(2); // user 3 had no activity in the window
    expect(captured.entries[0]).toMatchObject({
      userId: 2, // 30 kW in the window beats user 1's 5 kW...
      rank: 1,
      score: 30, // ...and the entry score is the period score, not overallScore 900/1000
      eventsParticipated: 3,
      totalReduction: 30,
      compensationEarned: 300,
      reliabilityScore: 90,
      rewardAmount: 5000, // top daily reward
      rewardPaid: false,
    });
    expect(captured.entries[1]).toMatchObject({ userId: 1, rank: 2, score: 5, rewardAmount: 3000 });
  });

  it('all_time still ranks by accumulated overallScore and pays no reward', async () => {
    const captured: Captured = { entries: [], updates: [] };
    mockDb({ scores, responses: [], leaderboard: [] }, captured);
    const { GamificationEngine } = await import('./gamification');

    const created = await GamificationEngine.updateLeaderboard('all_time');

    expect(created).toBe(3);
    expect(captured.entries.map(e => [e.userId, e.score, e.rewardAmount])).toEqual([
      [3, 1000, 0],
      [1, 900, 0],
      [2, 100, 0],
    ]);
  });
});

describe('disbursePeriodRewards is loud about the missing payout rail (P14)', () => {
  it('surfaces earned rewards as pending_rail and marks nothing paid', async () => {
    const captured: Captured = { entries: [], updates: [] };
    const earned: Row[] = [
      { id: 11, userId: 2, rank: 1, rewardAmount: 5000, rewardPaid: false },
      { id: 12, userId: 1, rank: 2, rewardAmount: 3000, rewardPaid: false },
    ];
    mockDb({ scores: [], responses: [], leaderboard: earned }, captured);
    const { GamificationEngine } = await import('./gamification');

    const result = await GamificationEngine.disbursePeriodRewards('daily');

    expect(result.status).toBe('pending_rail');
    expect(result.reason).toMatch(/no reward payout rail/i);
    expect(result.awards).toEqual([
      { entryId: 11, userId: 2, rank: 1, rewardAmount: 5000, rewardPaid: false, status: 'pending_rail' },
      { entryId: 12, userId: 1, rank: 2, rewardAmount: 3000, rewardPaid: false, status: 'pending_rail' },
    ]);
    // No payout was faked: nothing was updated (rewardPaid stays false).
    expect(captured.updates).toHaveLength(0);
  });

  it('reports no_rewards when nothing was earned', async () => {
    const captured: Captured = { entries: [], updates: [] };
    mockDb({ scores: [], responses: [], leaderboard: [] }, captured);
    const { GamificationEngine } = await import('./gamification');

    const result = await GamificationEngine.disbursePeriodRewards('monthly');
    expect(result.status).toBe('no_rewards');
    expect(result.awards).toEqual([]);
  });
});
