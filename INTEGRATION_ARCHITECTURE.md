# VPP Platform Integration Architecture

## Overview

This document describes the integration layer that connects the consumer-facing VPP platform (Node.js/TypeScript) with the enterprise nextgen platform middleware (Go/Python), creating a unified, production-ready system.

## Integration Principles

1. **Preserve All Features**: No existing functionality is removed or degraded
2. **Gradual Migration**: Services can be migrated incrementally
3. **Backward Compatibility**: Existing APIs continue to work
4. **Zero Downtime**: Integration happens without service interruption
5. **Performance**: Integration layer adds minimal latency (<10ms)

## Architecture Layers

### Layer 1: Consumer Platform (Existing)
- Web application (React + Node.js/TypeScript)
- Mobile app (React Native)
- tRPC API
- PostgreSQL database
- Current authentication (Manus OAuth)

### Layer 2: Integration Layer (New)
- Event publishers (Kafka producers)
- Workflow adapters (Temporal clients)
- Auth bridge (Keycloak adapter)
- Cache adapter (Redis client)
- API gateway adapter (APISIX routes)

### Layer 3: NextGen Middleware (Existing)
- Kafka event streaming
- Temporal workflows
- Keycloak IAM
- Redis caching
- APISIX gateway
- Prometheus/Jaeger observability

### Layer 4: NextGen Services (Existing)
- Grid services (pandapower, threat prediction)
- DR services (OpenLEADR)
- Trading services (optimization)
- EV charging (EVerest, CitrineOS)
- Forecasting (OpenSTEF)
- Lakehouse analytics

## Integration Components

### 1. Kafka Event Bridge

**Purpose**: Publish consumer platform events to Kafka for downstream processing

**Implementation**:
```typescript
// server/integration/kafka-bridge.ts
import { Kafka } from 'kafkajs';

export class KafkaEventBridge {
  private kafka: Kafka;
  private producer: Producer;
  
  async publishTelemetry(data: TelemetryEvent) {
    await this.producer.send({
      topic: 'telemetry.raw',
      messages: [{ value: JSON.stringify(data) }]
    });
  }
  
  async publishTrade(data: TradeEvent) {
    await this.producer.send({
      topic: 'trades.created',
      messages: [{ value: JSON.stringify(data) }]
    });
  }
  
  async publishPayment(data: PaymentEvent) {
    await this.producer.send({
      topic: 'payments.initiated',
      messages: [{ value: JSON.stringify(data) }]
    });
  }
  
  async publishDREvent(data: DREvent) {
    await this.producer.send({
      topic: 'dr.events.created',
      messages: [{ value: JSON.stringify(data) }]
    });
  }
}
```

**Topics**:
- `telemetry.raw` - IoT device telemetry
- `telemetry.processed` - Processed telemetry
- `trades.created` - New energy trades
- `trades.settled` - Completed trades
- `payments.initiated` - Payment requests
- `payments.completed` - Successful payments
- `payments.failed` - Failed payments
- `dr.events.created` - New DR events
- `dr.events.started` - Active DR events
- `dr.events.completed` - Completed DR events
- `dr.responses` - User DR responses
- `notifications` - User notifications

### 2. Temporal Workflow Adapter

**Purpose**: Use Temporal workflows for long-running processes

**Implementation**:
```typescript
// server/integration/temporal-adapter.ts
import { Client, Connection } from '@temporalio/client';

export class TemporalWorkflowAdapter {
  private client: Client;
  
  async startDREventWorkflow(eventId: string) {
    const handle = await this.client.workflow.start('drEventOrchestration', {
      taskQueue: 'vpp-workflows',
      workflowId: `dr-event-${eventId}`,
      args: [{ eventId }]
    });
    return handle.workflowId;
  }
  
  async startPaymentWorkflow(paymentId: string) {
    const handle = await this.client.workflow.start('paymentProcessing', {
      taskQueue: 'vpp-workflows',
      workflowId: `payment-${paymentId}`,
      args: [{ paymentId }]
    });
    return handle.workflowId;
  }
  
  async startReconciliationWorkflow(date: string) {
    const handle = await this.client.workflow.start('reconciliation', {
      taskQueue: 'vpp-workflows',
      workflowId: `reconciliation-${date}`,
      args: [{ date }]
    });
    return handle.workflowId;
  }
}
```

**Workflows**:
- `drEventOrchestration` - DR event lifecycle management
- `paymentProcessing` - Payment processing with retries
- `reconciliation` - Daily payment reconciliation
- `tradingSettlement` - Energy trading settlement
- `billingGeneration` - Monthly billing generation

### 3. Keycloak Auth Bridge

**Purpose**: Migrate authentication to Keycloak while maintaining backward compatibility

