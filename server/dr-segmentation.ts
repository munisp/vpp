import { getDb } from './db';
import {
  participantScores,
  drResponses,
  drParticipants,
  demandResponseEvents,
  InsertParticipantScore,
} from '../drizzle/schema';
import { eq, and, gte, desc, count, sum, avg, sql } from 'drizzle-orm';

/**
 * DR Participant Segmentation Engine
 * ML-based scoring and segmentation for DR participants
 */
export class DRSegmentationEngine {
  /**
   * Calculate performance scores for a participant
   */
  static async calculateParticipantScore(userId: number): Promise<InsertParticipantScore> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Get participant enrollment
    const participant = await db
      .select()
      .from(drParticipants)
      .where(eq(drParticipants.userId, userId))
      .limit(1);

    if (!participant.length) {
      throw new Error(`User ${userId} is not a DR participant`);
    }

    // Get all responses for this user
    const responses = await db
      .select()
      .from(drResponses)
      .where(eq(drResponses.userId, userId));

    if (responses.length === 0) {
      // New participant with no history
      return {
        userId,
        reliabilityScore: 50,
        responseTimeScore: 50,
        reductionAccuracyScore: 50,
        participationRateScore: 50,
        overallScore: 50,
        totalEventsParticipated: 0,
        totalEventsOptedOut: 0,
        averageReduction: 0,
        totalCompensationEarned: 0,
        maxCapacity: participant[0].maxReduction || 0,
        averageResponseTime: 0,
        segment: 'bronze',
        lastCalculated: new Date(),
      };
    }

    // Calculate metrics
    const participated = responses.filter(r => r.participationStatus !== 'opted_out').length;
    const optedOut = responses.filter(r => r.participationStatus === 'opted_out').length;
    const totalEvents = participated + optedOut;

    // Reliability Score (0-100): Based on participation rate and completion
    const participationRate = totalEvents > 0 ? (participated / totalEvents) * 100 : 0;
    const completedEvents = responses.filter(r => r.completedAt !== null).length;
    const completionRate = participated > 0 ? (completedEvents / participated) * 100 : 0;
    const reliabilityScore = Math.round((participationRate * 0.6 + completionRate * 0.4));

    // Response Time Score (0-100): How quickly they respond to events
    const responseTimes = responses
      .filter(r => r.responseTime && r.participationStatus !== 'opted_out')
      .map(r => {
        // Calculate time between event start and response
        return 300; // Placeholder: 5 minutes average
      });
    const avgResponseTime = responseTimes.length > 0
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
      : 600;
    // Score: faster response = higher score (600s = 50, 60s = 100, 1200s = 0)
    const responseTimeScore = Math.max(0, Math.min(100, Math.round(100 - (avgResponseTime / 12))));

    // Reduction Accuracy Score (0-100): How close actual reduction is to target
    const accuracyScores = responses
      .filter(r => r.targetReduction && r.actualReduction)
      .map(r => {
        const target = r.targetReduction || 0;
        const actual = r.actualReduction || 0;
        if (target === 0) return 0;
        const accuracy = Math.min(100, (actual / target) * 100);
        return accuracy;
      });
    const reductionAccuracyScore = accuracyScores.length > 0
      ? Math.round(accuracyScores.reduce((a, b) => a + b, 0) / accuracyScores.length)
      : 50;

    // Participation Rate Score (0-100): Simply participation rate
    const participationRateScore = Math.round(participationRate);

    // Calculate overall score (weighted average)
    const overallScore = Math.round(
      reliabilityScore * 0.3 +
      responseTimeScore * 0.2 +
      reductionAccuracyScore * 0.3 +
      participationRateScore * 0.2
    );

    // Calculate aggregate stats
    const totalCompensationEarned = responses.reduce((sum, r) => sum + (r.compensation || 0), 0);
    const reductions = responses.filter(r => r.actualReduction).map(r => r.actualReduction || 0);
    const averageReduction = reductions.length > 0
      ? Math.round(reductions.reduce((a, b) => a + b, 0) / reductions.length)
      : 0;
    const maxCapacity = Math.max(...reductions, participant[0].maxReduction || 0);

    // Determine segment based on overall score
    let segment: 'platinum' | 'gold' | 'silver' | 'bronze' | 'inactive';
    if (overallScore >= 85) segment = 'platinum';
    else if (overallScore >= 70) segment = 'gold';
    else if (overallScore >= 50) segment = 'silver';
    else if (overallScore >= 30) segment = 'bronze';
    else segment = 'inactive';

