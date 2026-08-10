import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { TRPCError } from '@trpc/server';
import { getDb } from '../db';
import { auditLogs } from '../../drizzle/schema';
import { desc, eq, and, like, gte, lte, sql } from 'drizzle-orm';

// Admin-only procedure
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== 'admin') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Admin access required',
    });
  }
  return next({ ctx });
});

export const auditLogsRouter = router({
  // List audit logs with filtering and pagination
  list: adminProcedure
    .input(
      z.object({
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(50),
        userId: z.number().optional(),
        action: z.enum([
          "create",
          "update",
          "delete",
          "approve",
          "reject",
          "suspend",
          "activate",
          "login",
          "logout",
          "payment",
          "trade",
          "export",
          "import",
          "configure"
        ]).optional(),
        entityType: z.enum([
          "user",
          "asset",
          "trade",
          "payment",
          "billing",
          "alert",
          "device",
          "dr_event",
          "market_price",
          "payment_credential",
          "system_config"
        ]).optional(),
        status: z.enum(["success", "failure", "pending"]).optional(),
        startDate: z.string().optional(), // ISO date string
        endDate: z.string().optional(),
        search: z.string().optional(), // Search in description, entityName, userName
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const { page, limit, userId, action, entityType, status, startDate, endDate, search } = input;
      const offset = (page - 1) * limit;

      // Build where conditions
      const conditions = [];
      
      if (userId) {
        conditions.push(eq(auditLogs.userId, userId));
      }
      
      if (action) {
        conditions.push(eq(auditLogs.action, action));
      }
      
      if (entityType) {
        conditions.push(eq(auditLogs.entityType, entityType));
      }
      
      if (status) {
        conditions.push(eq(auditLogs.status, status));
      }
      
      if (startDate) {
        conditions.push(gte(auditLogs.createdAt, new Date(startDate)));
      }
      
      if (endDate) {
        conditions.push(lte(auditLogs.createdAt, new Date(endDate)));
      }
      
      if (search) {
        const searchPattern = `%${search}%`;
        conditions.push(
          sql`(${auditLogs.description} LIKE ${searchPattern} OR ${auditLogs.entityName} LIKE ${searchPattern} OR ${auditLogs.userName} LIKE ${searchPattern})`
        );
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      // Get total count
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(auditLogs)
        .where(whereClause);

      // Get paginated results
      const logs = await db
        .select()
        .from(auditLogs)
        .where(whereClause)
        .orderBy(desc(auditLogs.createdAt))
        .limit(limit)
        .offset(offset);

      return {
        logs,
        pagination: {
          page,
          limit,
          total: count,
          totalPages: Math.ceil(count / limit),
        },
      };
    }),

  // Get single audit log by ID
  getById: adminProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const [log] = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.id, input.id))
        .limit(1);

      if (!log) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Audit log not found',
        });
      }

      return log;
    }),

  // Get audit logs for a specific entity
  getByEntity: adminProcedure
    .input(
      z.object({
        entityType: z.enum([
          "user",
          "asset",
          "trade",
          "payment",
          "billing",
          "alert",
          "device",
          "dr_event",
          "market_price",
          "payment_credential",
          "system_config"
        ]),
        entityId: z.string(),
        limit: z.number().min(1).max(100).default(20),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const logs = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, input.entityType),
            eq(auditLogs.entityId, input.entityId)
          )
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(input.limit);

      return logs;
    }),

  // Get audit statistics
  getStats: adminProcedure
    .input(
      z.object({
        startDate: z.string().optional(),
        endDate: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const conditions = [];
      
      if (input.startDate) {
        conditions.push(gte(auditLogs.createdAt, new Date(input.startDate)));
      }
      
      if (input.endDate) {
        conditions.push(lte(auditLogs.createdAt, new Date(input.endDate)));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      // Get action counts
      const actionCounts = await db
        .select({
          action: auditLogs.action,
          count: sql<number>`count(*)`,
        })
        .from(auditLogs)
        .where(whereClause)
        .groupBy(auditLogs.action);

      // Get entity type counts
      const entityCounts = await db
        .select({
          entityType: auditLogs.entityType,
          count: sql<number>`count(*)`,
        })
        .from(auditLogs)
        .where(whereClause)
        .groupBy(auditLogs.entityType);

      // Get status counts
      const statusCounts = await db
        .select({
          status: auditLogs.status,
          count: sql<number>`count(*)`,
        })
        .from(auditLogs)
        .where(whereClause)
        .groupBy(auditLogs.status);

      // Get total count
      const [{ total }] = await db
        .select({ total: sql<number>`count(*)` })
        .from(auditLogs)
        .where(whereClause);

      return {
        total,
        byAction: actionCounts,
        byEntityType: entityCounts,
        byStatus: statusCounts,
      };
    }),

  // Export audit logs to CSV
  export: adminProcedure
    .input(
      z.object({
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        action: z.string().optional(),
        entityType: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new Error('Database not available');

      const conditions = [];
      
      if (input.startDate) {
        conditions.push(gte(auditLogs.createdAt, new Date(input.startDate)));
      }
      
      if (input.endDate) {
        conditions.push(lte(auditLogs.createdAt, new Date(input.endDate)));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const logs = await db
        .select()
        .from(auditLogs)
        .where(whereClause)
        .orderBy(desc(auditLogs.createdAt))
        .limit(10000); // Limit to prevent memory issues

      // Convert to CSV format
      const headers = [
        'ID',
        'Timestamp',
        'User ID',
        'User Name',
        'Role',
        'Action',
        'Entity Type',
        'Entity ID',
        'Entity Name',
        'Description',
        'Status',
        'IP Address',
      ];

      const rows = logs.map((log) => [
        log.id,
        log.createdAt.toISOString(),
        log.userId,
        log.userName || '',
        log.userRole,
        log.action,
        log.entityType,
        log.entityId || '',
        log.entityName || '',
        log.description || '',
        log.status,
        log.ipAddress || '',
      ]);

      const csv = [headers, ...rows].map((row) => row.map((cell) => `"${cell}"`).join(',')).join('\n');

      return {
        csv,
        filename: `audit-logs-${new Date().toISOString().split('T')[0]}.csv`,
        count: logs.length,
      };
    }),
});
