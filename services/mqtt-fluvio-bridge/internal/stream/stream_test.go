package stream

import (
	"testing"

	"github.com/vpp/mqtt-fluvio-bridge/config"
)

func TestTopicsForIncludesDefaultAndMappedTopics(t *testing.T) {
	cfg := &config.Config{
		Stream: config.StreamConfig{Transport: config.TransportKafka, DefaultTopic: "telemetry.raw"},
		Kafka: config.KafkaConfig{Topics: map[string]string{
			"vpp/telemetry/+":       "telemetry.raw",
			"vpp/devices/+/status":  "edge.connectivity",
			"vpp/devices/+/ignored": "",
		}},
	}

	topics := TopicsFor(cfg)
	if len(topics) != 2 {
		t.Fatalf("expected 2 distinct topics, got %v", topics)
	}
	if topics[0] != "telemetry.raw" {
		t.Fatalf("expected default topic first, got %v", topics)
	}
}

func TestNewProducerRejectsUnknownTransport(t *testing.T) {
	if _, err := NewProducer(&config.Config{Stream: config.StreamConfig{Transport: "kinesis"}}, nil); err == nil {
		t.Fatal("expected unknown transport to be rejected")
	}
}

func TestValidateRecordRejectsDelimiters(t *testing.T) {
	if err := validateRecord(Record{Key: "device" + keySeparator + "1", Value: []byte("{}")}); err == nil {
		t.Fatal("expected a key containing the separator to be rejected")
	}
	if err := validateRecord(Record{Key: "device-1", Value: []byte("{\"a\":1}\n{\"b\":2}")}); err == nil {
		t.Fatal("expected a multi-line value to be rejected")
	}
	if err := validateRecord(Record{Key: "device-1", Value: []byte(`{"a":1}`)}); err != nil {
		t.Fatalf("expected a compact JSON record to be accepted: %v", err)
	}
}

func TestParseTopicListSkipsHeader(t *testing.T) {
	out := " NAME        TYPE      PARTITIONS\n telemetry   computed  1\n device-status computed 1\n"
	topics := parseTopicList(out)
	if !topics["telemetry"] || !topics["device-status"] {
		t.Fatalf("expected both topics to be parsed, got %v", topics)
	}
	if topics["NAME"] {
		t.Fatal("expected the header row to be skipped")
	}
}
