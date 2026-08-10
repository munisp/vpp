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

// Event interfaces
export interface TelemetryEvent {
  deviceId: string;
  userId: string;
  assetId: string;
  timestamp: Date;
  metrics: Record<string, number>;
}

export interface TradeEvent {
  tradeId: string;
  userId: string;
  type: 'buy' | 'sell';
  quantity: number;
  price: number;
  timestamp: Date;
  status?: string;
}

export interface PaymentEvent {
  paymentId: string;
  userId: string;
  amount: number;
  currency: string;
  gateway: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

export interface DREvent {
  eventId: string;
  type: string;
  startTime: Date;
  endTime: Date;
  targetReduction: number;
  compensationRate: number;
  status?: string;
}

export interface DRResponseEvent {
  responseId: string;
  eventId: string;
  userId: string;
  participated: boolean;
  actualReduction?: number;
  timestamp: Date;
}

export interface NotificationEvent {
  userId: string;
  type: string;
  title: string;
  message: string;
  timestamp: Date;
  metadata?: Record<string, any>;
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

  // Telemetry events
  async publishTelemetry(data: TelemetryEvent): Promise<void> {
    await this.publish(KAFKA_TOPICS.TELEMETRY_RAW, [{
      key: data.deviceId,
      value: data
    }]);
  }

  async publishTelemetryBatch(data: TelemetryEvent[]): Promise<void> {
    await this.publish(KAFKA_TOPICS.TELEMETRY_RAW, 
      data.map(d => ({ key: d.deviceId, value: d }))
    );
  }

  // Trade events
  async publishTradeCreated(data: TradeEvent): Promise<void> {
    await this.publish(KAFKA_TOPICS.TRADES_CREATED, [{
      key: data.tradeId,
      value: data
    }]);
  }

  async publishTradeSettled(data: {
    tradeId: string;
    settledAt: Date;
    finalPrice: number;
    finalQuantity: number;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.TRADES_SETTLED, [{
      key: data.tradeId,
      value: data
    }]);
  }

  // Payment events
  async publishPaymentInitiated(data: PaymentEvent): Promise<void> {
    await this.publish(KAFKA_TOPICS.PAYMENTS_INITIATED, [{
      key: data.paymentId,
      value: data
    }]);
  }

  async publishPaymentCompleted(data: {
    paymentId: string;
    completedAt: Date;
    transactionId: string;
    amount: number;
    gateway: string;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.PAYMENTS_COMPLETED, [{
      key: data.paymentId,
      value: data
    }]);
  }

  async publishPaymentFailed(data: {
    paymentId: string;
    failedAt: Date;
    reason: string;
    gateway: string;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.PAYMENTS_FAILED, [{
      key: data.paymentId,
      value: data
    }]);
  }

  // DR events
  async publishDREventCreated(data: DREvent): Promise<void> {
    await this.publish(KAFKA_TOPICS.DR_EVENTS_CREATED, [{
      key: data.eventId,
      value: data
    }]);
  }

  async publishDREventStarted(data: {
    eventId: string;
    startedAt: Date;
    participantCount: number;
    targetReduction: number;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.DR_EVENTS_STARTED, [{
      key: data.eventId,
      value: data
    }]);
  }

  async publishDREventCompleted(data: {
    eventId: string;
    completedAt: Date;
    actualReduction: number;
    compensationPaid: number;
    participantCount: number;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.DR_EVENTS_COMPLETED, [{
      key: data.eventId,
      value: data
    }]);
  }

  async publishDRResponse(data: DRResponseEvent): Promise<void> {
    await this.publish(KAFKA_TOPICS.DR_RESPONSES, [{
      key: data.responseId,
      value: data
    }]);
  }

  // Notification events
  async publishNotification(data: NotificationEvent): Promise<void> {
    await this.publish(KAFKA_TOPICS.NOTIFICATIONS, [{
      key: data.userId,
      value: data
    }]);
  }

  async publishNotificationBatch(data: NotificationEvent[]): Promise<void> {
    await this.publish(KAFKA_TOPICS.NOTIFICATIONS,
      data.map(d => ({ key: d.userId, value: d }))
    );
  }

  // User action events
  async publishUserAction(data: {
    userId: string;
    action: string;
    resource: string;
    timestamp: Date;
    metadata?: Record<string, any>;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.USER_ACTIONS, [{
      key: data.userId,
      value: data
    }]);
  }

