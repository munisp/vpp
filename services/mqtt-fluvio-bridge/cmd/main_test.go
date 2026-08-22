package main

import (
	"testing"

	"github.com/vpp/mqtt-fluvio-bridge/config"
)

func TestResolveTopic(t *testing.T) {
	cfg := &config.Config{
		Stream: config.StreamConfig{Transport: config.TransportKafka, DefaultTopic: "telemetry.raw"},
		Kafka: config.KafkaConfig{Topics: map[string]string{
			"vpp/telemetry/+":      "telemetry.raw",
			"vpp/devices/+/status": "edge.connectivity",
			"vpp/audit/exact":      "system.events",
		}},
	}

	cases := []struct{ source, want string }{
		{"vpp/telemetry/meter-1", "telemetry.raw"},
		{"vpp/devices/meter-1/status", "edge.connectivity"},
		{"vpp/audit/exact", "system.events"},
		{"vpp/unmapped/thing", "telemetry.raw"},
	}
	for _, tc := range cases {
		if got := resolveTopic(cfg, tc.source); got != tc.want {
			t.Errorf("resolveTopic(%q) = %q, want %q", tc.source, got, tc.want)
		}
	}
}
