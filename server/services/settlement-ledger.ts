/**
 * Settlement Ledger Service
 * 
 * Provides tamper-evident hash-chained settlement tracking for all VPP transactions.
 * Supports optional blockchain anchoring for external verification.
 */

import { createHash } from 'crypto';
import { getDb } from '../db';
import { eq, desc, and, gte, lte, sql } from 'drizzle-orm';
import { kafkaPublisher } from '../integration/kafka-publisher';

// Import schema (will be available after schema update)
interface SettlementEvent {
  id: number;
  eventHash: string;
  previousHash: string;
  sequenceNumber: number;
  eventType: string;
  userId: number;
  counterpartyId: number | null;
  sourceType: string;
  sourceId: number;
  energyWh: number | null;
  powerKw: number | null;
  durationMinutes: number | null;
  ratePerUnit: number | null;
  grossAmount: number | null;
  fees: number | null;
  netAmount: number | null;
  currency: 'NGN' | 'TZS' | 'USD';
  measurementMethod: string | null;
  baselineMethod: string | null;
  verificationStatus: string;
  eventData: string;
  blockchainTxHash: string | null;
  anchoredAt: Date | null;
  createdAt: Date;
}

interface CreateSettlementEventInput {
  eventType: 'dispatch_completed' | 'service_delivered' | 'measurement_verified' | 
             'compensation_calculated' | 'payment_initiated' | 'payment_completed' |
             'dispute_raised' | 'dispute_resolved' | 'adjustment_applied';
  userId: number;
  counterpartyId?: number;
  sourceType: string;
  sourceId: number;
  energyWh?: number;
  powerKw?: number;
  durationMinutes?: number;
  ratePerUnit?: number;
  grossAmount?: number;
  fees?: number;
  netAmount?: number;
  currency: 'NGN' | 'TZS' | 'USD';
  measurementMethod?: string;
  baselineMethod?: string;
  eventData: Record<string, any>;
}

interface SettlementPeriodSummary {
  userId: number;
  periodStart: Date;
  periodEnd: Date;
  totalEnergyExportedWh: number;
  totalEnergyImportedWh: number;
  totalServicesDelivered: number;
  grossRevenue: number;
  platformFees: number;
  gridCharges: number;
  netRevenue: number;
  emissionsSavedGrams: number;
  renewableEnergyWh: number;
  eventCount: number;
  periodHash: string;
}

// Genesis hash for the first event in the chain
const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/** Retries allowed when concurrent writers race for the same chain slot. */
const CHAIN_APPEND_MAX_ATTEMPTS = 5;

export class SettlementLedgerService {
  
  /**
   * Create a new settlement event with hash chaining
   */
  async createEvent(input: CreateSettlementEventInput): Promise<SettlementEvent> {
    // The chain tip is read before the insert, so two concurrent writers can
    // pick the same slot. `sequence_number`/`previous_hash` are unique in the
    // schema, so the loser gets a duplicate-key error and re-reads the tip
    // instead of silently forking the chain.
    let lastError: unknown = null;

    for (let attempt = 0; attempt < CHAIN_APPEND_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.appendEvent(input);
      } catch (error: any) {
        const isChainConflict =
          error?.code === 'ER_DUP_ENTRY' ||
          error?.errno === 1062 ||
          /duplicate entry/i.test(String(error?.message ?? ''));

        if (!isChainConflict) throw error;

        lastError = error;
        console.warn(
          `[SettlementLedger] Chain append conflict on attempt ${attempt + 1}, retrying`
        );
      }
    }

