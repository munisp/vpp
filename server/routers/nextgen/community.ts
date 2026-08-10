import { z } from 'zod';
import { protectedProcedure, router } from '../../_core/trpc';
import { communityEnergy } from '../../services/community-energy';

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

  getUserCommunities: protectedProcedure
    .query(async ({ ctx }) => {
      return communityEnergy.getUserCommunities(ctx.user.id);
    }),
});
