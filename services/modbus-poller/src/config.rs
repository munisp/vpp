//! Configuration for the Modbus poller. Every device and register must be
//! described explicitly: a poller that guesses register maps produces numbers
//! that look like telemetry but describe nothing.

use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Config {
    pub platform: PlatformConfig,
    #[serde(default = "default_poll_interval_secs")]
    pub poll_interval_secs: u64,
    #[serde(default = "default_request_timeout_ms")]
    pub request_timeout_ms: u64,
    /// Readings held while the platform is unreachable. Bounded on purpose: when
    /// it fills, the oldest readings are dropped and counted rather than the
    /// poller growing without limit on a field gateway.
    #[serde(default = "default_spool_max_readings")]
    pub spool_max_readings: usize,
    /// Readings sent per delivery attempt, including replayed ones. A batch
    /// overshoots this rather than cut through an instant: the platform groups
    /// registers into one sample per device per instant within a request, so a
    /// split instant would be stored as two half-populated rows.
    #[serde(default = "default_publish_batch_size")]
    pub publish_batch_size: usize,
    #[serde(default)]
    pub devices: Vec<DeviceConfig>,
}

#[derive(Debug, Deserialize)]
pub struct PlatformConfig {
    pub base_url: String,
    pub shared_secret: String,
    #[serde(default = "default_platform_timeout_secs")]
    pub timeout_secs: u64,
}

