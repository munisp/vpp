use fluvio_smartmodule::{smartmodule, Result, SmartModuleRecord};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct TelemetryInput {
    device_id: String,
    asset_id: i32,
    power: f64,
    voltage: f64,
    current: f64,
    frequency: f64,
    power_factor: f64,
    battery_level: Option<f64>,
}

#[derive(Debug, Serialize)]
struct AnomalyAlert {
    device_id: String,
    asset_id: i32,
    timestamp: String,
    anomaly_type: String,
    severity: String,
    message: String,
    value: f64,
    threshold: f64,
}

// Thresholds for anomaly detection
const POWER_MAX: f64 = 5000.0;  // W
const VOLTAGE_MIN: f64 = 210.0;  // V
const VOLTAGE_MAX: f64 = 250.0;  // V
const FREQUENCY_MIN: f64 = 49.0;  // Hz
const FREQUENCY_MAX: f64 = 51.0;  // Hz
const POWER_FACTOR_MIN: f64 = 0.70;
const BATTERY_CRITICAL: f64 = 15.0;  // %

#[smartmodule(filter_map)]
pub fn detect_anomalies(record: &SmartModuleRecord) -> Result<Option<(Option<Vec<u8>>, Vec<u8>)>> {
    // Parse input JSON
    let input: TelemetryInput = serde_json::from_slice(record.value.as_ref())?;
    
    let mut anomalies = Vec::new();
    
    // Check for power anomalies
    if input.power > POWER_MAX {
        anomalies.push(AnomalyAlert {
            device_id: input.device_id.clone(),
            asset_id: input.asset_id,
            timestamp: chrono::Utc::now().to_rfc3339(),
            anomaly_type: "high_power".to_string(),
            severity: "warning".to_string(),
            message: format!("Power consumption exceeds threshold: {:.2}W", input.power),
            value: input.power,
            threshold: POWER_MAX,
        });
    }
    
    // Check for voltage anomalies
    if input.voltage < VOLTAGE_MIN {
        anomalies.push(AnomalyAlert {
            device_id: input.device_id.clone(),
            asset_id: input.asset_id,
            timestamp: chrono::Utc::now().to_rfc3339(),
            anomaly_type: "low_voltage".to_string(),
            severity: if input.voltage < 200.0 { "critical" } else { "warning" }.to_string(),
            message: format!("Voltage below safe threshold: {:.2}V", input.voltage),
            value: input.voltage,
            threshold: VOLTAGE_MIN,
        });
    } else if input.voltage > VOLTAGE_MAX {
        anomalies.push(AnomalyAlert {
            device_id: input.device_id.clone(),
            asset_id: input.asset_id,
            timestamp: chrono::Utc::now().to_rfc3339(),
            anomaly_type: "high_voltage".to_string(),
            severity: if input.voltage > 260.0 { "critical" } else { "warning" }.to_string(),
            message: format!("Voltage above safe threshold: {:.2}V", input.voltage),
            value: input.voltage,
            threshold: VOLTAGE_MAX,
        });
    }
    
    // Check for frequency anomalies
    if input.frequency < FREQUENCY_MIN || input.frequency > FREQUENCY_MAX {
        anomalies.push(AnomalyAlert {
            device_id: input.device_id.clone(),
            asset_id: input.asset_id,
            timestamp: chrono::Utc::now().to_rfc3339(),
            anomaly_type: "frequency_deviation".to_string(),
            severity: "critical".to_string(),
            message: format!("Grid frequency out of range: {:.2}Hz", input.frequency),
            value: input.frequency,
            threshold: 50.0,
        });
    }
    
    // Check for power factor anomalies
    if input.power_factor < POWER_FACTOR_MIN {
        anomalies.push(AnomalyAlert {
            device_id: input.device_id.clone(),
            asset_id: input.asset_id,
            timestamp: chrono::Utc::now().to_rfc3339(),
            anomaly_type: "low_power_factor".to_string(),
            severity: "warning".to_string(),
            message: format!("Poor power factor: {:.3}", input.power_factor),
            value: input.power_factor,
            threshold: POWER_FACTOR_MIN,
        });
    }
    
    // Check for battery anomalies
    if let Some(battery_level) = input.battery_level {
        if battery_level < BATTERY_CRITICAL {
            anomalies.push(AnomalyAlert {
                device_id: input.device_id.clone(),
                asset_id: input.asset_id,
                timestamp: chrono::Utc::now().to_rfc3339(),
                anomaly_type: "battery_critical".to_string(),
                severity: "critical".to_string(),
                message: format!("Battery level critically low: {:.1}%", battery_level),
                value: battery_level,
                threshold: BATTERY_CRITICAL,
            });
        }
    }
    
    // If anomalies detected, return the first one (or combine into array)
    if let Some(anomaly) = anomalies.first() {
        let output = serde_json::to_vec(anomaly)?;
        Ok(Some((record.key.clone(), output)))
    } else {
        // No anomalies, filter out this record
        Ok(None)
    }
}
