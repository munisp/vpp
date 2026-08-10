/**
 * Blockchain Audit Anchoring Service
 * 
 * Provides optional blockchain anchoring for settlement events,
 * creating tamper-proof audit trails and verifiable proofs.
 * 
 * Note: This is an optional layer on top of the settlement ledger.
 * The core settlement functionality works without blockchain.
 */

import { getDb } from '../db';
import { sql } from 'drizzle-orm';
import { createHash } from 'crypto';
import { kafkaPublisher } from '../integration/kafka-publisher';

// Types for blockchain anchoring
export interface BlockchainAnchor {
  id: number;
  anchorType: 'settlement_period' | 'settlement_event' | 'carbon_credit' | 'compliance_report';
  sourceId: number;
  sourceHash: string;
  merkleRoot: string | null;
  blockchainNetwork: 'ethereum' | 'polygon' | 'arbitrum' | 'optimism' | 'hedera' | 'stellar' | 'mock';
  transactionHash: string | null;
  blockNumber: number | null;
  anchoredAt: Date | null;
  status: 'pending' | 'submitted' | 'confirmed' | 'failed';
  gasUsed: number | null;
  costWei: string | null;
  verificationUrl: string | null;
  metadata: Record<string, any>;
  createdAt: Date;
}

export interface AnchorBatch {
  batchId: string;
  anchors: BlockchainAnchor[];
  merkleRoot: string;
  status: 'pending' | 'submitted' | 'confirmed' | 'failed';
  transactionHash: string | null;
  submittedAt: Date | null;
  confirmedAt: Date | null;
}

export interface VerificationResult {
  valid: boolean;
  anchorId: number;
  sourceHash: string;
  merkleRoot: string | null;
  transactionHash: string | null;
  blockNumber: number | null;
  verifiedAt: Date;
  verificationMethod: 'local' | 'blockchain';
  details: string;
}

// Blockchain provider interface (for future real implementations)
interface BlockchainProvider {
  name: string;
  network: string;
  submitAnchor(merkleRoot: string, metadata: string): Promise<{ txHash: string; blockNumber?: number }>;
  verifyAnchor(txHash: string, expectedMerkleRoot: string): Promise<boolean>;
  getTransactionUrl(txHash: string): string;
}

// Mock blockchain provider for development/testing
class MockBlockchainProvider implements BlockchainProvider {
  name = 'Mock Blockchain';
  network = 'mock';

  async submitAnchor(merkleRoot: string, metadata: string): Promise<{ txHash: string; blockNumber: number }> {
    // Simulate blockchain submission delay
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const txHash = '0x' + createHash('sha256')
      .update(`${merkleRoot}-${Date.now()}-${Math.random()}`)
      .digest('hex');
    
    const blockNumber = Math.floor(Date.now() / 1000) - 1700000000 + Math.floor(Math.random() * 1000);
    
    return { txHash, blockNumber };
  }

  async verifyAnchor(txHash: string, expectedMerkleRoot: string): Promise<boolean> {
    // Mock verification always succeeds for valid-looking hashes
    return txHash.startsWith('0x') && txHash.length === 66;
  }

  getTransactionUrl(txHash: string): string {
    return `https://mock-explorer.example.com/tx/${txHash}`;
  }
}

// Hedera provider stub (for future implementation)
class HederaProvider implements BlockchainProvider {
  name = 'Hedera Hashgraph';
  network = 'hedera';

  async submitAnchor(merkleRoot: string, metadata: string): Promise<{ txHash: string }> {
    // In production, would use Hedera SDK to submit to Hedera Consensus Service
    throw new Error('Hedera provider not configured. Set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY');
  }

  async verifyAnchor(txHash: string, expectedMerkleRoot: string): Promise<boolean> {
    throw new Error('Hedera provider not configured');
  }

  getTransactionUrl(txHash: string): string {
    return `https://hashscan.io/mainnet/transaction/${txHash}`;
  }
}

// Polygon provider stub (for future implementation)
class PolygonProvider implements BlockchainProvider {
  name = 'Polygon';
  network = 'polygon';

  async submitAnchor(merkleRoot: string, metadata: string): Promise<{ txHash: string }> {
    // In production, would use ethers.js to submit to Polygon
    throw new Error('Polygon provider not configured. Set POLYGON_RPC_URL and POLYGON_PRIVATE_KEY');
  }

