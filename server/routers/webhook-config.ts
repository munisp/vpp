import { z } from 'zod';
import { adminProcedure, router } from '../_core/trpc';
import { webhookNotificationService } from '../services/webhook-notifications';

export const webhookConfigRouter = router({
  /**
   * Get current webhook configuration
   */
  getConfig: adminProcedure.query(async () => {
    return {
      webhookUrl: webhookNotificationService.getWebhookUrl(),
      configured: webhookNotificationService.getWebhookUrl() !== 'Not configured',
    };
  }),

  /**
   * Test webhook connection
   */
  testWebhook: adminProcedure.mutation(async () => {
    const result = await webhookNotificationService.testConnection();
    return result;
  }),

  /**
   * Send test notification
   */
  sendTestNotification: adminProcedure
    .input(z.object({
      type: z.enum(['dr_event', 'grid_stress', 'system_alert']),
    }))
    .mutation(async ({ input }) => {
      let success = false;

      switch (input.type) {
        case 'dr_event':
          success = await webhookNotificationService.notifyDREventTriggered({
            eventId: 999,
            eventName: 'Test DR Event',
            targetReduction: 100,
            startTime: new Date(),
            endTime: new Date(Date.now() + 3600000),
            reason: 'Test notification from admin panel',
          });
          break;

        case 'grid_stress':
          success = await webhookNotificationService.notifyGridStress({
            loadLevel: 85,
            frequency: 49.9,
            voltage: 230,
            temperature: 32,
            severity: 'medium',
          });
          break;

        case 'system_alert':
          success = await webhookNotificationService.notifySystemAlert({
            title: 'Test System Alert',
            message: 'This is a test alert from the admin panel',
            severity: 'info',
          });
          break;
      }

      return {
        success,
        message: success
          ? `Test ${input.type} notification sent successfully`
          : `Failed to send test ${input.type} notification`,
      };
    }),
});
