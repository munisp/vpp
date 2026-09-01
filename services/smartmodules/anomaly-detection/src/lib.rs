use fluvio_smartmodule::{smartmodule, RecordData, Result, SmartModuleRecord};
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
    /// W3C trace-context (`traceparent`) stamped by the producing bridge.
    /// SmartModules cannot run an OTel exporter (WASM guest, no sockets), so
    /// the context is carried through the payload verbatim for consumers to
    /// extract; records without it are processed unchanged.
    #[serde(default)]
    traceparent: Option<String>,
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
    /// Copied from the incoming record so alerts join the same trace.
    /// Omitted when the record carried no trace context.
    #[serde(skip_serializing_if = "Option::is_none")]
    traceparent: Option<String>,
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
pub fn detect_anomalies(
    record: &SmartModuleRecord,
) -> Result<Option<(Option<RecordData>, RecordData)>> {
    let output = detect_anomalies_value(record.value.as_ref())?;
    Ok(output.map(|alert| (record.key().cloned(), alert.into())))
}

/// The actual detection, separated from the SmartModule glue so it is
/// unit-testable on the host.
fn detect_anomalies_value(value: &[u8]) -> Result<Option<Vec<u8>>> {
    // Parse input JSON
    let input: TelemetryInput = serde_json::from_slice(value)?;

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
            traceparent: input.traceparent.clone(),
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
            traceparent: input.traceparent.clone(),
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
            traceparent: input.traceparent.clone(),
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
            traceparent: input.traceparent.clone(),
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
            traceparent: input.traceparent.clone(),
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
                traceparent: input.traceparent.clone(),
            });
        }
    }
    
    // If anomalies detected, return the first one (or combine into array)
    match anomalies.first() {
        Some(anomaly) => Ok(Some(serde_json::to_vec(anomaly)?)),
        // No anomalies, filter out this record
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRACEPARENT: &str = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    fn payload(power: f64, traceparent: Option<&str>) -> Vec<u8> {
        let tp = traceparent
            .map(|tp| format!(",\"traceparent\":\"{tp}\""))
            .unwrap_or_default();
        format!(
            r#"{{"device_id":"device-001","asset_id":1,"power":{power},"voltage":230.0,"current":6.5,"frequency":50.0,"power_factor":0.95,"battery_level":75.0{tp}}}"#
        )
        .into_bytes()
    }

    #[test]
    fn alert_carries_the_incoming_traceparent() {
        let output = detect_anomalies_value(&payload(9000.0, Some(TRACEPARENT)))
            .expect("detect")
            .expect("high power is an anomaly");
        let alert: serde_json::Value = serde_json::from_slice(&output).expect("alert json");
        assert_eq!(alert["traceparent"], TRACEPARENT);
        assert_eq!(alert["anomaly_type"], "high_power");
    }

    #[test]
    fn alert_is_valid_without_traceparent() {
        let output = detect_anomalies_value(&payload(9000.0, None))
            .expect("detect")
            .expect("high power is an anomaly");
        let alert: serde_json::Value = serde_json::from_slice(&output).expect("alert json");
        assert!(alert.get("traceparent").is_none());
        assert_eq!(alert["anomaly_type"], "high_power");
        assert_eq!(alert["device_id"], "device-001");
    }

    #[test]
    fn record_without_anomalies_is_filtered_out() {
        assert!(detect_anomalies_value(&payload(1500.0, Some(TRACEPARENT)))
            .expect("detect")
            .is_none());
    }
}
