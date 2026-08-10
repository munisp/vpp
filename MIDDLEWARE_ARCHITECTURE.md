# VPP Platform - Enterprise Middleware Architecture

## Overview

This document describes the enterprise middleware integration for the Virtual Power Plant (VPP) platform, incorporating industry-standard tools for messaging, workflow orchestration, authentication, data storage, and API management.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          APISIX API Gateway                              │
│                    (Rate Limiting, Auth, Routing)                        │
└────────────────────────────────┬────────────────────────────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
┌───────▼────────┐      ┌───────▼────────┐      ┌───────▼────────┐
│   Web Client   │      │  Mobile App    │      │  IoT Devices   │
└────────────────┘      └────────────────┘      └────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
┌───────▼────────┐      ┌───────▼────────┐      ┌───────▼────────┐
│   Node.js/TS   │      │  Go Services   │      │ Python Services│
│   Platform     │      │  (High Perf)   │      │  (Analytics)   │
└───────┬────────┘      └───────┬────────┘      └───────┬────────┘
        │                        │                        │
        └────────────────────────┼────────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │    Dapr Runtime         │
                    │  (Service Mesh Layer)   │
                    └────────────┬────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
┌───────▼────────┐      ┌───────▼────────┐      ┌───────▼────────┐
│     Kafka      │      │    Temporal    │      │     Redis      │
│ Event Streaming│      │   Workflows    │      │  Cache/State   │
└────────────────┘      └────────────────┘      └────────────────┘
        │                        │                        │
┌───────▼────────┐      ┌───────▼────────┐      ┌───────▼────────┐
│    Fluvio      │      │   Keycloak     │      │  TigerBeetle   │
│  Real-time     │      │      IAM       │      │    Ledger      │
└────────────────┘      └────────────────┘      └────────────────┘
        │                        │                        │
        └────────────────────────┼────────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │      Permify            │
                    │   Authorization         │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │     Lakehouse           │
                    │  (MinIO + Iceberg)      │
                    │   Analytics Storage     │
                    └─────────────────────────┘
