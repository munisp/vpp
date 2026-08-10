/**
 * DR Automation Engine
 * 
 * Automatically triggers DR events based on rules and conditions
 */

import { getDb } from './db';
import {
  drAutomationRules,
  drEventTemplates,
  gridMonitoring,
  demandResponseEvents,
  drResponses,
  drCompensation,
  alerts,
  users,
} from '../drizzle/schema';
import { eq, and, desc, gte, lte, sql } from 'drizzle-orm';
import { createDREvent } from './dr-db';

/**
 * Evaluate all automation rules
 */
export async function evaluateAutomationRules(): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.warn('[DR Automation] Database not available');
    return;
  }

  // Get all enabled rules
  const rules = await db
    .select()
    .from(drAutomationRules)
    .where(eq(drAutomationRules.isEnabled, 'true'))
    .orderBy(desc(drAutomationRules.priority));

  console.log(`[DR Automation] Evaluating ${rules.length} rules`);

  for (const rule of rules) {
    try {
      await evaluateRule(rule);
    } catch (error) {
      console.error(`[DR Automation] Error evaluating rule ${rule.id}:`, error);
    }
  }
}

/**
 * Evaluate a single automation rule
 */
async function evaluateRule(rule: any): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // Check cooldown period
  if (rule.lastTriggered) {
    const cooldownEnd = new Date(rule.lastTriggered);
    cooldownEnd.setMinutes(cooldownEnd.getMinutes() + rule.cooldownMinutes);
    
    if (new Date() < cooldownEnd) {
      console.log(`[DR Automation] Rule ${rule.id} in cooldown period`);
      return;
    }
  }

  // Check time constraints
  const now = new Date();
  const currentHour = now.getHours();
  const currentDay = now.getDay();

  if (rule.activeHoursStart !== null && rule.activeHoursEnd !== null) {
    if (currentHour < rule.activeHoursStart || currentHour > rule.activeHoursEnd) {
      return;
    }
  }

  if (rule.activeDays) {
    const activeDays = JSON.parse(rule.activeDays);
    if (!activeDays.includes(currentDay)) {
      return;
    }
  }

  // Get current grid conditions
  const latestGrid = await db
    .select()
    .from(gridMonitoring)
    .orderBy(desc(gridMonitoring.timestamp))
    .limit(1);

  if (latestGrid.length === 0) {
    console.log(`[DR Automation] No grid data available`);
    return;
  }

  const gridData = latestGrid[0];

  // Evaluate condition
  const shouldTrigger = evaluateCondition(rule, gridData);

  if (shouldTrigger) {
    console.log(`[DR Automation] Rule ${rule.id} triggered!`);
    await triggerEvent(rule);
  }
}

/**
 * Evaluate rule condition against grid data
 */
function evaluateCondition(rule: any, gridData: any): boolean {
  let value: number;

  // Get value based on condition type
  switch (rule.condition) {
    case 'load_threshold':
      value = gridData.totalLoad;
      break;
    case 'price_threshold':
      value = gridData.spotPrice || 0;
      break;
    case 'grid_frequency':
      value = gridData.frequency;
      break;
    case 'renewable_percentage':
      value = gridData.renewablePercentage;
      break;
    case 'time_based':
      // Time-based rules are handled in evaluateRule
      return true;
    default:
      return false;
  }

  // Apply operator
  switch (rule.operator) {
    case 'greater_than':
      return value > rule.threshold;
    case 'less_than':
      return value < rule.threshold;
    case 'equals':
      return value === rule.threshold;
    case 'between':
      return value >= rule.threshold && value <= (rule.thresholdMax || rule.threshold);
    default:
      return false;
  }
}

/**
 * Trigger a DR event from a rule
 */
async function triggerEvent(rule: any): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // Get event template
  const template = await db
    .select()
    .from(drEventTemplates)
    .where(eq(drEventTemplates.id, rule.templateId))
    .limit(1);

  if (template.length === 0) {
    console.error(`[DR Automation] Template ${rule.templateId} not found`);
    return;
  }

  const tmpl = template[0];

  // Calculate event times
  const now = new Date();
  const startTime = new Date(now.getTime() + tmpl.advanceNoticeMinutes * 60 * 1000);
  const endTime = new Date(startTime.getTime() + tmpl.defaultDuration * 60 * 1000);

  // Create DR event
  await createDREvent({
    operatorId: 1, // System operator
    eventName: `${tmpl.name} (Auto)`,
    eventType: tmpl.eventType,
    startTime,
    endTime,
    targetReduction: tmpl.defaultTargetReduction,
    compensationRate: tmpl.defaultCompensationRate,
    status: 'scheduled',
    metadata: JSON.stringify({
      triggeredBy: 'automation',
      ruleId: rule.id,
      ruleName: rule.name,
      templateId: tmpl.id,
    }),
  });

  // Update rule last triggered time
  await db
    .update(drAutomationRules)
    .set({ lastTriggered: now })
    .where(eq(drAutomationRules.id, rule.id));

  console.log(`[DR Automation] Created event from rule ${rule.id}`);
}

/**
 * Check for events that should start now
 */
export async function checkScheduledEvents(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const now = new Date();

  // Find scheduled events that should start
  const events = await db
    .select()
    .from(demandResponseEvents)
    .where(
      and(
        eq(demandResponseEvents.status, 'scheduled'),
        lte(demandResponseEvents.startTime, now)
      )
    );

  for (const event of events) {
    // Update status to active
    await db
      .update(demandResponseEvents)
      .set({ status: 'active' })
      .where(eq(demandResponseEvents.id, event.id));

    console.log(`[DR Automation] Event ${event.id} started`);
    
    // Send notifications to participants
    await sendEventNotifications(event.id, 'event_started', {
      eventName: event.eventName,
      eventType: event.eventType,
      targetReduction: event.targetReduction,
      compensationRate: event.compensationRate,
      endTime: event.endTime,
    });
  }
}

