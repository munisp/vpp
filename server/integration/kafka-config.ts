import { Kafka, KafkaConfig, logLevel } from 'kafkajs';

export const kafkaConfig: KafkaConfig = {
  clientId: 'vpp-consumer-platform',
  brokers: process.env.KAFKA_BROKERS?.split(',') || ['localhost:9092'],
  ssl: process.env.KAFKA_SSL === 'true',
  sasl: process.env.KAFKA_SASL_ENABLED === 'true' ? {
    mechanism: 'plain',
    username: process.env.KAFKA_SASL_USERNAME || '',
    password: process.env.KAFKA_SASL_PASSWORD || ''
  } : undefined,
  retry: {
    initialRetryTime: 100,
    retries: 8,
    maxRetryTime: 30000,
    multiplier: 2
  },
  connectionTimeout: 10000,
  requestTimeout: 30000,
  logLevel: logLevel.INFO
};

export const kafka = new Kafka(kafkaConfig);

// Kafka topics
export const KAFKA_TOPICS = {
  // Core platform topics
  TELEMETRY_RAW: 'telemetry.raw',
  TELEMETRY_PROCESSED: 'telemetry.processed',
  TRADES_CREATED: 'trades.created',
  TRADES_SETTLED: 'trades.settled',
  PAYMENTS_INITIATED: 'payments.initiated',
  PAYMENTS_COMPLETED: 'payments.completed',
  PAYMENTS_FAILED: 'payments.failed',
  DR_EVENTS_CREATED: 'dr.events.created',
  DR_EVENTS_STARTED: 'dr.events.started',
  DR_EVENTS_COMPLETED: 'dr.events.completed',
  DR_RESPONSES: 'dr.responses',
  NOTIFICATIONS: 'notifications',
  USER_ACTIONS: 'user.actions',
  SYSTEM_EVENTS: 'system.events',
  
  // Next-gen service topics for lakehouse analytics
  // Probabilistic Forecasting
  FORECASTS_GENERATED: 'forecasts.generated',
  FORECASTS_EVALUATED: 'forecasts.evaluated',
  
  // Optimization Engine
  OPTIMIZATION_RUNS: 'optimization.runs',
  OPTIMIZATION_SCHEDULES: 'optimization.schedules',
  OPTIMIZATION_CONSTRAINTS: 'optimization.constraints',
  
  // Settlement Ledger
  SETTLEMENT_EVENTS: 'settlement.events',
  SETTLEMENT_PERIODS: 'settlement.periods',
  
  // Edge Orchestration
  EDGE_COMMANDS: 'edge.commands',
  EDGE_RESULTS: 'edge.results',
  EDGE_CONNECTIVITY: 'edge.connectivity',
  
  // V2G/EV Charging
  EV_SESSIONS: 'ev.sessions',
  EV_SCHEDULES: 'ev.schedules',
  EV_V2G_DISCHARGE: 'ev.v2g.discharge',
  
  // Carbon-Aware Dispatch
  CARBON_SIGNALS: 'carbon.signals',
  CARBON_SCHEDULES: 'carbon.schedules',
  CARBON_REC_EVENTS: 'carbon.rec.events',
  
  // Community Energy
  COMMUNITY_ALLOCATIONS: 'community.allocations',
  COMMUNITY_BALANCES: 'community.balances',
  COMMUNITY_ISLANDING: 'community.islanding',
  
  // MLOps Pipeline
  MLOPS_TRAINING_RUNS: 'mlops.training.runs',
  MLOPS_MODEL_REGISTRY: 'mlops.model.registry',
  MLOPS_DRIFT_EVENTS: 'mlops.drift.events',
  MLOPS_DEPLOYMENTS: 'mlops.deployments',
  
  // Anomaly Detection
  ANOMALIES_DETECTED: 'anomalies.detected',
  ANOMALIES_SCORES: 'anomalies.scores',
  ANOMALIES_FEEDBACK: 'anomalies.feedback',
  
  // Compliance Automation
  COMPLIANCE_CHECKS: 'compliance.checks',
  COMPLIANCE_VIOLATIONS: 'compliance.violations',
  COMPLIANCE_REMEDIATION: 'compliance.remediation',
  
  // Blockchain Audit
  BLOCKCHAIN_ANCHORS: 'blockchain.anchors',
  BLOCKCHAIN_PROOFS: 'blockchain.proofs',
  
  // DER Capabilities
  DER_CAPABILITIES_UPDATED: 'der.capabilities.updated',
  DER_AVAILABILITY_CHANGED: 'der.availability.changed'
} as const;
