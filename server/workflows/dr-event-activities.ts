/**
 * Temporal DR Event Activities
 * 
 * Activity implementations for DR event workflows
 */

export interface DREventActivityInput {
  type: 'peak_reduction' | 'emergency' | 'scheduled';
  startTime: Date;
  endTime: Date;
  targetReduction: number;
  compensationRate: number;
}

export interface EnrollParticipantsInput {
  eventId: number;
  autoEnroll: boolean;
  eligibilityCriteria?: {
    minAssetCapacity?: number;
    minReliabilityScore?: number;
    segments?: string[];
  };
}

export interface SendDRNotificationsInput {
  eventId: number;
  type: 'enrollment_confirmation' | 'event_started' | 'event_completed' | 'event_cancelled';
  participantIds: number[];
  metadata?: Record<string, any>;
}

export interface MonitorDRParticipationInput {
  eventId: number;
  startTime: Date;
  endTime: Date;
  targetReduction: number;
}

export interface CalculateDRPerformanceInput {
  eventId: number;
  participantIds: number[];
}

export interface AwardDRCompensationInput {
  eventId: number;
  performances: Array<{
    userId: number;
    actualReduction: number;
    performanceScore: number;
  }>;
  compensationRate: number;
}

/**
 * Create DR Event Activity
 */
