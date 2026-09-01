package services

import (
	"context"
	"testing"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// TestKafkaHeaderCarrierRoundTrip proves the manual propagation path used by
// PublishEvent: the trace context injected into confluent record headers is
// recovered byte-equal by a consumer extracting from the same headers.
func TestKafkaHeaderCarrierRoundTrip(t *testing.T) {
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
	ctx := trace.ContextWithSpanContext(context.Background(), sc)

	msg := &kafka.Message{}
	otel.GetTextMapPropagator().Inject(ctx, headerCarrier{headers: &msg.Headers})

	carrier := headerCarrier{headers: &msg.Headers}
	if got := carrier.Get("traceparent"); got != "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" {
		t.Fatalf("injected traceparent %q", got)
	}

	extracted := otel.GetTextMapPropagator().Extract(context.Background(), carrier)
	extractedSC := trace.SpanContextFromContext(extracted)
	if extractedSC.TraceID() != sc.TraceID() || extractedSC.SpanID() != sc.SpanID() || extractedSC.TraceFlags() != sc.TraceFlags() {
		t.Fatalf("extracted span context %+v, want %+v", extractedSC, sc)
	}
	if !extractedSC.IsRemote() {
		t.Fatal("an extracted span context must be marked remote")
	}

	// Re-injecting a different context must replace, not duplicate, headers.
	otherSpanID, _ := trace.SpanIDFromHex("00f067aa0ba902b8")
	other := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: traceID, SpanID: otherSpanID, TraceFlags: trace.FlagsSampled,
	})
	otel.GetTextMapPropagator().Inject(
		trace.ContextWithSpanContext(context.Background(), other), carrier)
	if count := 0; true {
		for _, h := range msg.Headers {
			if h.Key == "traceparent" {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("traceparent header duplicated: %d present", count)
		}
	}
}
