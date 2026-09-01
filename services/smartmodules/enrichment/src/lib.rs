use fluvio_smartmodule::{smartmodule, RecordData, Result, SmartModuleRecord};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct TelemetryInput {
    device_id: String,
    asset_id: i32,
    timestamp: String,
    power: f64,
    energy: f64,
    voltage: f64,
    current: f64,
    frequency: f64,
    power_factor: f64,
    battery_level: Option<f64>,
    /// W3C trace-context (`traceparent`) stamped by the producing bridge.
    /// SmartModules cannot run an OTel exporter (WASM guest, no sockets), so
    /// the context is carried through the payload verbatim for consumers to
    /// extract; records without it are enriched unchanged.
    #[serde(default)]
    traceparent: Option<String>,
}

#[derive(Debug, Serialize)]
struct EnrichedTelemetry {
    // Original fields
    device_id: String,
    asset_id: i32,
    timestamp: String,
    power: f64,
    energy: f64,
    voltage: f64,
    current: f64,
    frequency: f64,
    power_factor: f64,
    battery_level: Option<f64>,
    /// Passed through untouched when present, omitted when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    traceparent: Option<String>,

    // Enriched fields
    power_kw: f64,
    energy_kwh: f64,
    apparent_power: f64,
    reactive_power: f64,
    power_quality: String,
    voltage_status: String,
    frequency_status: String,
    battery_status: Option<String>,
}

#[smartmodule(map)]
pub fn enrich(record: &SmartModuleRecord) -> Result<(Option<RecordData>, RecordData)> {
    let output = enrich_value(record.value.as_ref())?;
    Ok((record.key().cloned(), output.into()))
}

/// The actual transform, separated from the SmartModule glue so it is
/// unit-testable on the host.
fn enrich_value(value: &[u8]) -> Result<Vec<u8>> {
    // Parse input JSON
    let input: TelemetryInput = serde_json::from_slice(value)?;
    
    // Calculate derived metrics
    let power_kw = input.power / 1000.0;
    let energy_kwh = input.energy / 1000.0;
    let apparent_power = input.voltage * input.current;
    let reactive_power = (apparent_power.powi(2) - input.power.powi(2)).sqrt();
    
    // Determine power quality
    let power_quality = if input.power_factor >= 0.95 {
        "excellent"
    } else if input.power_factor >= 0.85 {
        "good"
    } else if input.power_factor >= 0.75 {
        "fair"
    } else {
        "poor"
    }.to_string();
    
    // Determine voltage status
    let voltage_status = if input.voltage >= 220.0 && input.voltage <= 240.0 {
        "normal"
    } else if input.voltage >= 210.0 && input.voltage <= 250.0 {
        "warning"
    } else {
        "critical"
    }.to_string();
    
    // Determine frequency status
    let frequency_status = if input.frequency >= 49.5 && input.frequency <= 50.5 {
        "normal"
    } else if input.frequency >= 49.0 && input.frequency <= 51.0 {
        "warning"
    } else {
        "critical"
    }.to_string();
    
    // Determine battery status
    let battery_status = input.battery_level.map(|level| {
        if level >= 80.0 {
            "high"
        } else if level >= 40.0 {
            "medium"
        } else if level >= 20.0 {
            "low"
        } else {
            "critical"
        }.to_string()
    });
    
    // Create enriched output
    let enriched = EnrichedTelemetry {
        device_id: input.device_id,
        asset_id: input.asset_id,
        timestamp: input.timestamp,
        power: input.power,
        energy: input.energy,
        voltage: input.voltage,
        current: input.current,
        frequency: input.frequency,
        power_factor: input.power_factor,
        battery_level: input.battery_level,
        traceparent: input.traceparent,
        power_kw,
        energy_kwh,
        apparent_power,
        reactive_power,
        power_quality,
        voltage_status,
        frequency_status,
        battery_status,
    };
    
    // Serialize to JSON
    let output = serde_json::to_vec(&enriched)?;

    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRACEPARENT: &str = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

    fn payload(traceparent: Option<&str>) -> Vec<u8> {
        let tp = traceparent
            .map(|tp| format!(",\"traceparent\":\"{tp}\""))
            .unwrap_or_default();
        format!(
            r#"{{"device_id":"device-001","asset_id":1,"timestamp":"2024-01-01T00:00:00Z","power":1500.0,"energy":12000.0,"voltage":230.0,"current":6.5,"frequency":50.0,"power_factor":0.95,"battery_level":75.0{tp}}}"#
        )
        .into_bytes()
    }

    #[test]
    fn preserves_traceparent_when_present() {
        let output = enrich_value(&payload(Some(TRACEPARENT))).expect("enrich");
        let value: serde_json::Value = serde_json::from_slice(&output).expect("output json");
        assert_eq!(value["traceparent"], TRACEPARENT);
        // The enrichment itself is unaffected.
        assert_eq!(value["power_kw"], 1.5);
        assert_eq!(value["power_quality"], "excellent");
    }

    #[test]
    fn omits_traceparent_when_absent() {
        let output = enrich_value(&payload(None)).expect("enrich");
        let value: serde_json::Value = serde_json::from_slice(&output).expect("output json");
        assert!(value.get("traceparent").is_none());
        // Output is still a valid enriched record.
        assert_eq!(value["device_id"], "device-001");
        assert!(value.get("power_kw").is_some());
    }
}