  async verifyAnchor(txHash: string, expectedMerkleRoot: string): Promise<boolean> {
    throw new Error('Polygon provider not configured');
  }

  getTransactionUrl(txHash: string): string {
    return `https://polygonscan.com/tx/${txHash}`;
  }
}

export class BlockchainAuditService {
  private provider: BlockchainProvider;
  private enabled: boolean;

  constructor() {
    // Select provider based on environment
    const network = process.env.BLOCKCHAIN_NETWORK || 'mock';
    
    switch (network) {
      case 'hedera':
        this.provider = new HederaProvider();
        this.enabled = !!process.env.HEDERA_OPERATOR_ID;
        break;
      case 'polygon':
        this.provider = new PolygonProvider();
        this.enabled = !!process.env.POLYGON_PRIVATE_KEY;
        break;
      default:
        this.provider = new MockBlockchainProvider();
        this.enabled = true;
    }

    console.log(`[BlockchainAudit] Initialized with ${this.provider.name} (enabled: ${this.enabled})`);
  }

  /**
   * Anchor a settlement period to blockchain
   */
  async anchorSettlementPeriod(periodId: number): Promise<BlockchainAnchor> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Get settlement period
    const periodResult = await db.execute(sql`
      SELECT * FROM settlement_periods WHERE id = ${periodId}
    `);
    const period = (periodResult as any)[0]?.[0];
    if (!period) throw new Error('Settlement period not found');

    // Get all events in the period
    const eventsResult = await db.execute(sql`
      SELECT event_hash FROM settlement_events
      WHERE user_id = ${period.user_id}
        AND created_at >= ${period.period_start}
        AND created_at <= ${period.period_end}
      ORDER BY sequence_number ASC
    `);
    const events = (eventsResult as any)[0] || [];

    // Calculate Merkle root of event hashes
    const eventHashes = events.map((e: any) => e.event_hash);
    const merkleRoot = this.calculateMerkleRoot(eventHashes);

    // Create anchor record
    const sourceHash = period.period_hash || createHash('sha256')
      .update(`${period.user_id}-${period.period_start}-${period.period_end}`)
      .digest('hex');

    const anchor = await this.createAnchor({
      anchorType: 'settlement_period',
      sourceId: periodId,
      sourceHash,
      merkleRoot,
      metadata: {
        userId: period.user_id,
        periodStart: period.period_start,
        periodEnd: period.period_end,
        eventCount: events.length,
        totalGross: period.total_gross_amount,
        totalNet: period.total_net_amount,
      },
    });

    // Publish to Kafka for lakehouse analytics
    try {
      await kafkaPublisher.publishBlockchainAnchor({
        anchorId: anchor.id.toString(),
        ledgerHash: sourceHash,
        chainNetwork: this.provider.name,
        merkleRoot: merkleRoot || undefined,
        timestamp: new Date(),
      });
    } catch (error) {
      console.error('[BlockchainAudit] Error publishing to Kafka:', error);
    }

    // Submit to blockchain if enabled
    if (this.enabled) {
      return this.submitAnchor(anchor.id);
    }

