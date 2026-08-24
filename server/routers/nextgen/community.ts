import { z } from 'zod';
import { adminProcedure, protectedProcedure, router } from '../../_core/trpc';
import { communityEnergy } from '../../services/community-energy';
import {
  CRITICAL_LOAD_CATEGORIES,
  CRITICAL_LOAD_RATING_SOURCES,
  declareCriticalLoad,
  listCriticalLoads,
  updateCriticalLoad,
} from '../../services/critical-loads';

const criticalLoadCategory = z.enum(CRITICAL_LOAD_CATEGORIES);
const criticalLoadRatingSource = z.enum(CRITICAL_LOAD_RATING_SOURCES);

export const communityRouter = router({
  createCommunity: protectedProcedure
    .input(z.object({
      name: z.string(),
      description: z.string().optional(),
      communityType: z.enum(['residential', 'commercial', 'mixed', 'microgrid', 'virtual']),
      region: z.string().optional(),
      governanceModel: z.enum(['cooperative', 'utility_managed', 'peer_to_peer', 'hybrid']).default('cooperative'),
      allocationMethod: z.enum(['equal_share', 'proportional_capacity', 'proportional_consumption', 'dynamic_pricing', 'custom']).default('proportional_capacity'),
      canIsland: z.boolean().default(false),
    }))
    .mutation(async ({ input }) => {
      return communityEnergy.createCommunity(input);
    }),

  getCommunity: protectedProcedure
    .input(z.object({ communityId: z.number() }))
    .query(async ({ input }) => {
      return communityEnergy.getCommunity(input.communityId);
    }),

    addMember: protectedProcedure
      .input(z.object({
        communityId: z.number(),
        role: z.enum(['admin', 'operator', 'member', 'prosumer']).default('member'),
        contributedCapacityKw: z.number().optional(),
        sharePercentage: z.number().optional(),
        autoParticipate: z.boolean().optional(),
        priorityLevel: z.number().optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const { communityId, ...options } = input;
        return communityEnergy.addMember(communityId, ctx.user.id, options);
      }),

  getCommunityMembers: protectedProcedure
    .input(z.object({ communityId: z.number() }))
    .query(async ({ input }) => {
      return communityEnergy.getCommunityMembers(input.communityId);
    }),

  calculateAllocation: protectedProcedure
    .input(z.object({
      communityId: z.number(),
      periodStart: z.date(),
      periodEnd: z.date(),
    }))
    .mutation(async ({ input }) => {
      return communityEnergy.calculateAllocation(input.communityId, input.periodStart, input.periodEnd);
    }),

  getMicrogridStatus: protectedProcedure
    .input(z.object({ communityId: z.number() }))
    .query(async ({ input }) => {
      return communityEnergy.getMicrogridStatus(input.communityId);
    }),

  initiateIslanding: protectedProcedure
    .input(z.object({ communityId: z.number(), reason: z.string() }))
    .mutation(async ({ input }) => {
      return communityEnergy.initiateIslanding(input.communityId, input.reason);
    }),

  reconnectToGrid: protectedProcedure
    .input(z.object({ communityId: z.number() }))
    .mutation(async ({ input }) => {
      return communityEnergy.reconnectToGrid(input.communityId);
    }),

  /**
   * Operator-only confirmation that the physical switchgear transition for a
   * pending islanding/reconnection request has been performed on site. This
   * is the only path that actually changes islanding_mode.
   */
  confirmModeTransition: adminProcedure
    .input(z.object({
      communityId: z.number(),
      approve: z.boolean(),
    }))
    .mutation(async ({ input, ctx }) => {
      return communityEnergy.confirmModeTransition(input.communityId, ctx.user.id, input.approve);
    }),

  /**
   * The critical-load register. Reading it is open to members of the platform
   * (a resident may reasonably ask which loads their microgrid protects);
   * declaring or changing one is an operator action, because the register is
   * what the islanding gate and every resilience figure are computed from.
   */
  listCriticalLoads: protectedProcedure
    .input(z.object({ communityId: z.number(), includeInactive: z.boolean().default(false) }))
    .query(async ({ input }) => {
      return listCriticalLoads(input.communityId, { includeInactive: input.includeInactive });
    }),

  declareCriticalLoad: adminProcedure
    .input(z.object({
      communityId: z.number(),
      label: z.string().min(1).max(160),
      category: criticalLoadCategory,
      ratedPowerW: z.number().int().positive(),
      ratingSource: criticalLoadRatingSource,
      priority: z.number().int().min(1).max(99).default(1),
      assetId: z.number().int().positive().nullish(),
      autonomyTargetHours: z.number().int().positive().nullish(),
      notes: z.string().max(500).nullish(),
    }))
    .mutation(async ({ input, ctx }) => {
      return declareCriticalLoad(input, ctx.user.id);
    }),

  updateCriticalLoad: adminProcedure
    .input(z.object({
      id: z.number(),
      priority: z.number().int().min(1).max(99).optional(),
      ratedPowerW: z.number().int().positive().optional(),
      ratingSource: criticalLoadRatingSource.optional(),
      autonomyTargetHours: z.number().int().positive().nullable().optional(),
      assetId: z.number().int().positive().nullable().optional(),
      active: z.boolean().optional(),
      notes: z.string().max(500).nullable().optional(),
    }))
    .mutation(async ({ input }) => {
      const { id, ...patch } = input;
      return updateCriticalLoad(id, patch);
    }),

  getUserCommunities: protectedProcedure
    .query(async ({ ctx }) => {
      return communityEnergy.getUserCommunities(ctx.user.id);
    }),
});