/**
 * Check for events that should end now
 */
export async function checkActiveEvents(): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const now = new Date();

  // Find active events that should end
  const events = await db
    .select()
    .from(demandResponseEvents)
    .where(
      and(
        eq(demandResponseEvents.status, 'active'),
        lte(demandResponseEvents.endTime, now)
      )
    );

  for (const event of events) {
    // Calculate total actual reduction from participant responses
    const actualReduction = await calculateEventReduction(event.id);
    
    // Update status to completed with actual reduction
    await db
      .update(demandResponseEvents)
      .set({ 
        status: 'completed',
        actualReduction,
      })
      .where(eq(demandResponseEvents.id, event.id));

    console.log(`[DR Automation] Event ${event.id} completed with ${actualReduction}kW reduction`);
    
    // Calculate and distribute compensation to participants
    await calculateAndDistributeCompensation(event.id, event.compensationRate);
    
    // Send completion notifications
    await sendEventNotifications(event.id, 'event_completed', {
      eventName: event.eventName,
      actualReduction,
      compensationRate: event.compensationRate,
    });
  }
}

/**
 * Main automation loop - run every minute
 */
export async function runAutomationLoop(): Promise<void> {
  console.log('[DR Automation] Running automation loop');
  
  try {
    // Evaluate automation rules
    await evaluateAutomationRules();
    
    // Check for scheduled events to start
    await checkScheduledEvents();
    
    // Check for active events to end
    await checkActiveEvents();
  } catch (error) {
    console.error('[DR Automation] Error in automation loop:', error);
  }
}

/**
 * Start automation scheduler (run every minute)
 */
export function startAutomationScheduler(): void {
  console.log('[DR Automation] Starting automation scheduler');
  
  // Run immediately
  runAutomationLoop();
  
  // Then run every minute
  setInterval(runAutomationLoop, 60 * 1000);
}

/**
 * Calculate total actual reduction for an event from participant responses
 */
async function calculateEventReduction(eventId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  try {
    // Get all participant responses for this event
    const responses = await db
      .select()
      .from(drResponses)
      .where(eq(drResponses.eventId, eventId));

    // Sum up actual reductions from participants who participated
    let totalReduction = 0;
    for (const response of responses) {
      if (response.participationStatus === 'opted_in' && response.actualReduction) {
        totalReduction += response.actualReduction;
      }
    }

    return totalReduction;
  } catch (error) {
    console.error('[DR Automation] Error calculating event reduction:', error);
    return 0;
  }
}

/**
 * Calculate and distribute compensation to event participants
 */
async function calculateAndDistributeCompensation(
  eventId: number,
  compensationRate: number
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  try {
    // Get all participant responses for this event
    const responses = await db
      .select()
      .from(drResponses)
      .where(eq(drResponses.eventId, eventId));

    for (const response of responses) {
      if (response.participationStatus === 'opted_in' && response.actualReduction) {
        // Calculate compensation: reduction (kW) * rate (cents/kWh) * duration (assumed 1 hour)
        const compensationAmount = Math.round(response.actualReduction * compensationRate);

        // Create compensation record
        await db.insert(drCompensation).values({
          eventId,
          userId: response.userId,
          responseId: response.id,
          amount: compensationAmount,
          currency: 'TZS',
          status: 'pending',
          metadata: JSON.stringify({
            actualReduction: response.actualReduction,
            compensationRate,
            calculatedAt: new Date().toISOString(),
          }),
        });

        console.log(`[DR Automation] Created compensation of ${compensationAmount} for user ${response.userId}`);
      }
    }
  } catch (error) {
    console.error('[DR Automation] Error distributing compensation:', error);
  }
}

/**
 * Send notifications to event participants
 */
async function sendEventNotifications(
  eventId: number,
  notificationType: 'event_started' | 'event_completed' | 'event_cancelled',
  eventData: Record<string, unknown>
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  try {
    // Get all participant responses for this event
    const responses = await db
      .select()
      .from(drResponses)
      .where(eq(drResponses.eventId, eventId));

    // Get unique user IDs
    const userIds = Array.from(new Set(responses.map(r => r.userId)));

    // Create notification for each participant
    for (const userId of userIds) {
      let title: string;
      let message: string;
      let severity: 'info' | 'warning' | 'error' | 'critical' = 'info';

      switch (notificationType) {
        case 'event_started':
          title = 'DR Event Started';
          message = `Demand Response event "${eventData.eventName}" has started. Target reduction: ${eventData.targetReduction}kW. Compensation rate: ${eventData.compensationRate} cents/kWh.`;
          severity = 'warning';
          break;
        case 'event_completed':
          title = 'DR Event Completed';
          message = `Demand Response event "${eventData.eventName}" has completed. Total reduction achieved: ${eventData.actualReduction}kW. Your compensation will be processed shortly.`;
          severity = 'info';
          break;
        case 'event_cancelled':
          title = 'DR Event Cancelled';
          message = `Demand Response event "${eventData.eventName}" has been cancelled.`;
          severity = 'info';
          break;
      }

      await db.insert(alerts).values({
        userId,
        alertType: 'system',
        severity,
        title,
        message,
        isRead: false,
        metadata: JSON.stringify({
          eventId,
          notificationType,
          ...eventData,
        }),
      });

      console.log(`[DR Automation] Sent ${notificationType} notification to user ${userId}`);
    }
  } catch (error) {
    console.error('[DR Automation] Error sending notifications:', error);
  }
}
