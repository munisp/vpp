// Package telemetry wires OpenTelemetry tracing for the MQTT→Fluvio/Kafka
// bridge.
//
// Configuration is entirely environment driven, matching the platform-wide
// contract:
//
//	OTEL_EXPORTER_OTLP_ENDPOINT  gRPC OTLP collector, e.g. http://localhost:4317.
//	                             Unset means telemetry is disabled (logged loudly
//	                             at boot); an unreachable collector never blocks
//	                             or crashes the bridge — the gRPC exporter
//	                             connects lazily and retries in the background.
//	OTEL_SERVICE_NAME            resource service.name (default "mqtt-fluvio-bridge").
//	OTEL_SERVICE_VERSION         resource service.version (omitted when empty).
//	OTEL_ENVIRONMENT             resource deployment.environment (omitted when empty).
//	OTEL_TENANT_ID               resource tenant.id (default "default").
//	OTEL_SDK_DISABLED=true       escape hatch: forces the no-op SDK even when an
//	                             endpoint is configured.
//
// Metrics stay on the existing client_golang Prometheus registry (the
// dashboards are built on it); this package covers traces only.
package telemetry

import (
	"context"
	"crypto/tls"
	"os"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
	"google.golang.org/grpc/credentials"
)

// Status reports the telemetry pipeline state for /healthz.
type Status struct {
	Enabled     bool   `json:"enabled"`
	Endpoint    string `json:"endpoint,omitempty"`
	ServiceName string `json:"service_name"`
	Reason      string `json:"reason,omitempty"`
}

// Telemetry owns the SDK tracer provider. When disabled, the global provider
// stays no-op and Shutdown is a no-op.
type Telemetry struct {
	status         Status
	resource       *resource.Resource
	tracerProvider *sdktrace.TracerProvider
}

// Setup initialises the SDK from the environment. It never fails hard: an
// unparseable endpoint or exporter construction error degrades to disabled
// with a loud log line, because bridging telemetry must not depend on the
// observability stack. warnf receives exactly one loudly-worded line per
// degradation.
func Setup(defaultServiceName string, warnf func(format string, args ...any)) *Telemetry {
	if warnf == nil {
		warnf = func(string, ...any) {}
	}

	// W3C tracecontext is the propagation contract across the platform. It is
	// installed even when the SDK is disabled so inject/extract code paths are
	// uniform; with no recording spans there is simply nothing to propagate.
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{}))

	serviceName := strings.TrimSpace(os.Getenv("OTEL_SERVICE_NAME"))
	if serviceName == "" {
		serviceName = defaultServiceName
	}
	t := &Telemetry{status: Status{ServiceName: serviceName}}

	endpoint := strings.TrimSpace(os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"))
	switch {
	case strings.EqualFold(os.Getenv("OTEL_SDK_DISABLED"), "true"):
		t.status.Reason = "OTEL_SDK_DISABLED=true"
		warnf("telemetry disabled: OTEL_SDK_DISABLED=true")
		return t
	case endpoint == "":
		t.status.Reason = "OTEL_EXPORTER_OTLP_ENDPOINT not set"
		warnf("telemetry disabled: OTEL_EXPORTER_OTLP_ENDPOINT not set")
		return t
	}

	tenantID := strings.TrimSpace(os.Getenv("OTEL_TENANT_ID"))
	if tenantID == "" {
		tenantID = "default"
	}
	attrs := []attribute.KeyValue{
		semconv.ServiceName(serviceName),
		attribute.String("tenant.id", tenantID),
	}
	if v := strings.TrimSpace(os.Getenv("OTEL_SERVICE_VERSION")); v != "" {
		attrs = append(attrs, semconv.ServiceVersion(v))
	}
	if v := strings.TrimSpace(os.Getenv("OTEL_ENVIRONMENT")); v != "" {
		attrs = append(attrs, semconv.DeploymentEnvironment(v))
	}
	res, err := resource.New(context.Background(), resource.WithAttributes(attrs...))
	if err != nil {
		t.status.Reason = "resource: " + err.Error()
		warnf("telemetry disabled: %s", t.status.Reason)
		return t
	}
	t.resource = res

	target, insecure := grpcTarget(endpoint)
	opts := []otlptracegrpc.Option{otlptracegrpc.WithEndpoint(target)}
	if insecure {
		opts = append(opts, otlptracegrpc.WithInsecure())
	} else {
		opts = append(opts, otlptracegrpc.WithTLSCredentials(
			credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12})))
	}
	// The gRPC exporter connects lazily: a collector that is down at boot does
	// not fail construction, and the batcher keeps retrying in the background.
	exporter, err := otlptracegrpc.New(context.Background(), opts...)
	if err != nil {
		t.status.Reason = "trace exporter: " + err.Error()
		warnf("telemetry disabled: %s", t.status.Reason)
		return t
	}
	t.tracerProvider = sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(t.tracerProvider)

	t.status.Enabled = true
	t.status.Endpoint = endpoint
	return t
}

// Enabled reports whether the SDK is exporting.
func (t *Telemetry) Enabled() bool { return t != nil && t.status.Enabled }

// Status returns the current pipeline state for health reporting.
func (t *Telemetry) Status() Status {
	if t == nil {
		return Status{}
	}
	return t.status
}

// Shutdown flushes and stops the provider. It tolerates a nil receiver and a
// disabled pipeline.
func (t *Telemetry) Shutdown(ctx context.Context) error {
	if t == nil || t.tracerProvider == nil {
		return nil
	}
	return t.tracerProvider.Shutdown(ctx)
}

// grpcTarget splits an OTLP endpoint into a gRPC authority target and whether
// it is plaintext. An endpoint with no scheme is treated as TLS, matching the
// OTLP spec default; http:// selects plaintext.
func grpcTarget(endpoint string) (target string, insecure bool) {
	rest := endpoint
	if i := strings.Index(endpoint, "://"); i >= 0 {
		scheme := strings.ToLower(endpoint[:i])
		rest = endpoint[i+3:]
		return strings.TrimSuffix(rest, "/"), scheme == "http"
	}
	return strings.TrimSuffix(rest, "/"), false
}