#[derive(Debug, Deserialize)]
pub struct DeviceConfig {
    /// Device identifier as known to the platform (asset id).
    pub id: String,
    pub transport: Transport,
    pub registers: Vec<RegisterConfig>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Transport {
    Tcp {
        host: String,
        #[serde(default = "default_modbus_port")]
        port: u16,
        #[serde(default = "default_unit_id")]
        unit_id: u8,
    },
    Rtu {
        path: String,
        baud_rate: u32,
        #[serde(default = "default_unit_id")]
        unit_id: u8,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RegisterKind {
    Holding,
    Input,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DataType {
    U16,
    I16,
    U32,
    I32,
    F32,
}

impl DataType {
    pub fn word_count(self) -> u16 {
        match self {
            DataType::U16 | DataType::I16 => 1,
            DataType::U32 | DataType::I32 | DataType::F32 => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum WordOrder {
    /// Most significant word first, the Modbus convention.
    #[default]
    Big,
    /// Least significant word first, used by several inverter vendors.
    Little,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RegisterConfig {
    /// Measurement name, e.g. active_power_w or state_of_charge_percent.
    pub name: String,
    pub address: u16,
    pub kind: RegisterKind,
    pub data_type: DataType,
    /// Multiplier applied to the raw value to reach `unit`.
    #[serde(default = "default_scale")]
    pub scale: f64,
    /// Physical unit of the scaled value, recorded with the reading so the
    /// platform never has to infer it.
    pub unit: String,
    #[serde(default)]
    pub word_order: WordOrder,
}

fn default_poll_interval_secs() -> u64 {
    30
}
fn default_request_timeout_ms() -> u64 {
    3_000
}
fn default_platform_timeout_secs() -> u64 {
    15
}
fn default_modbus_port() -> u16 {
    502
}
fn default_unit_id() -> u8 {
    1
}
fn default_scale() -> f64 {
    1.0
}
fn default_spool_max_readings() -> usize {
    50_000
}
fn default_publish_batch_size() -> usize {
    500
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading configuration {}", path.display()))?;
        let mut config: Config = toml::from_str(&text)
            .with_context(|| format!("parsing configuration {}", path.display()))?;
        config.apply_env_overrides();
        config.validate()?;
        Ok(config)
    }

    fn apply_env_overrides(&mut self) {
        if let Ok(url) = std::env::var("PLATFORM_BASE_URL") {
            if !url.is_empty() {
                self.platform.base_url = url;
            }
        }
        if let Ok(secret) = std::env::var("GRID_PROTOCOL_SHARED_SECRET") {
            if !secret.is_empty() {
                self.platform.shared_secret = secret;
            }
        }
    }

    pub fn validate(&self) -> Result<()> {
        if self.platform.base_url.trim().is_empty() {
            bail!("platform.base_url is required: readings have nowhere to go without it");
        }
        if !self.platform.base_url.starts_with("http://")
            && !self.platform.base_url.starts_with("https://")
        {
            bail!(
                "platform.base_url {} is not an http(s) URL",
                self.platform.base_url
            );
        }
        if self.platform.shared_secret.len() < 32 {
            bail!("platform.shared_secret must be at least 32 characters");
        }
        if self.devices.is_empty() {
            bail!("no devices configured: the poller would run without reading anything");
        }
        if self.poll_interval_secs == 0 {
            bail!("poll_interval_secs must be greater than zero");
        }
        if self.request_timeout_ms == 0 {
            bail!("request_timeout_ms must be greater than zero");
        }
        if self.publish_batch_size == 0 {
            bail!("publish_batch_size must be greater than zero: nothing would ever be sent");
        }
        if self.spool_max_readings < self.publish_batch_size {
            bail!(
                "spool_max_readings ({}) must be at least publish_batch_size ({}): a spool smaller than one batch would discard readings it was about to send",
                self.spool_max_readings,
                self.publish_batch_size
            );
        }

        for device in &self.devices {
            if device.id.trim().is_empty() {
                bail!("every device needs an id");
            }
            if device.registers.is_empty() {
                bail!("device {} has no registers to read", device.id);
            }
            let mut names = std::collections::HashSet::new();
            for register in &device.registers {
                if register.name.trim().is_empty() {
                    bail!("device {} has a register without a name", device.id);
                }
                if !names.insert(register.name.as_str()) {
                    bail!(
                        "device {} declares register name {} twice",
                        device.id,
                        register.name
                    );
                }
                if register.unit.trim().is_empty() {
                    bail!(
                        "device {} register {} has no unit: an unlabelled value cannot be settled against",
                        device.id, register.name
                    );
                }
                if register.scale == 0.0 || !register.scale.is_finite() {
                    bail!(
                        "device {} register {} has an unusable scale {}",
                        device.id,
                        register.name,
                        register.scale
                    );
                }
            }
            match &device.transport {
                Transport::Tcp { host, port, .. } => {
                    if host.trim().is_empty() {
                        bail!("device {} has no host", device.id);
                    }
                    if *port == 0 {
                        bail!("device {} has port 0", device.id);
                    }
                }
                Transport::Rtu {
                    path, baud_rate, ..
                } => {
                    if path.trim().is_empty() {
                        bail!("device {} has no serial path", device.id);
                    }
                    if *baud_rate == 0 {
                        bail!("device {} has baud rate 0", device.id);
                    }
                }
            }
        }
        Ok(())
    }

    pub fn poll_interval(&self) -> Duration {
        Duration::from_secs(self.poll_interval_secs)
    }

    pub fn request_timeout(&self) -> Duration {
        Duration::from_millis(self.request_timeout_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<Config> {
        let config: Config = toml::from_str(text)?;
        config.validate()?;
        Ok(config)
    }

    const VALID: &str = r#"
        poll_interval_secs = 10

        [platform]
        base_url = "https://vpp.example.com"
        shared_secret = "0123456789abcdef0123456789abcdef"

        [[devices]]
        id = "inverter-1"
        transport = { type = "tcp", host = "10.0.0.5", port = 502, unit_id = 3 }
        registers = [
          { name = "active_power_w", address = 40083, kind = "input", data_type = "i32", scale = 1.0, unit = "W" },
          { name = "soc_percent", address = 40100, kind = "holding", data_type = "u16", scale = 0.1, unit = "%" },
        ]
    "#;

    #[test]
    fn accepts_a_complete_configuration() {
        let config = parse(VALID).expect("valid config");
        assert_eq!(config.devices.len(), 1);
        assert_eq!(config.poll_interval(), Duration::from_secs(10));
        match &config.devices[0].transport {
            Transport::Tcp { unit_id, .. } => assert_eq!(*unit_id, 3),
            other => panic!("unexpected transport {other:?}"),
        }
    }

    #[test]
    fn rejects_incomplete_configurations() {
        let cases = [
            (
                "short secret",
                VALID.replace("0123456789abcdef0123456789abcdef", "short"),
            ),
            ("no unit", VALID.replace(r#"unit = "W""#, r#"unit = """#)),
            ("zero scale", VALID.replace("scale = 1.0", "scale = 0.0")),
            (
                "no devices",
                VALID.split("[[devices]]").next().unwrap().to_string(),
            ),
            (
                "plain hostname",
                VALID.replace("https://vpp.example.com", "vpp.example.com"),
            ),
            (
                "duplicate register",
                VALID.replace("soc_percent", "active_power_w"),
            ),
            (
                "spool smaller than a batch",
                format!("spool_max_readings = 10\npublish_batch_size = 100\n{VALID}"),
            ),
        ];
        for (name, text) in cases {
            assert!(parse(&text).is_err(), "expected {name} to be rejected");
        }
    }
}