    return anchor;
  }

  /**
   * Anchor a carbon credit to blockchain
   */
  async anchorCarbonCredit(creditId: number): Promise<BlockchainAnchor> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Get carbon credit
    const creditResult = await db.execute(sql`
      SELECT * FROM carbon_credits WHERE id = ${creditId}
    `);
    const credit = (creditResult as any)[0]?.[0];
    if (!credit) throw new Error('Carbon credit not found');

    // Create source hash from credit data
    const sourceHash = createHash('sha256')
      .update(`${credit.certificate_id}-${credit.user_id}-${credit.energy_mwh}-${credit.created_at}`)
      .digest('hex');

    const anchor = await this.createAnchor({
      anchorType: 'carbon_credit',
      sourceId: creditId,
      sourceHash,
      merkleRoot: null,
      metadata: {
        certificateId: credit.certificate_id,
        creditType: credit.credit_type,
        energyMwh: credit.energy_mwh,
        carbonTonnes: credit.carbon_tonnes,
        generationSource: credit.generation_source,
        registry: credit.registry,
      },
    });

    // Submit to blockchain if enabled
    if (this.enabled) {
      return this.submitAnchor(anchor.id);
    }

    return anchor;
  }

  /**
   * Anchor a compliance report to blockchain
   */
  async anchorComplianceReport(reportId: string): Promise<BlockchainAnchor> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    // Get compliance report
    const reportResult = await db.execute(sql`
      SELECT * FROM compliance_reports WHERE report_id = ${reportId}
    `);
    const report = (reportResult as any)[0]?.[0];
    if (!report) throw new Error('Compliance report not found');

    // Create source hash from report data
    const sourceHash = createHash('sha256')
      .update(`${report.report_id}-${report.jurisdiction}-${report.period_start}-${report.period_end}-${report.sections}`)
      .digest('hex');

    const anchor = await this.createAnchor({
      anchorType: 'compliance_report',
      sourceId: report.id,
      sourceHash,
      merkleRoot: null,
      metadata: {
        reportId: report.report_id,
        reportType: report.report_type,
        jurisdiction: report.jurisdiction,
        periodStart: report.period_start,
        periodEnd: report.period_end,
        status: report.status,
      },
    });

    // Submit to blockchain if enabled
    if (this.enabled) {
      return this.submitAnchor(anchor.id);
    }

    return anchor;
  }

  /**
   * Create an anchor record
   */
  private async createAnchor(
    anchor: {
      anchorType: BlockchainAnchor['anchorType'];
      sourceId: number;
      sourceHash: string;
      merkleRoot: string | null;
      metadata: Record<string, any>;
    }
  ): Promise<BlockchainAnchor> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute(sql`
      INSERT INTO blockchain_anchors (
        anchor_type, source_id, source_hash, merkle_root,
        blockchain_network, status, metadata, created_at
      ) VALUES (
        ${anchor.anchorType}, ${anchor.sourceId}, ${anchor.sourceHash},
        ${anchor.merkleRoot}, ${this.provider.network}, 'pending',
        ${JSON.stringify(anchor.metadata)}, NOW()
      )
    `);

    return {
      id: (result as any).insertId,
      anchorType: anchor.anchorType,
      sourceId: anchor.sourceId,
      sourceHash: anchor.sourceHash,
      merkleRoot: anchor.merkleRoot,
      blockchainNetwork: this.provider.network as BlockchainAnchor['blockchainNetwork'],
      transactionHash: null,
      blockNumber: null,
      anchoredAt: null,
      status: 'pending',
      gasUsed: null,
      costWei: null,
      verificationUrl: null,
      metadata: anchor.metadata,
      createdAt: new Date(),
    };
  }

  /**
   * Submit anchor to blockchain
   */
  async submitAnchor(anchorId: number): Promise<BlockchainAnchor> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const anchor = await this.getAnchor(anchorId);
    if (!anchor) throw new Error('Anchor not found');

    if (anchor.status !== 'pending') {
      throw new Error(`Anchor already ${anchor.status}`);
    }

    try {
      // Prepare data for blockchain
      const dataToAnchor = anchor.merkleRoot || anchor.sourceHash;
      const metadata = JSON.stringify({
        type: anchor.anchorType,
        sourceId: anchor.sourceId,
        timestamp: new Date().toISOString(),
      });

      // Submit to blockchain
      const result = await this.provider.submitAnchor(dataToAnchor, metadata);

      // Update anchor record
      const verificationUrl = this.provider.getTransactionUrl(result.txHash);

      await db.execute(sql`
        UPDATE blockchain_anchors SET
          transaction_hash = ${result.txHash},
          block_number = ${result.blockNumber || null},
          anchored_at = NOW(),
          status = 'confirmed',
          verification_url = ${verificationUrl}
        WHERE id = ${anchorId}
      `);

      console.log(`[BlockchainAudit] Anchored ${anchor.anchorType} ${anchor.sourceId} to ${this.provider.network}: ${result.txHash}`);

      return this.getAnchor(anchorId) as Promise<BlockchainAnchor>;
    } catch (error: any) {
      // Update anchor with failure
      await db.execute(sql`
        UPDATE blockchain_anchors SET
          status = 'failed',
          metadata = JSON_SET(COALESCE(metadata, '{}'), '$.error', ${error.message})
        WHERE id = ${anchorId}
      `);

      console.error(`[BlockchainAudit] Failed to anchor ${anchor.anchorType} ${anchor.sourceId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Verify an anchor
   */
  async verifyAnchor(anchorId: number): Promise<VerificationResult> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const anchor = await this.getAnchor(anchorId);
    if (!anchor) throw new Error('Anchor not found');

    // Local verification - recalculate hash and compare
    let localValid = false;
    let details = '';

    if (anchor.anchorType === 'settlement_period') {
      const periodResult = await db.execute(sql`
        SELECT * FROM settlement_periods WHERE id = ${anchor.sourceId}
      `);
      const period = (periodResult as any)[0]?.[0];

      if (period) {
        const eventsResult = await db.execute(sql`
          SELECT event_hash FROM settlement_events
          WHERE user_id = ${period.user_id}
            AND created_at >= ${period.period_start}
            AND created_at <= ${period.period_end}
          ORDER BY sequence_number ASC
        `);
        const events = (eventsResult as any)[0] || [];
        const eventHashes = events.map((e: any) => e.event_hash);
        const recalculatedMerkleRoot = this.calculateMerkleRoot(eventHashes);

        localValid = recalculatedMerkleRoot === anchor.merkleRoot;
        details = localValid 
          ? `Merkle root verified: ${anchor.merkleRoot?.substring(0, 16)}...`
          : `Merkle root mismatch: expected ${anchor.merkleRoot?.substring(0, 16)}..., got ${recalculatedMerkleRoot.substring(0, 16)}...`;
      }
    } else {
      // For other types, just verify the hash exists
      localValid = !!anchor.sourceHash;
      details = `Source hash present: ${anchor.sourceHash.substring(0, 16)}...`;
    }

    // Blockchain verification if transaction exists
    let blockchainValid = false;
    if (anchor.transactionHash && this.enabled) {
      try {
        blockchainValid = await this.provider.verifyAnchor(
          anchor.transactionHash,
          anchor.merkleRoot || anchor.sourceHash
        );
        details += blockchainValid 
          ? ` | Blockchain verified on ${this.provider.network}`
          : ` | Blockchain verification failed`;
      } catch (error: any) {
        details += ` | Blockchain verification error: ${error.message}`;
      }
    }

    return {
      valid: localValid && (anchor.transactionHash ? blockchainValid : true),
      anchorId,
      sourceHash: anchor.sourceHash,
      merkleRoot: anchor.merkleRoot,
      transactionHash: anchor.transactionHash,
      blockNumber: anchor.blockNumber,
      verifiedAt: new Date(),
      verificationMethod: anchor.transactionHash ? 'blockchain' : 'local',
      details,
    };
  }

  /**
   * Get anchor by ID
   */
  async getAnchor(anchorId: number): Promise<BlockchainAnchor | null> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute(sql`
      SELECT * FROM blockchain_anchors WHERE id = ${anchorId}
    `);

    const row = (result as any)[0]?.[0];
    return row ? this.mapRowToAnchor(row) : null;
  }

  /**
   * Get anchors for a source
   */
  async getAnchorsForSource(
    anchorType: BlockchainAnchor['anchorType'],
    sourceId: number
  ): Promise<BlockchainAnchor[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute(sql`
      SELECT * FROM blockchain_anchors
      WHERE anchor_type = ${anchorType} AND source_id = ${sourceId}
      ORDER BY created_at DESC
    `);

    return ((result as any)[0] || []).map(this.mapRowToAnchor);
  }

  /**
   * Batch anchor multiple items
   */
  async batchAnchor(
    items: Array<{ type: BlockchainAnchor['anchorType']; sourceId: number }>
  ): Promise<AnchorBatch> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const batchId = `batch_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
    const anchors: BlockchainAnchor[] = [];
    const hashes: string[] = [];

    // Create individual anchors
    for (const item of items) {
      let anchor: BlockchainAnchor;
      
      switch (item.type) {
        case 'settlement_period':
          anchor = await this.createAnchor({
            anchorType: item.type,
            sourceId: item.sourceId,
            sourceHash: createHash('sha256').update(`period-${item.sourceId}`).digest('hex'),
            merkleRoot: null,
            metadata: { batchId },
          });
          break;
        case 'carbon_credit':
          anchor = await this.createAnchor({
            anchorType: item.type,
            sourceId: item.sourceId,
            sourceHash: createHash('sha256').update(`credit-${item.sourceId}`).digest('hex'),
            merkleRoot: null,
            metadata: { batchId },
          });
          break;
        default:
          anchor = await this.createAnchor({
            anchorType: item.type,
            sourceId: item.sourceId,
            sourceHash: createHash('sha256').update(`${item.type}-${item.sourceId}`).digest('hex'),
            merkleRoot: null,
            metadata: { batchId },
          });
      }

      anchors.push(anchor);
      hashes.push(anchor.sourceHash);
    }

    // Calculate batch Merkle root
    const merkleRoot = this.calculateMerkleRoot(hashes);

    // Submit batch to blockchain
    let transactionHash: string | null = null;
    let status: AnchorBatch['status'] = 'pending';

    if (this.enabled) {
      try {
        const result = await this.provider.submitAnchor(merkleRoot, JSON.stringify({ batchId, count: items.length }));
        transactionHash = result.txHash;
        status = 'confirmed';

        // Update all anchors with batch transaction
        for (const anchor of anchors) {
          await db.execute(sql`
            UPDATE blockchain_anchors SET
              merkle_root = ${merkleRoot},
              transaction_hash = ${transactionHash},
              block_number = ${result.blockNumber || null},
              anchored_at = NOW(),
              status = 'confirmed',
              verification_url = ${this.provider.getTransactionUrl(transactionHash)}
            WHERE id = ${anchor.id}
          `);
        }

        console.log(`[BlockchainAudit] Batch anchored ${items.length} items: ${transactionHash}`);
      } catch (error: any) {
        status = 'failed';
        console.error(`[BlockchainAudit] Batch anchor failed: ${error.message}`);
      }
    }

    return {
      batchId,
      anchors,
      merkleRoot,
      status,
      transactionHash,
      submittedAt: status === 'confirmed' ? new Date() : null,
      confirmedAt: status === 'confirmed' ? new Date() : null,
    };
  }

  /**
   * Get pending anchors
   */
  async getPendingAnchors(): Promise<BlockchainAnchor[]> {
    const db = await getDb();
    if (!db) throw new Error('Database not available');

    const result = await db.execute(sql`
      SELECT * FROM blockchain_anchors
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 100
    `);

    return ((result as any)[0] || []).map(this.mapRowToAnchor);
  }

  /**
   * Process pending anchors
   */
  async processPendingAnchors(): Promise<{ processed: number; failed: number }> {
    const pending = await this.getPendingAnchors();
    let processed = 0;
    let failed = 0;

    for (const anchor of pending) {
      try {
        await this.submitAnchor(anchor.id);
        processed++;
      } catch (error) {
        failed++;
      }
    }

    return { processed, failed };
  }

  /**
   * Calculate Merkle root from array of hashes
   */
  private calculateMerkleRoot(hashes: string[]): string {
    if (hashes.length === 0) {
      return createHash('sha256').update('empty').digest('hex');
    }

    if (hashes.length === 1) {
      return hashes[0];
    }

    // Build Merkle tree
    let level = [...hashes];

    while (level.length > 1) {
      const nextLevel: string[] = [];

      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = level[i + 1] || left; // Duplicate last if odd number
        const combined = createHash('sha256')
          .update(left + right)
          .digest('hex');
        nextLevel.push(combined);
      }

      level = nextLevel;
    }

    return level[0];
  }

  /**
   * Check if blockchain anchoring is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Get provider info
   */
  getProviderInfo(): { name: string; network: string; enabled: boolean } {
    return {
      name: this.provider.name,
      network: this.provider.network,
      enabled: this.enabled,
    };
  }

  private mapRowToAnchor(row: any): BlockchainAnchor {
    return {
      id: row.id,
      anchorType: row.anchor_type,
      sourceId: row.source_id,
      sourceHash: row.source_hash,
      merkleRoot: row.merkle_root,
      blockchainNetwork: row.blockchain_network,
      transactionHash: row.transaction_hash,
      blockNumber: row.block_number,
      anchoredAt: row.anchored_at,
      status: row.status,
      gasUsed: row.gas_used,
      costWei: row.cost_wei,
      verificationUrl: row.verification_url,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      createdAt: row.created_at,
    };
  }
}

// Singleton instance
export const blockchainAudit = new BlockchainAuditService();
