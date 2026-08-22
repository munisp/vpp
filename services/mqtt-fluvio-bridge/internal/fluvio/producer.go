package fluvio

import (
	"context"
	"errors"
	"fmt"

	"github.com/sirupsen/logrus"
	"github.com/vpp/mqtt-fluvio-bridge/config"
)

// ErrNoClient reports that this build has no Fluvio client wired in.
//
// The previous implementation imported github.com/infinyon/fluvio-client-go,
// which does not exist: there is no official Fluvio SDK for Go, so this service
// never compiled and never shipped a single telemetry record. Rather than
// pretend to publish, every operation fails with this error until a real
// transport is wired into Producer.
var ErrNoClient = errors.New(
	"no Fluvio client is wired into the MQTT bridge: telemetry is NOT being published; " +
		"integrate a supported transport (e.g. the Fluvio CLI/connector or the platform Kafka topics) before deploying",
)

// Producer publishes telemetry records to a stream processing cluster.
type Producer struct {
	config *config.FluvioConfig
	logger *logrus.Logger
}

// NewProducer constructs a Producer. It fails loudly because no transport is
// implemented: a bridge that starts up and silently drops telemetry would let
// billing and settlement run on missing meter data.
func NewProducer(cfg *config.FluvioConfig, logger *logrus.Logger) (*Producer, error) {
	logger.Errorf("Fluvio: refusing to start bridge for endpoint %q: %v", cfg.Endpoint, ErrNoClient)
	return nil, ErrNoClient
}

// Send publishes a single record.
func (p *Producer) Send(ctx context.Context, topic string, key string, value []byte) error {
	return fmt.Errorf("send to topic %s: %w", topic, ErrNoClient)
}

// SendBatch publishes multiple records.
func (p *Producer) SendBatch(ctx context.Context, topic string, records []struct {
	Key   string
	Value []byte
}) error {
	return fmt.Errorf("batch send to topic %s: %w", topic, ErrNoClient)
}

// Flush flushes pending records.
func (p *Producer) Flush(ctx context.Context) error {
	return ErrNoClient
}

// Close releases producer resources.
func (p *Producer) Close() error {
	return nil
}

// EnsureTopics verifies that every configured target topic exists.
func (p *Producer) EnsureTopics(ctx context.Context) error {
	return ErrNoClient
}
