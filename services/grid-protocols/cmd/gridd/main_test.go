package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"

	"github.com/vpp/grid-protocols/internal/telemetry"
)

// TestMetricsEndpointEmitsStableSemconv locks the contract the monitoring
// stack is built on: GET /metrics serves the stable HTTP semconv histogram
// http_server_request_duration_seconds_* labelled with service_name,
// tenant_id, http_request_method, http_response_status_code and http_route.
func TestMetricsEndpointEmitsStableSemconv(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
	t.Setenv("OTEL_SDK_DISABLED", "")
	t.Setenv("OTEL_SERVICE_NAME", "")
	t.Setenv("OTEL_TENANT_ID", "")

	tele := telemetry.Setup("grid-protocols", func(format string, args ...any) {
		t.Fatalf("enabled setup must not warn: "+format, args...)
	})
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = tele.Shutdown(ctx)
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	server := httptest.NewServer(tracingHandler(mux))
	defer server.Close()

	resp, err := http.Get(server.URL + "/health")
	if err != nil {
		t.Fatalf("request through the traced handler failed: %v", err)
	}
	resp.Body.Close()

	families, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatalf("gathering the default registry failed: %v", err)
	}
	var found *dto.MetricFamily
	for _, family := range families {
		if family.GetName() == "http_server_request_duration_seconds" {
			found = family
		}
	}
	if found == nil {
		names := make([]string, 0, len(families))
		for _, family := range families {
			names = append(names, family.GetName())
		}
		t.Fatalf("http_server_request_duration_seconds not exported; have: %s", strings.Join(names, ", "))
	}

	labels := map[string]bool{}
	for _, metric := range found.GetMetric() {
		for _, pair := range metric.GetLabel() {
			labels[pair.GetName()] = true
			switch pair.GetName() {
			case "service_name":
				if pair.GetValue() != "grid-protocols" {
					t.Fatalf("service_name = %q", pair.GetValue())
				}
			case "tenant_id":
				if pair.GetValue() != "default" {
					t.Fatalf("tenant_id = %q", pair.GetValue())
				}
			case "http_route":
				if pair.GetValue() != "/health" {
					t.Fatalf("http_route = %q", pair.GetValue())
				}
			case "http_response_status_code":
				if pair.GetValue() != "200" {
					t.Fatalf("http_response_status_code = %q", pair.GetValue())
				}
			}
		}
	}
	for _, want := range []string{
		"service_name", "tenant_id", "http_request_method", "http_response_status_code", "http_route",
	} {
		if !labels[want] {
			t.Fatalf("label %s missing from http_server_request_duration_seconds (have %v)", want, labels)
		}
	}
}
