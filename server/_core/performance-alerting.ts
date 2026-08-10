/**
 * Performance Alerting System
 * 
 * Monitors performance metrics and sends alerts when thresholds are exceeded
 */

import { performanceMonitor } from './performance-monitoring';
import { notifyOwner } from './notification';
import { getDb } from '../db';
import { alerts as alertsTable, users } from '../../drizzle/schema';
import { desc, eq } from 'drizzle-orm';

export interface AlertThreshold {
  metric: 'api' | 'database' | 'external_api' | 'workflow';
  condition: 'p95_duration' | 'avg_duration' | 'success_rate' | 'error_count';
  operator: 'gt' | 'lt' | 'gte' | 'lte';
  value: number;
  severity: 'info' | 'warning' | 'critical';
  timeWindow: number; // minutes
}

export interface AlertConfig {
  enabled: boolean;
  thresholds: AlertThreshold[];
  cooldownPeriod: number; // minutes - prevent alert spam
  channels: ('email' | 'sms' | 'push')[];
}

interface AlertState {
  lastAlertTime: Map<string, Date>;
  activeAlerts: Map<string, Alert>;
}

interface Alert {
  id: string;
  threshold: AlertThreshold;
  value: number;
  message: string;
  timestamp: Date;
  acknowledged: boolean;
}

class PerformanceAlertingSystem {
  private config: AlertConfig;
  private state: AlertState;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Default configuration
    this.config = {
      enabled: true,
      cooldownPeriod: 15, // 15 minutes between same alerts
      channels: ['email'],
      thresholds: [
        // API Performance
        {
          metric: 'api',
          condition: 'p95_duration',
          operator: 'gt',
          value: 2000, // 2 seconds
          severity: 'warning',
          timeWindow: 5,
        },
        {
          metric: 'api',
          condition: 'success_rate',
          operator: 'lt',
          value: 95, // 95%
          severity: 'critical',
          timeWindow: 5,
        },
        
        // Database Performance
        {
          metric: 'database',
          condition: 'p95_duration',
          operator: 'gt',
          value: 1000, // 1 second
          severity: 'warning',
          timeWindow: 5,
        },
        {
          metric: 'database',
          condition: 'success_rate',
          operator: 'lt',
          value: 98, // 98%
          severity: 'critical',
          timeWindow: 5,
        },
        
        // External API Performance
        {
          metric: 'external_api',
          condition: 'p95_duration',
          operator: 'gt',
          value: 5000, // 5 seconds
          severity: 'warning',
          timeWindow: 5,
        },
        {
          metric: 'external_api',
          condition: 'success_rate',
          operator: 'lt',
          value: 90, // 90%
          severity: 'critical',
          timeWindow: 5,
        },
        
        // Workflow Performance
        {
          metric: 'workflow',
          condition: 'success_rate',
          operator: 'lt',
          value: 95, // 95%
          severity: 'critical',
          timeWindow: 10,
        },
      ],
    };

