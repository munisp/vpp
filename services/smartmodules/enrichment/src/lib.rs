use fluvio_smartmodule::{smartmodule, Result, SmartModuleRecord};
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
pub fn enrich(record: &SmartModuleRecord) -> Result<(Option<Vec<u8>>, Vec<u8>)> {
    // Parse input JSON
    let input: TelemetryInput = serde_json::from_slice(record.value.as_ref())?;
    
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
    
    Ok((record.key.clone(), output))
}
