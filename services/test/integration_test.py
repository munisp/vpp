"""
Integration test for MQTT-Fluvio pipeline
Tests end-to-end data flow from MQTT to database
"""

import json
import os
import time
from datetime import datetime

import psycopg2
import psycopg2.extras
import paho.mqtt.client as mqtt
from loguru import logger


class IntegrationTest:
    """End-to-end integration test"""
    
    def __init__(self):
        self.mqtt_host = "localhost"
        self.mqtt_port = 1883
        self.db_config = {
            "host": os.getenv("DB_HOST", "localhost"),
            "port": int(os.getenv("DB_PORT", "5432")),
            "user": os.getenv("DB_USER", "postgres"),
            "password": os.getenv("DB_PASSWORD", ""),
            "dbname": os.getenv("DB_NAME", "vpp"),
            "sslmode": os.getenv("DB_SSLMODE", "disable"),
        }
        
        self.test_device_id = "test-integration-001"
        self.test_asset_id = 9999
        self.test_timestamp = None
        
    def send_test_message(self) -> bool:
        """Send a test message via MQTT"""
        logger.info("Sending test message via MQTT...")
        
        try:
            client = mqtt.Client()
            client.connect(self.mqtt_host, self.mqtt_port, keepalive=60)
            
            self.test_timestamp = datetime.utcnow().isoformat() + "Z"
            
            telemetry = {
                "device_id": self.test_device_id,
                "asset_id": self.test_asset_id,
                "timestamp": self.test_timestamp,
                "power": 1500.0,
                "energy": 1.5,
                "voltage": 230.0,
                "current": 6.5,
                "frequency": 50.0,
                "power_factor": 0.95,
                "battery_level": 75.0
            }
            
            topic = f"vpp/telemetry/{self.test_device_id}"
            payload = json.dumps(telemetry)
            
            result = client.publish(topic, payload, qos=1)
            client.disconnect()
            
            if result.rc == mqtt.MQTT_ERR_SUCCESS:
                logger.info(f"✓ Test message sent successfully to {topic}")
                return True
            else:
                logger.error(f"✗ Failed to send test message: {result.rc}")
                return False
                
        except Exception as e:
            logger.error(f"✗ Error sending test message: {e}")
            return False
    
    def verify_database_storage(self, max_wait: int = 30) -> bool:
        """Verify message was stored in database"""
        logger.info(f"Verifying database storage (max wait: {max_wait}s)...")
        
        try:
            conn = psycopg2.connect(**self.db_config)
            cursor = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            
            # Poll database for the test message
            for attempt in range(max_wait):
                query = """
                    SELECT * FROM telemetry
                    WHERE "assetId" = %s
                    AND timestamp >= NOW() - INTERVAL '1 minute'
                    ORDER BY "createdAt" DESC
                    LIMIT 1
                """
                
                cursor.execute(query, (self.test_asset_id,))
                result = cursor.fetchone()
                
                if result:
                    logger.info(f"✓ Test message found in database after {attempt+1}s")
                    logger.info(f"  Power: {result['power']}W")
                    logger.info(f"  Voltage: {result['voltage']}V")
                    logger.info(f"  Battery: {result['stateOfCharge']}%")
                    
                    cursor.close()
                    conn.close()
                    return True
                
                time.sleep(1)
            
            logger.error(f"✗ Test message NOT found in database after {max_wait}s")
            cursor.close()
            conn.close()
            return False
            
        except Exception as e:
            logger.error(f"✗ Database verification error: {e}")
            return False
    
    def run(self) -> bool:
        """Run the integration test"""
        logger.info("=== Starting Integration Test ===")
        logger.info("")
        
        # Step 1: Send test message
        if not self.send_test_message():
            logger.error("Integration test FAILED at step 1")
            return False
        
        # Wait a bit for processing
        logger.info("Waiting 5s for message processing...")
        time.sleep(5)
        
        # Step 2: Verify database storage
        if not self.verify_database_storage():
            logger.error("Integration test FAILED at step 2")
            return False
        
        logger.info("")
        logger.info("=== Integration Test PASSED ===")
        return True


if __name__ == "__main__":
    import sys
    
    logger.remove()
    logger.add(sys.stdout, level="INFO")
    
    test = IntegrationTest()
    success = test.run()
    
    sys.exit(0 if success else 1)
