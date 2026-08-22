package config

import "testing"

func TestValidateRejectsMissingTransport(t *testing.T) {
	cfg := &Config{Stream: StreamConfig{DefaultTopic: "telemetry.raw"}}
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected an unset transport to be rejected")
	}
}

func TestValidateRejectsMissingDefaultTopic(t *testing.T) {
	cfg := &Config{
		Stream: StreamConfig{Transport: TransportKafka},
		Kafka:  KafkaConfig{Brokers: []string{"localhost:9092"}},
	}
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected a missing default topic to be rejected")
	}
}

func TestValidateRejectsKafkaWithoutBrokers(t *testing.T) {
	cfg := &Config{Stream: StreamConfig{Transport: TransportKafka, DefaultTopic: "telemetry.raw"}}
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected kafka without brokers to be rejected")
	}
}

func TestValidateRejectsFireAndForgetAcks(t *testing.T) {
	cfg := &Config{
		Stream: StreamConfig{Transport: TransportKafka, DefaultTopic: "telemetry.raw"},
		Kafka:  KafkaConfig{Brokers: []string{"localhost:9092"}, RequiredAcks: "none"},
	}
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected required_acks=none to be rejected: telemetry drives billing")
	}
}

func TestValidateAppliesFluvioDefaults(t *testing.T) {
	cfg := &Config{Stream: StreamConfig{Transport: TransportFluvio, DefaultTopic: "telemetry"}}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected a valid fluvio config: %v", err)
	}
	if cfg.Fluvio.CLIPath != "fluvio" || cfg.Fluvio.Partitions != 1 {
		t.Fatalf("expected fluvio defaults, got %+v", cfg.Fluvio)
	}
}

func TestStreamTopicsFollowsTransport(t *testing.T) {
	cfg := &Config{
		Stream: StreamConfig{Transport: TransportFluvio, DefaultTopic: "telemetry"},
		Fluvio: FluvioConfig{Topics: map[string]string{"vpp/telemetry/+": "telemetry"}},
		Kafka:  KafkaConfig{Topics: map[string]string{"vpp/telemetry/+": "telemetry.raw"}},
	}
	if got := cfg.StreamTopics()["vpp/telemetry/+"]; got != "telemetry" {
		t.Fatalf("expected fluvio mapping, got %q", got)
	}
	cfg.Stream.Transport = TransportKafka
	if got := cfg.StreamTopics()["vpp/telemetry/+"]; got != "telemetry.raw" {
		t.Fatalf("expected kafka mapping, got %q", got)
	}
}
