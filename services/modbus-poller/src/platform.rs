//! Client for the VPP server's telemetry ingest endpoint.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Result};
use hmac::{Hmac, Mac};
use opentelemetry::global;
use opentelemetry_http::HeaderInjector;
use serde::Serialize;
use sha2::Sha256;
use tracing_opentelemetry::OpenTelemetrySpanExt;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Reading {
    pub device_id: String,
    pub name: String,
    pub value: f64,
    pub unit: String,
    pub address: u16,
    pub timestamp_ms: i64,
}

#[derive(Debug, Serialize)]
struct Batch<'a> {
    source: &'static str,
    readings: &'a [Reading],
}

pub struct PlatformClient {
    base_url: String,
    secret: Vec<u8>,
    http: reqwest::Client,
}

impl PlatformClient {
    pub fn new(base_url: &str, shared_secret: &str, timeout: Duration) -> Result<Self> {
        if shared_secret.len() < 32 {
            bail!("shared secret must be at least 32 characters");
        }
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            secret: shared_secret.as_bytes().to_vec(),
            http: reqwest::Client::builder().timeout(timeout).build()?,
        })
    }

    /// Publishes a batch of readings. A non-2xx response is an error: telemetry
    /// the platform never accepted must not be treated as delivered.
    pub async fn publish(&self, readings: &[Reading]) -> Result<()> {
        if readings.is_empty() {
            return Ok(());
        }
        let body = serde_json::to_vec(&Batch {
            source: "modbus",
            readings,
        })?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|err| anyhow!("system clock is before the epoch: {err}"))?
            .as_secs()
            .to_string();
        let signature = sign(&self.secret, &timestamp, &body);

        let response = self
            .http
            .post(format!("{}/api/grid/modbus/readings", self.base_url))
            .header("content-type", "application/json")
            .header("x-grid-timestamp", &timestamp)
            .header("x-grid-signature", signature)
            .headers(trace_context_headers())
            .body(body)
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            let detail = response.text().await.unwrap_or_default();
            bail!(
                "platform rejected {} readings: HTTP {status}: {detail}",
                readings.len()
            );
        }
        Ok(())
    }
}

/// W3C trace-context headers for the current span, so the ingest endpoint can
/// continue the edge trace. With telemetry disabled (or called outside any
/// span) the context is invalid and the propagator injects nothing.
fn trace_context_headers() -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    let context = tracing::Span::current().context();
    global::get_text_map_propagator(|propagator| {
        propagator.inject_context(&context, &mut HeaderInjector(&mut headers));
    });
    headers
}

/// Signs a request body the same way the Go grid protocol service does.
pub fn sign(secret: &[u8], timestamp: &str, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(timestamp.as_bytes());
    mac.update(b".");
    mac.update(body);
    hex::encode(mac.finalize().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_covers_timestamp_and_body() {
        let secret = b"0123456789abcdef0123456789abcdef";
        let a = sign(secret, "1700000000", b"{}");
        let b = sign(secret, "1700000001", b"{}");
        let c = sign(secret, "1700000000", b"{ }");
        assert_ne!(a, b, "timestamp must be covered");
        assert_ne!(a, c, "body must be covered");
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn rejects_a_short_secret() {
        assert!(
            PlatformClient::new("https://vpp.example.com", "short", Duration::from_secs(5))
                .is_err()
        );
    }

    #[test]
    fn no_traceparent_without_an_active_sampled_span() {
        assert!(trace_context_headers().get("traceparent").is_none());
    }

    #[test]
    fn traceparent_reflects_the_current_span() {
        use opentelemetry::trace::{SpanContext, TraceContextExt};
        use opentelemetry_sdk::propagation::TraceContextPropagator;
        use opentelemetry_sdk::trace::SdkTracerProvider;
        use tracing_subscriber::layer::SubscriberExt;

        global::set_text_map_propagator(TraceContextPropagator::new());
        let provider = SdkTracerProvider::builder()
            .with_sampler(opentelemetry_sdk::trace::Sampler::AlwaysOn)
            .build();
        let tracer = opentelemetry::trace::TracerProvider::tracer(&provider, "test");
        let subscriber =
            tracing_subscriber::registry().with(tracing_opentelemetry::layer().with_tracer(tracer));
        let _default = tracing::subscriber::set_default(subscriber);

        let span = tracing::info_span!("test.poll");
        let _entered = span.enter();

        let headers = trace_context_headers();
        let traceparent = headers
            .get("traceparent")
            .expect("sampled span must inject traceparent")
            .to_str()
            .expect("traceparent is ascii");
        let span_context: SpanContext = span.context().span().span_context().clone();
        assert_eq!(
            traceparent,
            format!(
                "00-{}-{}-01",
                span_context.trace_id(),
                span_context.span_id()
            )
        );
    }
}
