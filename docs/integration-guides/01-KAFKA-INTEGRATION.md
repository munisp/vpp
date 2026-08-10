# Kafka Integration Implementation Guide

## Overview

This guide provides step-by-step instructions for integrating Apache Kafka event streaming into the VPP consumer platform, connecting it to the nextgen platform's existing Kafka infrastructure.

## Prerequisites

- Access to nextgen_vpp_platform Kafka cluster
- Node.js 18+ with TypeScript
- Kafka client library (kafkajs)
- Understanding of event-driven architecture

## Architecture

```
Consumer Platform → Kafka Producer → Kafka Cluster → Kafka Consumers → NextGen Services
                                                    → Lakehouse
                                                    → Analytics
                                                    → Monitoring
```

## Step 1: Install Dependencies

```bash
cd /home/ubuntu/vpp_consumer_platform
pnpm add kafkajs
pnpm add -D @types/kafkajs
```

## Step 2: Configure Kafka Connection

Create configuration file:

```typescript
// server/integration/kafka-config.ts
import { Kafka, KafkaConfig } from 'kafkajs';

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
    retries: 8
  }
};

export const kafka = new Kafka(kafkaConfig);
```

Add environment variables to `.env`:

```bash
KAFKA_BROKERS=localhost:9092,localhost:9093,localhost:9094
KAFKA_SSL=false
KAFKA_SASL_ENABLED=false
KAFKA_SASL_USERNAME=
KAFKA_SASL_PASSWORD=
```

## Step 3: Create Event Publisher Service

```typescript
// server/integration/kafka-publisher.ts
import { kafka } from './kafka-config';
import { Producer, ProducerRecord } from 'kafkajs';

export class KafkaEventPublisher {
  private producer: Producer;
  private connected: boolean = false;

  constructor() {
    this.producer = kafka.producer({
      allowAutoTopicCreation: false,
      transactionTimeout: 30000
    });
  }

  async connect() {
    if (!this.connected) {
      await this.producer.connect();
      this.connected = true;
      console.log('[Kafka] Producer connected');
    }
  }

  async disconnect() {
    if (this.connected) {
      await this.producer.disconnect();
      this.connected = false;
      console.log('[Kafka] Producer disconnected');
    }
  }

  private async publish(topic: string, messages: any[]) {
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
            'timestamp': Date.now().toString()
          }
        }))
      };

      await this.producer.send(record);
      console.log(`[Kafka] Published ${messages.length} messages to ${topic}`);
    } catch (error) {
      console.error(`[Kafka] Error publishing to ${topic}:`, error);
      throw error;
    }
  }

  // Telemetry events
  async publishTelemetry(data: {
    deviceId: string;
    userId: string;
    assetId: string;
    timestamp: Date;
    metrics: Record<string, number>;
  }) {
    await this.publish('telemetry.raw', [{
      key: data.deviceId,
      value: data
    }]);
  }

  // Trade events
  async publishTradeCreated(data: {
    tradeId: string;
    userId: string;
    type: 'buy' | 'sell';
    quantity: number;
    price: number;
    timestamp: Date;
  }) {
    await this.publish('trades.created', [{
      key: data.tradeId,
      value: data
    }]);
  }

  async publishTradeSettled(data: {
    tradeId: string;
    settledAt: Date;
    finalPrice: number;
  }) {
    await this.publish('trades.settled', [{
      key: data.tradeId,
      value: data
    }]);
  }

  // Payment events
  async publishPaymentInitiated(data: {
    paymentId: string;
    userId: string;
    amount: number;
    currency: string;
    gateway: string;
    timestamp: Date;
  }) {
    await this.publish('payments.initiated', [{
      key: data.paymentId,
      value: data
    }]);
  }

  async publishPaymentCompleted(data: {
    paymentId: string;
    completedAt: Date;
    transactionId: string;
  }) {
    await this.publish('payments.completed', [{
      key: data.paymentId,
      value: data
    }]);
  }

  async publishPaymentFailed(data: {
    paymentId: string;
    failedAt: Date;
    reason: string;
  }) {
    await this.publish('payments.failed', [{
      key: data.paymentId,
      value: data
    }]);
  }

  // DR events
  async publishDREventCreated(data: {
    eventId: string;
    type: string;
    startTime: Date;
    endTime: Date;
    targetReduction: number;
    compensationRate: number;
  }) {
    await this.publish('dr.events.created', [{
      key: data.eventId,
      value: data
    }]);
  }

  async publishDREventStarted(data: {
    eventId: string;
    startedAt: Date;
    participantCount: number;
  }) {
    await this.publish('dr.events.started', [{
      key: data.eventId,
      value: data
    }]);
  }

  async publishDREventCompleted(data: {
    eventId: string;
    completedAt: Date;
    actualReduction: number;
    compensationPaid: number;
  }) {
    await this.publish('dr.events.completed', [{
      key: data.eventId,
      value: data
    }]);
  }

  async publishDRResponse(data: {
    responseId: string;
    eventId: string;
    userId: string;
    participated: boolean;
    actualReduction?: number;
  }) {
    await this.publish('dr.responses', [{
      key: data.responseId,
      value: data
    }]);
  }

  // User notifications
  async publishNotification(data: {
    userId: string;
    type: string;
    title: string;
    message: string;
    timestamp: Date;
  }) {
    await this.publish('notifications', [{
      key: data.userId,
      value: data
    }]);
  }
}

// Singleton instance
export const kafkaPublisher = new KafkaEventPublisher();
```

