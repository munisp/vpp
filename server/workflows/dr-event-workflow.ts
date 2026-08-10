/**
 * Temporal DR Event Workflow
 * 
 * Orchestrates demand response events from creation to completion,
 * including participant enrollment, monitoring, and compensation.
 */

import {
  createDREventActivity,
  enrollParticipantsActivity,
  sendDRNotificationsActivity,
  monitorDRParticipationActivity,
  calculateDRPerformanceActivity,
  awardDRCompensationActivity,
  updateDREventStatusActivity,
  DREventActivityInput,
} from './dr-event-activities';

/**
 * DR Event Workflow Input
 */
export interface DREventWorkflowInput {
  type: 'peak_reduction' | 'emergency' | 'scheduled';
  startTime: Date;
  endTime: Date;
  targetReduction: number; // kW
  compensationRate: number; // per kWh
  autoEnroll?: boolean;
  eligibilityCriteria?: {
    minAssetCapacity?: number;
    minReliabilityScore?: number;
    segments?: string[];
  };
}

export interface DREventWorkflowResult {
  success: boolean;
  eventId?: number;
  participantCount?: number;
  totalReduction?: number;
  totalCompensation?: number;
  error?: string;
}

/**
 * Main DR Event Workflow
 * 
 * Orchestrates the complete DR event lifecycle:
 * 1. Create event in database
 * 2. Enroll eligible participants
 * 3. Send notifications
 * 4. Monitor participation during event
 * 5. Calculate performance and award compensation
 */
export async function drEventWorkflow(
  input: DREventWorkflowInput
): Promise<DREventWorkflowResult> {
  let eventId: number | undefined;

  try {
    // Step 1: Create DR event
    const createResult = await createDREventActivity({
      type: input.type,
      startTime: input.startTime,
      endTime: input.endTime,
      targetReduction: input.targetReduction,
      compensationRate: input.compensationRate,
    });

    if (!createResult.success || !createResult.eventId) {
      throw new Error(createResult.error || 'Failed to create DR event');
    }

    eventId = createResult.eventId;

    // Step 2: Enroll participants
    const enrollResult = await enrollParticipantsActivity({
      eventId,
      autoEnroll: input.autoEnroll || false,
      eligibilityCriteria: input.eligibilityCriteria,
    });

    if (!enrollResult.success) {
      throw new Error(enrollResult.error || 'Failed to enroll participants');
    }

    const participantCount = enrollResult.participantCount || 0;

    // Step 3: Send notifications to enrolled participants
    await sendDRNotificationsActivity({
      eventId,
      type: 'enrollment_confirmation',
      participantIds: enrollResult.participantIds || [],
    });

    // Step 4: Wait until event start time
    const now = new Date();
    const startTime = new Date(input.startTime);
    if (startTime > now) {
      const waitMs = startTime.getTime() - now.getTime();
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    // Step 5: Update event status to active
    await updateDREventStatusActivity(eventId, 'active');

    // Step 6: Send event start notifications
    await sendDRNotificationsActivity({
      eventId,
      type: 'event_started',
      participantIds: enrollResult.participantIds || [],
    });

    // Step 7: Monitor participation during event
    const monitorResult = await monitorDRParticipationActivity({
      eventId,
      startTime: input.startTime,
      endTime: input.endTime,
      targetReduction: input.targetReduction,
    });

    // Step 8: Wait until event end time
    const endTime = new Date(input.endTime);
    const nowAfterStart = new Date();
    if (endTime > nowAfterStart) {
      const waitMs = endTime.getTime() - nowAfterStart.getTime();
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    // Step 9: Calculate performance for all participants
    const performanceResult = await calculateDRPerformanceActivity({
      eventId,
      participantIds: enrollResult.participantIds || [],
    });

    if (!performanceResult.success) {
      throw new Error(performanceResult.error || 'Failed to calculate performance');
    }

    // Step 10: Award compensation
    const compensationResult = await awardDRCompensationActivity({
      eventId,
      performances: performanceResult.performances || [],
      compensationRate: input.compensationRate,
    });

    // Step 11: Update event status to completed
    await updateDREventStatusActivity(eventId, 'completed');

    // Step 12: Send completion notifications with compensation details
    await sendDRNotificationsActivity({
      eventId,
      type: 'event_completed',
      participantIds: enrollResult.participantIds || [],
    });

    return {
      success: true,
      eventId,
      participantCount,
      totalReduction: performanceResult.totalReduction,
      totalCompensation: compensationResult.totalCompensation,
    };
  } catch (error) {
    console.error('[DREventWorkflow] Error:', error);

    // Compensation: Mark event as cancelled
    if (eventId) {
      await updateDREventStatusActivity(eventId, 'cancelled');
    }

    return {
      success: false,
      eventId,
      error: error instanceof Error ? error.message : 'DR event workflow failed',
    };
  }
}

/**
 * DR Event Cancellation Workflow
 * 
 * Handles cancellation of scheduled DR events
 */
export async function cancelDREventWorkflow(
  eventId: number,
  reason: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Update event status to cancelled
    await updateDREventStatusActivity(eventId, 'cancelled');

    // Get enrolled participants
    // (This would need a new activity to fetch participants)
    
    // Send cancellation notifications
    await sendDRNotificationsActivity({
      eventId,
      type: 'event_cancelled',
      participantIds: [], // Would be populated from database
      metadata: { reason },
    });

    return { success: true };
  } catch (error) {
    console.error('[CancelDREventWorkflow] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Cancellation workflow failed',
    };
  }
}

/**
 * Automated DR Event Forecasting Workflow
 * 
 * Uses ML forecasting to automatically create DR events
 * when grid stress is predicted
 */
export async function drForecastingWorkflow(input: {
  forecastHorizon: number; // hours
  gridStressThreshold: number; // percentage
}): Promise<{ success: boolean; eventsCreated: number; error?: string }> {
  try {
    // This would integrate with the forecasting service
    // For now, it's a placeholder for the workflow structure
    
    // Step 1: Run forecasting model
    // const forecast = await runForecastingActivity(input.forecastHorizon);
    
    // Step 2: Identify peak periods
    // const peaks = await identifyPeakPeriodsActivity(forecast, input.gridStressThreshold);
    
    // Step 3: Create DR events for each peak
    let eventsCreated = 0;
    // for (const peak of peaks) {
    //   const result = await drEventWorkflow({
    //     type: 'scheduled',
    //     startTime: peak.startTime,
    //     endTime: peak.endTime,
    //     targetReduction: peak.recommendedReduction,
    //     compensationRate: peak.dynamicRate,
    //     autoEnroll: true,
    //   });
    //   if (result.success) eventsCreated++;
    // }

    return { success: true, eventsCreated };
  } catch (error) {
    console.error('[DRForecastingWorkflow] Error:', error);
    return {
      success: false,
      eventsCreated: 0,
      error: error instanceof Error ? error.message : 'Forecasting workflow failed',
    };
  }
}

/**
 * Workflow Configuration
 */
export const DR_WORKFLOW_CONFIG = {
  taskQueue: 'dr-orchestration',
  workflowId: (eventId: number) => `dr-event-${eventId}`,
  retryPolicy: {
    initialInterval: '1s',
    backoffCoefficient: 2,
    maximumInterval: '60s',
    maximumAttempts: 3,
  },
  workflowExecutionTimeout: '24h', // DR events can be long
  workflowRunTimeout: '12h',
  workflowTaskTimeout: '1m',
};
