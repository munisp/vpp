# Workflow Testing Guide

This guide provides step-by-step instructions for testing all 14 Temporal workflows in the VPP Consumer Platform.

## Prerequisites

Before testing workflows, ensure:

1. ✅ All external services are running (`./scripts/start-external-services.sh`)
2. ✅ Keycloak is configured (`./scripts/setup-keycloak.sh`)
3. ✅ TigerBeetle is initialized (`./scripts/init-tigerbeetle.sh`)
4. ✅ Kafka topics are created (`./scripts/create-kafka-topics.sh`)
5. ✅ Orchestrator is built (`./scripts/build-orchestrator.sh`)
6. ✅ Orchestrator is running (`./orchestrator/vpp-orchestrator`)
7. ✅ Web application is running (`pnpm dev`)

## Testing Methods

### Method 1: Via Web UI (Recommended)

The easiest way to test workflows is through the web application UI. All workflow triggers are integrated into the user interface.

### Method 2: Via tRPC API (Direct)

You can also test workflows directly via the tRPC API using curl or Postman.

### Method 3: Via Temporal Web UI (Monitoring)

Monitor workflow execution in real-time at http://localhost:8233

## Test Scenarios

### 1. Trading Workflows

#### 1.1 Auto Trading Workflow

**Purpose**: Automatically sell surplus energy when available

**Trigger**:
```typescript
// Frontend (React)
const startAutoTrading = trpc.orchestrator.startAutoTrading.useMutation();

await startAutoTrading.mutateAsync({
  assetId: "solar-panel-123"
});
```

**cURL**:
```bash
curl -X POST http://localhost:3000/api/trpc/orchestrator.startAutoTrading \
  -H "Content-Type: application/json" \
  -H "Cookie: session=<your-session-cookie>" \
  -d '{"json":{"assetId":"solar-panel-123"}}'
```

**Expected Behavior**:
1. Workflow checks auto-trading rules for user
2. Queries current energy surplus from asset
3. Gets current market price
4. Creates sell order on marketplace
5. Publishes order to Kafka topic `vpp.trading.orders`
6. Caches order in Redis
7. Returns workflow ID

**Verify**:
- Check Temporal Web UI for workflow execution
- Check Kafka UI for message in `vpp.trading.orders` topic
- Check Redis Commander for cached order data

---

#### 1.2 Manual Trading Workflow

**Purpose**: User manually purchases energy from marketplace

**Trigger**:
```typescript
const startManualTrade = trpc.orchestrator.startManualTrade.useMutation();

await startManualTrade.mutateAsync({
  amount: 10.5,  // kWh
  maxPrice: 0.15  // per kWh
});
```

**cURL**:
```bash
curl -X POST http://localhost:3000/api/trpc/orchestrator.startManualTrade \
  -H "Content-Type: application/json" \
  -H "Cookie: session=<your-session-cookie>" \
  -d '{"json":{"amount":10.5,"maxPrice":0.15}}'
```

**Expected Behavior**:
1. Workflow checks user wallet balance
2. Finds best matching offer on marketplace
3. Creates buy order
4. Processes TigerBeetle transfer (debit buyer, credit seller)
5. Transfers energy credits
6. Publishes execution to Kafka `vpp.trading.executions`
7. Sends notification to both parties

**Verify**:
- Check TigerBeetle ledger for transaction
- Check Kafka UI for execution message
- Check user notifications

---

#### 1.3 P2P Trading Workflow

**Purpose**: Direct peer-to-peer energy trading with escrow

**Trigger**:
```typescript
const startP2PTrade = trpc.orchestrator.startP2PTrade.useMutation();

await startP2PTrade.mutateAsync({
  buyerId: "user-456",
  amount: 5.0,
  price: 0.12
});
```

**cURL**:
```bash
curl -X POST http://localhost:3000/api/trpc/orchestrator.startP2PTrade \
  -H "Content-Type: application/json" \
  -H "Cookie: session=<your-session-cookie>" \
  -d '{"json":{"buyerId":"user-456","amount":5.0,"price":0.12}}'
```

**Expected Behavior**:
1. Verify energy availability from seller
2. Create P2P trade record
3. Lock funds in TigerBeetle escrow
4. Transfer energy credits
5. Release escrow funds
6. Publish to Kafka `vpp.trading.p2p`
7. Notify both parties

**Verify**:
- Check TigerBeetle escrow transactions
- Check energy credit transfers
- Check Kafka P2P topic

---

### 2. Demand Response Workflows

#### 2.1 DR Event Participation Workflow

**Purpose**: Enroll user in demand response event and track participation

**Trigger**:
```typescript
const enrollInDREvent = trpc.orchestrator.enrollInDREvent.useMutation();

await enrollInDREvent.mutateAsync({
  eventId: "dr-event-789"
});
```

