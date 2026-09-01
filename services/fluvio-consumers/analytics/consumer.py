"""
Fluvio consumer for real-time analytics and aggregations
"""

import json
import os
import signal
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Dict, List

from dotenv import load_dotenv
from fluvio import Fluvio, Offset
from loguru import logger

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import metrics
from common import telemetry as otel
from common.models import TelemetryData


class AnalyticsConsumer:
    def __init__(self):
        load_dotenv()

        # OTel tracing: honours OTEL_SDK_DISABLED / OTEL_EXPORTER_OTLP_ENDPOINT,
        # logs "telemetry disabled: <reason>" loudly when off, never raises.
        otel.init_telemetry("fluvio-analytics-consumer")

        self.fluvio_topic = os.getenv("FLUVIO_TOPIC", "telemetry")
        self.fluvio_partition = int(os.getenv("FLUVIO_PARTITION", "0"))
        self.window_size = int(os.getenv("WINDOW_SIZE_SECONDS", "60"))  # 1 minute windows
        
        self.fluvio = None
        self.consumer = None
        self.running = True
        
        # In-memory aggregations (in production, use Redis or similar)
        self.windows: Dict[str, List[TelemetryData]] = defaultdict(list)
        self.last_flush = datetime.now()
        
        # Setup signal handlers
        signal.signal(signal.SIGINT, self.shutdown)
        signal.signal(signal.SIGTERM, self.shutdown)
    
    def connect_fluvio(self):
        """Connect to Fluvio cluster"""
        logger.info("Connecting to Fluvio cluster")
        
        self.fluvio = Fluvio.connect()
        self.consumer = self.fluvio.partition_consumer(self.fluvio_topic, 0)
        
        logger.info(f"Connected to Fluvio topic: {self.fluvio_topic}")
    
    def add_to_window(self, telemetry: TelemetryData):
        """Add telemetry to time window"""
        window_key = self.get_window_key(telemetry.timestamp)
        self.windows[window_key].append(telemetry)
    
    def get_window_key(self, timestamp: datetime) -> str:
        """Get window key for timestamp"""
        window_start = timestamp.replace(second=0, microsecond=0)
        window_start = window_start - timedelta(
            minutes=window_start.minute % (self.window_size // 60)
        )
        return window_start.isoformat()
    
    def compute_aggregations(self, window_key: str, data: List[TelemetryData]):
        """Compute aggregations for a time window"""
        if not data:
            return
        
        # Group by asset
        by_asset = defaultdict(list)
        for item in data:
            by_asset[item.asset_id].append(item)
        
        logger.info(f"Window {window_key}: Processing {len(data)} records from {len(by_asset)} assets")
        metrics.window_aggregations.inc()
        metrics.records_per_window.observe(len(data))
        metrics.active_windows.set(len(self.windows))
        
        for asset_id, records in by_asset.items():
            avg_power = sum(r.power for r in records) / len(records)
            total_energy = sum(r.energy for r in records)
            avg_voltage = sum(r.voltage for r in records) / len(records)
            avg_current = sum(r.current for r in records) / len(records)
            
            logger.info(
                f"Asset {asset_id} - "
                f"Avg Power: {avg_power:.2f}W, "
                f"Total Energy: {total_energy:.2f}Wh, "
                f"Avg Voltage: {avg_voltage:.2f}V, "
                f"Avg Current: {avg_current:.2f}A"
            )
            
            # In production, store these aggregations in a time-series database
            # or send to another Fluvio topic for further processing
    
    def flush_old_windows(self):
        """Flush and compute aggregations for completed windows"""
        now = datetime.now()
        cutoff = now - timedelta(seconds=self.window_size * 2)
        
        to_remove = []
        for window_key, data in self.windows.items():
            window_time = datetime.fromisoformat(window_key)
            
            if window_time < cutoff:
                self.compute_aggregations(window_key, data)
                to_remove.append(window_key)
        
        for key in to_remove:
            del self.windows[key]
        
        self.last_flush = now
    
    def process_message(self, record):
        """Process a single Fluvio record"""
        try:
            # Parse JSON payload
            data = json.loads(record.value())

            # Validate and parse telemetry
            telemetry = TelemetryData(**data)

            # Continue the trace stamped into the payload envelope by the
            # mqtt-fluvio-bridge when present.
            with otel.consume_span(
                record,
                topic=self.fluvio_topic,
                partition=self.fluvio_partition,
                payload=data,
            ):
                # Add to time window
                self.add_to_window(telemetry)

                # Periodically flush old windows
                if (datetime.now() - self.last_flush).seconds >= self.window_size:
                    self.flush_old_windows()
            metrics.messages_processed.labels(consumer="analytics-consumer").inc()

        except Exception as e:
            logger.error(f"Failed to process message: {e}")
            metrics.processing_errors.labels(
                consumer="analytics-consumer", error_type=type(e).__name__
            ).inc()
    
    def run(self):
        """Main consumer loop"""
        logger.info("Starting analytics consumer")

        # Prometheus scrape target: analytics-consumer:8000/metrics
        try:
            metrics.start_metrics_server(int(os.getenv("METRICS_PORT", "8000")))
            logger.info(f"Metrics server on :{os.getenv('METRICS_PORT', '8000')}/metrics")
        except Exception as e:
            logger.error(f"Metrics server failed to start (continuing without it): {e}")

        try:
            self.connect_fluvio()
            
            # Start consuming from the end (only new messages)
            stream = self.consumer.stream(Offset.end())
            
            logger.info(f"Consuming messages with {self.window_size}s windows...")
            
            for record in stream:
                if not self.running:
                    break
                
                self.process_message(record)
                
        except Exception as e:
            logger.error(f"Consumer error: {e}")
            raise
        finally:
            self.cleanup()
    
    def cleanup(self):
        """Cleanup resources"""
        logger.info("Cleaning up resources")
        
        # Flush remaining windows
        for window_key, data in self.windows.items():
            self.compute_aggregations(window_key, data)
        
        logger.info("Consumer stopped")
    
    def shutdown(self, signum, frame):
        """Handle shutdown signals"""
        logger.info(f"Received signal {signum}, shutting down...")
        self.running = False


if __name__ == "__main__":
    logger.add(
        "logs/analytics-consumer.log",
        rotation="100 MB",
        retention="30 days",
        level="INFO",
    )
    
    consumer = AnalyticsConsumer()
    consumer.run()
