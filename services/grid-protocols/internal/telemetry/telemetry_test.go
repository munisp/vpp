package telemetry

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	"go.opentelemetry.io/otel/trace"
)

func TestSetupDisabledWhenEndpointUnset(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	t.Setenv("OTEL_SDK_DISABLED", "")

	var warnings []string
	tele := Setup("grid-protocols", func(format string, args ...any) {
		warnings = append(warnings, format)
	})

	if tele.Enabled() {
		t.Fatal("telemetry must be disabled when OTEL_EXPORTER_OTLP_ENDPOINT is unset")
	}
	if tele.Status().Reason != "OTEL_EXPORTER_OTLP_ENDPOINT not set" {
		t.Fatalf("unexpected reason %q", tele.Status().Reason)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "telemetry disabled: OTEL_EXPORTER_OTLP_ENDPOINT not set") {
		t.Fatalf("expected the loud disabled log line, got %v", warnings)
	}
	if err := tele.Shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown of a disabled pipeline must be a no-op: %v", err)
	}
}

func TestSetupSDKDisabledEscapeHatch(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
	t.Setenv("OTEL_SDK_DISABLED", "true")

	tele := Setup("grid-protocols", func(string, ...any) {})
	if tele.Enabled() {
		t.Fatal("OTEL_SDK_DISABLED=true must win over a configured endpoint")
	}
	if tele.Status().Reason != "OTEL_SDK_DISABLED=true" {
		t.Fatalf("unexpected reason %q", tele.Status().Reason)
	}
}

func TestSetupEnabledWithEndpoint(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
	t.Setenv("OTEL_SDK_DISABLED", "")
	t.Setenv("OTEL_SERVICE_NAME", "")
	t.Setenv("OTEL_TENANT_ID", "")

	tele := Setup("grid-protocols", func(format string, args ...any) {
		t.Fatalf("enabled setup must not warn: "+format, args...)
	})
	if !tele.Enabled() {
		t.Fatal("telemetry must be enabled with a configured endpoint")
	}
	status := tele.Status()
	if status.Endpoint != "http://localhost:4317" {
		t.Fatalf("unexpected endpoint %q", status.Endpoint)
	}
	if status.ServiceName != "grid-protocols" {
		t.Fatalf("service name must fall back to the service default, got %q", status.ServiceName)
	}
	res := tele.resource
	if got := resourceAttr(res, "tenant.id"); got != "default" {
		t.Fatalf("tenant.id must default to \"default\", got %q", got)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := tele.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown with the collector unreachable must not fail: %v", err)
	}
}

func TestSetupHonoursIdentityEnv(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
	t.Setenv("OTEL_SDK_DISABLED", "")
	t.Setenv("OTEL_SERVICE_NAME", "gridd-staging")
	t.Setenv("OTEL_SERVICE_VERSION", "1.2.3")
	t.Setenv("OTEL_ENVIRONMENT", "staging")
	t.Setenv("OTEL_TENANT_ID", "tenant-42")

	tele := Setup("grid-protocols", func(string, ...any) {})
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = tele.Shutdown(ctx)
	}()

	if tele.Status().ServiceName != "gridd-staging" {
		t.Fatalf("OTEL_SERVICE_NAME not honoured: %q", tele.Status().ServiceName)
	}
	res := tele.resource
	for key, want := range map[string]string{
		"service.name":           "gridd-staging",
		"service.version":        "1.2.3",
		"deployment.environment": "staging",
		"tenant.id":              "tenant-42",
	} {
		if got := resourceAttr(res, key); got != want {
			t.Fatalf("resource attribute %s = %q, want %q", key, got, want)
		}
	}
}

func TestGRPCTarget(t *testing.T) {
	for _, tc := range []struct {
		endpoint string
		target   string
		insecure bool
	}{
		{"http://localhost:4317", "localhost:4317", true},
		{"http://otel-collector.monitoring:4317/", "otel-collector.monitoring:4317", true},
		{"https://otel.example.com:4317", "otel.example.com:4317", false},
		{"otel.example.com:4317", "otel.example.com:4317", false},
	} {
		target, insecure := grpcTarget(tc.endpoint)
		if target != tc.target || insecure != tc.insecure {
			t.Fatalf("grpcTarget(%q) = (%q, %v), want (%q, %v)", tc.endpoint, target, insecure, tc.target, tc.insecure)
		}
	}
}

// TestTraceContextRoundTrip proves the W3C propagation contract the platform
// shares: what one service injects as traceparent another extracts byte-equal.
func TestTraceContextRoundTrip(t *testing.T) {
	Setup("grid-protocols", func(string, ...any) {})

	traceID, _ := trace.TraceIDFromHex("4bf92f3577b34da6a3ce929d0e0e4736")
	spanID, _ := trace.SpanIDFromHex("00f067aa0ba902b7")
	sc := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    traceID,
		SpanID:     spanID,
		TraceFlags: trace.FlagsSampled,
	})
	ctx := trace.ContextWithSpanContext(context.Background(), sc)

	header := http.Header{}
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(header))

	got := header.Get("traceparent")
	if got != "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" {
		t.Fatalf("injected traceparent %q", got)
	}

	extracted := otel.GetTextMapPropagator().Extract(
		context.Background(), propagation.HeaderCarrier(header))
	extractedSC := trace.SpanContextFromContext(extracted)
	if extractedSC.TraceID() != sc.TraceID() || extractedSC.SpanID() != sc.SpanID() || extractedSC.TraceFlags() != sc.TraceFlags() {
		t.Fatalf("extracted span context %+v, want %+v", extractedSC, sc)
	}
	if !extractedSC.IsRemote() {
		t.Fatal("an extracted span context must be marked remote")
	}
}

func resourceAttr(res *resource.Resource, key string) string {
	for _, kv := range res.Attributes() {
		if string(kv.Key) == key {
			return kv.Value.AsString()
		}
	}
	return ""
}
