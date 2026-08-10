"""
IoT Device Simulator for VPP Platform
Simulates multiple smart meters sending telemetry data via MQTT
"""

import json
import random
import time
from datetime import datetime
from typing import List

import paho.mqtt.client as mqtt
from loguru import logger


class SmartMeterSimulator:
    """Simulates a smart meter device"""
    
    def __init__(self, device_id: str, asset_id: int):
        self.device_id = device_id
        self.asset_id = asset_id
        
        # Simulated state
        self.battery_level = random.uniform(50, 100)
        self.base_power = random.uniform(1000, 3000)  # W
        self.voltage = 230.0  # V
        
    def generate_telemetry(self) -> dict:
        """Generate realistic telemetry data"""
        
        # Add some randomness to simulate real conditions
        power = self.base_power + random.uniform(-200, 200)
        voltage = self.voltage + random.uniform(-5, 5)
        current = power / voltage if voltage > 0 else 0
        
        # Simulate battery charge/discharge
        if power > 2000:
            self.battery_level = max(0, self.battery_level - random.uniform(0.1, 0.5))
        else:
            self.battery_level = min(100, self.battery_level + random.uniform(0.1, 0.3))
        
        telemetry = {
            "device_id": self.device_id,
            "asset_id": self.asset_id,
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "power": round(power, 2),
            "energy": round(power / 1000, 2),  # Convert to kWh
            "voltage": round(voltage, 2),
            "current": round(current, 2),
            "frequency": round(50.0 + random.uniform(-0.1, 0.1), 2),
            "power_factor": round(random.uniform(0.90, 0.99), 3),
            "battery_level": round(self.battery_level, 1)
        }
        
        return telemetry


class DeviceFleet:
    """Manages a fleet of simulated devices"""
    
    def __init__(
        self,
        broker_host: str = "localhost",
        broker_port: int = 1883,
        device_count: int = 10,
        use_tls: bool = False
    ):
        self.broker_host = broker_host
        self.broker_port = broker_port
        self.device_count = device_count
        self.use_tls = use_tls
        
        self.client = mqtt.Client(client_id="device-simulator")
        self.devices: List[SmartMeterSimulator] = []
        self.running = False
        
    def setup_mqtt(self):
        """Setup MQTT client"""
        
        def on_connect(client, userdata, flags, rc):
            if rc == 0:
                logger.info(f"Connected to MQTT broker at {self.broker_host}:{self.broker_port}")
            else:
                logger.error(f"Failed to connect to MQTT broker: {rc}")
        
        def on_disconnect(client, userdata, rc):
            logger.warning(f"Disconnected from MQTT broker: {rc}")
        
        self.client.on_connect = on_connect
        self.client.on_disconnect = on_disconnect
        
        if self.use_tls:
            self.client.tls_set()
        
    def create_devices(self):
        """Create simulated devices"""
        logger.info(f"Creating {self.device_count} simulated devices")
        
        for i in range(self.device_count):
            device_id = f"sim-device-{i+1:03d}"
            asset_id = i + 1
            device = SmartMeterSimulator(device_id, asset_id)
            self.devices.append(device)
        
        logger.info(f"Created {len(self.devices)} devices")
    
    def publish_telemetry(self, device: SmartMeterSimulator):
        """Publish telemetry from a device"""
        telemetry = device.generate_telemetry()
        topic = f"vpp/telemetry/{device.device_id}"
        payload = json.dumps(telemetry)
        
        result = self.client.publish(topic, payload, qos=1)
        
        if result.rc == mqtt.MQTT_ERR_SUCCESS:
            logger.debug(f"Published telemetry from {device.device_id}")
        else:
            logger.error(f"Failed to publish from {device.device_id}: {result.rc}")
    
    def run(self, interval: float = 5.0, duration: int = None):
        """
        Run the simulator
        
        Args:
            interval: Seconds between telemetry messages per device
            duration: Total duration in seconds (None for infinite)
        """
        self.setup_mqtt()
        self.create_devices()
        
        logger.info(f"Connecting to MQTT broker at {self.broker_host}:{self.broker_port}")
        self.client.connect(self.broker_host, self.broker_port, keepalive=60)
        self.client.loop_start()
        
        # Wait for connection
        time.sleep(2)
        
        self.running = True
        start_time = time.time()
        message_count = 0
        
        logger.info(f"Starting simulation (interval={interval}s, duration={duration}s)")
        
        try:
            while self.running:
                # Publish from all devices
                for device in self.devices:
                    self.publish_telemetry(device)
                    message_count += 1
                
                # Check duration
                if duration and (time.time() - start_time) >= duration:
                    logger.info(f"Simulation duration reached ({duration}s)")
                    break
                
                # Wait for next interval
                time.sleep(interval)
                
                # Log stats every 60 seconds
                elapsed = time.time() - start_time
                if int(elapsed) % 60 == 0 and elapsed > 0:
                    rate = message_count / elapsed
                    logger.info(
                        f"Stats: {message_count} messages sent, "
                        f"{rate:.2f} msg/s, "
                        f"{len(self.devices)} devices"
                    )
        
        except KeyboardInterrupt:
            logger.info("Simulation interrupted by user")
        
        finally:
            self.stop()
            logger.info(f"Total messages sent: {message_count}")
    
    def stop(self):
        """Stop the simulator"""
        self.running = False
        self.client.loop_stop()
        self.client.disconnect()
        logger.info("Simulator stopped")


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="IoT Device Simulator for VPP Platform")
    parser.add_argument("--host", default="localhost", help="MQTT broker host")
    parser.add_argument("--port", type=int, default=1883, help="MQTT broker port")
    parser.add_argument("--devices", type=int, default=10, help="Number of devices to simulate")
    parser.add_argument("--interval", type=float, default=5.0, help="Interval between messages (seconds)")
    parser.add_argument("--duration", type=int, default=None, help="Simulation duration (seconds)")
    parser.add_argument("--tls", action="store_true", help="Use TLS connection")
    
    args = parser.parse_args()
    
    logger.add("logs/simulator.log", rotation="10 MB", retention="7 days")
    
    fleet = DeviceFleet(
        broker_host=args.host,
        broker_port=args.port,
        device_count=args.devices,
        use_tls=args.tls
    )
    
    fleet.run(interval=args.interval, duration=args.duration)
