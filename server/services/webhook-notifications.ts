/**
 * Webhook Notification Service
 * 
 * Sends alerts to configured webhook URLs for critical events:
 * - DR event triggers
 * - Grid stress detection
 * - System alerts
 */

import { ENV } from '../_core/env';

export interface WebhookPayload {
  event: string;
  severity: 'info' | 'warning' | 'critical';
  timestamp: string;
  data: Record<string, any>;
  source: string;
}

class WebhookNotificationService {
  private webhookUrl: string | undefined;

  constructor() {
    this.webhookUrl = ENV.alertWebhookUrl;
  }

  /**
   * Send notification to webhook
   */
  async send(payload: WebhookPayload): Promise<boolean> {
    if (!this.webhookUrl) {
      console.log('[Webhook] No webhook URL configured, skipping notification');
      return false;
    }

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.error(`[Webhook] Failed to send notification: ${response.statusText}`);
        return false;
      }

      console.log(`[Webhook] Notification sent successfully: ${payload.event}`);
      return true;
    } catch (error: any) {
      console.error('[Webhook] Error sending notification:', error);
      return false;
    }
  }

  /**
   * Send DR event trigger notification
   */
  async notifyDREventTriggered(eventData: {
    eventId: number;
    eventName: string;
    targetReduction: number;
    startTime: Date;
    endTime: Date;
    reason: string;
  }): Promise<boolean> {
    return this.send({
      event: 'dr_event_triggered',
      severity: 'warning',
      timestamp: new Date().toISOString(),
      source: 'vpp_platform',
      data: {
        event_id: eventData.eventId,
        event_name: eventData.eventName,
        target_reduction_kw: eventData.targetReduction,
        start_time: eventData.startTime.toISOString(),
        end_time: eventData.endTime.toISOString(),
        reason: eventData.reason,
      },
    });
  }

  /**
   * Send grid stress detection notification
   */
  async notifyGridStress(stressData: {
    loadLevel: number;
    frequency: number;
    voltage: number;
    temperature: number;
    severity: 'low' | 'medium' | 'high';
  }): Promise<boolean> {
    const severityMap = {
      low: 'info' as const,
      medium: 'warning' as const,
      high: 'critical' as const,
    };

    return this.send({
      event: 'grid_stress_detected',
      severity: severityMap[stressData.severity],
      timestamp: new Date().toISOString(),
      source: 'vpp_platform',
      data: {
        load_level_percent: stressData.loadLevel,
        frequency_hz: stressData.frequency,
        voltage_v: stressData.voltage,
        temperature_c: stressData.temperature,
        severity: stressData.severity,
      },
    });
  }

  /**
   * Send system alert notification
   */
  async notifySystemAlert(alertData: {
    title: string;
    message: string;
    severity: 'info' | 'warning' | 'critical';
    metadata?: Record<string, any>;
  }): Promise<boolean> {
    return this.send({
      event: 'system_alert',
      severity: alertData.severity,
      timestamp: new Date().toISOString(),
      source: 'vpp_platform',
      data: {
        title: alertData.title,
        message: alertData.message,
        ...alertData.metadata,
      },
    });
  }

  /**
   * Test webhook connection
   */
  async testConnection(): Promise<{ success: boolean; message: string }> {
    if (!this.webhookUrl) {
      return {
        success: false,
        message: 'No webhook URL configured',
      };
    }

    const success = await this.send({
      event: 'webhook_test',
      severity: 'info',
      timestamp: new Date().toISOString(),
      source: 'vpp_platform',
      data: {
        message: 'This is a test notification from VPP Platform',
      },
    });

    return {
      success,
      message: success
        ? 'Webhook test successful'
        : 'Webhook test failed - check URL and connectivity',
    };
  }

  /**
   * Update webhook URL
   */
  setWebhookUrl(url: string | undefined): void {
    this.webhookUrl = url;
  }

  /**
   * Get current webhook URL (masked for security)
   */
  getWebhookUrl(): string {
    if (!this.webhookUrl) {
      return 'Not configured';
    }
    
    try {
      const url = new URL(this.webhookUrl);
      return `${url.protocol}//${url.host}/***`;
    } catch {
      return 'Invalid URL';
    }
  }
}

// Export singleton instance
export const webhookNotificationService = new WebhookNotificationService();
