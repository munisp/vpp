import { z } from 'zod';
import { adminProcedure, protectedProcedure, router } from '../../_core/trpc';
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
    .mutation(async ({ input, ctx }) => {
      return communityEnergy.createCommunity(input, ctx.user.id);
    }),

  getCommunity: protectedProcedure
    .input(z.object({ communityId: z.number() }))
    .query(async ({ input }) => {
      return communityEnergy.getCommunity(input.communityId);
    }),

  /**
   * Ask to join a community. The request is recorded pending, and neither the
   * role nor the share is the applicant's to choose: a self-declared `admin`
   * would govern a community that never admitted them, and a self-declared
   * share would take allocation money from the members who earned it.
   */
  addMember: protectedProcedure
    .input(z.object({
      communityId: z.number(),
      autoParticipate: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      return communityEnergy.addMember(input.communityId, ctx.user.id, {
        role: 'member',
        autoParticipate: input.autoParticipate,
      });
    }),

  /** Admit a pending applicant, as one of the community's own admins. */
  approveMember: protectedProcedure
    .input(z.object({ memberId: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      return communityEnergy.approveMember(
        input.memberId,
        ctx.user.id,
        ctx.user.role === 'admin'
      );
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

  getUserCommunities: protectedProcedure
    .query(async ({ ctx }) => {
      return communityEnergy.getUserCommunities(ctx.user.id);
    }),
});