```

## Component Responsibilities

### 1. APISIX API Gateway
**Purpose:** Unified entry point for all API traffic

**Responsibilities:**
- Route requests to appropriate services
- Rate limiting and throttling
- Authentication and authorization
- Request/response transformation
- Circuit breaking and retry logic
- API versioning
- Metrics and logging

**Configuration:**
- Routes for Node.js platform (`/api/*`)
- Routes for Go services (`/go/*`)
- Routes for Python services (`/python/*`)
- WebSocket support for real-time features
- gRPC support for internal services

### 2. Kafka Event Streaming
**Purpose:** Event backbone for asynchronous communication

**Topics:**
- `telemetry.raw` - Raw IoT device telemetry
- `telemetry.processed` - Processed telemetry data
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
- `analytics.events` - Analytics tracking events

**Producers:**
- Node.js platform (trades, payments, DR events)
- Go telemetry ingestion service
- IoT devices (via MQTT bridge)

**Consumers:**
- Go event processor
- Python analytics ETL
- Temporal workflows
- Notification service

### 3. Dapr Runtime
**Purpose:** Distributed application runtime providing building blocks

**Components:**
- **State Store:** Redis for distributed state
- **Pub/Sub:** Kafka for event-driven communication
- **Service Invocation:** mTLS-secured service-to-service calls
- **Bindings:** External system integrations (MQTT, S3)
- **Secrets:** Secure secret management
- **Actors:** Stateful workflow execution

**Usage:**
- State management for user sessions
- Pub/sub for decoupled event handling
- Service discovery and invocation
- Configuration management

### 4. Temporal Workflows
**Purpose:** Durable workflow orchestration

**Workflows:**

**DR Event Orchestration:**
```
1. Create DR event
2. Calculate dynamic pricing
3. Notify eligible participants
4. Wait for event start time
5. Monitor participant responses
6. Calculate actual reduction
7. Process compensation payments
8. Generate event report
```

**Payment Processing:**
```
1. Initiate payment request
2. Validate user balance
3. Call payment gateway (M-Pesa/Airtel/Tigo)
4. Wait for callback (with timeout)
5. Verify payment status
6. Update TigerBeetle ledger
7. Send confirmation notification
8. Handle failures and retries
```

**Energy Trading Settlement:**
```
1. Match buy/sell orders
2. Validate participant balances
3. Execute trade
4. Update TigerBeetle accounts
5. Notify participants
6. Generate settlement report
```

**Reconciliation:**
```
1. Fetch payment gateway transactions
2. Match with database records
3. Identify discrepancies
4. Generate reconciliation report
5. Notify admins of issues
6. Schedule retry for failed matches
```

### 5. Keycloak Identity & Access Management
**Purpose:** Centralized authentication and user management

**Features:**
- OAuth 2.0 / OpenID Connect
- Social login (Google, Facebook)
- Multi-factor authentication
- User federation (LDAP, Active Directory)
- Single Sign-On (SSO)
- User self-service

**Realms:**
- `vpp-platform` - Main application realm
- `vpp-admin` - Admin portal realm

**Clients:**
- `web-app` - Web application
- `mobile-app` - Mobile application
- `iot-devices` - IoT device authentication
- `admin-portal` - Admin dashboard

**Integration:**
- Replace Manus OAuth with Keycloak
- Migrate existing users
- Maintain backward compatibility

### 6. Permify Authorization
**Purpose:** Fine-grained access control

**Schema:**
```
entity user {}

entity asset {
  relation owner: user
  relation viewer: user
  
  action view = owner or viewer
  action edit = owner
  action delete = owner
}

entity trade {
  relation creator: user
  relation participant: user
  
  action view = creator or participant
  action cancel = creator
}

entity dr_event {
  relation operator: user
  relation participant: user
  
  action view = operator or participant
  action create = operator
  action edit = operator
  action participate = participant
}

entity payment {
  relation payer: user
  relation admin: user
  
  action view = payer or admin
  action process = admin
}
```

**Usage:**
- Check permissions before operations
- Implement resource-level access control
- Support hierarchical permissions

### 7. TigerBeetle Financial Ledger
**Purpose:** High-performance double-entry accounting

**Account Types:**
- User balance accounts
- Platform revenue account
- DR compensation pool
- Trading settlement accounts
- Payment gateway accounts

**Operations:**
- Credit/debit user accounts
- Record all financial transactions
- Ensure ACID guarantees
- Support multi-currency
- Generate financial reports

**Integration:**
- Replace in-memory payment tracking
- Provide real-time balance queries
- Enable financial auditing

### 8. Redis
**Purpose:** High-performance caching and state storage

**Use Cases:**
- Session storage
- API response caching
- Real-time leaderboard
- Rate limiting counters
- Pub/sub for real-time updates
- Distributed locks

**Data Structures:**
- Strings: Session tokens, cached responses
- Hashes: User profiles, asset metadata
- Sorted Sets: Leaderboards, time-series data
- Lists: Recent activities, notifications
- Pub/Sub: Real-time events

### 9. Fluvio
**Purpose:** Real-time data streaming with stateful processing

**Streams:**
- Telemetry aggregation
- Real-time analytics
- Anomaly detection
- Stream joins and enrichment

**SmartModules:**
- Telemetry validation
- Data transformation
- Filtering and routing
- Aggregation

### 10. Lakehouse (MinIO + Apache Iceberg)
**Purpose:** Unified analytics data platform

**Architecture:**
- **Storage:** MinIO object storage
- **Table Format:** Apache Iceberg (or Delta Lake)
- **Query Engine:** DuckDB / Trino
- **ETL:** Python-based pipelines

**Data Layers:**
- **Bronze:** Raw data from Kafka
- **Silver:** Cleaned and validated data
- **Gold:** Aggregated analytics tables

**Tables:**
- `telemetry_raw` - Raw IoT telemetry
- `telemetry_hourly` - Hourly aggregates
- `trades` - All energy trades
- `payments` - Payment transactions
- `dr_events` - DR event history
- `dr_responses` - Participant responses
- `user_analytics` - User behavior metrics

## Service Architecture

### Go Microservices

#### 1. Telemetry Ingestion Service
**Port:** 8081  
**Purpose:** High-throughput IoT data ingestion

**Responsibilities:**
- Receive telemetry from IoT devices (MQTT, HTTP)
- Validate and enrich data
- Publish to Kafka `telemetry.raw` topic
- Handle backpressure and rate limiting

**Tech Stack:**
- Go 1.21+
- Kafka Go client (confluent-kafka-go)
- MQTT client (paho.mqtt.golang)
- Prometheus metrics

#### 2. Event Processor Service
**Port:** 8082  
**Purpose:** Real-time event processing

**Responsibilities:**
- Consume events from Kafka
- Apply business logic and transformations
- Trigger Temporal workflows
- Update Redis cache
- Publish derived events

**Tech Stack:**
- Go 1.21+
- Kafka consumer groups
- Temporal Go SDK
- Redis Go client

#### 3. Payment Ledger Service
**Port:** 8083  
**Purpose:** Financial transaction management

**Responsibilities:**
- Interface with TigerBeetle
- Record all financial transactions
- Provide balance queries
- Generate financial reports
- Ensure transaction atomicity

**Tech Stack:**
- Go 1.21+
- TigerBeetle Go client
- gRPC API
- PostgreSQL for metadata

#### 4. Real-time Aggregator Service
**Port:** 8084  
**Purpose:** Real-time metrics aggregation

**Responsibilities:**
- Aggregate telemetry data in real-time
- Calculate rolling averages and statistics
- Update Redis with latest metrics
- Provide WebSocket API for live updates

**Tech Stack:**
- Go 1.21+
- Fluvio Go client
- WebSocket server
- Redis for state

### Python Services

#### 1. Lakehouse ETL Service
**Port:** 9001  
**Purpose:** Data pipeline orchestration

**Responsibilities:**
- Ingest data from Kafka to Lakehouse
- Transform and clean data
- Create Iceberg tables
- Schedule batch jobs
- Data quality checks

**Tech Stack:**
- Python 3.11+
- Apache Iceberg Python
- PyArrow
- Pandas
- Airflow (optional)

#### 2. ML Model Serving Service
**Port:** 9002  
**Purpose:** Machine learning inference

**Responsibilities:**
- Serve DR forecasting models
- Participant segmentation
- Anomaly detection
- Load prediction

**Tech Stack:**
- Python 3.11+
- FastAPI
- scikit-learn / TensorFlow
- MLflow for model registry

#### 3. Data Quality Service
**Port:** 9003  
**Purpose:** Data validation and monitoring

**Responsibilities:**
- Validate incoming data
- Monitor data quality metrics
- Alert on anomalies
- Generate data quality reports

**Tech Stack:**
- Python 3.11+
- Great Expectations
- Prometheus metrics
- Grafana dashboards

#### 4. Analytics API Service
**Port:** 9004  
**Purpose:** Analytics query interface

**Responsibilities:**
- Query Lakehouse data
- Provide analytics APIs
- Generate reports
- Support ad-hoc queries

**Tech Stack:**
- Python 3.11+
- FastAPI
- DuckDB / Trino
- Pandas

## Data Flow Examples

### 1. Telemetry Ingestion Flow
```
IoT Device → MQTT → Go Telemetry Service → Kafka (telemetry.raw) 
  → Go Event Processor → Kafka (telemetry.processed)
  → Python Lakehouse ETL → MinIO/Iceberg
  → Analytics API → Dashboard
```

### 2. Payment Processing Flow
```
User → Node.js API → Temporal Workflow → Payment Gateway
  → Webhook → Node.js API → Kafka (payments.completed)
  → Go Payment Ledger → TigerBeetle
  → Reconciliation Workflow → Report
```

### 3. DR Event Flow
```
Admin → Node.js API → Temporal DR Workflow
  → Kafka (dr.events.created) → Notification Service
  → Users → DR Response → Kafka (dr.responses)
  → Go Event Processor → Calculate Reduction
  → Temporal Compensation Workflow → TigerBeetle
```

## Deployment Strategy

### Docker Compose (Development)
All services run in Docker containers with docker-compose.yml

### Kubernetes (Production)
- Helm charts for each component
- Horizontal pod autoscaling
- Service mesh (Istio/Linkerd)
- Distributed tracing (Jaeger)
- Centralized logging (ELK stack)

## Monitoring & Observability

### Metrics
- Prometheus for metrics collection
- Grafana for visualization
- Service-level indicators (SLIs)
- Service-level objectives (SLOs)

### Logging
- Structured logging (JSON)
- Centralized log aggregation
- Log correlation with trace IDs

### Tracing
- OpenTelemetry instrumentation
- Jaeger for distributed tracing
- Trace sampling and analysis

## Security

### Authentication
- Keycloak for identity management
- JWT tokens for API authentication
- mTLS for service-to-service communication

### Authorization
- Permify for fine-grained access control
- RBAC and ABAC support
- Policy enforcement points

### Secrets Management
- Dapr secrets component
- Vault integration
- Encrypted at rest and in transit

### Network Security
- API Gateway as single entry point
- Internal service mesh
- Network policies
- DDoS protection

## Performance Targets

- **Telemetry Ingestion:** 100,000 messages/second
- **API Response Time:** p95 < 200ms
- **Payment Processing:** < 5 seconds end-to-end
- **DR Event Notification:** < 1 second to all participants
- **Analytics Query:** < 2 seconds for standard reports

## Next Steps

1. Setup infrastructure with Docker Compose
2. Implement Go telemetry ingestion service
3. Configure Kafka topics and schemas
4. Build Temporal workflows
5. Integrate Keycloak authentication
6. Implement TigerBeetle ledger service
7. Setup Lakehouse data pipeline
8. Deploy APISIX gateway
9. Add monitoring and observability
10. Performance testing and optimization
