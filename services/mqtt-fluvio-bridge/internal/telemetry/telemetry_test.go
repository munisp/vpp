package telemetry

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestSetupDisabledWhenEndpointUnset(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	t.Setenv("OTEL_SDK_DISABLED", "")

	var warnings []string
	tele := Setup("mqtt-fluvio-bridge", func(format string, args ...any) {
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

	tele := Setup("mqtt-fluvio-bridge", func(string, ...any) {})
	if tele.Enabled() {
		t.Fatal("OTEL_SDK_DISABLED=true must win over a configured endpoint")
	}
}

func TestSetupEnabledWithEndpoint(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
	t.Setenv("OTEL_SDK_DISABLED", "")
	t.Setenv("OTEL_SERVICE_NAME", "")
	t.Setenv("OTEL_TENANT_ID", "")

	tele := Setup("mqtt-fluvio-bridge", func(format string, args ...any) {
		t.Fatalf("enabled setup must not warn: "+format, args...)
	})
	if !tele.Enabled() {
		t.Fatal("telemetry must be enabled with a configured endpoint")
	}
	if tele.Status().ServiceName != "mqtt-fluvio-bridge" {
		t.Fatalf("service name must fall back to the default, got %q", tele.Status().ServiceName)
	}
	for key, want := range map[string]string{
		"service.name": "mqtt-fluvio-bridge",
		"tenant.id":    "default",
	} {
		got := ""
		for _, kv := range tele.resource.Attributes() {
			if string(kv.Key) == key {
				got = kv.Value.AsString()
			}
		}
		if got != want {
			t.Fatalf("resource attribute %s = %q, want %q", key, got, want)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := tele.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown with the collector unreachable must not fail: %v", err)
	}
}

func TestGRPCTarget(t *testing.T) {
	for _, tc := range []struct {
		endpoint string
		target   string
		insecure bool
	}{
		{"http://localhost:4317", "localhost:4317", true},
		{"https://otel.example.com:4317", "otel.example.com:4317", false},
		{"otel.example.com:4317", "otel.example.com:4317", false},
	} {
		target, insecure := grpcTarget(tc.endpoint)
		if target != tc.target || insecure != tc.insecure {
			t.Fatalf("grpcTarget(%q) = (%q, %v), want (%q, %v)", tc.endpoint, target, insecure, tc.target, tc.insecure)
		}
	}
}
