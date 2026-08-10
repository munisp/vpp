#!/usr/bin/env python3
"""
Lakehouse ETL Pipeline
Consumes events from Kafka and writes to Apache Iceberg tables for long-term analytics
"""

import os
import json
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Any
from confluent_kafka import Consumer, KafkaError
import pandas as pd
from pyiceberg.catalog import load_catalog
from pyiceberg.schema import Schema
from pyiceberg.types import (
    NestedField,
    StringType,
    IntegerType,
    FloatType,
    TimestampType,
    BooleanType,
    StructType,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Kafka configuration
KAFKA_BOOTSTRAP_SERVERS = os.getenv('KAFKA_BOOTSTRAP_SERVERS', 'localhost:9092')
KAFKA_GROUP_ID = os.getenv('KAFKA_GROUP_ID', 'lakehouse-etl')
KAFKA_AUTO_OFFSET_RESET = os.getenv('KAFKA_AUTO_OFFSET_RESET', 'earliest')

# Iceberg configuration - aligned with MinIO + Hive Metastore HA deployment
ICEBERG_CATALOG_NAME = os.getenv('ICEBERG_CATALOG_NAME', 'vpp_lakehouse')
ICEBERG_CATALOG_TYPE = os.getenv('ICEBERG_CATALOG_TYPE', 'hive')  # Use hive for production
ICEBERG_WAREHOUSE_PATH = os.getenv('ICEBERG_WAREHOUSE_PATH', 's3a://vpp-lakehouse/warehouse')
ICEBERG_NAMESPACE = os.getenv('ICEBERG_NAMESPACE', 'vpp')
HIVE_METASTORE_URI = os.getenv('HIVE_METASTORE_URI', 'thrift://hive-metastore.lakehouse.svc.cluster.local:9083')
S3_ENDPOINT = os.getenv('S3_ENDPOINT', 'http://minio.lakehouse.svc.cluster.local:9000')
S3_ACCESS_KEY = os.getenv('S3_ACCESS_KEY', '')
S3_SECRET_KEY = os.getenv('S3_SECRET_KEY', '')

# Topics to consume - Core platform + Next-gen services
# Note: Topic names match kafka-config.ts (without vpp. prefix)
KAFKA_TOPICS = [
    # Core platform topics
    'telemetry.raw',
    'trades.created',
    'trades.settled',
    'payments.initiated',
    'payments.completed',
    'payments.failed',
    'dr.events.created',
    'dr.events.started',
    'dr.events.completed',
    'dr.responses',
    
    # Next-gen service topics for lakehouse analytics
    # Probabilistic Forecasting
    'forecasts.generated',
    'forecasts.evaluated',
    
    # Optimization Engine
    'optimization.runs',
    'optimization.schedules',
    'optimization.constraints',
    
    # Settlement Ledger
    'settlement.events',
    'settlement.periods',
    
    # Edge Orchestration
    'edge.commands',
    'edge.results',
    'edge.connectivity',
    
    # V2G/EV Charging
    'ev.sessions',
    'ev.schedules',
    'ev.v2g.discharge',
    
    # Carbon-Aware Dispatch
    'carbon.signals',
    'carbon.schedules',
    'carbon.rec.events',
    
    # Community Energy
    'community.allocations',
    'community.balances',
    'community.islanding',
    
    # MLOps Pipeline
    'mlops.training.runs',
    'mlops.model.registry',
    'mlops.drift.events',
    'mlops.deployments',
    
    # Anomaly Detection
    'anomalies.detected',
    'anomalies.scores',
    'anomalies.feedback',
    
    # Compliance Automation
    'compliance.checks',
    'compliance.violations',
    'compliance.remediation',
    
    # Blockchain Audit
    'blockchain.anchors',
    'blockchain.proofs',
    
    # DER Capabilities
    'der.capabilities.updated',
    'der.availability.changed',
]

# Batch configuration
BATCH_SIZE = 1000
BATCH_TIMEOUT_SECONDS = 60


class LakehouseETL:
    """ETL pipeline for Kafka to Iceberg"""

    def __init__(self):
        self.consumer = self._create_consumer()
        self.catalog = self._create_catalog()
        self.batches: Dict[str, List[Dict[str, Any]]] = {}
        self.last_flush: Dict[str, datetime] = {}

    def _create_consumer(self) -> Consumer:
        """Create Kafka consumer"""
        config = {
            'bootstrap.servers': KAFKA_BOOTSTRAP_SERVERS,
            'group.id': KAFKA_GROUP_ID,
            'auto.offset.reset': KAFKA_AUTO_OFFSET_RESET,
            'enable.auto.commit': False,
            'max.poll.interval.ms': 300000,
        }
        consumer = Consumer(config)
        consumer.subscribe(KAFKA_TOPICS)
        logger.info(f"Kafka consumer created, subscribed to {len(KAFKA_TOPICS)} topics")
        return consumer

    def _create_catalog(self):
        """Create Iceberg catalog - aligned with MinIO + Hive Metastore HA deployment"""
        try:
            # Use Hive Metastore catalog for production alignment with Trino
            if ICEBERG_CATALOG_TYPE == 'hive':
                catalog = load_catalog(
                    ICEBERG_CATALOG_NAME,
                    **{
                        "type": "hive",
                        "uri": HIVE_METASTORE_URI,
                        "warehouse": ICEBERG_WAREHOUSE_PATH,
                        "s3.endpoint": S3_ENDPOINT,
                        "s3.access-key-id": S3_ACCESS_KEY,
                        "s3.secret-access-key": S3_SECRET_KEY,
                        "s3.path-style-access": "true",
                    }
                )
            else:
                # Fallback to hadoop catalog for local development
                catalog = load_catalog(
                    ICEBERG_CATALOG_NAME,
                    **{
                        "type": "hadoop",
                        "warehouse": ICEBERG_WAREHOUSE_PATH,
                    }
                )
            logger.info(f"Iceberg catalog loaded: {ICEBERG_CATALOG_NAME} (type: {ICEBERG_CATALOG_TYPE})")
            return catalog
        except Exception as e:
            logger.error(f"Failed to load Iceberg catalog: {e}")
            raise

    def _get_table_name(self, topic: str) -> str:
        """Convert Kafka topic to Iceberg table name"""
        # vpp.telemetry.raw -> telemetry_raw
        return topic.replace('vpp.', '').replace('.', '_')

    def _create_table_if_not_exists(self, table_name: str, schema: Schema):
        """Create Iceberg table if it doesn't exist"""
        table_identifier = f"{ICEBERG_NAMESPACE}.{table_name}"
        
        try:
            self.catalog.load_table(table_identifier)
            logger.debug(f"Table {table_identifier} already exists")
        except Exception:
            # Table doesn't exist, create it
            try:
                self.catalog.create_table(
                    identifier=table_identifier,
                    schema=schema,
                )
                logger.info(f"Created table: {table_identifier}")
            except Exception as e:
                logger.error(f"Failed to create table {table_identifier}: {e}")
                raise

    def _get_schema_for_topic(self, topic: str) -> Schema:
        """Get Iceberg schema for topic"""
        
        # Common fields
        common_fields = [
            NestedField(1, "event_id", StringType(), required=True),
            NestedField(2, "timestamp", TimestampType(), required=True),
            NestedField(3, "source", StringType(), required=False),
        ]

        # Topic-specific fields
        if 'telemetry' in topic:
            return Schema(
                *common_fields,
                NestedField(4, "device_id", StringType(), required=True),
                NestedField(5, "user_id", StringType(), required=True),
                NestedField(6, "asset_id", StringType(), required=True),
                NestedField(7, "power", FloatType(), required=False),
                NestedField(8, "energy", FloatType(), required=False),
                NestedField(9, "voltage", FloatType(), required=False),
                NestedField(10, "current", FloatType(), required=False),
                NestedField(11, "battery_soc", FloatType(), required=False),
            )
        
        elif 'trades' in topic:
            return Schema(
                *common_fields,
                NestedField(4, "trade_id", StringType(), required=True),
                NestedField(5, "user_id", StringType(), required=True),
                NestedField(6, "type", StringType(), required=True),
                NestedField(7, "quantity", IntegerType(), required=True),
                NestedField(8, "price", IntegerType(), required=True),
                NestedField(9, "status", StringType(), required=False),
            )
        
        elif 'payments' in topic:
            return Schema(
                *common_fields,
                NestedField(4, "payment_id", StringType(), required=True),
                NestedField(5, "user_id", StringType(), required=True),
                NestedField(6, "amount", IntegerType(), required=True),
                NestedField(7, "currency", StringType(), required=True),
                NestedField(8, "gateway", StringType(), required=True),
            )
        
        elif 'dr.events' in topic:
            return Schema(
                *common_fields,
                NestedField(4, "event_id", StringType(), required=True),
                NestedField(5, "type", StringType(), required=True),
                NestedField(6, "start_time", TimestampType(), required=True),
                NestedField(7, "end_time", TimestampType(), required=True),
                NestedField(8, "target_reduction", IntegerType(), required=True),
                NestedField(9, "compensation_rate", IntegerType(), required=True),
            )
        
        elif 'dr.responses' in topic:
            return Schema(
                *common_fields,
                NestedField(4, "response_id", StringType(), required=True),
                NestedField(5, "event_id", StringType(), required=True),
                NestedField(6, "user_id", StringType(), required=True),
                NestedField(7, "participated", BooleanType(), required=True),
                NestedField(8, "actual_reduction", IntegerType(), required=False),
            )
        
        # Next-gen service schemas
        elif 'forecasts' in topic:
            return Schema(
                *common_fields,
                NestedField(4, "forecast_id", StringType(), required=True),
                NestedField(5, "target_type", StringType(), required=True),
                NestedField(6, "horizon_hours", IntegerType(), required=True),
                NestedField(7, "p10", FloatType(), required=False),
                NestedField(8, "p50", FloatType(), required=False),
                NestedField(9, "p90", FloatType(), required=False),
                NestedField(10, "model_version", StringType(), required=False),
                NestedField(11, "confidence_score", FloatType(), required=False),
                NestedField(12, "asset_id", StringType(), required=False),
                NestedField(13, "user_id", StringType(), required=False),
            )
        
        elif 'optimization' in topic:
            return Schema(
                *common_fields,
                NestedField(4, "run_id", StringType(), required=True),
                NestedField(5, "objective_type", StringType(), required=True),
                NestedField(6, "objective_value", FloatType(), required=False),
                NestedField(7, "constraints_satisfied", BooleanType(), required=False),
                NestedField(8, "asset_count", IntegerType(), required=False),
                NestedField(9, "schedule_horizon_hours", IntegerType(), required=False),
                NestedField(10, "total_power_kw", FloatType(), required=False),
                NestedField(11, "total_energy_kwh", FloatType(), required=False),
                NestedField(12, "user_id", StringType(), required=False),
            )
        
        elif 'settlement' in topic:
            return Schema(
                *common_fields,
                NestedField(4, "settlement_id", StringType(), required=True),
                NestedField(5, "event_type", StringType(), required=True),
                NestedField(6, "period_start", TimestampType(), required=False),
                NestedField(7, "period_end", TimestampType(), required=False),
                NestedField(8, "asset_id", StringType(), required=False),
                NestedField(9, "meter_id", StringType(), required=False),
                NestedField(10, "quantity_kwh", FloatType(), required=False),
                NestedField(11, "amount", FloatType(), required=False),
                NestedField(12, "currency", StringType(), required=False),
                NestedField(13, "hash_prev", StringType(), required=False),
                NestedField(14, "hash_curr", StringType(), required=True),
            )
        
        elif 'edge' in topic:
            return Schema(
                *common_fields,
                NestedField(4, "command_id", StringType(), required=True),
                NestedField(5, "gateway_id", StringType(), required=True),
                NestedField(6, "device_id", StringType(), required=False),
                NestedField(7, "command_type", StringType(), required=True),
                NestedField(8, "status", StringType(), required=True),
                NestedField(9, "issued_at", TimestampType(), required=False),
                NestedField(10, "acked_at", TimestampType(), required=False),
                NestedField(11, "offline_executed", BooleanType(), required=False),
                NestedField(12, "signature_valid", BooleanType(), required=False),
                NestedField(13, "retry_count", IntegerType(), required=False),
            )
        
        elif 'ev' in topic:
            return Schema(
                *common_fields,
                NestedField(4, "session_id", StringType(), required=True),
                NestedField(5, "charger_id", StringType(), required=True),
                NestedField(6, "user_id", StringType(), required=True),
                NestedField(7, "vehicle_id", StringType(), required=False),
                NestedField(8, "session_type", StringType(), required=True),
                NestedField(9, "start_time", TimestampType(), required=False),
                NestedField(10, "end_time", TimestampType(), required=False),
                NestedField(11, "energy_kwh", FloatType(), required=False),
                NestedField(12, "v2g_discharge_kwh", FloatType(), required=False),
                NestedField(13, "soc_start", FloatType(), required=False),
                NestedField(14, "soc_end", FloatType(), required=False),
            )
        
        elif 'carbon' in topic:
            return Schema(
                *common_fields,
                NestedField(4, "signal_id", StringType(), required=True),
                NestedField(5, "signal_type", StringType(), required=True),
                NestedField(6, "grid_intensity_gco2_kwh", FloatType(), required=False),
                NestedField(7, "carbon_price", FloatType(), required=False),
                NestedField(8, "rec_id", StringType(), required=False),
                NestedField(9, "rec_action", StringType(), required=False),
                NestedField(10, "rec_quantity_mwh", FloatType(), required=False),
                NestedField(11, "emissions_avoided_kg", FloatType(), required=False),
                NestedField(12, "asset_id", StringType(), required=False),
            )
        
        elif 'community' in topic:
            return Schema(
                *common_fields,
                NestedField(4, "community_id", StringType(), required=True),
                NestedField(5, "member_id", StringType(), required=False),
                NestedField(6, "allocation_type", StringType(), required=True),
                NestedField(7, "allocation_kwh", FloatType(), required=False),
                NestedField(8, "credits", FloatType(), required=False),
                NestedField(9, "debits", FloatType(), required=False),
                NestedField(10, "fairness_metric", FloatType(), required=False),
                NestedField(11, "islanding_active", BooleanType(), required=False),
                NestedField(12, "grid_connected", BooleanType(), required=False),
            )
        
        elif 'mlops' in topic:
            return Schema(
                *common_fields,
                NestedField(4, "run_id", StringType(), required=True),
                NestedField(5, "model_id", StringType(), required=False),
                NestedField(6, "model_name", StringType(), required=False),
                NestedField(7, "model_version", StringType(), required=False),
                NestedField(8, "event_type", StringType(), required=True),
                NestedField(9, "metrics_json", StringType(), required=False),
                NestedField(10, "drift_score", FloatType(), required=False),
                NestedField(11, "drift_type", StringType(), required=False),
                NestedField(12, "deployment_state", StringType(), required=False),
                NestedField(13, "dataset_ref", StringType(), required=False),
            )
        
        elif 'anomalies' in topic:
            return Schema(
                *common_fields,
                NestedField(4, "anomaly_id", StringType(), required=True),
                NestedField(5, "asset_id", StringType(), required=True),
                NestedField(6, "anomaly_type", StringType(), required=True),
                NestedField(7, "score", FloatType(), required=True),
                NestedField(8, "severity", StringType(), required=False),
                NestedField(9, "window_start", TimestampType(), required=False),
                NestedField(10, "window_end", TimestampType(), required=False),
                NestedField(11, "label", StringType(), required=False),
                NestedField(12, "recommended_action", StringType(), required=False),
            )
        
        elif 'compliance' in topic:
            return Schema(
                *common_fields,
                NestedField(4, "check_id", StringType(), required=True),
                NestedField(5, "rule_id", StringType(), required=True),
                NestedField(6, "jurisdiction", StringType(), required=True),
                NestedField(7, "subject_type", StringType(), required=True),
                NestedField(8, "subject_id", StringType(), required=True),
                NestedField(9, "result", StringType(), required=True),
                NestedField(10, "violation_details", StringType(), required=False),
                NestedField(11, "remediation_action", StringType(), required=False),
                NestedField(12, "evidence_ref", StringType(), required=False),
            )
        
        elif 'blockchain' in topic:
            return Schema(
                *common_fields,
                NestedField(4, "anchor_id", StringType(), required=True),
                NestedField(5, "ledger_hash", StringType(), required=True),
                NestedField(6, "chain_network", StringType(), required=True),
                NestedField(7, "tx_hash", StringType(), required=False),
                NestedField(8, "block_number", IntegerType(), required=False),
                NestedField(9, "verification_status", StringType(), required=False),
                NestedField(10, "merkle_root", StringType(), required=False),
                NestedField(11, "proof_json", StringType(), required=False),
            )
        
        elif 'der' in topic:
            return Schema(
                *common_fields,
                NestedField(4, "asset_id", StringType(), required=True),
                NestedField(5, "capability_type", StringType(), required=True),
                NestedField(6, "power_min_kw", FloatType(), required=False),
                NestedField(7, "power_max_kw", FloatType(), required=False),
                NestedField(8, "energy_capacity_kwh", FloatType(), required=False),
                NestedField(9, "ramp_rate_kw_min", FloatType(), required=False),
                NestedField(10, "response_time_sec", IntegerType(), required=False),
                NestedField(11, "availability_start", TimestampType(), required=False),
                NestedField(12, "availability_end", TimestampType(), required=False),
                NestedField(13, "effective_from", TimestampType(), required=False),
            )
        
        else:
            # Generic schema for unknown topics
            return Schema(*common_fields)

    def _process_message(self, msg):
        """Process a single Kafka message"""
        try:
            topic = msg.topic()
            value = json.loads(msg.value().decode('utf-8'))
            
            # Add to batch
            if topic not in self.batches:
                self.batches[topic] = []
                self.last_flush[topic] = datetime.now()
            
            self.batches[topic].append(value)
            
            # Check if batch should be flushed
            should_flush = (
                len(self.batches[topic]) >= BATCH_SIZE or
                (datetime.now() - self.last_flush[topic]).seconds >= BATCH_TIMEOUT_SECONDS
            )
            
            if should_flush:
                self._flush_batch(topic)
            
        except Exception as e:
            logger.error(f"Error processing message from {msg.topic()}: {e}")

    def _flush_batch(self, topic: str):
        """Flush batch to Iceberg table"""
        if not self.batches.get(topic):
            return
        
        try:
            table_name = self._get_table_name(topic)
            schema = self._get_schema_for_topic(topic)
            
            # Create table if not exists
            self._create_table_if_not_exists(table_name, schema)
            
            # Convert batch to DataFrame
            df = pd.DataFrame(self.batches[topic])
            
            # Load table and append data
            table_identifier = f"{ICEBERG_NAMESPACE}.{table_name}"
            table = self.catalog.load_table(table_identifier)
            
            # Append data
            table.append(df)
            
            logger.info(f"Flushed {len(self.batches[topic])} records to {table_identifier}")
            
            # Clear batch
            self.batches[topic] = []
            self.last_flush[topic] = datetime.now()
            
        except Exception as e:
            logger.error(f"Error flushing batch for {topic}: {e}")
            # Keep batch for retry
            raise

    def run(self):
        """Run ETL pipeline"""
        logger.info("Starting Lakehouse ETL pipeline...")
        
        try:
            while True:
                msg = self.consumer.poll(timeout=1.0)
                
                if msg is None:
                    # Check for timeout flushes
                    for topic in list(self.batches.keys()):
                        if (datetime.now() - self.last_flush.get(topic, datetime.now())).seconds >= BATCH_TIMEOUT_SECONDS:
                            self._flush_batch(topic)
                    continue
                
                if msg.error():
                    if msg.error().code() == KafkaError._PARTITION_EOF:
                        logger.debug(f"Reached end of partition for {msg.topic()}")
                    else:
                        logger.error(f"Kafka error: {msg.error()}")
                    continue
                
                self._process_message(msg)
                
                # Commit offset
                self.consumer.commit(asynchronous=False)
                
        except KeyboardInterrupt:
            logger.info("Shutting down ETL pipeline...")
        finally:
            # Flush remaining batches
            for topic in list(self.batches.keys()):
                self._flush_batch(topic)
            
            self.consumer.close()
            logger.info("ETL pipeline stopped")


def main():
    """Main entry point"""
    etl = LakehouseETL()
    etl.run()


if __name__ == '__main__':
    main()