export async function createDREventActivity(
  input: DREventActivityInput
): Promise<{ success: boolean; eventId?: number; error?: string }> {
  try {
    // Import database helpers
    const { getDb } = await import('../db');
    const { demandResponseEvents } = await import('../../drizzle/schema');

    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.insert(demandResponseEvents).values({
      operatorId: 1, // System operator
      eventName: `${input.type} DR Event`,
      eventType: input.type === 'peak_reduction' ? 'peak_shaving' : input.type === 'emergency' ? 'emergency' : 'economic',
      startTime: input.startTime,
      endTime: input.endTime,
      targetReduction: input.targetReduction,
      compensationRate: input.compensationRate,
      status: 'scheduled',
    });

    const eventId = result[0]?.insertId;
    if (!eventId) throw new Error('Failed to get event ID');

    console.log(`[DREventActivity] Created DR event ${eventId}`);
    return { success: true, eventId };
  } catch (error) {
    console.error('[DREventActivity] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Enroll Participants Activity
 */
export async function enrollParticipantsActivity(
  input: EnrollParticipantsInput
): Promise<{ success: boolean; participantCount?: number; participantIds?: number[]; error?: string }> {
  try {
    const { getDb } = await import('../db');
    const { drParticipants, users, assets } = await import('../../drizzle/schema');
    const { eq, and, gte } = await import('drizzle-orm');

    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Get eligible users based on criteria
    let eligibleUsers = await db.select({ id: users.id }).from(users);

    // Filter by asset capacity if specified
    if (input.eligibilityCriteria?.minAssetCapacity) {
      const usersWithAssets = await db
        .select({ userId: assets.userId })
        .from(assets)
        .where(
          and(
            eq(assets.status, 'active'),
            gte(assets.capacity, input.eligibilityCriteria.minAssetCapacity)
          )
        );
      
      const userIds = new Set(usersWithAssets.map(u => u.userId));
      eligibleUsers = eligibleUsers.filter(u => userIds.has(u.id));
    }

    // Enroll participants
    const participantIds: number[] = [];
    for (const user of eligibleUsers) {
      const result = await db.insert(drParticipants).values({
        userId: user.id,
        status: 'active',
        autoOptIn: input.autoEnroll,
      });

      if (result[0]?.insertId) {
        participantIds.push(user.id);
      }
    }

    console.log(`[EnrollParticipantsActivity] Enrolled ${participantIds.length} participants for event ${input.eventId}`);
    return {
      success: true,
      participantCount: participantIds.length,
      participantIds,
    };
  } catch (error) {
    console.error('[EnrollParticipantsActivity] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Send DR Notifications Activity
 * Production-ready with real push notification sending
 */
export async function sendDRNotificationsActivity(
  input: SendDRNotificationsInput
): Promise<{ success: boolean; sentCount?: number; error?: string }> {
  try {
    const { sendPushNotification } = await import('../_core/sendNotification');
    const { getDb } = await import('../db');
    const { demandResponseEvents, alerts } = await import('../../drizzle/schema');
    const { eq } = await import('drizzle-orm');

    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Get event details
    const events = await db.select().from(demandResponseEvents).where(eq(demandResponseEvents.id, input.eventId));
    const event = events[0];
    if (!event) throw new Error('Event not found');

    let sentCount = 0;
    let errorCount = 0;

    // Send notifications to all participants
    const notificationPromises = input.participantIds.map(async (userId) => {
      let title = '';
      let body = '';
      let notificationType: 'pushDREventCreated' | 'pushDREventReminder' | 'pushSystemAlert' = 'pushDREventCreated';

      switch (input.type) {
        case 'enrollment_confirmation':
          title = 'DR Event Enrollment Confirmed';
          body = `You're enrolled in a ${event.eventType} event starting at ${event.startTime.toLocaleString()}`;
          notificationType = 'pushDREventCreated';
          break;
        case 'event_started':
          title = 'DR Event Started';
          body = `The DR event has started. Target reduction: ${event.targetReduction} kW`;
          notificationType = 'pushDREventReminder';
          break;
        case 'event_completed':
          title = 'DR Event Completed';
          body = `The DR event has ended. Check your compensation in the app.`;
          notificationType = 'pushDREventReminder';
          break;
        case 'event_cancelled':
          title = 'DR Event Cancelled';
          body = `The DR event has been cancelled. ${input.metadata?.reason || ''}`;
          notificationType = 'pushSystemAlert';
          break;
      }

      try {
        // Send real push notification
        const result = await sendPushNotification(
          userId,
          {
            title,
            body,
            data: {
              type: 'dr_event',
              eventId: input.eventId,
              notificationType: input.type,
            },
          },
          notificationType
        );

        if (result.sentCount > 0) {
          sentCount += result.sentCount;
        }

        // Also create an in-app alert record for users without push subscriptions
        await db.insert(alerts).values({
          userId,
          alertType: 'system', // Use 'system' for DR event notifications
          severity: input.type === 'event_cancelled' ? 'warning' : 'info',
          title,
          message: body,
          metadata: JSON.stringify({
            eventId: input.eventId,
            notificationType: input.type,
            category: 'dr_event',
          }),
          createdAt: new Date(),
        });

        console.log(`[DRNotification] Sent to user ${userId}: ${title}`);
      } catch (error) {
        errorCount++;
        console.error(`[DRNotification] Failed to send to user ${userId}:`, error);
        // Don't throw - continue sending to other users
      }
    });

    await Promise.all(notificationPromises);

    console.log(`[SendDRNotificationsActivity] Sent ${sentCount} push notifications, ${errorCount} errors for event ${input.eventId}`);
    return { success: true, sentCount };
  } catch (error) {
    console.error('[SendDRNotificationsActivity] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Monitor DR Participation Activity
 */
export async function monitorDRParticipationActivity(
  input: MonitorDRParticipationInput
): Promise<{ success: boolean; error?: string }> {
  try {
    // This would monitor real-time telemetry during the event
    // For now, it's a placeholder
    console.log(`[MonitorDRParticipationActivity] Monitoring event ${input.eventId}`);
    return { success: true };
  } catch (error) {
    console.error('[MonitorDRParticipationActivity] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Calculate DR Performance Activity
 */
export async function calculateDRPerformanceActivity(
  input: CalculateDRPerformanceInput
): Promise<{
  success: boolean;
  performances?: Array<{ userId: number; actualReduction: number; performanceScore: number }>;
  totalReduction?: number;
  error?: string;
}> {
  try {
    const { getDb } = await import('../db');
    const { drResponses } = await import('../../drizzle/schema');
    const { eq } = await import('drizzle-orm');

    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const performances: Array<{ userId: number; actualReduction: number; performanceScore: number }> = [];
    let totalReduction = 0;

    for (const userId of input.participantIds) {
      // Get user's DR response
      const responses = await db
        .select()
        .from(drResponses)
        .where(eq(drResponses.eventId, input.eventId));

      const userResponse = responses.find(r => r.userId === userId);
      if (userResponse && userResponse.actualReduction) {
        const actualReduction = userResponse.actualReduction;
        const baselineConsumption = userResponse.targetReduction || 0;
        const performanceScore = baselineConsumption > 0 ? Math.min(100, (actualReduction / baselineConsumption) * 100) : 0;

        performances.push({
          userId,
          actualReduction,
          performanceScore,
        });

        totalReduction += actualReduction;
      }
    }

    console.log(`[CalculateDRPerformanceActivity] Calculated performance for ${performances.length} participants`);
    return {
      success: true,
      performances,
      totalReduction,
    };
  } catch (error) {
    console.error('[CalculateDRPerformanceActivity] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Award DR Compensation Activity
 */
export async function awardDRCompensationActivity(
  input: AwardDRCompensationInput
): Promise<{ success: boolean; totalCompensation?: number; error?: string }> {
  try {
    const { getDb } = await import('../db');
    const { drCompensation } = await import('../../drizzle/schema');

    const db = await getDb();
    if (!db) throw new Error('Database not available');

    let totalCompensation = 0;

    for (const performance of input.performances) {
      const compensation = performance.actualReduction * input.compensationRate;
      
      await db.insert(drCompensation).values({
        userId: performance.userId,
        eventId: input.eventId,
        responseId: 0, // Would need to fetch from drResponses
        amount: Math.round(compensation * 100), // Convert to cents
        currency: 'USD',
        paymentMethod: 'mpesa',
        status: 'pending',
      });

      totalCompensation += compensation;
    }

    console.log(`[AwardDRCompensationActivity] Awarded ${totalCompensation} in compensation for event ${input.eventId}`);
    return {
      success: true,
      totalCompensation,
    };
  } catch (error) {
    console.error('[AwardDRCompensationActivity] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Update DR Event Status Activity
 */
export async function updateDREventStatusActivity(
  eventId: number,
  status: 'scheduled' | 'active' | 'completed' | 'cancelled'
): Promise<{ success: boolean; error?: string }> {
  try {
    const { getDb } = await import('../db');
    const { demandResponseEvents } = await import('../../drizzle/schema');
    const { eq } = await import('drizzle-orm');

    const db = await getDb();
    if (!db) throw new Error('Database not available');

    await db.update(demandResponseEvents).set({ status }).where(eq(demandResponseEvents.id, eventId));

    console.log(`[UpdateDREventStatusActivity] Updated event ${eventId} status to ${status}`);
    return { success: true };
  } catch (error) {
    console.error('[UpdateDREventStatusActivity] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