    this.state = {
      lastAlertTime: new Map(),
      activeAlerts: new Map(),
    };
  }

  /**
   * Start monitoring and alerting
   */
  start(checkIntervalMs: number = 60000): void {
    if (this.checkInterval) {
      console.warn('[Alerting] Already running');
      return;
    }

    console.log('[Alerting] Starting performance alerting system');
    
    // Initial check
    this.checkThresholds();
    
    // Schedule periodic checks
    this.checkInterval = setInterval(() => {
      this.checkThresholds();
    }, checkIntervalMs);
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      console.log('[Alerting] Stopped performance alerting system');
    }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<AlertConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };
    console.log('[Alerting] Configuration updated');
  }

  /**
   * Check all thresholds
   */
  private checkThresholds(): void {
    if (!this.config.enabled) return;

    for (const threshold of this.config.thresholds) {
      this.checkThreshold(threshold);
    }
  }

  /**
   * Check a single threshold
   */
  private checkThreshold(threshold: AlertThreshold): void {
    const stats = performanceMonitor.getStats({
      type: threshold.metric,
      timeWindow: threshold.timeWindow,
    });

    // Get the metric value
    let value: number;
    switch (threshold.condition) {
      case 'p95_duration':
        value = stats.p95Duration;
        break;
      case 'avg_duration':
        value = stats.avgDuration;
        break;
      case 'success_rate':
        value = stats.successRate;
        break;
      case 'error_count':
        value = stats.count - (stats.count * stats.successRate / 100);
        break;
      default:
        return;
    }

    // Check if threshold is breached
    const breached = this.evaluateCondition(value, threshold.operator, threshold.value);

    if (breached) {
      this.triggerAlert(threshold, value);
    } else {
      // Clear alert if it was active
      const alertKey = this.getAlertKey(threshold);
      if (this.state.activeAlerts.has(alertKey)) {
        this.clearAlert(alertKey);
      }
    }
  }

  /**
   * Evaluate condition
   */
  private evaluateCondition(value: number, operator: string, threshold: number): boolean {
    switch (operator) {
      case 'gt':
        return value > threshold;
      case 'lt':
        return value < threshold;
      case 'gte':
        return value >= threshold;
      case 'lte':
        return value <= threshold;
      default:
        return false;
    }
  }

  /**
   * Trigger an alert
   */
  private async triggerAlert(threshold: AlertThreshold, value: number): Promise<void> {
    const alertKey = this.getAlertKey(threshold);
    
    // Check cooldown period
    const lastAlertTime = this.state.lastAlertTime.get(alertKey);
    if (lastAlertTime) {
      const timeSinceLastAlert = Date.now() - lastAlertTime.getTime();
      const cooldownMs = this.config.cooldownPeriod * 60 * 1000;
      
      if (timeSinceLastAlert < cooldownMs) {
        // Still in cooldown period
        return;
      }
    }

    // Create alert
    const alert: Alert = {
      id: `${alertKey}-${Date.now()}`,
      threshold,
      value,
      message: this.formatAlertMessage(threshold, value),
      timestamp: new Date(),
      acknowledged: false,
    };

    // Store alert in memory
    this.state.activeAlerts.set(alertKey, alert);
    this.state.lastAlertTime.set(alertKey, new Date());

    console.warn('[Alerting] Alert triggered:', alert.message);

    // Persist alert lifecycle (fire-and-forget; failures are logged loudly)
    this.persistAlertEvent(alert, 'triggered').catch((error) =>
      console.error('[Alerting] Failed to persist triggered alert:', error)
    );

    // Send notifications
    await this.sendAlertNotifications(alert);
  }

  /**
   * Clear an alert
   */
  private clearAlert(alertKey: string): void {
    const alert = this.state.activeAlerts.get(alertKey);
    if (alert) {
      console.log('[Alerting] Alert cleared:', alert.message);
      this.state.activeAlerts.delete(alertKey);

      // Persist the clear event so history reflects the full lifecycle
      this.persistAlertEvent(alert, 'cleared').catch((error) =>
        console.error('[Alerting] Failed to persist cleared alert:', error)
      );
    }
  }

  /**
   * Persist an alert lifecycle event into the alerts table.
   *
   * Performance alerts are system-wide, so one history row is written per
   * admin user. The alert rule and event details are stored in the metadata
   * column as JSON. Throws on DB failure — callers decide how to handle it.
   */
  private async persistAlertEvent(alert: Alert, event: 'triggered' | 'acknowledged' | 'cleared'): Promise<void> {
    const db = await getDb();
    if (!db) {
      throw new Error('[Alerting] Database not available — alert event not persisted');
    }

    const admins = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'admin'));

    if (admins.length === 0) {
      console.warn('[Alerting] No admin users found — alert event has no recipient rows and was not persisted');
      return;
    }

    const metadata = JSON.stringify({
      alertId: alert.id,
      alertKey: this.getAlertKey(alert.threshold),
      event,
      metric: alert.threshold.metric,
      condition: alert.threshold.condition,
      operator: alert.threshold.operator,
      thresholdValue: alert.threshold.value,
      observedValue: alert.value,
      severity: alert.threshold.severity,
    });

    await db.insert(alertsTable).values(
      admins.map((admin) => ({
        userId: admin.id,
        alertType: 'system' as const,
        severity: (alert.threshold.severity === 'critical' ? 'critical' : alert.threshold.severity) as
          | 'info'
          | 'warning'
          | 'critical',
        title: `Performance Alert: ${alert.threshold.severity.toUpperCase()}`,
        message: alert.message,
        isRead: event === 'acknowledged',
        readAt: event === 'acknowledged' ? new Date() : null,
        metadata,
      }))
    );
  }

  /**
   * Format alert message
   */
  private formatAlertMessage(threshold: AlertThreshold, value: number): string {
    const metricName = threshold.metric.replace('_', ' ').toUpperCase();
    const conditionName = threshold.condition.replace('_', ' ');
    
    let formattedValue: string;
    let formattedThreshold: string;
    
    if (threshold.condition.includes('duration')) {
      formattedValue = `${Math.round(value)}ms`;
      formattedThreshold = `${threshold.value}ms`;
    } else if (threshold.condition === 'success_rate') {
      formattedValue = `${value.toFixed(1)}%`;
      formattedThreshold = `${threshold.value}%`;
    } else {
      formattedValue = value.toString();
      formattedThreshold = threshold.value.toString();
    }

    return `[${threshold.severity.toUpperCase()}] ${metricName} ${conditionName} is ${formattedValue} (threshold: ${formattedThreshold})`;
  }

  /**
   * Send alert notifications
   */
  private async sendAlertNotifications(alert: Alert): Promise<void> {
    const title = `Performance Alert: ${alert.threshold.severity.toUpperCase()}`;
    const content = alert.message;

    // Send to owner
    try {
      await notifyOwner({ title, content });
    } catch (error) {
      console.error('[Alerting] Failed to send owner notification:', error);
    }

    // TODO: Implement additional notification channels
    // - Email alerts
    // - SMS alerts
    // - Push notifications
    // - Webhook integrations (Slack, PagerDuty, etc.)
  }

  /**
   * Get alert key for deduplication
   */
  private getAlertKey(threshold: AlertThreshold): string {
    return `${threshold.metric}-${threshold.condition}-${threshold.operator}-${threshold.value}`;
  }

  /**
   * Get active alerts
   */
  getActiveAlerts(): Alert[] {
    return Array.from(this.state.activeAlerts.values());
  }

  /**
   * Acknowledge alert
   */
  acknowledgeAlert(alertId: string): boolean {
    const alerts = Array.from(this.state.activeAlerts.values());
    for (const alert of alerts) {
      if (alert.id === alertId) {
        alert.acknowledged = true;
        console.log('[Alerting] Alert acknowledged:', alertId);

        // Persist the acknowledgement into alert history
        this.persistAlertEvent(alert, 'acknowledged').catch((error) =>
          console.error('[Alerting] Failed to persist acknowledged alert:', error)
        );
        return true;
      }
    }
    return false;
  }

  /**
   * Get alert history from the persisted alerts table.
   * Returns real lifecycle rows (triggered/acknowledged/cleared events).
   * On database failure it logs loudly and returns an empty list — never
   * fabricated entries.
   */
  async getAlertHistory(limit: number = 100): Promise<Alert[]> {
    const db = await getDb();
    if (!db) {
      console.error('[Alerting] Database not available — cannot load alert history');
      return [];
    }

    try {
      const rows = await db
        .select()
        .from(alertsTable)
        .where(eq(alertsTable.alertType, 'system'))
        .orderBy(desc(alertsTable.createdAt))
        .limit(limit);

      const history: Alert[] = [];
      for (const row of rows) {
        let meta: any = null;
        try {
          meta = row.metadata ? JSON.parse(row.metadata) : null;
        } catch {
          console.warn(`[Alerting] Skipping alert row ${row.id} with unparseable metadata`);
          continue;
        }
        if (!meta || typeof meta.alertId !== 'string') continue;

        history.push({
          id: meta.alertId,
          threshold: {
            metric: meta.metric ?? 'api',
            condition: meta.condition ?? 'error_count',
            operator: meta.operator ?? 'gt',
            value: typeof meta.thresholdValue === 'number' ? meta.thresholdValue : 0,
            severity: meta.severity ?? row.severity,
            timeWindow: 5,
          },
          value: typeof meta.observedValue === 'number' ? meta.observedValue : 0,
          message: row.message,
          timestamp: row.createdAt,
          acknowledged: row.isRead,
        });
      }

      return history;
    } catch (error) {
      console.error('[Alerting] Failed to load alert history:', error);
      return [];
    }
  }
}

// Singleton instance
export const performanceAlerting = new PerformanceAlertingSystem();

// Auto-start in production
if (process.env.NODE_ENV === 'production') {
  performanceAlerting.start();
}
