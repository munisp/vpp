import { kafka, KAFKA_TOPICS } from './kafka-config';
import { Producer, ProducerRecord, RecordMetadata } from 'kafkajs';
import { Counter, Histogram } from 'prom-client';

// Prometheus metrics
const kafkaMessagesPublished = new Counter({
  name: 'kafka_messages_published_total',
  help: 'Total number of messages published to Kafka',
  labelNames: ['topic', 'status']
});

const kafkaPublishDuration = new Histogram({
  name: 'kafka_publish_duration_seconds',
  help: 'Duration of Kafka publish operations',
  labelNames: ['topic'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1]
});

// Event interfaces (only those with a live publisher remain; the interfaces
// and 35 publish methods with zero callers were removed — every live call
// site is listed in git history and in the callers of the methods below).
export interface DREvent {
  eventId: string;
  type: string;
  startTime: Date;
  endTime: Date;
  targetReduction: number;
  compensationRate: number;
  status?: string;
}

export class KafkaEventPublisher {
  private producer: Producer;
  private connected: boolean = false;
  private connecting: boolean = false;

  constructor() {
    this.producer = kafka.producer({
      allowAutoTopicCreation: false,
      transactionTimeout: 30000,
      idempotent: true,
      maxInFlightRequests: 5,
      retry: {
        retries: 5,
        initialRetryTime: 100,
        multiplier: 2
      }
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) {
      // Wait for existing connection attempt
      await new Promise(resolve => setTimeout(resolve, 100));
      return this.connect();
    }

    this.connecting = true;
    try {
      await this.producer.connect();
      this.connected = true;
      console.log('[Kafka] Producer connected');
    } catch (error) {
      console.error('[Kafka] Failed to connect producer:', error);
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    
    try {
      await this.producer.disconnect();
      this.connected = false;
      console.log('[Kafka] Producer disconnected');
    } catch (error) {
      console.error('[Kafka] Error disconnecting producer:', error);
    }
  }

  private async publish(topic: string, messages: any[]): Promise<RecordMetadata[]> {
    const timer = kafkaPublishDuration.startTimer({ topic });
    
    try {
      await this.connect();
      
      const record: ProducerRecord = {
        topic,
        messages: messages.map(msg => ({
          key: msg.key || null,
          value: JSON.stringify(msg.value),
          headers: {
            'content-type': 'application/json',
            'source': 'vpp-consumer-platform',
            'timestamp': Date.now().toString(),
            ...(msg.headers || {})
          }
        }))
      };

      const result = await this.producer.send(record);
      kafkaMessagesPublished.inc({ topic, status: 'success' }, messages.length);
      console.log(`[Kafka] Published ${messages.length} messages to ${topic}`);
      timer();
      return result;
    } catch (error) {
      kafkaMessagesPublished.inc({ topic, status: 'error' });
      timer();
      console.error(`[Kafka] Error publishing to ${topic}:`, error);
      throw error;
    }
  }

  /**
   * Publish one already-composed record, for the outbox relay.
   *
   * Every other method here composes an event and sends it inline, which is what
   * lost events when the broker was away. The relay owns durability, so it needs
   * the raw send and nothing else: it throws on failure, and the caller decides
   * whether that is a retry or a dead letter.
   */
  async publishRecord(
    topic: string,
    message: { key?: string | null; value: unknown; headers?: Record<string, string> }
  ): Promise<void> {
    await this.publish(topic, [message]);
  }

  // DR events
  async publishDREventCreated(data: DREvent): Promise<void> {
    await this.publish(KAFKA_TOPICS.DR_EVENTS_CREATED, [{
      key: data.eventId,
      value: data
    }]);
  }

  // Health check
  async isHealthy(): Promise<boolean> {
    try {
      await this.connect();
      return this.connected;
    } catch {
      return false;
    }
  }

  // ============================================
  // Next-Gen Service Events for Lakehouse Analytics
  // ============================================

  // Probabilistic Forecasting events
  async publishForecastGenerated(data: {
    forecastId: string;
    targetType: string;
    horizonHours: number;
    p10: number;
    p50: number;
    p90: number;
    modelVersion: string;
    confidenceScore: number;
    assetId?: string;
    userId?: string;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.FORECASTS_GENERATED, [{
      key: data.forecastId,
      value: { event_id: data.forecastId, source: 'probabilistic-forecasting', ...data }
    }]);
  }

  // Optimization Engine events
  async publishOptimizationRun(data: {
    runId: string;
    objectiveType: string;
    objectiveValue: number;
    constraintsSatisfied: boolean;
    assetCount: number;
    scheduleHorizonHours: number;
    totalPowerKw: number;
    totalEnergyKwh: number;
    userId?: string;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.OPTIMIZATION_RUNS, [{
      key: data.runId,
      value: { event_id: data.runId, source: 'optimization-engine', ...data }
    }]);
  }

  // Edge Orchestration events
  async publishEdgeCommand(data: {
    commandId: string;
    gatewayId: string;
    deviceId?: string;
    commandType: string;
    status: string;
    issuedAt: Date;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.EDGE_COMMANDS, [{
      key: data.commandId,
      value: { event_id: data.commandId, source: 'edge-orchestration', ...data }
    }]);
  }

  // V2G/EV Charging events
  async publishEVSession(data: {
    sessionId: string;
    chargerId: string;
    userId: string;
    vehicleId?: string;
    sessionType: 'charging' | 'v2g' | 'idle';
    startTime?: Date;
    endTime?: Date;
    energyKwh?: number;
    v2gDischargeKwh?: number;
    socStart?: number;
    socEnd?: number;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.EV_SESSIONS, [{
      key: data.sessionId,
      value: { event_id: data.sessionId, source: 'ev-charging', ...data }
    }]);
  }

  // Carbon-Aware Dispatch events
  async publishCarbonSignal(data: {
    signalId: string;
    signalType: string;
    gridIntensityGco2Kwh: number;
    carbonPrice?: number;
    region: string;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.CARBON_SIGNALS, [{
      key: data.signalId,
      value: { event_id: data.signalId, source: 'carbon-aware-dispatch', ...data }
    }]);
  }

  // Community Energy events
  async publishCommunityAllocation(data: {
    communityId: string;
    memberId?: string;
    allocationType: string;
    allocationKwh: number;
    fairnessMetric?: number;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.COMMUNITY_ALLOCATIONS, [{
      key: `${data.communityId}-${data.memberId || 'all'}`,
      value: { event_id: `alloc-${data.communityId}-${Date.now()}`, source: 'community-energy', ...data }
    }]);
  }

  // MLOps Pipeline events
  async publishMLOpsTrainingRun(data: {
    runId: string;
    modelId?: string;
    modelName: string;
    modelVersion?: string;
    metricsJson: string;
    datasetRef?: string;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.MLOPS_TRAINING_RUNS, [{
      key: data.runId,
      value: { event_id: data.runId, source: 'mlops-pipeline', event_type: 'training_run', ...data }
    }]);
  }

  // Anomaly Detection events
  async publishAnomalyDetected(data: {
    anomalyId: string;
    assetId: string;
    anomalyType: string;
    score: number;
    severity: string;
    windowStart?: Date;
    windowEnd?: Date;
    recommendedAction?: string;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.ANOMALIES_DETECTED, [{
      key: data.anomalyId,
      value: { event_id: data.anomalyId, source: 'anomaly-detection', ...data }
    }]);
  }

  // Compliance Automation events
  async publishComplianceCheck(data: {
    checkId: string;
    ruleId: string;
    jurisdiction: string;
    subjectType: string;
    subjectId: string;
    result: 'pass' | 'fail' | 'warning' | 'pending_review';
    evidenceRef?: string;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.COMPLIANCE_CHECKS, [{
      key: data.checkId,
      value: { event_id: data.checkId, source: 'compliance-automation', ...data }
    }]);
  }

  // Blockchain Audit events
  async publishBlockchainAnchor(data: {
    anchorId: string;
    ledgerHash: string;
    chainNetwork: string;
    txHash?: string;
    blockNumber?: number;
    merkleRoot?: string;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.BLOCKCHAIN_ANCHORS, [{
      key: data.anchorId,
      value: { event_id: data.anchorId, source: 'blockchain-audit', ...data }
    }]);
  }

  // DER Capabilities events
  async publishDERCapabilitiesUpdated(data: {
    assetId: string;
    capabilityType: string;
    powerMinKw?: number;
    powerMaxKw?: number;
    energyCapacityKwh?: number;
    rampRateKwMin?: number;
    responseTimeSec?: number;
    effectiveFrom?: Date;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.DER_CAPABILITIES_UPDATED, [{
      key: data.assetId,
      value: { event_id: `cap-${data.assetId}-${Date.now()}`, source: 'der-capabilities', ...data }
    }]);
  }

}

// Singleton instance
export const kafkaPublisher = new KafkaEventPublisher();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Kafka] Shutting down publisher...');
  await kafkaPublisher.disconnect();
});

process.on('SIGINT', async () => {
  console.log('[Kafka] Shutting down publisher...');
  await kafkaPublisher.disconnect();
});