**Implementation**:
```typescript
// server/integration/keycloak-bridge.ts
import Keycloak from 'keycloak-connect';

export class KeycloakAuthBridge {
  private keycloak: Keycloak.Keycloak;
  
  async migrateUser(manusUser: User) {
    // Create user in Keycloak
    const keycloakUser = await this.keycloak.users.create({
      username: manusUser.email,
      email: manusUser.email,
      firstName: manusUser.name,
      enabled: true,
      emailVerified: true
    });
    
    // Assign roles
    if (manusUser.role === 'admin') {
      await this.assignRole(keycloakUser.id, 'admin');
    }
    
    return keycloakUser;
  }
  
  async validateToken(token: string) {
    // Validate JWT token from Keycloak
    return this.keycloak.grantManager.validateAccessToken(token);
  }
  
  async getUserInfo(token: string) {
    const grant = await this.keycloak.grantManager.createGrant({ access_token: token });
    return grant.access_token.content;
  }
}
```

**Migration Strategy**:
1. Phase 1: Dual authentication (Manus OAuth + Keycloak)
2. Phase 2: Gradual user migration
3. Phase 3: Keycloak as primary
4. Phase 4: Deprecate Manus OAuth

### 4. Redis Cache Adapter

**Purpose**: Centralized caching layer

**Implementation**:
```typescript
// server/integration/redis-adapter.ts
import Redis from 'ioredis';

export class RedisCacheAdapter {
  private redis: Redis;
  
  async cacheUserSession(userId: string, session: any, ttl: number = 3600) {
    await this.redis.setex(`session:${userId}`, ttl, JSON.stringify(session));
  }
  
  async getUserSession(userId: string) {
    const data = await this.redis.get(`session:${userId}`);
    return data ? JSON.parse(data) : null;
  }
  
  async cacheAssetData(assetId: string, data: any, ttl: number = 300) {
    await this.redis.setex(`asset:${assetId}`, ttl, JSON.stringify(data));
  }
  
  async cacheLeaderboard(data: any[], ttl: number = 60) {
    await this.redis.setex('leaderboard:current', ttl, JSON.stringify(data));
  }
  
  async invalidateCache(pattern: string) {
    const keys = await this.redis.keys(pattern);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }
}
```

**Cache Strategy**:
- User sessions: 1 hour TTL
- Asset data: 5 minutes TTL
- Leaderboard: 1 minute TTL
- Analytics: 10 minutes TTL
- Market prices: 30 seconds TTL

### 5. APISIX Gateway Configuration

**Purpose**: Unified API gateway for all services

**Configuration**:
```yaml
# middleware/apisix/apisix.yaml
routes:
  # Consumer platform routes
  - uri: /api/*
    upstream:
      type: roundrobin
      nodes:
        "consumer-platform:3000": 1
    plugins:
      rate-limit:
        count: 100
        time_window: 60
      jwt-auth: {}
      prometheus: {}
  
  # NextGen services routes
  - uri: /grid/*
    upstream:
      type: roundrobin
      nodes:
        "grid-services:8080": 1
    plugins:
      rate-limit:
        count: 50
        time_window: 60
      jwt-auth: {}
  
  - uri: /forecasting/*
    upstream:
      type: roundrobin
      nodes:
        "forecasting-service:8081": 1
    plugins:
      rate-limit:
        count: 30
        time_window: 60
      jwt-auth: {}
  
  - uri: /trading/*
    upstream:
      type: roundrobin
      nodes:
        "trading-service:8082": 1
    plugins:
      rate-limit:
        count: 50
        time_window: 60
      jwt-auth: {}
```

### 6. Lakehouse Data Pipeline

**Purpose**: Send analytics data to lakehouse for advanced analytics

**Implementation**:
```typescript
// server/integration/lakehouse-adapter.ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

export class LakehouseAdapter {
  private s3: S3Client;
  
  async sendTelemetryData(data: TelemetryRecord[]) {
    const parquetData = this.convertToParquet(data);
    await this.s3.send(new PutObjectCommand({
      Bucket: 'vpp-lakehouse',
      Key: `bronze/telemetry/${Date.now()}.parquet`,
      Body: parquetData
    }));
  }
  
  async sendTradeData(data: TradeRecord[]) {
    const parquetData = this.convertToParquet(data);
    await this.s3.send(new PutObjectCommand({
      Bucket: 'vpp-lakehouse',
      Key: `bronze/trades/${Date.now()}.parquet`,
      Body: parquetData
    }));
  }
  
  async sendPaymentData(data: PaymentRecord[]) {
    const parquetData = this.convertToParquet(data);
    await this.s3.send(new PutObjectCommand({
      Bucket: 'vpp-lakehouse',
      Key: `bronze/payments/${Date.now()}.parquet`,
      Body: parquetData
    }));
  }
}
```

## Data Flow Examples

### Example 1: Telemetry Ingestion with Integration

```
IoT Device → MQTT → Consumer Platform → Kafka (telemetry.raw)
  → Fluvio Processing → Kafka (telemetry.processed)
  → Lakehouse (Bronze Layer)
  → Analytics Pipeline → Lakehouse (Silver/Gold)
  → Superset Dashboards
```

### Example 2: DR Event with Temporal Workflow

