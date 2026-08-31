import { z } from 'zod';
import { router, adminProcedure } from '../../_core/trpc';
import { TRPCError } from '@trpc/server';
import {
  cancelCampaign,
  createCampaign,
  excludeTarget,
  getCampaignProgress,
  listCampaigns,
  listTargets,
  markTargetFailed,
  pauseCampaign,
  reconcileCampaign,
  startCampaign,
} from '../../services/innov3-firmware';

function toError(error: unknown): TRPCError {
  const message = error instanceof Error ? error.message : '';
  if (message === 'CAMPAIGN_NOT_FOUND' || message === 'TARGET_NOT_FOUND') {
    return new TRPCError({ code: 'NOT_FOUND', message: 'Campaign or target not found.' });
  }
  if (message === 'DEVICE_NOT_FOUND') return new TRPCError({ code: 'NOT_FOUND', message: 'One or more target devices not found.' });
  if (message === 'NO_MATCHING_DEVICES') return new TRPCError({ code: 'BAD_REQUEST', message: 'No devices match the campaign filters.' });
  if (message.startsWith('INVALID_CAMPAIGN_STATE') || message.startsWith('INVALID_TARGET_STATE')) {
    return new TRPCError({ code: 'BAD_REQUEST', message: `Invalid state for this operation (${message.split(':')[1]}).` });
  }
  if (message === 'TARGET_VERSION_REQUIRED' || message === 'REASON_REQUIRED') {
    return new TRPCError({ code: 'BAD_REQUEST', message });
  }
  console.error('[FirmwareCampaigns]', error);
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Firmware campaign operation failed.' });
}

/**
 * Firmware campaign manager router (admin-only).
 *
 * A target is `applied` only when the device's own reported firmwareVersion
 * equals the expected version (reconcileCampaign), never because the
 * platform offered it. Devices that have never reported a version stay
 * pending with reportedVersion:null.
 */
export const firmwareCampaignsRouter = router({
  create: adminProcedure
    .input(z.object({
      name: z.string().min(1).max(255),
      model: z.string().max(255).optional(),
      fromVersion: z.string().max(50).optional(),
      targetVersion: z.string().min(1).max(50),
      deviceIds: z.array(z.number().int().positive()).max(500).optional(),
      notes: z.string().max(5000).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await createCampaign(ctx.user.id, input);
      } catch (error) {
        throw toError(error);
      }
    }),

  start: adminProcedure
    .input(z.object({ campaignId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      try {
        const campaign = await startCampaign(input.campaignId);
        return { success: true, campaign };
      } catch (error) {
        throw toError(error);
      }
    }),

  pause: adminProcedure
    .input(z.object({ campaignId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      try {
        const campaign = await pauseCampaign(input.campaignId);
        return { success: true, campaign };
      } catch (error) {
        throw toError(error);
      }
    }),

  cancel: adminProcedure
    .input(z.object({ campaignId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      try {
        const campaign = await cancelCampaign(input.campaignId);
        return { success: true, campaign };
      } catch (error) {
        throw toError(error);
      }
    }),

  /**
   * Re-read real device-reported versions for all open targets. This is the
   * only path (besides explicit operator failure) that moves targets.
   */
  reconcile: adminProcedure
    .input(z.object({ campaignId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      try {
        return await reconcileCampaign(input.campaignId);
      } catch (error) {
        throw toError(error);
      }
    }),

  markTargetFailed: adminProcedure
    .input(z.object({
      targetId: z.number().int().positive(),
      reason: z.string().min(1).max(2000),
    }))
    .mutation(async ({ input }) => {
      try {
        const target = await markTargetFailed(input.targetId, input.reason);
        return { success: true, target };
      } catch (error) {
        throw toError(error);
      }
    }),

  excludeTarget: adminProcedure
    .input(z.object({
      targetId: z.number().int().positive(),
      reason: z.string().min(1).max(2000),
    }))
    .mutation(async ({ input }) => {
      try {
        const target = await excludeTarget(input.targetId, input.reason);
        return { success: true, target };
      } catch (error) {
        throw toError(error);
      }
    }),

  progress: adminProcedure
    .input(z.object({ campaignId: z.number().int().positive() }))
    .query(async ({ input }) => {
      try {
        return await getCampaignProgress(input.campaignId);
      } catch (error) {
        throw toError(error);
      }
    }),

  list: adminProcedure
    .input(z.object({ limit: z.number().int().positive().max(200).default(50) }))
    .query(async ({ input }) => {
      try {
        const campaigns = await listCampaigns(input.limit);
        return { campaigns, count: campaigns.length };
      } catch (error) {
        throw toError(error);
      }
    }),

  listTargets: adminProcedure
    .input(z.object({ campaignId: z.number().int().positive() }))
    .query(async ({ input }) => {
      try {
        const targets = await listTargets(input.campaignId);
        return { targets, count: targets.length };
      } catch (error) {
        throw toError(error);
      }
    }),
});

export type FirmwareCampaignsRouter = typeof firmwareCampaignsRouter;