**cURL**:
```bash
curl -X POST http://localhost:3000/api/trpc/orchestrator.enrollInDREvent \
  -H "Content-Type: application/json" \
  -H "Cookie: session=<your-session-cookie>" \
  -d '{"json":{"eventId":"dr-event-789"}}'
```

**Expected Behavior**:
1. Enroll user in DR event
2. Wait for event start time (Temporal timer)
3. Monitor consumption during event
4. Calculate performance vs baseline
5. Award rewards based on reduction
6. Publish to Kafka `vpp.dr.participation`
7. Send reward notification

**Verify**:
- Check Temporal Web UI for timer activity
- Check DR participation records in database
- Check Kafka DR participation topic
- Check user reward balance

---

#### 2.2 DR Forecasting Workflow (Admin Only)

**Purpose**: ML-based prediction of optimal DR event timing

**Trigger**:
```typescript
const startDRForecasting = trpc.orchestrator.startDRForecasting.useMutation();

await startDRForecasting.mutateAsync({
  regionId: "region-east"
});
```

**cURL**:
```bash
curl -X POST http://localhost:3000/api/trpc/orchestrator.startDRForecasting \
  -H "Content-Type: application/json" \
  -H "Cookie: session=<your-session-cookie>" \
  -d '{"json":{"regionId":"region-east"}}'
```

**Expected Behavior**:
1. Query historical data from Lakehouse
2. Run ML forecasting model
3. Identify peak demand periods
4. Create recommended DR events
5. Notify eligible users
6. Store forecast results
7. Publish to Kafka `vpp.dr.forecasts`

**Verify**:
- Check Lakehouse query execution
- Check forecast results in database
- Check Kafka forecasts topic
- Check admin notifications

---

### 3. Payment Workflows

#### 3.1 Payment Processing Workflow

**Purpose**: Process mobile money payment with TigerBeetle ledger

**Trigger**:
```typescript
const processPayment = trpc.orchestrator.processPayment.useMutation();

await processPayment.mutateAsync({
  amount: 50.00,
  method: "mpesa"
});
```

**cURL**:
```bash
curl -X POST http://localhost:3000/api/trpc/orchestrator.processPayment \
  -H "Content-Type: application/json" \
  -H "Cookie: session=<your-session-cookie>" \
  -d '{"json":{"amount":50.00,"method":"mpesa"}}'
```

**Expected Behavior**:
1. Validate payment method
2. Process payment via gateway (M-Pesa/Airtel/Tigo)
3. Record transaction in TigerBeetle
4. Update user wallet balance
5. Send payment receipt
6. Publish to Kafka `vpp.payments.transactions`

**Verify**:
- Check payment gateway response
- Check TigerBeetle transaction
- Check wallet balance update
- Check Kafka payments topic
- Check email/SMS receipt

---

#### 3.2 QR Payment Workflow

**Purpose**: Process QR code-based merchant payment

**Trigger**:
```typescript
const processQRPayment = trpc.orchestrator.processQRPayment.useMutation();

await processQRPayment.mutateAsync({
  qrData: "VPP:MERCHANT:12345:AMOUNT:25.00"
});
```

**cURL**:
```bash
curl -X POST http://localhost:3000/api/trpc/orchestrator.processQRPayment \
  -H "Content-Type: application/json" \
  -H "Cookie: session=<your-session-cookie>" \
  -d '{"json":{"qrData":"VPP:MERCHANT:12345:AMOUNT:25.00"}}'
```

**Expected Behavior**:
1. Parse QR code data
2. Verify merchant exists
3. Process QR payment
4. Record in TigerBeetle
5. Send receipt
6. Publish to Kafka

**Verify**:
- Check QR code parsing
- Check merchant verification
- Check TigerBeetle transaction
- Check Kafka payments topic

---

### 4. Monitoring Workflows

#### 4.1 Telemetry Monitoring Workflow

**Purpose**: Continuous IoT device monitoring with anomaly detection

**Trigger**:
```typescript
const startTelemetryMonitoring = trpc.orchestrator.startTelemetryMonitoring.useMutation();

await startTelemetryMonitoring.mutateAsync({
  deviceId: "meter-001"
});
```

**cURL**:
```bash
curl -X POST http://localhost:3000/api/trpc/orchestrator.startTelemetryMonitoring \
  -H "Content-Type: application/json" \
  -H "Cookie: session=<your-session-cookie>" \
  -d '{"json":{"deviceId":"meter-001"}}'
```

**Expected Behavior**:
1. Start continuous telemetry polling
2. Get device telemetry data
3. Detect anomalies (voltage spikes, etc.)
4. Create alerts if anomalies found
5. Publish to Fluvio `vpp.telemetry.processed`
6. Cache in Redis for fast access

