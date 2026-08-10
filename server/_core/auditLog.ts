import { getDb } from '../db';
import { auditLogs, InsertAuditLog } from '../../drizzle/schema';

interface AuditLogParams {
  userId: number;
  userName?: string;
  userRole: 'user' | 'admin';
  action: InsertAuditLog['action'];
  entityType: InsertAuditLog['entityType'];
  entityId?: string;
  entityName?: string;
  changes?: Record<string, any>;
  description?: string;
  ipAddress?: string;
  userAgent?: string;
  status?: 'success' | 'failure' | 'pending';
  errorMessage?: string;
}

/**
 * Create an audit log entry for tracking admin and critical user actions
 */
export async function createAuditLog(params: AuditLogParams): Promise<void> {
  try {
    const db = await getDb();
    if (!db) {
      console.warn('[AuditLog] Database not available, skipping audit log');
      return;
    }

    const logEntry: InsertAuditLog = {
      userId: params.userId,
      userName: params.userName,
      userRole: params.userRole,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      entityName: params.entityName,
      changes: params.changes ? JSON.stringify(params.changes) : undefined,
      description: params.description,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
      status: params.status || 'success',
      errorMessage: params.errorMessage,
    };

    await db.insert(auditLogs).values(logEntry);
    
    console.log('[AuditLog] Created:', {
      user: params.userName || params.userId,
      action: params.action,
      entity: `${params.entityType}:${params.entityId || 'N/A'}`,
    });
  } catch (error) {
    console.error('[AuditLog] Failed to create audit log:', error);
    // Don't throw - audit logging should not break the main flow
  }
}

/**
 * Helper to extract IP address from request
 */
export function getClientIP(req: any): string | undefined {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress
  );
}

/**
 * Helper to get user agent from request
 */
export function getUserAgent(req: any): string | undefined {
  return req.headers['user-agent'];
}
