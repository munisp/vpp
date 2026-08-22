/**
 * Demand Response Automation Service
 * 
 * Automatically triggers DR events based on grid stress conditions,
 * enrolls participants, and calculates real-time compensation
 */

import { getDb } from '../db';
import { demandResponseEvents, drParticipants, drResponses, users, assets } from '../../drizzle/schema';
import { eq, and, gte, lte, sql, desc } from 'drizzle-orm';
import { redisCache } from './redis-cache';
import { webhookNotificationService } from './webhook-notifications';

export interface GridStressConditions {
  loadLevel: number; // Percentage of grid capacity (0-100)
  frequency: number; // Grid frequency in Hz
  voltage: number; // Grid voltage in V
  temperature: number; // Ambient temperature in Celsius
  timestamp: Date;
}

export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  conditions: {
    minLoadLevel?: number;
    maxFrequency?: number;
    minFrequency?: number;
    minTemperature?: number;
    timeOfDay?: { start: string; end: string };
  };
  eventConfig: {
    targetReduction: number; // kW
    duration: number; // minutes
    baselineCompensation: number; // TZS per kWh
    performanceBonus: number; // Additional % for high performers
  };
  participantCriteria: {
    minReliabilityScore?: number;
    minCapacity?: number;
    segments?: string[];
  };
}

class DRAutomationService {
  private automationRules: AutomationRule[] = [];

  constructor() {
    this.initializeDefaultRules();
  }

  /**
   * Initialize default automation rules
   */
  private initializeDefaultRules() {
    this.automationRules = [
      {
        id: 'peak-demand',
        name: 'Peak Demand Response',
        enabled: true,
        conditions: {
          minLoadLevel: 85,
          timeOfDay: { start: '17:00', end: '21:00' },
        },
        eventConfig: {
          targetReduction: 500,
          duration: 120,
          baselineCompensation: 150,
          performanceBonus: 20,
        },
        participantCriteria: {
          minReliabilityScore: 70,
          minCapacity: 5,
        },
      },
      {
        id: 'frequency-deviation',
        name: 'Grid Frequency Stabilization',
        enabled: true,
        conditions: {
          maxFrequency: 49.8,
          minFrequency: 50.2,
        },
        eventConfig: {
          targetReduction: 300,
          duration: 30,
          baselineCompensation: 200,
          performanceBonus: 30,
        },
        participantCriteria: {
          minReliabilityScore: 80,
          segments: ['high_performer', 'reliable'],
        },
      },
      {
        id: 'heat-wave',
        name: 'Heat Wave Load Reduction',
        enabled: true,
        conditions: {
          minTemperature: 35,
          minLoadLevel: 75,
        },
        eventConfig: {
          targetReduction: 400,
          duration: 180,
          baselineCompensation: 120,
          performanceBonus: 15,
        },
        participantCriteria: {
          minReliabilityScore: 60,
        },
      },
    ];
  }

  /**
   * Check grid conditions and trigger DR events if needed
   */
  async checkAndTriggerEvents(conditions: GridStressConditions): Promise<number[]> {
    const triggeredEventIds: number[] = [];

    // Cache grid status
    await redisCache.cacheGridStatus(conditions);

    // Send grid stress notification
    const severity = conditions.loadLevel >= 90 ? 'high' : conditions.loadLevel >= 80 ? 'medium' : 'low';
    await webhookNotificationService.notifyGridStress({
      loadLevel: conditions.loadLevel,
      frequency: conditions.frequency,
      voltage: conditions.voltage,
      temperature: conditions.temperature,
      severity,
    });

    for (const rule of this.automationRules) {
      if (!rule.enabled) continue;

      if (this.shouldTriggerEvent(rule, conditions)) {
        console.log(`[DR Automation] Triggering event for rule: ${rule.name}`);
        
        try {
          const eventId = await this.createAutomatedEvent(rule, conditions);
          triggeredEventIds.push(eventId);
        } catch (error) {
          console.error(`[DR Automation] Failed to create event for rule ${rule.id}:`, error);
        }
      }
    }

    return triggeredEventIds;
  }

