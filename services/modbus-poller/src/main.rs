//! Modbus poller: reads real registers from field devices (inverters, meters,
//! battery controllers) and forwards the decoded values to the VPP platform.
//! Unreachable devices, Modbus exceptions and rejected publishes are all
//! reported; none of them is replaced with a plausible number.

mod config;
mod decode;
mod platform;
mod poller;
mod spool;
mod telemetry;

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use tokio::time::{interval, MissedTickBehavior};
use tracing::{error, info, info_span, warn, Instrument};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::platform::{PlatformClient, Reading};
use crate::spool::Spool;

#[tokio::main]
async fn main() -> Result<()> {
    // The existing JSON fmt output stays; an OTel layer is layered on when
    // telemetry is enabled (see telemetry.rs for the env contract).
    let otel = telemetry::init();
    tracing_subscriber::registry()
        .with(otel.layer)
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer().json())
        .init();
    match otel.status {
        telemetry::Status::Enabled {
            endpoint,
            service_name,
        } => info!(
            service.name = %service_name,
            otlp.endpoint = %endpoint,
            "telemetry enabled: exporting OTLP traces over gRPC"
        ),
        telemetry::Status::Disabled { reason } => {
            warn!("telemetry disabled: reason {reason}")
        }
    }

    let path = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("config.toml"));
    let config = Config::load(&path).context("loading configuration")?;

    let client = PlatformClient::new(
        &config.platform.base_url,
        &config.platform.shared_secret,
        Duration::from_secs(config.platform.timeout_secs),
    )?;

    info!(
        devices = config.devices.len(),
        poll_interval_secs = config.poll_interval_secs,
        spool_max_readings = config.spool_max_readings,
        "modbus poller starting"
    );
    let mut spool = Spool::new(config.spool_max_readings);

    let mut ticker = interval(config.poll_interval());
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                info!("shutting down");
                if let Some(telemetry) = otel.telemetry {
                    telemetry.shutdown();
                }
                return Ok(());
            }
            _ = ticker.tick() => {
                // Root span of the cycle's trace: device polls and publishes
                // below are its children.
                let span = info_span!("modbus.poll_cycle", devices = config.devices.len());
                poll_once(&config, &client, &mut spool).instrument(span).await;
            }
        }
    }
}

async fn poll_once(config: &Config, client: &PlatformClient, spool: &mut Spool) {
    let held_before = spool.len();
    let now_ms = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(elapsed) => elapsed.as_millis() as i64,
        Err(err) => {
            error!(error = %err, "system clock is before the epoch; skipping this cycle");
            return;
        }
    };

    for device in &config.devices {
        // One span per device per poll cycle: register range attributes make
        // the span useful on its own, and every warn!/error! below lands on it
        // as a span event.
        let span = info_span!(
            "modbus.poll_device",
            device.id = %device.id,
            modbus.register_count = device.registers.len(),
            modbus.address_min = device.registers.iter().map(|r| r.address).min().unwrap_or(0),
            modbus.address_max = device.registers.iter().map(|r| r.address).max().unwrap_or(0),
        );
        poll_device_cycle(device, config, spool, now_ms)
            .instrument(span)
            .await;
    }

    drain(config, client, spool, held_before).await;
}

/// Reads every register of one device. Failures are reported on the span, not
/// smoothed over: an unreachable device or a failed register is visible in the
/// trace exactly as it is in the logs.
async fn poll_device_cycle(
    device: &config::DeviceConfig,
    config: &Config,
    spool: &mut Spool,
    now_ms: i64,
) {
    let mut context = match poller::connect(device, config.request_timeout()).await {
        Ok(context) => context,
        Err(err) => {
            warn!(device = %device.id, error = %format!("{err:#}"), "device unreachable");
            return;
        }
    };

    let (readings, failures) =
        poller::poll_device(&mut context, device, config.request_timeout(), now_ms).await;
    for failure in &failures {
        warn!(device = %device.id, error = %format!("{failure:#}"), "register read failed");
    }
    let dropped = spool.push(readings);
    if dropped > 0 {
        error!(
            device = %device.id,
            dropped,
            dropped_total = spool.dropped_total(),
            "spool is full: readings discarded, the meter history now has a hole"
        );
    }
}

/// Delivers what the poller is holding, oldest first. Readings stay in the spool
/// until the platform has accepted them: a reading that was never accepted is not
/// delivered telemetry, and the register read behind it cannot be repeated.
async fn drain(config: &Config, client: &PlatformClient, spool: &mut Spool, held_before: usize) {
    let mut delivered = 0usize;

    while !spool.is_empty() {
        let batch: Vec<Reading> = spool.take(config.publish_batch_size);
        let count = batch.len();
        // The publish span is what the server joins: publish() injects the
        // current span context as a W3C `traceparent` header on the POST.
        let span = info_span!("modbus.publish", modbus.batch_readings = count);
        match client.publish(&batch).instrument(span).await {
            Ok(()) => delivered += count,
            Err(err) => {
                let dropped = spool.requeue(batch);
                error!(
                    error = %format!("{err:#}"),
                    delivered,
                    holding = spool.len(),
                    dropped,
                    dropped_total = spool.dropped_total(),
                    "publishing readings failed; holding them for the next cycle"
                );
                return;
            }
        }
    }

    if delivered > 0 {
        info!(
            readings = delivered,
            replayed = held_before.min(delivered),
            "published readings"
        );
    }
}