    throw new Error(
      `Failed to append settlement event after ${CHAIN_APPEND_MAX_ATTEMPTS} attempts due to chain contention: ${
        (lastError as any)?.message ?? String(lastError)
      }`
    );
  }

  private async appendEvent(input: CreateSettlementEventInput): Promise<SettlementEvent> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Get the previous event to chain from
    const previousEvents = await db.execute(sql`
      SELECT event_hash, sequence_number 
      FROM settlement_events 
      ORDER BY sequence_number DESC 
      LIMIT 1
    `);
    
    const previousEvent = (previousEvents as any)[0]?.[0];
    const previousHash = previousEvent?.event_hash || GENESIS_HASH;
    const sequenceNumber = Number(previousEvent?.sequence_number || 0) + 1;

    // Prepare event data
    const eventData = JSON.stringify({
      ...input.eventData,
      timestamp: new Date().toISOString(),
      sequenceNumber,
    });

    // Calculate hash: SHA-256(previousHash + eventType + userId + sourceType + sourceId + eventData)
    const hashInput = `${previousHash}|${input.eventType}|${input.userId}|${input.sourceType}|${input.sourceId}|${eventData}`;
    const eventHash = createHash('sha256').update(hashInput).digest('hex');

    // Insert the event
    const result = await db.execute(sql`
      INSERT INTO settlement_events (
        event_hash, previous_hash, sequence_number, event_type,
        user_id, counterparty_id, source_type, source_id,
        energy_wh, power_kw, duration_minutes, rate_per_unit,
        gross_amount, fees, net_amount, currency,
        measurement_method, baseline_method, verification_status,
        event_data, created_at
      ) VALUES (
        ${eventHash}, ${previousHash}, ${sequenceNumber}, ${input.eventType},
        ${input.userId}, ${input.counterpartyId || null}, ${input.sourceType}, ${input.sourceId},
        ${input.energyWh || null}, ${input.powerKw || null}, ${input.durationMinutes || null}, ${input.ratePerUnit || null},
        ${input.grossAmount || null}, ${input.fees || null}, ${input.netAmount || null}, ${input.currency},
        ${input.measurementMethod || null}, ${input.baselineMethod || null}, 'pending',
        ${eventData}, NOW()
      )
    `);

    console.log(`[SettlementLedger] Created event ${eventHash.substring(0, 16)}... seq=${sequenceNumber} type=${input.eventType}`);

    // Publish to Kafka for lakehouse analytics
    try {
      await kafkaPublisher.publishSettlementEvent({
        settlementId: eventHash,
        eventType: input.eventType,
        assetId: input.sourceType === 'asset' ? input.sourceId.toString() : undefined,
        quantityKwh: input.energyWh ? input.energyWh / 1000 : undefined,
        amount: input.netAmount || undefined,
        currency: input.currency,
        hashPrev: previousHash,
        hashCurr: eventHash,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error('[SettlementLedger] Error publishing to Kafka:', error);
    }

    return {
      id: (result as any).insertId,
      eventHash,
      previousHash,
      sequenceNumber,
      eventType: input.eventType,
      userId: input.userId,
      counterpartyId: input.counterpartyId || null,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      energyWh: input.energyWh || null,
      powerKw: input.powerKw || null,
      durationMinutes: input.durationMinutes || null,
      ratePerUnit: input.ratePerUnit || null,
      grossAmount: input.grossAmount || null,
      fees: input.fees || null,
      netAmount: input.netAmount || null,
      currency: input.currency,
      measurementMethod: input.measurementMethod || null,
      baselineMethod: input.baselineMethod || null,
      verificationStatus: 'pending',
      eventData,
      blockchainTxHash: null,
      anchoredAt: null,
      createdAt: new Date(),
    };
  }

  /**
   * Verify the integrity of the hash chain
   */
  async verifyChain(fromSequence?: number, toSequence?: number): Promise<{
    valid: boolean;
    checkedCount: number;
    errors: Array<{ sequenceNumber: number; error: string }>;
  }> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    let query = sql`
      SELECT id, event_hash, previous_hash, sequence_number, event_type,
             user_id, source_type, source_id, event_data
      FROM settlement_events
    `;

    if (fromSequence !== undefined && toSequence !== undefined) {
      query = sql`
        SELECT id, event_hash, previous_hash, sequence_number, event_type,
               user_id, source_type, source_id, event_data
        FROM settlement_events
        WHERE sequence_number >= ${fromSequence} AND sequence_number <= ${toSequence}
        ORDER BY sequence_number ASC
      `;
    } else {
      query = sql`
        SELECT id, event_hash, previous_hash, sequence_number, event_type,
               user_id, source_type, source_id, event_data
        FROM settlement_events
        ORDER BY sequence_number ASC
      `;
    }

    const events = await db.execute(query);
    const eventList = (events as any)[0] || [];
    
    const errors: Array<{ sequenceNumber: number; error: string }> = [];
    let previousHash = GENESIS_HASH;

    for (const event of eventList) {
      // Verify previous hash matches
      if (event.previous_hash !== previousHash) {
        errors.push({
          sequenceNumber: event.sequence_number,
          error: `Previous hash mismatch: expected ${previousHash.substring(0, 16)}..., got ${event.previous_hash.substring(0, 16)}...`,
        });
      }

      // Recalculate and verify event hash
      const hashInput = `${event.previous_hash}|${event.event_type}|${event.user_id}|${event.source_type}|${event.source_id}|${event.event_data}`;
      const calculatedHash = createHash('sha256').update(hashInput).digest('hex');

      if (calculatedHash !== event.event_hash) {
        errors.push({
          sequenceNumber: event.sequence_number,
          error: `Event hash mismatch: calculated ${calculatedHash.substring(0, 16)}..., stored ${event.event_hash.substring(0, 16)}...`,
        });
      }

      previousHash = event.event_hash;
    }

    console.log(`[SettlementLedger] Chain verification: ${eventList.length} events, ${errors.length} errors`);

    return {
      valid: errors.length === 0,
      checkedCount: eventList.length,
      errors,
    };
  }

  /**
   * Get events for a specific user
   */
  async getUserEvents(
    userId: number,
    options: {
      fromDate?: Date;
      toDate?: Date;
      eventTypes?: string[];
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<SettlementEvent[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const limit = options.limit || 100;
    const offset = options.offset || 0;

    let query = sql`
      SELECT * FROM settlement_events
      WHERE user_id = ${userId}
    `;

    if (options.fromDate) {
      query = sql`${query} AND created_at >= ${options.fromDate}`;
    }
    if (options.toDate) {
      query = sql`${query} AND created_at <= ${options.toDate}`;
    }
    if (options.eventTypes && options.eventTypes.length > 0) {
      query = sql`${query} AND event_type IN (${sql.join(options.eventTypes.map(t => sql`${t}`), sql`, `)})`;
    }

    query = sql`${query} ORDER BY sequence_number DESC LIMIT ${limit} OFFSET ${offset}`;

    const result = await db.execute(query);
    return ((result as any)[0] || []).map(this.mapRowToEvent);
  }

  /**
   * Calculate settlement period summary
   */
  async calculatePeriodSummary(
    userId: number,
    periodStart: Date,
    periodEnd: Date
  ): Promise<SettlementPeriodSummary> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Get all events in the period
    const eventsResult = await db.execute(sql`
      SELECT * FROM settlement_events
      WHERE user_id = ${userId}
        AND created_at >= ${periodStart}
        AND created_at <= ${periodEnd}
      ORDER BY sequence_number ASC
    `);

    const events = (eventsResult as any)[0] || [];

    // Calculate aggregates
    let totalEnergyExportedWh = 0;
    let totalEnergyImportedWh = 0;
    let totalServicesDelivered = 0;
    let grossRevenue = 0;
    let platformFees = 0;
    let gridCharges = 0;
    let emissionsSavedGrams = 0;
    let renewableEnergyWh = 0;

    for (const event of events) {
      const energyWh = event.energy_wh || 0;
      
      if (energyWh > 0) {
        totalEnergyExportedWh += energyWh;
      } else {
        totalEnergyImportedWh += Math.abs(energyWh);
      }

      if (event.event_type === 'service_delivered') {
        totalServicesDelivered++;
      }

      grossRevenue += event.gross_amount || 0;
      platformFees += event.fees || 0;

      // Parse event data for additional metrics
      try {
        const eventData = JSON.parse(event.event_data);
        emissionsSavedGrams += eventData.emissionsSavedGrams || 0;
        renewableEnergyWh += eventData.renewableEnergyWh || 0;
        gridCharges += eventData.gridCharges || 0;
      } catch (e) {
        // Ignore parse errors
      }
    }

    const netRevenue = grossRevenue - platformFees - gridCharges;

    // Calculate period hash (Merkle root of all event hashes)
    const eventHashes = events.map((e: any) => e.event_hash);
    const periodHash = this.calculateMerkleRoot(eventHashes);

    return {
      userId,
      periodStart,
      periodEnd,
      totalEnergyExportedWh,
      totalEnergyImportedWh,
      totalServicesDelivered,
      grossRevenue,
      platformFees,
      gridCharges,
      netRevenue,
      emissionsSavedGrams,
      renewableEnergyWh,
      eventCount: events.length,
      periodHash,
    };
  }

  /**
   * Calculate Merkle root of event hashes
   */
  private calculateMerkleRoot(hashes: string[]): string {
    if (hashes.length === 0) {
      return createHash('sha256').update('empty').digest('hex');
    }
    if (hashes.length === 1) {
      return hashes[0];
    }

    const nextLevel: string[] = [];
    for (let i = 0; i < hashes.length; i += 2) {
      const left = hashes[i];
      const right = hashes[i + 1] || left; // Duplicate last if odd number
      const combined = createHash('sha256').update(left + right).digest('hex');
      nextLevel.push(combined);
    }

    return this.calculateMerkleRoot(nextLevel);
  }

  /**
   * Anchor a settlement period hash to the configured blockchain provider.
   *
   * Anchors the period Merkle root as generic data via
   * BlockchainAuditService.anchorData — no synthetic/spoofed settlement period
   * id is ever used. Throws on failure: anchoring errors must be surfaced to
   * the caller, never silently swallowed into a null return.
   */
  async anchorToBlockchain(
    periodHash: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<{ txHash: string; anchoredAt: Date }> {
    const { blockchainAudit } = await import('./blockchain-audit');
    const proofData = `${periodHash}|${periodStart.toISOString()}|${periodEnd.toISOString()}`;
    const merkleRoot = createHash('sha256').update(proofData).digest('hex');

    const anchor = await blockchainAudit.anchorData(merkleRoot, {
      periodHash,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
    });

    const txHash = anchor.transactionHash;
    if (!txHash) {
      throw new Error('[SettlementLedger] Blockchain anchoring did not produce a transaction hash');
    }

    console.log(`[SettlementLedger] Anchored to blockchain: ${txHash.substring(0, 20)}...`);
    return { txHash, anchoredAt: anchor.anchoredAt ?? new Date() };
  }

  /**
   * Record a dispatch completion event
   */
  async recordDispatchCompletion(
    userId: number,
    dispatchId: number,
    actualPowerWatts: number,
    durationMinutes: number,
    serviceProductId: number | null,
    performanceScore: number,
    compensation: number,
    currency: 'NGN' | 'TZS' | 'USD'
  ): Promise<SettlementEvent> {
    const energyWh = Math.round((actualPowerWatts * durationMinutes) / 60);
    const platformFee = Math.round(compensation * 0.30); // 30% platform fee

    // Fetch the real setpoint for this dispatch so performance fields reflect
    // the actual target, not an echo of the actual power. If the setpoint is
    // not queryable, both fields stay null — never echoed or hardcoded.
    let targetPowerWatts: number | null = null;
    let deviationPercent: number | null = null;
    try {
      const db = await getDb();
      if (db) {
        const setpointResult = await db.execute(sql`
          SELECT target_power_watts FROM dispatch_setpoints WHERE id = ${dispatchId} LIMIT 1
        `);
        const setpoint = (setpointResult as any)[0]?.[0];
        if (setpoint && setpoint.target_power_watts !== null && setpoint.target_power_watts !== undefined) {
          const target = Number(setpoint.target_power_watts);
          targetPowerWatts = target;
          deviationPercent = target !== 0
            ? Math.round(((actualPowerWatts - target) / Math.abs(target)) * 10000) / 100
            : null;
        }
      }
    } catch (error) {
      console.error(`[SettlementLedger] Could not fetch setpoint ${dispatchId} for performance fields:`, error);
    }

    return this.createEvent({
      eventType: 'dispatch_completed',
      userId,
      sourceType: 'dispatch_setpoint',
      sourceId: dispatchId,
      energyWh,
      powerKw: Math.round(actualPowerWatts / 1000),
      durationMinutes,
      grossAmount: compensation,
      fees: platformFee,
      netAmount: compensation - platformFee,
      currency,
      measurementMethod: 'telemetry',
      eventData: {
        serviceProductId,
        performanceScore,
        targetPowerWatts,
        actualPowerWatts,
        deviationPercent,
      },
    });
  }

  /**
   * Record a DR event completion
   */
  async recordDRCompletion(
    userId: number,
    eventId: number,
    responseId: number,
    targetReductionKw: number,
    actualReductionKw: number,
    durationMinutes: number,
    compensationRate: number,
    currency: 'NGN' | 'TZS' | 'USD'
  ): Promise<SettlementEvent> {
    const energyWh = Math.round((actualReductionKw * 1000 * durationMinutes) / 60);
    const grossAmount = Math.round((energyWh / 1000) * compensationRate);
    const platformFee = Math.round(grossAmount * 0.30);
    const performanceScore = Math.min(100, Math.round((actualReductionKw / targetReductionKw) * 100));

    return this.createEvent({
      eventType: 'service_delivered',
      userId,
      sourceType: 'dr_response',
      sourceId: responseId,
      energyWh,
      powerKw: actualReductionKw,
      durationMinutes,
      ratePerUnit: compensationRate,
      grossAmount,
      fees: platformFee,
      netAmount: grossAmount - platformFee,
      currency,
      measurementMethod: 'baseline_comparison',
      baselineMethod: 'rolling_average_10_of_10',
      eventData: {
        drEventId: eventId,
        targetReductionKw,
        actualReductionKw,
        performanceScore,
        serviceType: 'demand_response',
      },
    });
  }

  /**
   * Record a P2P trade settlement
   */
  async recordP2PTrade(
    sellerId: number,
    buyerId: number,
    tradeId: number,
    energyWh: number,
    pricePerKwh: number,
    currency: 'NGN' | 'TZS' | 'USD'
  ): Promise<{ sellerEvent: SettlementEvent; buyerEvent: SettlementEvent }> {
    const grossAmount = Math.round((energyWh / 1000) * pricePerKwh);
    const platformFee = Math.round(grossAmount * 0.05); // 5% P2P fee

    // Seller event (receives payment)
    const sellerEvent = await this.createEvent({
      eventType: 'payment_completed',
      userId: sellerId,
      counterpartyId: buyerId,
      sourceType: 'trade',
      sourceId: tradeId,
      energyWh,
      ratePerUnit: pricePerKwh,
      grossAmount,
      fees: platformFee,
      netAmount: grossAmount - platformFee,
      currency,
      eventData: {
        tradeType: 'p2p_sell',
        counterpartyId: buyerId,
      },
    });

    // Buyer event (makes payment)
    const buyerEvent = await this.createEvent({
      eventType: 'payment_completed',
      userId: buyerId,
      counterpartyId: sellerId,
      sourceType: 'trade',
      sourceId: tradeId,
      energyWh: -energyWh, // Negative for import
      ratePerUnit: pricePerKwh,
      grossAmount: -grossAmount, // Negative for payment
      fees: 0,
      netAmount: -grossAmount,
      currency,
      eventData: {
        tradeType: 'p2p_buy',
        counterpartyId: sellerId,
      },
    });

    return { sellerEvent, buyerEvent };
  }

  /**
   * Map database row to SettlementEvent
   */
  private mapRowToEvent(row: any): SettlementEvent {
    return {
      id: row.id,
      eventHash: row.event_hash,
      previousHash: row.previous_hash,
      sequenceNumber: row.sequence_number,
      eventType: row.event_type,
      userId: row.user_id,
      counterpartyId: row.counterparty_id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      energyWh: row.energy_wh,
      powerKw: row.power_kw,
      durationMinutes: row.duration_minutes,
      ratePerUnit: row.rate_per_unit,
      grossAmount: row.gross_amount,
      fees: row.fees,
      netAmount: row.net_amount,
      currency: row.currency,
      measurementMethod: row.measurement_method,
      baselineMethod: row.baseline_method,
      verificationStatus: row.verification_status,
      eventData: row.event_data,
      blockchainTxHash: row.blockchain_tx_hash,
      anchoredAt: row.anchored_at,
      createdAt: row.created_at,
    };
  }
}

// Singleton instance
export const settlementLedger = new SettlementLedgerService();
