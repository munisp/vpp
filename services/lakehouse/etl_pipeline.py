#!/usr/bin/env python3
"""
Lakehouse ETL Pipeline for VPP Consumer Platform
Extracts data from operational database, transforms, and loads into analytics lakehouse
"""

import os
import sys
import json
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Any, Optional
import mysql.connector
from mysql.connector import Error
import boto3
from botocore.exceptions import ClientError

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class LakehouseETL:
    """ETL pipeline for VPP data lakehouse"""
    
    def __init__(self):
        self.db_config = {
            'host': os.getenv('DATABASE_HOST', 'localhost'),
            'port': int(os.getenv('DATABASE_PORT', '3306')),
            'user': os.getenv('DATABASE_USER', 'root'),
            'password': os.getenv('DATABASE_PASSWORD', ''),
            'database': os.getenv('DATABASE_NAME', 'vpp_platform')
        }
        
        self.s3_client = boto3.client(
            's3',
            endpoint_url=os.getenv('S3_ENDPOINT'),
            aws_access_key_id=os.getenv('S3_ACCESS_KEY'),
            aws_secret_access_key=os.getenv('S3_SECRET_KEY')
        )
        
        self.lakehouse_bucket = os.getenv('LAKEHOUSE_BUCKET', 'vpp-lakehouse')
        self.connection = None
    
    def connect_db(self) -> bool:
        """Connect to operational database"""
        try:
            self.connection = mysql.connector.connect(**self.db_config)
            logger.info("Connected to operational database")
            return True
        except Error as e:
            logger.error(f"Error connecting to database: {e}")
            return False
    
    def disconnect_db(self):
        """Disconnect from database"""
        if self.connection and self.connection.is_connected():
            self.connection.close()
            logger.info("Disconnected from database")
    
    def extract_telemetry_data(self, start_date: datetime, end_date: datetime) -> List[Dict]:
        """Extract telemetry data from operational database"""
        query = """
            SELECT 
                t.id,
                t.assetId,
                t.timestamp,
                t.voltage,
                t.current,
                t.power,
                t.energy,
                t.frequency,
                t.powerFactor,
                t.temperature,
                t.soc,
                t.soh,
                a.userId,
                a.type as assetType,
                a.capacity
            FROM telemetry t
            JOIN assets a ON t.assetId = a.id
            WHERE t.timestamp BETWEEN %s AND %s
            ORDER BY t.timestamp
        """
        
        try:
            cursor = self.connection.cursor(dictionary=True)
            cursor.execute(query, (start_date, end_date))
            results = cursor.fetchall()
            cursor.close()
            logger.info(f"Extracted {len(results)} telemetry records")
            return results
        except Error as e:
            logger.error(f"Error extracting telemetry data: {e}")
            return []
    
    def extract_dr_events_data(self, start_date: datetime, end_date: datetime) -> List[Dict]:
        """Extract DR events data"""
        query = """
            SELECT 
                e.id,
                e.type,
                e.startTime,
                e.endTime,
                e.targetReduction,
                e.actualReduction,
                e.compensationRate,
                e.status,
                COUNT(DISTINCT p.userId) as participantCount,
                SUM(r.actualReduction) as totalReduction,
                SUM(c.amount) as totalCompensation
            FROM demandResponseEvents e
            LEFT JOIN drParticipants p ON e.id = p.eventId
            LEFT JOIN drResponses r ON e.id = r.eventId
            LEFT JOIN drCompensation c ON e.id = c.eventId
            WHERE e.startTime BETWEEN %s AND %s
            GROUP BY e.id
        """
        
        try:
            cursor = self.connection.cursor(dictionary=True)
            cursor.execute(query, (start_date, end_date))
            results = cursor.fetchall()
            cursor.close()
            logger.info(f"Extracted {len(results)} DR event records")
            return results
        except Error as e:
            logger.error(f"Error extracting DR events data: {e}")
            return []
    
    def extract_payment_data(self, start_date: datetime, end_date: datetime) -> List[Dict]:
        """Extract payment data"""
        query = """
            SELECT 
                p.id,
                p.userId,
                p.amount,
                p.currency,
                p.gateway,
                p.status,
                p.createdAt,
                p.updatedAt,
                b.type as billingType,
                b.amount as billingAmount
            FROM payments p
            LEFT JOIN billings b ON p.id = b.paymentId
            WHERE p.createdAt BETWEEN %s AND %s
        """
        
        try:
            cursor = self.connection.cursor(dictionary=True)
            cursor.execute(query, (start_date, end_date))
            results = cursor.fetchall()
            cursor.close()
            logger.info(f"Extracted {len(results)} payment records")
            return results
        except Error as e:
            logger.error(f"Error extracting payment data: {e}")
            return []
    
    def extract_trading_data(self, start_date: datetime, end_date: datetime) -> List[Dict]:
        """Extract trading data"""
        # Fixed schema to match actual MySQL trades table
        query = """
            SELECT 
                t.id,
                t.userId,
                t.tradeType as type,
                t.tradingMode,
                t.energy as energyAmount,
                t.price as pricePerUnit,
                t.totalAmount,
                t.status,
                t.timestamp as executedAt,
                t.counterpartyId,
                t.metadata,
                t.createdAt,
                t.updatedAt
            FROM trades t
            WHERE t.createdAt BETWEEN %s AND %s
        """
        
        try:
            cursor = self.connection.cursor(dictionary=True)
            cursor.execute(query, (start_date, end_date))
            results = cursor.fetchall()
            cursor.close()
            logger.info(f"Extracted {len(results)} trading records")
            return results
        except Error as e:
            logger.error(f"Error extracting trading data: {e}")
            return []
    
    def transform_data(self, data: List[Dict], data_type: str) -> List[Dict]:
        """Transform data for lakehouse storage"""
        transformed = []
        
        for record in data:
            # Convert datetime objects to ISO format strings
            for key, value in record.items():
                if isinstance(value, datetime):
                    record[key] = value.isoformat()
            
            # Add metadata
            record['_etl_timestamp'] = datetime.utcnow().isoformat()
            record['_data_type'] = data_type
            
            transformed.append(record)
        
        return transformed
    
    def load_to_lakehouse(self, data: List[Dict], data_type: str, partition_date: str) -> bool:
        """Load data to S3 lakehouse"""
        if not data:
            logger.info(f"No {data_type} data to load")
            return True
        
        # Create partition path
        partition_path = f"{data_type}/year={partition_date[:4]}/month={partition_date[5:7]}/day={partition_date[8:10]}"
        
        # Convert to JSON Lines format
        json_lines = '\n'.join([json.dumps(record) for record in data])
        
        # Generate filename
        timestamp = datetime.utcnow().strftime('%Y%m%d_%H%M%S')
        filename = f"{partition_path}/data_{timestamp}.jsonl"
        
        try:
            self.s3_client.put_object(
                Bucket=self.lakehouse_bucket,
                Key=filename,
                Body=json_lines.encode('utf-8'),
                ContentType='application/x-ndjson'
            )
            logger.info(f"Loaded {len(data)} {data_type} records to {filename}")
            return True
        except ClientError as e:
            logger.error(f"Error loading data to lakehouse: {e}")
            return False
    
    def run_daily_etl(self, target_date: Optional[datetime] = None):
        """Run daily ETL pipeline"""
        if target_date is None:
            target_date = datetime.utcnow() - timedelta(days=1)
        
        start_date = target_date.replace(hour=0, minute=0, second=0, microsecond=0)
        end_date = start_date + timedelta(days=1)
        partition_date = start_date.strftime('%Y-%m-%d')
        
        logger.info(f"Starting ETL for date: {partition_date}")
        
        if not self.connect_db():
            logger.error("Failed to connect to database")
            return False
        
        try:
            # Extract telemetry data
            telemetry_data = self.extract_telemetry_data(start_date, end_date)
            transformed_telemetry = self.transform_data(telemetry_data, 'telemetry')
            self.load_to_lakehouse(transformed_telemetry, 'telemetry', partition_date)
            
            # Extract DR events data
            dr_events_data = self.extract_dr_events_data(start_date, end_date)
            transformed_dr_events = self.transform_data(dr_events_data, 'dr_events')
            self.load_to_lakehouse(transformed_dr_events, 'dr_events', partition_date)
            
            # Extract payment data
            payment_data = self.extract_payment_data(start_date, end_date)
            transformed_payment = self.transform_data(payment_data, 'payments')
            self.load_to_lakehouse(transformed_payment, 'payments', partition_date)
            
            # Extract trading data
            trading_data = self.extract_trading_data(start_date, end_date)
            transformed_trading = self.transform_data(trading_data, 'trades')
            self.load_to_lakehouse(transformed_trading, 'trades', partition_date)
            
            logger.info(f"ETL completed successfully for {partition_date}")
            return True
            
        except Exception as e:
            logger.error(f"ETL failed: {e}")
            return False
        finally:
            self.disconnect_db()

def main():
    """Main entry point"""
    etl = LakehouseETL()
    
    # Get target date from command line or use yesterday
    target_date = None
    if len(sys.argv) > 1:
        try:
            target_date = datetime.strptime(sys.argv[1], '%Y-%m-%d')
        except ValueError:
            logger.error("Invalid date format. Use YYYY-MM-DD")
            sys.exit(1)
    
    success = etl.run_daily_etl(target_date)
    sys.exit(0 if success else 1)

if __name__ == '__main__':
    main()
