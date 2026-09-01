package stream

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/segmentio/kafka-go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

func testSpanContext(t *testing.T) (context.Context, trace.SpanContext) {
	t.Helper()
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{}))

	traceID, err := trace.TraceIDFromHex("4bf92f3577b34da6a3ce929d0e0e4736")
	if err != nil {
		t.Fatal(err)
	}
	spanID, err := trace.SpanIDFromHex("00f067aa0ba902b7")
	if err != nil {
		t.Fatal(err)
	}
	sc := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    traceID,
		SpanID:     spanID,
		TraceFlags: trace.FlagsSampled,
	})
	return trace.ContextWithSpanContext(context.Background(), sc), sc
}

// TestKafkaTraceHeaderRoundTrip proves the record-header propagation path:
// the producer injects traceparent into kafka.Message headers, and a consumer
// extracting from those headers recovers the same span context.
func TestKafkaTraceHeaderRoundTrip(t *testing.T) {
	ctx, sc := testSpanContext(t)

	headers := traceHeaders(ctx)
	if len(headers) == 0 {
		t.Fatal("a valid span context must produce trace headers")
	}
	msg := kafka.Message{Headers: headers}

	carrier := headerCarrier{headers: &msg.Headers}
	if got := carrier.Get("traceparent"); got != "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" {
		t.Fatalf("injected traceparent %q", got)
	}

	extracted := otel.GetTextMapPropagator().Extract(context.Background(), carrier)
	extractedSC := trace.SpanContextFromContext(extracted)
	if extractedSC.TraceID() != sc.TraceID() || extractedSC.SpanID() != sc.SpanID() {
		t.Fatalf("extracted span context %+v, want %+v", extractedSC, sc)
	}
}

func TestKafkaTraceHeadersAbsentWithoutSpan(t *testing.T) {
	otel.SetTextMapPropagator(propagation.TraceContext{})
	if headers := traceHeaders(context.Background()); headers != nil {
		t.Fatalf("no span context must mean no headers, got %v", headers)
	}
}

// TestFluvioEnvelopeCarriesTraceparent proves the payload-envelope propagation
// path: `fluvio produce` cannot carry record headers, so the trace context is
// stamped into the JSON envelope for downstream SmartModules to continue.
func TestFluvioEnvelopeCarriesTraceparent(t *testing.T) {
	ctx, sc := testSpanContext(t)

	out := withTraceContext(ctx, []byte(`{"device_id":"meter-1","power":42}`))

	var envelope struct {
		Traceparent string          `json:"traceparent"`
		Payload     json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(out, &envelope); err != nil {
		t.Fatalf("envelope is not JSON: %v", err)
	}
	if envelope.Traceparent != "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" {
		t.Fatalf("envelope traceparent %q", envelope.Traceparent)
	}

	// A consumer stamps the envelope fields into a carrier and recovers the
	// exact span context the bridge published with.
	carrier := propagation.MapCarrier{"traceparent": envelope.Traceparent}
	extracted := otel.GetTextMapPropagator().Extract(context.Background(), carrier)
	if got := trace.SpanContextFromContext(extracted); got.TraceID() != sc.TraceID() || got.SpanID() != sc.SpanID() {
		t.Fatalf("extracted span context %+v, want %+v", got, sc)
	}

	// The original telemetry payload survives the envelope intact.
	var payload map[string]any
	if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
		t.Fatalf("envelope payload is not JSON: %v", err)
	}
	if payload["device_id"] != "meter-1" {
		t.Fatalf("payload device_id %v", payload["device_id"])
	}
}

func TestFluvioEnvelopePassthroughWithoutSpan(t *testing.T) {
	otel.SetTextMapPropagator(propagation.TraceContext{})
	value := []byte(`{"device_id":"meter-1"}`)
	if out := withTraceContext(context.Background(), value); string(out) != string(value) {
		t.Fatalf("no span context must pass the payload through unchanged, got %s", out)
	}
}
