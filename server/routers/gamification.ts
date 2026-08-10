import { z } from 'zod';
import { router, protectedProcedure, publicProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import { GamificationEngine } from '../gamification';
import { getDb } from '../db';
import { users } from '../../drizzle/schema';
import { eq, inArray } from 'drizzle-orm';

/**
 * Admin-only procedure
 */
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== 'admin') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Admin access required',
    });
  }
  return next({ ctx });
});

/**
 * Gamification Router
 */
export const gamificationRouter = router({
  /**
   * Get user's achievements
   */
  getMyAchievements: protectedProcedure.query(async ({ ctx }) => {
    return await GamificationEngine.getUserAchievements(ctx.user.id);
  }),

  /**
   * Check and unlock new achievements
   */
  checkAchievements: protectedProcedure.mutation(async ({ ctx }) => {
    const newlyUnlocked = await GamificationEngine.checkAchievements(ctx.user.id);
    return { newlyUnlocked };
  }),

  /**
   * Get leaderboard
   */
  getLeaderboard: publicProcedure
    .input(
      z.object({
        period: z.enum(['daily', 'weekly', 'monthly', 'all_time']),
        limit: z.number().default(100),
      })
    )
    .query(async ({ input }) => {
      const entries = await GamificationEngine.getLeaderboard(input.period, input.limit);

      // Get user details for leaderboard
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const userIds = entries.map(e => e.userId);
      const userDetails = await db
        .select({
          id: users.id,
          name: users.name,
        })
        .from(users)
        .where(inArray(users.id, userIds));

      const userMap = new Map(userDetails.map(u => [u.id, u]));

      return entries.map(entry => ({
        ...entry,
        userName: userMap.get(entry.userId)?.name || 'Anonymous',
      }));
    }),

  /**
   * Get user's rank
   */
  getMyRank: protectedProcedure
    .input(z.object({ period: z.enum(['daily', 'weekly', 'monthly', 'all_time']) }))
    .query(async ({ input, ctx }) => {
      return await GamificationEngine.getUserRank(ctx.user.id, input.period);
    }),

  /**
   * Update leaderboard (admin only)
   */
  updateLeaderboard: adminProcedure
    .input(z.object({ period: z.enum(['daily', 'weekly', 'monthly', 'all_time']) }))
    .mutation(async ({ input }) => {
      const count = await GamificationEngine.updateLeaderboard(input.period);
      return { entriesCreated: count };
    }),

  /**
   * Initialize default achievements (admin only)
   */
  initializeAchievements: adminProcedure.mutation(async () => {
    await GamificationEngine.initializeDefaultAchievements();
    return { success: true };
  }),
});