## Step 4: Integrate with Existing Code

### Telemetry Integration

```typescript
// server/routers/telemetry.ts
import { kafkaPublisher } from '../integration/kafka-publisher';

// In your telemetry ingestion endpoint
publicProcedure
  .input(z.object({
    deviceId: z.string(),
    assetId: z.string(),
    metrics: z.record(z.number())
  }))
  .mutation(async ({ input, ctx }) => {
    // Save to database (existing code)
    const telemetry = await saveTelemetry(input);
    
    // Publish to Kafka (new)
    await kafkaPublisher.publishTelemetry({
      deviceId: input.deviceId,
      userId: ctx.user.id,
      assetId: input.assetId,
      timestamp: new Date(),
      metrics: input.metrics
    });
    
    return telemetry;
  });
```

### Trading Integration

```typescript
// server/routers/trading.ts
import { kafkaPublisher } from '../integration/kafka-publisher';

// In your trade creation endpoint
protectedProcedure
  .input(z.object({
    type: z.enum(['buy', 'sell']),
    quantity: z.number(),
    price: z.number()
  }))
  .mutation(async ({ input, ctx }) => {
    // Create trade (existing code)
    const trade = await createTrade({
      userId: ctx.user.id,
      ...input
    });
    
    // Publish to Kafka (new)
    await kafkaPublisher.publishTradeCreated({
      tradeId: trade.id,
      userId: ctx.user.id,
      type: input.type,
      quantity: input.quantity,
      price: input.price,
      timestamp: new Date()
    });
    
    return trade;
  });
```

### Payment Integration

```typescript
// server/routers/payments.ts
import { kafkaPublisher } from '../integration/kafka-publisher';

// In your payment initiation endpoint
protectedProcedure
  .input(z.object({
    amount: z.number(),
    gateway: z.enum(['mpesa', 'airtel', 'tigo'])
  }))
  .mutation(async ({ input, ctx }) => {
    // Initiate payment (existing code)
    const payment = await initiatePayment({
      userId: ctx.user.id,
      ...input
    });
    
    // Publish to Kafka (new)
    await kafkaPublisher.publishPaymentInitiated({
      paymentId: payment.id,
      userId: ctx.user.id,
      amount: input.amount,
      currency: 'TZS',
      gateway: input.gateway,
      timestamp: new Date()
    });
    
    return payment;
  });

// In your payment webhook handler
async function handlePaymentWebhook(data: any) {
  // Update payment status (existing code)
  const payment = await updatePaymentStatus(data.paymentId, 'completed');
  
  // Publish to Kafka (new)
  if (payment.status === 'completed') {
    await kafkaPublisher.publishPaymentCompleted({
      paymentId: payment.id,
      completedAt: new Date(),
      transactionId: data.transactionId
    });
  } else {
    await kafkaPublisher.publishPaymentFailed({
      paymentId: payment.id,
      failedAt: new Date(),
      reason: data.reason
    });
  }
}
```