  // System events
  async publishSystemEvent(data: {
    eventType: string;
    severity: 'info' | 'warning' | 'error' | 'critical';
    message: string;
    timestamp: Date;
    metadata?: Record<string, any>;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.SYSTEM_EVENTS, [{
      key: data.eventType,
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

  async publishForecastEvaluated(data: {
    forecastId: string;
    targetType: string;
    mae: number;
    rmse: number;
    mape: number;
    actualValue: number;
    predictedValue: number;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.FORECASTS_EVALUATED, [{
      key: data.forecastId,
      value: { event_id: `eval-${data.forecastId}`, source: 'probabilistic-forecasting', ...data }
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

  async publishOptimizationSchedule(data: {
    runId: string;
    assetId: string;
    scheduleJson: string;
    startTime: Date;
    endTime: Date;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.OPTIMIZATION_SCHEDULES, [{
      key: `${data.runId}-${data.assetId}`,
      value: { event_id: `${data.runId}-${data.assetId}`, source: 'optimization-engine', ...data }
    }]);
  }

  // Settlement Ledger events
  async publishSettlementEvent(data: {
    settlementId: string;
    eventType: string;
    periodStart?: Date;
    periodEnd?: Date;
    assetId?: string;
    meterId?: string;
    quantityKwh?: number;
    amount?: number;
    currency?: string;
    hashPrev?: string;
    hashCurr: string;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.SETTLEMENT_EVENTS, [{
      key: data.settlementId,
      value: { event_id: data.settlementId, source: 'settlement-ledger', ...data }
    }]);
  }

  async publishSettlementPeriod(data: {
    periodId: string;
    periodStart: Date;
    periodEnd: Date;
    totalEvents: number;
    totalAmount: number;
    currency: string;
    merkleRoot: string;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.SETTLEMENT_PERIODS, [{
      key: data.periodId,
      value: { event_id: data.periodId, source: 'settlement-ledger', ...data }
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

  async publishEdgeResult(data: {
    commandId: string;
    gatewayId: string;
    deviceId?: string;
    status: string;
    ackedAt?: Date;
    offlineExecuted: boolean;
    signatureValid: boolean;
    retryCount: number;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.EDGE_RESULTS, [{
      key: data.commandId,
      value: { event_id: `result-${data.commandId}`, source: 'edge-orchestration', ...data }
    }]);
  }

  async publishEdgeConnectivity(data: {
    gatewayId: string;
    status: 'online' | 'offline' | 'degraded';
    lastHeartbeat: Date;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.EDGE_CONNECTIVITY, [{
      key: data.gatewayId,
      value: { event_id: `conn-${data.gatewayId}-${Date.now()}`, source: 'edge-orchestration', ...data }
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

  async publishEVSchedule(data: {
    scheduleId: string;
    chargerId: string;
    userId: string;
    scheduleJson: string;
    departureTime: Date;
    targetSoc: number;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.EV_SCHEDULES, [{
      key: data.scheduleId,
      value: { event_id: data.scheduleId, source: 'ev-charging', ...data }
    }]);
  }

  async publishV2GDischarge(data: {
    sessionId: string;
    chargerId: string;
    userId: string;
    dischargeKwh: number;
    gridSupportType: string;
    compensationAmount: number;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.EV_V2G_DISCHARGE, [{
      key: data.sessionId,
      value: { event_id: `v2g-${data.sessionId}`, source: 'ev-charging', ...data }
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

  async publishCarbonSchedule(data: {
    scheduleId: string;
    assetId: string;
    scheduleJson: string;
    emissionsAvoided: number;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.CARBON_SCHEDULES, [{
      key: data.scheduleId,
      value: { event_id: data.scheduleId, source: 'carbon-aware-dispatch', ...data }
    }]);
  }

  async publishRECEvent(data: {
    recId: string;
    recAction: 'issued' | 'retired' | 'transferred';
    recQuantityMwh: number;
    assetId?: string;
    userId?: string;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.CARBON_REC_EVENTS, [{
      key: data.recId,
      value: { event_id: data.recId, source: 'carbon-aware-dispatch', ...data }
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

  async publishCommunityBalance(data: {
    communityId: string;
    memberId: string;
    credits: number;
    debits: number;
    netBalance: number;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.COMMUNITY_BALANCES, [{
      key: `${data.communityId}-${data.memberId}`,
      value: { event_id: `bal-${data.communityId}-${data.memberId}`, source: 'community-energy', ...data }
    }]);
  }

  async publishCommunityIslanding(data: {
    communityId: string;
    islandingActive: boolean;
    gridConnected: boolean;
    reason: string;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.COMMUNITY_ISLANDING, [{
      key: data.communityId,
      value: { event_id: `island-${data.communityId}-${Date.now()}`, source: 'community-energy', ...data }
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

  async publishMLOpsModelRegistry(data: {
    modelId: string;
    modelName: string;
    modelVersion: string;
    deploymentState: string;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.MLOPS_MODEL_REGISTRY, [{
      key: data.modelId,
      value: { event_id: `reg-${data.modelId}`, source: 'mlops-pipeline', event_type: 'model_registry', ...data }
    }]);
  }

  async publishMLOpsDriftEvent(data: {
    modelId: string;
    driftScore: number;
    driftType: string;
    threshold: number;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.MLOPS_DRIFT_EVENTS, [{
      key: data.modelId,
      value: { event_id: `drift-${data.modelId}-${Date.now()}`, source: 'mlops-pipeline', event_type: 'drift_event', ...data }
    }]);
  }

  async publishMLOpsDeployment(data: {
    modelId: string;
    modelVersion: string;
    deploymentState: 'deployed' | 'rolled_back' | 'canary';
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.MLOPS_DEPLOYMENTS, [{
      key: data.modelId,
      value: { event_id: `deploy-${data.modelId}-${Date.now()}`, source: 'mlops-pipeline', event_type: 'deployment', ...data }
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

  async publishAnomalyScore(data: {
    assetId: string;
    score: number;
    components: Record<string, number>;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.ANOMALIES_SCORES, [{
      key: data.assetId,
      value: { event_id: `score-${data.assetId}-${Date.now()}`, source: 'anomaly-detection', ...data }
    }]);
  }

  async publishAnomalyFeedback(data: {
    anomalyId: string;
    label: 'true_positive' | 'false_positive' | 'unknown';
    feedbackBy: string;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.ANOMALIES_FEEDBACK, [{
      key: data.anomalyId,
      value: { event_id: `fb-${data.anomalyId}`, source: 'anomaly-detection', ...data }
    }]);
  }

  // Compliance Automation events
  async publishComplianceCheck(data: {
    checkId: string;
    ruleId: string;
    jurisdiction: string;
    subjectType: string;
    subjectId: string;
    result: 'pass' | 'fail' | 'warning';
    evidenceRef?: string;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.COMPLIANCE_CHECKS, [{
      key: data.checkId,
      value: { event_id: data.checkId, source: 'compliance-automation', ...data }
    }]);
  }

  async publishComplianceViolation(data: {
    checkId: string;
    ruleId: string;
    jurisdiction: string;
    subjectId: string;
    violationDetails: string;
    severity: string;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.COMPLIANCE_VIOLATIONS, [{
      key: data.checkId,
      value: { event_id: `viol-${data.checkId}`, source: 'compliance-automation', ...data }
    }]);
  }

  async publishComplianceRemediation(data: {
    checkId: string;
    remediationAction: string;
    status: 'pending' | 'in_progress' | 'completed';
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.COMPLIANCE_REMEDIATION, [{
      key: data.checkId,
      value: { event_id: `rem-${data.checkId}`, source: 'compliance-automation', ...data }
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

  async publishBlockchainProof(data: {
    anchorId: string;
    proofJson: string;
    verificationStatus: 'verified' | 'failed' | 'pending';
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.BLOCKCHAIN_PROOFS, [{
      key: data.anchorId,
      value: { event_id: `proof-${data.anchorId}`, source: 'blockchain-audit', ...data }
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

  async publishDERAvailabilityChanged(data: {
    assetId: string;
    availabilityStart?: Date;
    availabilityEnd?: Date;
    available: boolean;
    reason?: string;
    timestamp: Date;
  }): Promise<void> {
    await this.publish(KAFKA_TOPICS.DER_AVAILABILITY_CHANGED, [{
      key: data.assetId,
      value: { event_id: `avail-${data.assetId}-${Date.now()}`, source: 'der-capabilities', ...data }
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
