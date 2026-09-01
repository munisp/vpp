//! OpenTelemetry tracing pipeline.
//!
//! The poller keeps its existing JSON `fmt` log output; when telemetry is
//! enabled a `tracing-opentelemetry` layer is added alongside it so every
//! span and `info!`/`warn!`/`error!` event is also exported as OTLP traces.
//!
//! Environment contract (shared with the rest of the platform rollout):
//!
//! - `OTEL_EXPORTER_OTLP_ENDPOINT`: gRPC (tonic) endpoint of an OTLP
//!   collector, e.g. `http://otel-collector:4317`. **Unset or empty →
//!   telemetry is disabled**, the reason is logged loudly at startup, and the
//!   poller runs exactly as before.
//! - `OTEL_SERVICE_NAME`: resource `service.name` (default `modbus-poller`).
//! - `OTEL_SERVICE_VERSION`: resource `service.version` (default: crate
//!   version).
//! - `OTEL_ENVIRONMENT`: resource `deployment.environment.name`; omitted from
//!   the resource when unset.
//! - `OTEL_TENANT_ID`: resource `tenant.id` (default `default`).
//! - `OTEL_SDK_DISABLED=true`: hard escape hatch; disables the SDK no matter
//!   what the endpoint says.
//!
//! The OTLP exporter connects lazily and batches spans on a background
//! worker: an unreachable collector produces export errors in the logs,
//! never a crash, an exit, or a stalled poll cycle.

use std::env;

use opentelemetry::trace::TracerProvider as _;
use opentelemetry::KeyValue;
use opentelemetry_otlp::{SpanExporter, WithExportConfig};
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::Resource;
use tracing_subscriber::registry::Registry;
use tracing_subscriber::Layer;

/// Keeps the tracer provider alive for the process lifetime; `shutdown`
/// flushes buffered spans on a clean exit.
pub struct Telemetry {
    provider: SdkTracerProvider,
}

impl Telemetry {
    /// Flushes and shuts the exporter down. Best effort: a dead collector at
    /// shutdown is logged, not treated as a fatal error.
    pub fn shutdown(self) {
        if let Err(err) = self.provider.shutdown() {
            tracing::warn!(error = %err, "telemetry shutdown did not complete cleanly");
        }
    }
}

/// Outcome of [`init`], logged by `main` once the subscriber exists (anything
/// logged before `tracing_subscriber` init would be dropped silently).
pub enum Status {
    Enabled {
        endpoint: String,
        service_name: String,
    },
    Disabled {
        reason: String,
    },
}

/// Everything the subscriber wiring needs from telemetry setup.
pub struct Init {
    pub layer: Option<Box<dyn Layer<Registry> + Send + Sync>>,
    pub telemetry: Option<Telemetry>,
    pub status: Status,
}

/// Builds the optional OTel layer for the subscriber. The W3C trace-context
/// propagator is installed unconditionally so outbound `traceparent`
/// injection degrades to a no-op (invalid context, nothing injected) when
/// telemetry is disabled.
pub fn init() -> Init {
    opentelemetry::global::set_text_map_propagator(TraceContextPropagator::new());

    let disabled = |reason: &str| Init {
        layer: None,
        telemetry: None,
        status: Status::Disabled {
            reason: reason.to_string(),
        },
    };

    if env::var("OTEL_SDK_DISABLED")
        .map(|v| v == "true")
        .unwrap_or(false)
    {
        return disabled("OTEL_SDK_DISABLED=true");
    }

    let endpoint = match env::var("OTEL_EXPORTER_OTLP_ENDPOINT") {
        Ok(endpoint) if !endpoint.trim().is_empty() => endpoint,
        _ => return disabled("OTEL_EXPORTER_OTLP_ENDPOINT is not set"),
    };

    let exporter = match SpanExporter::builder()
        .with_tonic()
        .with_endpoint(endpoint.clone())
        .build()
    {
        Ok(exporter) => exporter,
        Err(err) => return disabled(&format!("OTLP exporter could not be built: {err}")),
    };

    let service_name =
        env::var("OTEL_SERVICE_NAME").unwrap_or_else(|_| "modbus-poller".to_string());
    let service_version =
        env::var("OTEL_SERVICE_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string());
    let tenant_id = env::var("OTEL_TENANT_ID").unwrap_or_else(|_| "default".to_string());

    let mut attributes = vec![
        KeyValue::new("service.version", service_version),
        KeyValue::new("tenant.id", tenant_id),
    ];
    if let Ok(environment) = env::var("OTEL_ENVIRONMENT") {
        if !environment.trim().is_empty() {
            attributes.push(KeyValue::new("deployment.environment.name", environment));
        }
    }
    let resource = Resource::builder()
        .with_service_name(service_name.clone())
        .with_attributes(attributes)
        .build();

    let provider = SdkTracerProvider::builder()
        .with_batch_exporter(exporter)
        .with_resource(resource)
        .build();
    let tracer = provider.tracer(env!("CARGO_PKG_NAME"));
    let layer = tracing_opentelemetry::layer().with_tracer(tracer);

    Init {
        layer: Some(Box::new(layer)),
        telemetry: Some(Telemetry { provider }),
        status: Status::Enabled {
            endpoint,
            service_name,
        },
    }
}