### DR Integration

```typescript
// server/routers/demandResponse.ts
import { kafkaPublisher } from '../integration/kafka-publisher';

// In your DR event creation endpoint
adminProcedure
  .input(z.object({
    type: z.string(),
    startTime: z.date(),
    endTime: z.date(),
    targetReduction: z.number(),
    compensationRate: z.number()
  }))
  .mutation(async ({ input }) => {
    // Create DR event (existing code)
    const event = await createDREvent(input);
    
    // Publish to Kafka (new)
    await kafkaPublisher.publishDREventCreated({
      eventId: event.id,
      type: input.type,
      startTime: input.startTime,
      endTime: input.endTime,
      targetReduction: input.targetReduction,
      compensationRate: input.compensationRate
    });
    
    return event;
  });
```

## Step 5: Create Kafka Topics

Connect to nextgen platform and create topics:

```bash
cd /home/ubuntu/nextgen_vpp_platform

# Create topics
docker-compose exec kafka kafka-topics --create \
  --bootstrap-server localhost:9092 \
  --topic telemetry.raw \
  --partitions 6 \
  --replication-factor 3

docker-compose exec kafka kafka-topics --create \
  --bootstrap-server localhost:9092 \
  --topic trades.created \
  --partitions 3 \
  --replication-factor 3

docker-compose exec kafka kafka-topics --create \
  --bootstrap-server localhost:9092 \
  --topic trades.settled \
  --partitions 3 \
  --replication-factor 3

docker-compose exec kafka kafka-topics --create \
  --bootstrap-server localhost:9092 \
  --topic payments.initiated \
  --partitions 3 \
  --replication-factor 3

docker-compose exec kafka kafka-topics --create \
  --bootstrap-server localhost:9092 \
  --topic payments.completed \
  --partitions 3 \
  --replication-factor 3

docker-compose exec kafka kafka-topics --create \
  --bootstrap-server localhost:9092 \
  --topic payments.failed \
  --partitions 3 \
  --replication-factor 3

docker-compose exec kafka kafka-topics --create \
  --bootstrap-server localhost:9092 \
  --topic dr.events.created \
  --partitions 3 \
  --replication-factor 3

docker-compose exec kafka kafka-topics --create \
  --bootstrap-server localhost:9092 \
  --topic dr.events.started \
  --partitions 3 \
  --replication-factor 3

docker-compose exec kafka kafka-topics --create \
  --bootstrap-server localhost:9092 \
  --topic dr.events.completed \
  --partitions 3 \
  --replication-factor 3

docker-compose exec kafka kafka-topics --create \
  --bootstrap-server localhost:9092 \
  --topic dr.responses \
  --partitions 6 \
  --replication-factor 3

docker-compose exec kafka kafka-topics --create \
  --bootstrap-server localhost:9092 \
  --topic notifications \
  --partitions 6 \
  --replication-factor 3
```

## Step 6: Initialize Kafka on Server Startup

```typescript
// server/_core/index.ts
import { kafkaPublisher } from '../integration/kafka-publisher';

// In your server startup code
async function startServer() {
  // Existing server setup...
  
  // Connect Kafka producer
  try {
    await kafkaPublisher.connect();
    console.log('[Kafka] Event publisher initialized');
  } catch (error) {
    console.error('[Kafka] Failed to initialize publisher:', error);
    // Decide whether to fail startup or continue without Kafka
  }
  
  // Graceful shutdown
  process.on('SIGTERM', async () => {
    await kafkaPublisher.disconnect();
    process.exit(0);
  });
}
```

## Step 7: Monitoring and Observability

### Add Prometheus Metrics