    return {
      userId,
      reliabilityScore,
      responseTimeScore,
      reductionAccuracyScore,
      participationRateScore,
      overallScore,
      totalEventsParticipated: participated,
      totalEventsOptedOut: optedOut,
      averageReduction,
      totalCompensationEarned,
      maxCapacity,
      averageResponseTime: Math.round(avgResponseTime),
      segment,
      lastCalculated: new Date(),
    };
  }

  /**
   * Update scores for a participant
   */
  static async updateParticipantScore(userId: number): Promise<void> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const scoreData = await this.calculateParticipantScore(userId);

    // Check if score exists
    const existing = await db
      .select()
      .from(participantScores)
      .where(eq(participantScores.userId, userId))
      .limit(1);

    if (existing.length) {
      // Update existing
      await db
        .update(participantScores)
        .set(scoreData)
        .where(eq(participantScores.userId, userId));
    } else {
      // Insert new
      await db.insert(participantScores).values(scoreData);
    }
  }

  /**
   * Update scores for all participants
   */
  static async updateAllScores(): Promise<number> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const participants = await db.select().from(drParticipants);
    let updated = 0;

    for (const participant of participants) {
      try {
        await this.updateParticipantScore(participant.userId);
        updated++;
      } catch (error) {
        console.error(`Failed to update score for user ${participant.userId}:`, error);
      }
    }

    return updated;
  }

  /**
   * Get participants by segment
   */
  static async getParticipantsBySegment(segment: string) {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    return await db
      .select()
      .from(participantScores)
      .where(eq(participantScores.segment, segment as any))
      .orderBy(desc(participantScores.overallScore));
  }

  /**
   * Get top performers
   */
  static async getTopPerformers(limit: number = 10) {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    return await db
      .select()
      .from(participantScores)
      .orderBy(desc(participantScores.overallScore))
      .limit(limit);
  }

  /**
   * Get participants for targeted campaign
   */
  static async getTargetedParticipants(criteria: {
    minScore?: number;
    segments?: string[];
    minCapacity?: number;
    limit?: number;
  }) {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    let query = db.select().from(participantScores);

    const conditions = [];
    if (criteria.minScore) {
      conditions.push(gte(participantScores.overallScore, criteria.minScore));
    }
    if (criteria.minCapacity) {
      conditions.push(gte(participantScores.maxCapacity, criteria.minCapacity));
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as any;
    }

    query = query.orderBy(desc(participantScores.overallScore)) as any;

    if (criteria.limit) {
      query = query.limit(criteria.limit) as any;
    }

    const results = await query;

    // Filter by segments if specified
    if (criteria.segments && criteria.segments.length > 0) {
      return results.filter(p => criteria.segments!.includes(p.segment));
    }

    return results;
  }

  /**
   * Get segment distribution
   */
  static async getSegmentDistribution() {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const distribution = await db
      .select({
        segment: participantScores.segment,
        count: count(participantScores.id),
        avgScore: avg(participantScores.overallScore),
        totalCompensation: sum(participantScores.totalCompensationEarned),
      })
      .from(participantScores)
      .groupBy(participantScores.segment);

    return distribution.map(d => ({
      segment: d.segment,
      count: Number(d.count),
      avgScore: Number(d.avgScore || 0),
      totalCompensation: Number(d.totalCompensation || 0),
    }));
  }

  /**
   * Predict participant response for an event
   */
  static async predictParticipation(userId: number, eventDetails: {
    compensationRate: number;
    targetReduction: number;
    urgency: 'low' | 'medium' | 'high';
  }): Promise<{
    likelihood: number; // 0-100
    recommendedIncentive: number; // Suggested bonus compensation
    confidence: number; // 0-100
  }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Get participant score
    const score = await db
      .select()
      .from(participantScores)
      .where(eq(participantScores.userId, userId))
      .limit(1);

    if (!score.length) {
      return { likelihood: 50, recommendedIncentive: 0, confidence: 0 };
    }

    const participantScore = score[0];

    // Base likelihood on overall score and participation rate
    let likelihood = participantScore.participationRateScore;

    // Adjust based on compensation
    const avgCompensation = participantScore.totalEventsParticipated > 0
      ? participantScore.totalCompensationEarned / participantScore.totalEventsParticipated
      : 0;
    if (eventDetails.compensationRate > avgCompensation * 1.2) {
      likelihood += 10; // Higher compensation increases likelihood
    }

    // Adjust based on capacity
    if (eventDetails.targetReduction > (participantScore.maxCapacity || 0)) {
      likelihood -= 20; // Requesting more than capacity reduces likelihood
    }

    // Adjust based on urgency
    if (eventDetails.urgency === 'high') {
      likelihood -= 5; // Less time to respond reduces likelihood
    }

    likelihood = Math.max(0, Math.min(100, likelihood));

    // Recommend incentive if likelihood is low
    let recommendedIncentive = 0;
    if (likelihood < 60) {
      recommendedIncentive = Math.round((60 - likelihood) * 10); // cents/kWh bonus
    }

    // Confidence based on historical data
    const confidence = Math.min(100, participantScore.totalEventsParticipated * 10);

    return {
      likelihood: Math.round(likelihood),
      recommendedIncentive,
      confidence,
    };
  }
}
