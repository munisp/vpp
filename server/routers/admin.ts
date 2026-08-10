import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import * as db from '../db';
import { createAuditLog, getClientIP, getUserAgent } from '../_core/auditLog';

// Admin-only procedure that checks user role
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== 'admin') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Admin access required',
    });
  }
  return next({ ctx });
});

const UpdateUserStatusSchema = z.object({
  userId: z.number().int().positive(),
  role: z.enum(['user', 'admin']).optional(),
});

const ApproveAssetSchema = z.object({
  assetId: z.number().int().positive(),
  approved: z.boolean(),
});

const SetMarketPriceSchema = z.object({
  priceType: z.enum(['export', 'import']),
  price: z.number().int().positive(),
  effectiveFrom: z.date(),
});

export const adminRouter = router({
  // System overview statistics
  getSystemStats: adminProcedure.query(async () => {
    try {
      const db_instance = await db.getDb();
      if (!db_instance) throw new Error('Database not available');

      // Get total users
      const { users, assets } = await import('../../drizzle/schema');
      const usersList = await db_instance.select().from(users);
      const totalUsers = usersList.length;
      const activeUsers = usersList.filter((u: any) => {
        const lastSignIn = new Date(u.lastSignedIn);
        const daysSinceSignIn = (Date.now() - lastSignIn.getTime()) / (1000 * 60 * 60 * 24);
        return daysSinceSignIn <= 30;
      }).length;

      // Get total assets
      const allAssets = await db_instance.select().from(assets);
      const totalAssets = allAssets.length;
      const totalCapacity = allAssets.reduce((sum: number, asset: any) => sum + (asset.capacity || 0), 0);

      // Get payment statistics
      const { payments, trades } = await import('../../drizzle/schema');
      const allPayments = await db_instance.select().from(payments);
      const totalRevenue = allPayments
        .filter((p: any) => p.status === 'completed')
        .reduce((sum: number, p: any) => sum + p.amount, 0);
      const pendingPayments = allPayments.filter((p: any) => p.status === 'pending').length;

      // Get trading statistics
      const allTrades = await db_instance.select().from(trades);
      const totalTrades = allTrades.length;
      const totalEnergyTraded = allTrades.reduce((sum: number, t: any) => sum + t.energyKwh, 0);

      return {
        users: {
          total: totalUsers,
          active: activeUsers,
        },
        assets: {
          total: totalAssets,
          totalCapacity,
        },
        revenue: {
          total: totalRevenue,
          pendingPayments,
        },
        trading: {
          totalTrades,
          totalEnergyTraded,
        },
      };
    } catch (error) {
      console.error('Error getting system stats:', error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch system statistics',
      });
    }
  }),

  // Get all users with pagination
  getUsers: adminProcedure
    .input(z.object({
      page: z.number().int().positive().default(1),
      limit: z.number().int().positive().max(100).default(20),
    }))
    .query(async ({ input }) => {
      try {
      const db_instance = await db.getDb();
      if (!db_instance) throw new Error('Database not available');

      const { users } = await import('../../drizzle/schema');
      const offset = (input.page - 1) * input.limit;
      const usersList = await db_instance.select().from(users).limit(input.limit).offset(offset);
      const allUsers = await db_instance.select().from(users);
      const totalUsers = allUsers.length;

      return {
        users: usersList,
        pagination: {
            page: input.page,
            limit: input.limit,
            total: totalUsers,
            totalPages: Math.ceil(totalUsers / input.limit),
          },
        };
      } catch (error) {
        console.error('Error getting users:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to fetch users',
        });
      }
    }),

  // Update user role
  updateUserRole: adminProcedure
    .input(UpdateUserStatusSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const db_instance = await db.getDb();
        if (!db_instance) throw new Error('Database not available');

        const { users } = await import('../../drizzle/schema');
        const { eq } = await import('drizzle-orm');

        // Get user before update for audit log
        const [userBefore] = await db_instance.select().from(users).where(eq(users.id, input.userId)).limit(1);
        
        if (!userBefore) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'User not found',
          });
        }

        if (input.role) {
          await db_instance.update(users)
            .set({ role: input.role })
            .where(eq(users.id, input.userId));
          
          // Create audit log
          await createAuditLog({
            userId: ctx.user.id,
            userName: ctx.user.name || undefined,
            userRole: ctx.user.role,
            action: 'update',
            entityType: 'user',
            entityId: String(input.userId),
            entityName: userBefore.name || `User ${input.userId}`,
            changes: {
              role: { from: userBefore.role, to: input.role },
            },
            description: `Updated user role from ${userBefore.role} to ${input.role}`,
            ipAddress: getClientIP(ctx.req),
            userAgent: getUserAgent(ctx.req),
            status: 'success',
          });
        }

        return {
          success: true,
          message: 'User updated successfully',
        };
      } catch (error) {
        console.error('Error updating user:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update user',
        });
      }
    }),

  // Get all assets for approval
  getPendingAssets: adminProcedure.query(async () => {
    try {
      const db_instance = await db.getDb();
      if (!db_instance) throw new Error('Database not available');

      const { assets } = await import('../../drizzle/schema');
      const allAssets = await db_instance.select().from(assets);
      
      // In production, you would have an approval status field
      // For now, return all assets with user info
      const assetsWithUsers = await Promise.all(
        allAssets.map(async (asset: any) => {
          const user = await db.getUserByOpenId(String(asset.userId));
          return {
            ...asset,
            userName: user?.name || 'Unknown',
            userEmail: user?.email || 'Unknown',
          };
        })
      );

      return assetsWithUsers;
    } catch (error) {
      console.error('Error getting pending assets:', error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch pending assets',
      });
    }
  }),

  // Approve or reject asset
  approveAsset: adminProcedure
    .input(ApproveAssetSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        const db_instance = await db.getDb();
        if (!db_instance) throw new Error('Database not available');

        const { assets } = await import('../../drizzle/schema');
        const { eq } = await import('drizzle-orm');

        // Get asset details for audit log
        const [asset] = await db_instance.select().from(assets).where(eq(assets.id, input.assetId)).limit(1);
        
        if (!asset) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Asset not found',
          });
        }

        // In production, update asset approval status
        // For now, just create audit log
        await createAuditLog({
          userId: ctx.user.id,
          userName: ctx.user.name || undefined,
          userRole: ctx.user.role,
          action: input.approved ? 'approve' : 'reject',
          entityType: 'asset',
          entityId: String(input.assetId),
          entityName: asset.name,
          description: `${input.approved ? 'Approved' : 'Rejected'} asset: ${asset.name} (${asset.assetType})`,
          ipAddress: getClientIP(ctx.req),
          userAgent: getUserAgent(ctx.req),
          status: 'success',
        });
        
        return {
          success: true,
          message: input.approved ? 'Asset approved' : 'Asset rejected',
        };
      } catch (error) {
        console.error('Error approving asset:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to process asset approval',
        });
      }
    }),

  // Get market prices
  getMarketPrices: adminProcedure.query(async () => {
    try {
      // Check cache first
      const { redisCache } = await import('../services/redis-cache');
      const cached = await redisCache.getMarketPrice();
      if (cached) {
        return cached;
      }

      const db_instance = await db.getDb();
      if (!db_instance) throw new Error('Database not available');

      const { marketPrices } = await import('../../drizzle/schema');
      const prices = await db_instance.select().from(marketPrices).limit(50);
      
      // Cache the result
      await redisCache.cacheMarketPrice(prices);
      
      return prices;
    } catch (error) {
      console.error('Error getting market prices:', error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to fetch market prices',
      });
    }
  }),

  // Set market price
  setMarketPrice: adminProcedure
    .input(SetMarketPriceSchema)
    .mutation(async ({ input, ctx }) => {
      try {
        await db.insertMarketPrice({
          country: 'tanzania',
          priceType: input.priceType === 'export' ? 'peak' : 'off_peak',
          price: input.price,
          timestamp: input.effectiveFrom,
          validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
        });

        // Create audit log
        await createAuditLog({
          userId: ctx.user.id,
          userName: ctx.user.name || undefined,
          userRole: ctx.user.role,
          action: 'configure',
          entityType: 'market_price',
          entityId: `${input.priceType}-${input.effectiveFrom.toISOString()}`,
          entityName: `${input.priceType} price`,
          changes: {
            priceType: input.priceType,
            price: input.price,
            effectiveFrom: input.effectiveFrom.toISOString(),
          },
          description: `Set ${input.priceType} market price to ${input.price} TZS effective from ${input.effectiveFrom.toISOString()}`,
          ipAddress: getClientIP(ctx.req),
          userAgent: getUserAgent(ctx.req),
          status: 'success',
        });

        return {
          success: true,
          message: 'Market price updated successfully',
        };
      } catch (error) {
        console.error('Error setting market price:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update market price',
        });
      }
    }),

  // Get recent activity logs
  getActivityLogs: adminProcedure
    .input(z.object({
      limit: z.number().int().positive().max(100).default(50),
    }))
    .query(async ({ input }) => {
      try {
        const db_instance = await db.getDb();
        if (!db_instance) throw new Error('Database not available');

        // Get recent trades and payments
        const { trades, payments } = await import('../../drizzle/schema');
        const { desc } = await import('drizzle-orm');
        
        const recentTrades = await db_instance.select()
          .from(trades)
          .orderBy(desc(trades.createdAt))
          .limit(20);

        const recentPayments = await db_instance.select()
          .from(payments)
          .orderBy(desc(payments.createdAt))
          .limit(20);

        return {
          trades: recentTrades.slice(0, 20),
          payments: recentPayments.slice(0, 20),
        };
      } catch (error) {
        console.error('Error getting activity logs:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to fetch activity logs',
        });
      }
    }),
});
