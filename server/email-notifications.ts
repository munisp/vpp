import { notifyOwner } from './_core/notification';

/**
 * Email Notification Service
 * Sends email notifications using the built-in notification API
 */

export interface EmailNotification {
  to: string; // Email address or user ID
  subject: string;
  body: string;
  template?: string;
  data?: Record<string, any>;
}

export class EmailNotificationService {
  /**
   * Send a generic email notification
   */
  static async sendEmail(notification: EmailNotification): Promise<boolean> {
    try {
      // For now, use the owner notification API
      // In production, this would integrate with a proper email service
      const success = await notifyOwner({
        title: notification.subject,
        content: notification.body,
      });

      return success;
    } catch (error) {
      console.error('[EmailNotification] Failed to send email:', error);
      return false;
    }
  }

  /**
   * Send payment received notification
   */
  static async sendPaymentReceivedNotification(params: {
    userEmail: string;
    userName: string;
    amount: number;
    currency: string;
    transactionId: string;
    paymentMethod: string;
  }): Promise<boolean> {
    const body = `
Hello ${params.userName},

Your payment has been received successfully!

Payment Details:
- Amount: ${(params.amount / 100).toFixed(2)} ${params.currency}
- Payment Method: ${params.paymentMethod.replace('_', ' ').toUpperCase()}
- Transaction ID: ${params.transactionId}
- Date: ${new Date().toLocaleString()}

Thank you for using VPP Platform!

Best regards,
VPP Team
    `.trim();

    return await this.sendEmail({
      to: params.userEmail,
      subject: 'Payment Received - VPP Platform',
      body,
    });
  }

  /**
   * Send achievement unlocked notification
   */
  static async sendAchievementUnlockedNotification(params: {
    userEmail: string;
    userName: string;
    achievementName: string;
    achievementDescription: string;
    rewardPoints: number;
    badgeTier?: string;
  }): Promise<boolean> {
    const body = `
Hello ${params.userName},

Congratulations! You've unlocked a new achievement! 🏆

Achievement: ${params.achievementName}
${params.achievementDescription}

Rewards:
- Points: +${params.rewardPoints}
${params.badgeTier ? `- Badge: ${params.badgeTier.toUpperCase()}` : ''}

Keep up the great work and continue participating in demand response events!

Best regards,
VPP Team
    `.trim();

    return await this.sendEmail({
      to: params.userEmail,
      subject: `🏆 Achievement Unlocked: ${params.achievementName}`,
      body,
    });
  }

  /**
   * Send DR event reminder notification
   */
  static async sendDREventReminderNotification(params: {
    userEmail: string;
    userName: string;
    eventType: string;
    startTime: Date;
    endTime: Date;
    targetReduction: number;
    compensationRate: number;
    minutesUntilStart: number;
  }): Promise<boolean> {
    const body = `
Hello ${params.userName},

Reminder: A demand response event is starting ${params.minutesUntilStart === 30 ? 'in 30 minutes' : 'in 5 minutes'}!

Event Details:
- Type: ${params.eventType.replace('_', ' ').toUpperCase()}
- Start: ${params.startTime.toLocaleString()}
- End: ${params.endTime.toLocaleString()}
- Target Reduction: ${params.targetReduction} kW
- Compensation: ${(params.compensationRate / 100).toFixed(2)} TZS/kWh

Please ensure your systems are ready to participate.

Best regards,
VPP Team
    `.trim();

    return await this.sendEmail({
      to: params.userEmail,
      subject: `⚡ DR Event Starting ${params.minutesUntilStart === 30 ? 'in 30 Minutes' : 'Soon'}`,
      body,
    });
  }

  /**
   * Send leaderboard rank change notification
   */
  static async sendLeaderboardRankNotification(params: {
    userEmail: string;
    userName: string;
    period: string;
    newRank: number;
    oldRank: number;
    score: number;
    rewardAmount?: number;
  }): Promise<boolean> {
    const rankChange = params.oldRank - params.newRank;
    const isImprovement = rankChange > 0;

    const body = `
Hello ${params.userName},

Your leaderboard ranking has ${isImprovement ? 'improved' : 'changed'}!

${params.period.charAt(0).toUpperCase() + params.period.slice(1)} Leaderboard:
- New Rank: #${params.newRank} ${params.newRank <= 3 ? '🏆' : ''}
- Previous Rank: #${params.oldRank}
- Score: ${params.score}
${params.rewardAmount ? `\nCongratulations! You've earned a reward of ${(params.rewardAmount / 100).toFixed(2)} TZS!` : ''}

${isImprovement ? 'Great job! Keep up the excellent performance!' : 'Keep participating to improve your ranking!'}

Best regards,
VPP Team
    `.trim();

    return await this.sendEmail({
      to: params.userEmail,
      subject: `${isImprovement ? '📈' : '📊'} Leaderboard Update - Rank #${params.newRank}`,
      body,
    });
  }

  /**
   * Send payment discrepancy alert to admin
   */
  static async sendPaymentDiscrepancyAlert(params: {
    paymentId: number;
    transactionId: string;
    dbAmount: number;
    gatewayAmount: number;
    dbStatus: string;
    gatewayStatus: string;
    gateway: string;
  }): Promise<boolean> {
    const body = `
PAYMENT DISCREPANCY DETECTED

A payment discrepancy has been detected and requires attention.

Payment Details:
- Payment ID: ${params.paymentId}
- Transaction ID: ${params.transactionId}
- Gateway: ${params.gateway.toUpperCase()}

Discrepancy:
- Database Amount: ${(params.dbAmount / 100).toFixed(2)} TZS
- Gateway Amount: ${(params.gatewayAmount / 100).toFixed(2)} TZS
- Database Status: ${params.dbStatus}
- Gateway Status: ${params.gatewayStatus}

Please review and resolve this discrepancy in the reconciliation dashboard.

VPP Platform
    `.trim();

    return await this.sendEmail({
      to: 'admin@vpp.platform',
      subject: `⚠️ Payment Discrepancy Alert - Payment #${params.paymentId}`,
      body,
    });
  }

  /**
   * Send DR event created notification to participants
   */
  static async sendDREventCreatedNotification(params: {
    userEmail: string;
    userName: string;
    eventType: string;
    startTime: Date;
    endTime: Date;
    targetReduction: number;
    compensationRate: number;
  }): Promise<boolean> {
    const body = `
Hello ${params.userName},

A new demand response event has been scheduled!

Event Details:
- Type: ${params.eventType.replace('_', ' ').toUpperCase()}
- Start: ${params.startTime.toLocaleString()}
- End: ${params.endTime.toLocaleString()}
- Target Reduction: ${params.targetReduction} kW
- Compensation: ${(params.compensationRate / 100).toFixed(2)} TZS/kWh

You will receive reminders 30 minutes and 5 minutes before the event starts.

Best regards,
VPP Team
    `.trim();

    return await this.sendEmail({
      to: params.userEmail,
      subject: '📅 New DR Event Scheduled',
      body,
    });
  }

  /**
   * Send batch notifications
   */
  static async sendBatchNotifications(notifications: EmailNotification[]): Promise<{
    sent: number;
    failed: number;
  }> {
    let sent = 0;
    let failed = 0;

    for (const notification of notifications) {
      const success = await this.sendEmail(notification);
      if (success) {
        sent++;
      } else {
        failed++;
      }
    }

    return { sent, failed };
  }
}
