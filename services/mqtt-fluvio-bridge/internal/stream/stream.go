// Package stream publishes telemetry records to the platform's stream
// processing backend.
//
// The bridge originally imported github.com/infinyon/fluvio-client-go, a module
// that does not exist (there is no official Fluvio SDK for Go), so the service
// never compiled and never published a record. Two real transports are provided
// instead:
//
//   - Kafka, over the pure-Go segmentio/kafka-go client, matching the topics the
//     platform already produces to from Node (server/integration/kafka-*.ts).
//   - Fluvio, over the supported `fluvio` CLI (`fluvio produce`), which is the
//     only Fluvio integration available to Go programs.
//
// Neither transport degrades to a no-op: a publish that cannot be confirmed
// returns an error so the caller can retry or stop, because this telemetry is
// what billing and settlement are computed from.
package stream

import (
	"context"
	"fmt"

	"github.com/sirupsen/logrus"
	"github.com/vpp/mqtt-fluvio-bridge/config"
)

// Record is a single keyed telemetry record.
type Record struct {
	Key   string
	Value []byte
}

// Producer publishes records to a stream topic.
type Producer interface {
	// Send publishes one record and returns an error unless the broker
	// acknowledged it.
	Send(ctx context.Context, topic string, key string, value []byte) error
	// SendBatch publishes several records to the same topic.
	SendBatch(ctx context.Context, topic string, records []Record) error
	// EnsureTopics verifies that every topic the bridge will publish to exists.
	EnsureTopics(ctx context.Context, topics []string) error
	// Close releases resources, flushing anything buffered.
	Close() error
	// Transport names the backend, for logs and metrics.
	Transport() config.Transport
}

// NewProducer builds the producer selected by cfg.Stream.Transport.
func NewProducer(cfg *config.Config, logger *logrus.Logger) (Producer, error) {
	switch cfg.Stream.Transport {
	case config.TransportKafka:
		return NewKafkaProducer(&cfg.Kafka, logger)
	case config.TransportFluvio:
		return NewFluvioProducer(&cfg.Fluvio, logger)
	default:
		return nil, fmt.Errorf("unsupported stream transport %q", cfg.Stream.Transport)
	}
}

// TopicsFor returns the distinct stream topics the bridge may publish to.
func TopicsFor(cfg *config.Config) []string {
	seen := map[string]bool{cfg.Stream.DefaultTopic: true}
	topics := []string{cfg.Stream.DefaultTopic}
	for _, topic := range cfg.StreamTopics() {
		if topic == "" || seen[topic] {
			continue
		}
		seen[topic] = true
		topics = append(topics, topic)
	}
	return topics
}
