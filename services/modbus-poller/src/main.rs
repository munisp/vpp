//! Modbus poller: reads real registers from field devices (inverters, meters,
//! battery controllers) and forwards the decoded values to the VPP platform.
//! Unreachable devices, Modbus exceptions and rejected publishes are all
//! reported; none of them is replaced with a plausible number.

mod config;
mod decode;
mod platform;
mod poller;
mod spool;

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use tokio::time::{interval, MissedTickBehavior};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::platform::{PlatformClient, Reading};
use crate::spool::Spool;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .json()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

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
                return Ok(());
            }
            _ = ticker.tick() => {
                poll_once(&config, &client, &mut spool).await;
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
        let mut context = match poller::connect(device, config.request_timeout()).await {
            Ok(context) => context,
            Err(err) => {
                warn!(device = %device.id, error = %format!("{err:#}"), "device unreachable");
                continue;
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

    drain(config, client, spool, held_before).await;
}

/// Delivers what the poller is holding, oldest first. Readings stay in the spool
/// until the platform has accepted them: a reading that was never accepted is not
/// delivered telemetry, and the register read behind it cannot be repeated.
async fn drain(config: &Config, client: &PlatformClient, spool: &mut Spool, held_before: usize) {
    let mut delivered = 0usize;

    while !spool.is_empty() {
        let batch: Vec<Reading> = spool.take(config.publish_batch_size);
        let count = batch.len();
        match client.publish(&batch).await {
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