**Verify**:
- Check Temporal Web UI for continuous execution
- Check Fluvio topic for telemetry data
- Check Redis cache for latest readings
- Check alerts if anomalies detected

---

#### 4.2 Alert Management Workflow

**Purpose**: Process system alerts and notify affected users

**Trigger**:
```typescript
const processAlert = trpc.orchestrator.processAlert.useMutation();

await processAlert.mutateAsync({
  alertId: "alert-456"
});
```

**cURL**:
```bash
curl -X POST http://localhost:3000/api/trpc/orchestrator.processAlert \
  -H "Content-Type: application/json" \
  -H "Cookie: session=<your-session-cookie>" \
  -d '{"json":{"alertId":"alert-456"}}'
```

**Expected Behavior**:
1. Get alert details
2. Identify affected users
3. Send push notifications
4. Log alert to Lakehouse
5. Publish to Kafka `vpp.alerts.user`

**Verify**:
- Check alert details in database
- Check user notifications
- Check Lakehouse logs
- Check Kafka alerts topic

---

### 5. Gamification Workflows

#### 5.1 Leaderboard Update Workflow (Admin Only)

**Purpose**: Update global/weekly leaderboards with Redis

**Trigger**:
```typescript
const updateLeaderboard = trpc.orchestrator.updateLeaderboard.useMutation();

await updateLeaderboard.mutateAsync({
  period: "weekly"
});
```

**cURL**:
```bash
curl -X POST http://localhost:3000/api/trpc/orchestrator.updateLeaderboard \
  -H "Content-Type: application/json" \
  -H "Cookie: session=<your-session-cookie>" \
  -d '{"json":{"period":"weekly"}}'
```

**Expected Behavior**:
1. Calculate leaderboard scores
2. Update Redis sorted sets
3. Get top performers
4. Award bonus points
5. Publish to Kafka `vpp.gamification.leaderboard`

**Verify**:
- Check Redis sorted sets for leaderboard
- Check top performers list
- Check bonus points awarded
- Check Kafka gamification topic

---

#### 5.2 Achievement Tracking Workflow

**Purpose**: Track user actions and award achievements

**Trigger**:
```typescript
const trackAchievement = trpc.orchestrator.trackAchievement.useMutation();

await trackAchievement.mutateAsync({
  action: "first_trade"
});
```

**cURL**:
```bash
curl -X POST http://localhost:3000/api/trpc/orchestrator.trackAchievement \
  -H "Content-Type: application/json" \
  -H "Cookie: session=<your-session-cookie>" \
  -d '{"json":{"action":"first_trade"}}'
```

**Expected Behavior**:
1. Check if action qualifies for achievement
2. Award achievement if eligible
3. Send push notification
4. Trigger haptic feedback (mobile)
5. Publish to Kafka `vpp.gamification.achievements`

**Verify**:
- Check user achievements in database
- Check push notification
- Check Kafka achievements topic

---

### 6. Workflow Management

#### 6.1 Get Workflow Status

**Purpose**: Check status of running workflow

**Trigger**:
```typescript
const { data } = trpc.orchestrator.getWorkflowStatus.useQuery({
  workflowId: "auto-trading-123-solar-456-1234567890"
});
```

**cURL**:
```bash
curl -X GET "http://localhost:3000/api/trpc/orchestrator.getWorkflowStatus?input=%7B%22json%22%3A%7B%22workflowId%22%3A%22auto-trading-123-solar-456-1234567890%22%7D%7D" \
  -H "Cookie: session=<your-session-cookie>"
```

**Response**:
```json
{
  "workflowId": "auto-trading-123-solar-456-1234567890",
  "runId": "run-1234567890",
  "status": "running",
  "startTime": "2024-01-15T10:00:00Z"
}
```

---

#### 6.2 List User Workflows

**Purpose**: Get all workflows for current user

**Trigger**:
```typescript
const { data } = trpc.orchestrator.listUserWorkflows.useQuery();
```

**cURL**:
```bash
curl -X GET "http://localhost:3000/api/trpc/orchestrator.listUserWorkflows" \
  -H "Cookie: session=<your-session-cookie>"
```

**Response**:
```json
[
  {
    "workflowId": "auto-trading-123-solar-456-1234567890",
    "runId": "run-1234567890",
    "status": "completed",
    "startTime": "2024-01-15T10:00:00Z",
    "endTime": "2024-01-15T10:05:00Z"
  },
  ...
]
```

---

#### 6.3 Cancel Workflow

**Purpose**: Cancel a running workflow

**Trigger**:
```typescript
const cancelWorkflow = trpc.orchestrator.cancelWorkflow.useMutation();

await cancelWorkflow.mutateAsync({
  workflowId: "auto-trading-123-solar-456-1234567890"
});
```