```
Admin → Consumer Platform → Temporal Workflow Start
  → Workflow Step 1: Calculate pricing
  → Workflow Step 2: Notify participants (Kafka)
  → Workflow Step 3: Wait for event start
  → Workflow Step 4: Monitor responses
  → Workflow Step 5: Calculate compensation
  → Workflow Step 6: Process payments
  → Workflow Step 7: Generate report
```

### Example 3: Payment Processing with Reconciliation

```
User → Consumer Platform → Payment Gateway
  → Webhook → Consumer Platform → Kafka (payments.completed)
  → Temporal Reconciliation Workflow
  → Query Gateway Status
  → Match with Database
  → Update Ledger
  → Send Notification
```

## API Contracts

### Kafka Event Schemas

```typescript
// Telemetry Event
interface TelemetryEvent {
  deviceId: string;
  userId: string;
  assetId: string;
  timestamp: string;
  metrics: {
    powerGeneration?: number;
    powerConsumption?: number;
    batteryLevel?: number;
    voltage?: number;
    current?: number;
  };
}

// Trade Event
interface TradeEvent {
  tradeId: string;
  userId: string;
  type: 'buy' | 'sell';
  quantity: number;
  price: number;
  timestamp: string;
  status: 'pending' | 'completed' | 'cancelled';
}

// Payment Event
interface PaymentEvent {
  paymentId: string;
  userId: string;
  amount: number;
  currency: string;
  gateway: 'mpesa' | 'airtel' | 'tigo';
  status: 'initiated' | 'completed' | 'failed';
  timestamp: string;
}

// DR Event
interface DREvent {
  eventId: string;
  type: string;
  startTime: string;
  endTime: string;
  targetReduction: number;
  compensationRate: number;
  status: 'scheduled' | 'active' | 'completed';
}
```

### Temporal Workflow Inputs

```typescript
// DR Event Workflow
interface DREventWorkflowInput {
  eventId: string;
  type: string;
  startTime: Date;
  endTime: Date;
  targetReduction: number;
  compensationRate: number;
}

// Payment Workflow
interface PaymentWorkflowInput {
  paymentId: string;
  userId: string;
  amount: number;
  gateway: string;
  metadata: Record<string, any>;
}

// Reconciliation Workflow
interface ReconciliationWorkflowInput {
  date: string;
  gateway?: string;
}
```

## Deployment Strategy

### Phase 1: Infrastructure Setup (Week 1)
- Deploy Kafka cluster
- Deploy Temporal server
- Deploy Keycloak
- Deploy Redis cluster
- Deploy APISIX gateway
- Configure monitoring (Prometheus/Jaeger)

### Phase 2: Integration Layer (Week 2-3)
- Build Kafka event bridge
- Implement Temporal adapters
- Create Keycloak auth bridge
- Setup Redis cache adapter
- Configure APISIX routes
- Build lakehouse adapter

### Phase 3: Feature Migration (Week 4-6)
- Migrate telemetry to Kafka
- Migrate DR workflows to Temporal
- Migrate payments to Temporal
- Migrate auth to Keycloak
- Connect analytics to lakehouse
- Add monitoring and tracing

### Phase 4: Testing & Optimization (Week 7-8)
- Integration testing
- Performance testing
- Load testing
- Security testing
- Documentation
- Training

### Phase 5: Production Rollout (Week 9-10)
- Gradual traffic migration
- Monitor metrics
- Fix issues
- Complete migration
- Deprecate old systems

## Monitoring & Observability

### Metrics to Track
- Event publishing rate (Kafka)
- Workflow execution time (Temporal)
- Cache hit rate (Redis)
- API response time (APISIX)
- Authentication success rate (Keycloak)
- Data pipeline latency (Lakehouse)

### Dashboards
- System overview (Grafana)
- Kafka metrics
- Temporal workflows
- Redis performance
- APISIX traffic
- Application metrics

### Alerts
- Kafka lag > 1000 messages
- Temporal workflow failures
- Redis memory > 80%
- APISIX error rate > 1%
- Authentication failures > 5%
- Data pipeline delays > 5 minutes

## Security Considerations

### Authentication
- Keycloak for centralized IAM
- JWT tokens for API access
- mTLS for service-to-service communication
- API key rotation

### Authorization
- Role-based access control (RBAC)
- Resource-level permissions
- API gateway authorization
- Audit logging

### Data Protection
- Encryption at rest (database, S3)
- Encryption in transit (TLS)
- Secret management (Dapr secrets)
- PII data masking

### Network Security
- Private network for services
- API gateway as single entry point
- Network policies
- DDoS protection

## Performance Targets

- API response time: p95 < 200ms
- Event publishing latency: < 10ms
- Workflow execution: < 5 seconds
- Cache response time: < 5ms
- Authentication: < 100ms
- Data pipeline: < 1 minute end-to-end

## Next Steps

1. Setup infrastructure with Docker Compose
2. Implement Kafka event bridge
3. Build Temporal workflow adapters
4. Create Keycloak auth bridge
5. Setup Redis cache adapter
6. Configure APISIX gateway
7. Build lakehouse data pipeline
8. Add monitoring and observability
9. Integration testing
10. Production deployment
