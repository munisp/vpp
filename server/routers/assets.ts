import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import * as db from '../db';

const AssetTypeSchema = z.enum(['solar', 'battery', 'meter', 'generator', 'wind']);
const AssetStatusSchema = z.enum(['active', 'inactive', 'maintenance', 'fault']);

const RegisterAssetInputSchema = z.object({
  assetType: AssetTypeSchema,
  name: z.string().min(3, 'Asset name must be at least 3 characters long'),
  capacity: z.number().int().positive('Capacity must be a positive number'),
  make: z.string().optional(),
  model: z.string().optional(),
  serialNumber: z.string().optional(),
  installationDate: z.date().or(z.string().datetime()).optional(),
  metadata: z.string().optional(),
});

const UpdateAssetInputSchema = z.object({
  assetId: z.number().int().positive(),
  name: z.string().min(3).optional(),
  capacity: z.number().int().positive().optional(),
  make: z.string().optional(),
  model: z.string().optional(),
  status: AssetStatusSchema.optional(),
  metadata: z.string().optional(),
});

const DeleteAssetInputSchema = z.object({
  assetId: z.number().int().positive(),
});

export const assetsRouter = router({
  register: protectedProcedure
    .input(RegisterAssetInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const asset = await db.createAsset({
          userId: ctx.user.id,
          assetType: input.assetType,
          name: input.name,
          capacity: input.capacity,
          make: input.make,
          model: input.model,
          serialNumber: input.serialNumber,
          installationDate: input.installationDate ? new Date(input.installationDate) : undefined,
          metadata: input.metadata,
        });

        return {
          success: true,
          asset,
          message: `${input.assetType} asset '${input.name}' registered successfully.`,
        };
      } catch (error) {
        console.error('Error registering asset:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to register asset.',
        });
      }
    }),

  list: protectedProcedure.query(async ({ ctx }) => {
    try {
      const assets = await db.getUserAssets(ctx.user.id);
      return {
        assets,
        count: assets.length,
      };
    } catch (error) {
      console.error('Error listing assets:', error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to retrieve assets.',
      });
    }
  }),

  getById: protectedProcedure
    .input(z.object({ assetId: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      try {
        const asset = await db.getAssetById(input.assetId);
        
        if (!asset || asset.userId !== ctx.user.id) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Asset not found.',
          });
        }

        return asset;
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('Error getting asset:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve asset.',
        });
      }
    }),

  update: protectedProcedure
    .input(UpdateAssetInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const asset = await db.getAssetById(input.assetId);
        
        if (!asset || asset.userId !== ctx.user.id) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Asset not found.',
          });
        }

        const { assetId, ...updates } = input;
        const updatedAsset = await db.updateAsset(assetId, updates);

        return {
          success: true,
          asset: updatedAsset,
          message: 'Asset updated successfully.',
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('Error updating asset:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update asset.',
        });
      }
    }),

  delete: protectedProcedure
    .input(DeleteAssetInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const asset = await db.getAssetById(input.assetId);
        
        if (!asset || asset.userId !== ctx.user.id) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Asset not found.',
          });
        }

        await db.deleteAsset(input.assetId);

        return {
          success: true,
          message: 'Asset deleted successfully.',
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        console.error('Error deleting asset:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to delete asset.',
        });
      }
    }),
});

export type AssetsRouter = typeof assetsRouter;