  /**
   * Check if conditions match rule criteria
   */
  private shouldTriggerEvent(rule: AutomationRule, conditions: GridStressConditions): boolean {
    const { conditions: ruleCond } = rule;

    // Check load level
    if (ruleCond.minLoadLevel && conditions.loadLevel < ruleCond.minLoadLevel) {
      return false;
    }

    // Check frequency
    if (ruleCond.maxFrequency && conditions.frequency > ruleCond.maxFrequency) {
      return false;
    }
    if (ruleCond.minFrequency && conditions.frequency < ruleCond.minFrequency) {
      return false;
    }

    // Check temperature
    if (ruleCond.minTemperature && conditions.temperature < ruleCond.minTemperature) {
      return false;
    }

    // Check time of day
    if (ruleCond.timeOfDay) {
      const now = new Date();
      const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
      if (currentTime < ruleCond.timeOfDay.start || currentTime > ruleCond.timeOfDay.end) {
        return false;
      }
    }

    return true;
  }

  /**
   * Create automated DR event
   */
  private async createAutomatedEvent(rule: AutomationRule, conditions: GridStressConditions): Promise<number> {
    const db = await getDb();
    if (!db) {
      throw new Error('Database not available');
    }

    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + rule.eventConfig.duration * 60000);

    // Create event
    const result = await db.insert(demandResponseEvents).values({
      operatorId: 1, // System operator
      eventName: `Auto: ${rule.name}`,
      eventType: 'emergency',
      startTime,
      endTime,
      targetReduction: rule.eventConfig.targetReduction,
      compensationRate: rule.eventConfig.baselineCompensation,
      status: 'active',
      metadata: JSON.stringify({
        automated: true,
        ruleId: rule.id,
        gridConditions: conditions,
        performanceBonus: rule.eventConfig.performanceBonus,
      }),
    });

    const eventId = Number((result as any).insertId);

    // Auto-enroll eligible participants
    await this.enrollParticipants(eventId, rule);

    // Send webhook notification
    await webhookNotificationService.notifyDREventTriggered({
      eventId,
      eventName: `Auto: ${rule.name}`,
      targetReduction: rule.eventConfig.targetReduction,
      startTime,
      endTime,
      reason: `Automated trigger: ${rule.name} - Grid conditions met criteria`,
    });

