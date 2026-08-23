"""
Fluvio consumer for storing telemetry data in the PostgreSQL database
"""

import json
import os
import signal
import sys
from datetime import datetime
from typing import Optional

import psycopg2
from dotenv import load_dotenv
from fluvio import Fluvio, Offset
from loguru import logger

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common.models import TelemetryData


class DatabaseConsumer:
    def __init__(self):
        load_dotenv()
        
        self.fluvio_topic = os.getenv("FLUVIO_TOPIC", "telemetry")
        self.db_config = {
            "host": os.getenv("DB_HOST", "localhost"),
            "port": int(os.getenv("DB_PORT", "5432")),
            "user": os.getenv("DB_USER", "postgres"),
            "password": os.getenv("DB_PASSWORD", ""),
            "dbname": os.getenv("DB_NAME", "vpp"),
            "sslmode": os.getenv("DB_SSLMODE", "require"),
            "options": "-c timezone=UTC",
        }
        
        self.fluvio = None
        self.consumer = None
        self.db_conn = None
        self.running = True
        
        # Setup signal handlers
        signal.signal(signal.SIGINT, self.shutdown)
        signal.signal(signal.SIGTERM, self.shutdown)
    
    def connect_database(self):
        """Connect to the PostgreSQL database"""
        logger.info(f"Connecting to database at {self.db_config['host']}:{self.db_config['port']}")
        
        self.db_conn = psycopg2.connect(**self.db_config)
        self.db_conn.autocommit = False
        
        logger.info("Database connected")
    
    def connect_fluvio(self):
        """Connect to Fluvio cluster"""
        logger.info("Connecting to Fluvio cluster")
        
        self.fluvio = Fluvio.connect()
        self.consumer = self.fluvio.partition_consumer(self.fluvio_topic, 0)
        
        logger.info(f"Connected to Fluvio topic: {self.fluvio_topic}")
    
    def store_telemetry(self, telemetry: TelemetryData) -> bool:
        """Store telemetry data in database"""
        try:
            cursor = self.db_conn.cursor()
            
            query = """
                INSERT INTO telemetry (
                    "assetId", timestamp, power, energy, voltage, current,
                    frequency, "stateOfCharge", metadata, "createdAt"
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW()
                )
            """
            
            values = (
                telemetry.asset_id,
                telemetry.timestamp,
                telemetry.power,
                telemetry.energy,
                telemetry.voltage,
                telemetry.current,
                telemetry.frequency,
                telemetry.battery_level,
                json.dumps({
                    "deviceId": telemetry.device_id,
                    "powerFactor": telemetry.power_factor,
                }),
            )
            
            cursor.execute(query, values)
            self.db_conn.commit()
            cursor.close()
            
            logger.debug(f"Stored telemetry for device {telemetry.device_id}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to store telemetry: {e}")
            self.db_conn.rollback()
            return False
    
    def process_message(self, record):
        """Process a single Fluvio record"""
        try:
            # Parse JSON payload
            data = json.loads(record.value())
            
            # Validate and parse telemetry
            telemetry = TelemetryData(**data)
            
            # Store in database
            self.store_telemetry(telemetry)
            
        except Exception as e:
            logger.error(f"Failed to process message: {e}")
    
    def run(self):
        """Main consumer loop"""
        logger.info("Starting database consumer")
        
        try:
            self.connect_database()
            self.connect_fluvio()
            
            # Start consuming from the end (only new messages)
            stream = self.consumer.stream(Offset.end())
            
            logger.info("Consuming messages...")
            
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
        
        if self.db_conn:
            self.db_conn.close()
            logger.info("Database connection closed")
        
        logger.info("Consumer stopped")
    
    def shutdown(self, signum, frame):
        """Handle shutdown signals"""
        logger.info(f"Received signal {signum}, shutting down...")
        self.running = False


if __name__ == "__main__":
    logger.add(
        "logs/database-consumer.log",
        rotation="100 MB",
        retention="30 days",
        level="INFO",
    )
    
    consumer = DatabaseConsumer()
    consumer.run()