**cURL**:
```bash
curl -X POST http://localhost:3000/api/trpc/orchestrator.cancelWorkflow \
  -H "Content-Type: application/json" \
  -H "Cookie: session=<your-session-cookie>" \
  -d '{"json":{"workflowId":"auto-trading-123-solar-456-1234567890"}}'
```

**Expected Behavior**:
1. Verify workflow ownership
2. Cancel workflow in Temporal
3. Update status to "cancelled"
4. Return success message

---

## Monitoring Workflow Execution

### Temporal Web UI

**URL**: http://localhost:8233

**Features**:
- View all workflow executions
- See workflow history and events
- Debug failed workflows
- View activity execution details
- Replay workflows
- Search workflows by ID or type

**Navigation**:
1. Open http://localhost:8233
2. Select namespace: `default`
3. Click "Workflows" tab
4. Filter by workflow type or status
5. Click workflow ID to see details

### Kafka UI

**URL**: http://localhost:8090

**Features**:
- Monitor all Kafka topics
- View message throughput
- Inspect message payloads
- Monitor consumer lag

**Navigation**:
1. Open http://localhost:8090
2. Select cluster: `vpp-cluster`
3. Click "Topics" tab
4. Select topic (e.g., `vpp.trading.orders`)
5. View messages

### Redis Commander

**URL**: http://localhost:8091

**Features**:
- Browse cached data
- View key patterns
- Inspect values
- Monitor TTL

**Navigation**:
1. Open http://localhost:8091
2. Select database: `0`
3. Browse keys by pattern
4. Click key to view value

## Testing Checklist

Use this checklist to verify all workflows:

- [ ] Auto Trading Workflow
- [ ] Manual Trading Workflow
- [ ] P2P Trading Workflow
- [ ] DR Event Participation Workflow
- [ ] DR Forecasting Workflow
- [ ] Payment Processing Workflow
- [ ] QR Payment Workflow
- [ ] Telemetry Monitoring Workflow
- [ ] Alert Management Workflow
- [ ] Leaderboard Update Workflow
- [ ] Achievement Tracking Workflow
- [ ] Get Workflow Status
- [ ] List User Workflows
- [ ] Cancel Workflow

## Common Issues

### Workflow Not Starting

**Symptom**: Workflow trigger returns success but workflow doesn't execute

**Solutions**:
1. Check orchestrator is running: `ps aux | grep vpp-orchestrator`
2. Check Temporal connection: `curl http://localhost:7233/health`
3. Check orchestrator logs for errors
4. Verify task queue name matches: `vpp-workflows`

### Activity Failure

**Symptom**: Workflow starts but activity fails

**Solutions**:
1. Check Temporal Web UI for activity error details
2. Verify middleware service connectivity (Kafka, Redis, etc.)
3. Check activity retry policy
4. Review orchestrator logs for activity errors

### Timeout Errors

**Symptom**: Workflow times out

**Solutions**:
1. Increase workflow timeout in workflow definition
2. Check for blocking operations in activities
3. Verify external service response times
4. Review activity execution duration in Temporal UI

### Authentication Errors

**Symptom**: 401/403 errors when triggering workflows

**Solutions**:
1. Verify user is logged in
2. Check session cookie is valid
3. Verify user has required permissions
4. Check Keycloak token expiration

## Performance Testing

### Load Testing

Use Apache JMeter or k6 to load test workflows:

```javascript
// k6 load test example
import http from 'k6/http';
import { check } from 'k6';

export let options = {
  vus: 10,
  duration: '30s',
};

export default function() {
  let payload = JSON.stringify({
    json: { assetId: 'solar-panel-123' }
  });

  let res = http.post(
    'http://localhost:3000/api/trpc/orchestrator.startAutoTrading',
    payload,
    { headers: { 'Content-Type': 'application/json' } }
  );

  check(res, {
    'status is 200': (r) => r.status === 200,
  });
}
```

### Metrics to Monitor

- **Workflow execution time**: Average time from start to completion
- **Activity execution time**: Time per activity
- **Throughput**: Workflows per second
- **Error rate**: Percentage of failed workflows
- **Retry rate**: Percentage of activities that retry

## Next Steps

After testing all workflows:

1. **Deploy to staging** - Test in staging environment
2. **Load testing** - Verify performance under load
3. **Integration testing** - Test complete user journeys
4. **Security testing** - Verify authentication and authorization
5. **Deploy to production** - Roll out to production environment

## Support

For issues or questions:
- Check Temporal Web UI for workflow details
- Review orchestrator logs
- Check middleware service logs
- Consult `docs/ORCHESTRATOR_DEPLOYMENT.md`