    return eventId;
  }

  /**
   * Automatically enroll eligible participants
   */
  private async enrollParticipants(eventId: number, rule: AutomationRule): Promise<void> {
    const db = await getDb();
    if (!db) {
      throw new Error('Database not available');
    }

    const { participantCriteria } = rule;

    // Build query to find eligible participants
    let query = db
      .select({
        userId: users.id,
        capacity: sql<number>`SUM(${assets.capacity})`.as('total_capacity'),
        responses: drResponses,
      })
      .from(users)
      .leftJoin(assets, eq(assets.userId, users.id))
      .leftJoin(drResponses, eq(drResponses.userId, users.id))
      .where(eq(users.role, 'user'))
      .groupBy(users.id);

    const participants = await query;

    // Filter based on criteria
    const eligible = participants.filter(p => {
      // Check reliability score
      if (participantCriteria.minReliabilityScore) {
        // Calculate reliability from response history
        const score = 70; // Default score, calculate from response history
        if (score < participantCriteria.minReliabilityScore) {
          return false;
        }
      }

      // Check capacity
      if (participantCriteria.minCapacity) {
        const capacity = p.capacity || 0;
        if (capacity < participantCriteria.minCapacity) {
          return false;
        }
      }

      // Check segment
      if (participantCriteria.segments && participantCriteria.segments.length > 0) {
        const segment = 'reliable'; // Default segment
        if (!participantCriteria.segments.includes(segment)) {
          return false;
        }
      }

      return true;
    });

    // Enroll eligible participants
    const enrollments = eligible.map(p => ({
      eventId,
      userId: p.userId,
      enrollmentStatus: 'auto_enrolled' as const,
      enrolledAt: new Date(),
    }));

    if (enrollments.length > 0) {
      await db.insert(drParticipants).values(enrollments);
      console.log(`[DR Automation] Auto-enrolled ${enrollments.length} participants for event ${eventId}`);
    }
  }

  /**
   * Calculate real-time compensation for participant
   */
  async calculateCompensation(
    eventId: number,
    userId: number,
    actualReduction: number
  ): Promise<{
    baseCompensation: number;
    performanceBonus: number;
    totalCompensation: number;
  }> {
    const db = await getDb();
    if (!db) {
      throw new Error('Database not available');
    }

    // Get event details
    const event = await db
      .select()
      .from(demandResponseEvents)
      .where(eq(demandResponseEvents.id, eventId))
      .limit(1);

    if (event.length === 0) {
      throw new Error('Event not found');
    }

    const eventData = event[0];
    const compensationRate = eventData.compensationRate || 100;

    // Calculate participant reliability from response history
    const responses = await db
      .select()
      .from(drResponses)
      .where(eq(drResponses.userId, userId))
      .orderBy(desc(drResponses.responseTime))
      .limit(10);

    // Calculate reliability score from recent responses
    let reliabilityScore = 50; // Default
    if (responses.length > 0) {
      const successfulResponses = responses.filter(r => (r.actualReduction || 0) >= (r.targetReduction || 0) * 0.8);
      reliabilityScore = (successfulResponses.length / responses.length) * 100;
    }

    // Calculate base compensation
    const baseCompensation = actualReduction * compensationRate;

    // Calculate performance bonus
    let bonusPercentage = 0;
    if (reliabilityScore >= 90) {
      bonusPercentage = 30;
    } else if (reliabilityScore >= 80) {
      bonusPercentage = 20;
    } else if (reliabilityScore >= 70) {
      bonusPercentage = 10;
    }

    const performanceBonus = baseCompensation * (bonusPercentage / 100);
    const totalCompensation = baseCompensation + performanceBonus;

    return {
      baseCompensation,
      performanceBonus,
      totalCompensation,
    };
  }

  /**
   * Get automation rules
   */
  getAutomationRules(): AutomationRule[] {
    return this.automationRules;
  }

  /**
   * Update automation rule
   */
  updateAutomationRule(ruleId: string, updates: Partial<AutomationRule>): boolean {
    const index = this.automationRules.findIndex(r => r.id === ruleId);
    if (index === -1) {
      return false;
    }

    this.automationRules[index] = {
      ...this.automationRules[index],
      ...updates,
    };

    return true;
  }

  /**
   * Add new automation rule
   */
  addAutomationRule(rule: AutomationRule): void {
    this.automationRules.push(rule);
  }

  /**
   * Delete automation rule
   */
  deleteAutomationRule(ruleId: string): boolean {
    const index = this.automationRules.findIndex(r => r.id === ruleId);
    if (index === -1) {
      return false;
    }

    this.automationRules.splice(index, 1);
    return true;
  }

  /**
   * Simulate grid stress for testing
   */
  async simulateGridStress(severity: 'low' | 'medium' | 'high'): Promise<GridStressConditions> {
    // These conditions are invented, and checkAndTriggerEvents dispatches REAL
    // demand-response events that pay real compensation. Never in production.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'simulateGridStress is disabled in production: it would dispatch real DR events from fabricated grid conditions'
      );
    }

    const conditions: GridStressConditions = {
      loadLevel: severity === 'high' ? 90 : severity === 'medium' ? 80 : 70,
      frequency: severity === 'high' ? 49.5 : severity === 'medium' ? 49.8 : 50.0,
      voltage: severity === 'high' ? 220 : severity === 'medium' ? 230 : 240,
      temperature: severity === 'high' ? 38 : severity === 'medium' ? 32 : 28,
      timestamp: new Date(),
    };

    // Trigger events based on simulated conditions
    await this.checkAndTriggerEvents(conditions);

    return conditions;
  }
}

// Export singleton instance
export const drAutomationService = new DRAutomationService();