```typescript
// server/integration/kafka-metrics.ts
import { Counter, Histogram } from 'prom-client';

export const kafkaMessagesPublished = new Counter({
  name: 'kafka_messages_published_total',
  help: 'Total number of messages published to Kafka',
  labelNames: ['topic', 'status']
});

export const kafkaPublishDuration = new Histogram({
  name: 'kafka_publish_duration_seconds',
  help: 'Duration of Kafka publish operations',
  labelNames: ['topic'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1]
});

// Update KafkaEventPublisher to use metrics
private async publish(topic: string, messages: any[]) {
  const timer = kafkaPublishDuration.startTimer({ topic });
  
  try {
    await this.connect();
    // ... existing publish code ...
    
    kafkaMessagesPublished.inc({ topic, status: 'success' }, messages.length);
    timer();
  } catch (error) {
    kafkaMessagesPublished.inc({ topic, status: 'error' });
    timer();
    throw error;
  }
}
```

### Add Logging

```typescript
// Use structured logging
import winston from 'winston';

const logger = winston.createLogger({
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'kafka.log' })
  ]
});

// In publish method
logger.info('Kafka message published', {
  topic,
  messageCount: messages.length,
  timestamp: new Date().toISOString()
});
```

## Step 8: Testing

### Unit Tests

```typescript
// server/integration/__tests__/kafka-publisher.test.ts
import { KafkaEventPublisher } from '../kafka-publisher';

describe('KafkaEventPublisher', () => {
  let publisher: KafkaEventPublisher;

  beforeAll(async () => {
    publisher = new KafkaEventPublisher();
    await publisher.connect();
  });

  afterAll(async () => {
    await publisher.disconnect();
  });

  it('should publish telemetry event', async () => {
    await expect(publisher.publishTelemetry({
      deviceId: 'test-device',
      userId: 'test-user',
      assetId: 'test-asset',
      timestamp: new Date(),
      metrics: { power: 100 }
    })).resolves.not.toThrow();
  });

  it('should publish trade event', async () => {
    await expect(publisher.publishTradeCreated({
      tradeId: 'test-trade',
      userId: 'test-user',
      type: 'buy',
      quantity: 10,
      price: 50,
      timestamp: new Date()
    })).resolves.not.toThrow();
  });
});
```

### Integration Tests

```bash
# Start Kafka in test mode
docker-compose -f docker-compose.test.yml up -d kafka

# Run tests
pnpm test:integration
```

## Step 9: Production Deployment

### Update docker-compose.yml

```yaml
# Add Kafka connection to consumer platform service
services:
  consumer-platform:
    environment:
      - KAFKA_BROKERS=kafka-1:9092,kafka-2:9092,kafka-3:9092
      - KAFKA_SSL=true
      - KAFKA_SASL_ENABLED=true
      - KAFKA_SASL_USERNAME=${KAFKA_USERNAME}
      - KAFKA_SASL_PASSWORD=${KAFKA_PASSWORD}
    networks:
      - vpp-network

networks:
  vpp-network:
    external: true
```

### Health Checks

```typescript
// Add health check endpoint
app.get('/health/kafka', async (req, res) => {
  try {
    const admin = kafka.admin();
    await admin.connect();
    await admin.listTopics();
    await admin.disconnect();
    
    res.json({ status: 'healthy', kafka: 'connected' });
  } catch (error) {
    res.status(503).json({ status: 'unhealthy', error: error.message });
  }
});
```

## Troubleshooting

### Connection Issues

```bash
# Check Kafka broker status
docker-compose ps kafka

# Check Kafka logs
docker-compose logs -f kafka

# Test connection
kafkacat -b localhost:9092 -L
```

### Message Not Being Published

1. Check topic exists: `kafka-topics --list`
2. Check producer logs
3. Verify network connectivity
4. Check authentication credentials

### High Latency

1. Check broker load
2. Increase batch size
3. Tune linger.ms
4. Check network latency

## Next Steps

1. Implement Kafka consumers in nextgen platform
2. Setup Kafka Connect for database sync
3. Add schema registry for message validation
4. Implement dead letter queues
5. Setup monitoring dashboards

## References

- [KafkaJS Documentation](https://kafka.js.org/)
- [Apache Kafka Documentation](https://kafka.apache.org/documentation/)
- [Kafka Best Practices](https://kafka.apache.org/documentation/#bestpractices)
