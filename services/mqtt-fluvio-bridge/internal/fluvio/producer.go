package fluvio

import (
	"context"
	"fmt"
	"time"

	fluvio "github.com/infinyon/fluvio-client-go"
	"github.com/sirupsen/logrus"
	"github.com/vpp/mqtt-fluvio-bridge/config"
)

type Producer struct {
	client   *fluvio.Fluvio
	config   *config.FluvioConfig
	logger   *logrus.Logger
	producers map[string]*fluvio.TopicProducer
}

// NewProducer creates a new Fluvio producer
func NewProducer(cfg *config.FluvioConfig, logger *logrus.Logger) (*Producer, error) {
	logger.Infof("Fluvio: Connecting to %s", cfg.Endpoint)

	// Connect to Fluvio cluster
	client, err := fluvio.Connect()
	if err != nil {
		return nil, fmt.Errorf("failed to connect to Fluvio: %w", err)
	}

	logger.Info("Fluvio: Successfully connected")

	return &Producer{
		client:    client,
		config:    cfg,
		logger:    logger,
		producers: make(map[string]*fluvio.TopicProducer),
	}, nil
}

// Send sends a message to a Fluvio topic
func (p *Producer) Send(ctx context.Context, topic string, key string, value []byte) error {
	producer, err := p.getOrCreateProducer(topic)
	if err != nil {
		return fmt.Errorf("failed to get producer for topic %s: %w", topic, err)
	}

	// Send record with key for partitioning
	record := &fluvio.Record{
		Key:   []byte(key),
		Value: value,
	}

	if err := producer.SendRecord(ctx, record); err != nil {
		return fmt.Errorf("failed to send record: %w", err)
	}

	p.logger.Debugf("Fluvio: Sent message to topic %s (key: %s)", topic, key)
	return nil
}

// SendBatch sends multiple messages to a Fluvio topic
func (p *Producer) SendBatch(ctx context.Context, topic string, records []struct {
	Key   string
	Value []byte
}) error {
	producer, err := p.getOrCreateProducer(topic)
	if err != nil {
		return fmt.Errorf("failed to get producer for topic %s: %w", topic, err)
	}

	fluvioRecords := make([]*fluvio.Record, len(records))
	for i, r := range records {
		fluvioRecords[i] = &fluvio.Record{
			Key:   []byte(r.Key),
			Value: r.Value,
		}
	}

	if err := producer.SendRecords(ctx, fluvioRecords); err != nil {
		return fmt.Errorf("failed to send batch: %w", err)
	}

	p.logger.Debugf("Fluvio: Sent %d messages to topic %s", len(records), topic)
	return nil
}

// Flush flushes all pending messages
func (p *Producer) Flush(ctx context.Context) error {
	for topic, producer := range p.producers {
		if err := producer.Flush(ctx); err != nil {
			return fmt.Errorf("failed to flush producer for topic %s: %w", topic, err)
		}
	}
	return nil
}

// Close closes all producers and the Fluvio client
func (p *Producer) Close() error {
	p.logger.Info("Fluvio: Closing producers")

	// Flush all producers before closing
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := p.Flush(ctx); err != nil {
		p.logger.Warnf("Fluvio: Error flushing producers: %v", err)
	}

	// Close all producers
	for topic, producer := range p.producers {
		if err := producer.Close(); err != nil {
			p.logger.Warnf("Fluvio: Error closing producer for topic %s: %v", topic, err)
		}
	}

	p.logger.Info("Fluvio: Closed all producers")
	return nil
}

// getOrCreateProducer gets or creates a producer for a topic
func (p *Producer) getOrCreateProducer(topic string) (*fluvio.TopicProducer, error) {
	if producer, exists := p.producers[topic]; exists {
		return producer, nil
	}

	p.logger.Infof("Fluvio: Creating producer for topic: %s", topic)

	producer, err := p.client.TopicProducer(topic)
	if err != nil {
		return nil, fmt.Errorf("failed to create producer: %w", err)
	}

	p.producers[topic] = producer
	return producer, nil
}

// EnsureTopics ensures all configured topics exist
func (p *Producer) EnsureTopics(ctx context.Context) error {
	admin, err := p.client.Admin()
	if err != nil {
		return fmt.Errorf("failed to get admin client: %w", err)
	}

	for _, topic := range p.config.Topics {
		p.logger.Infof("Fluvio: Ensuring topic exists: %s", topic)

		// Check if topic exists
		topics, err := admin.ListTopics(ctx)
		if err != nil {
			return fmt.Errorf("failed to list topics: %w", err)
		}

		exists := false
		for _, t := range topics {
			if t.Name == topic {
				exists = true
				break
			}
		}

		if !exists {
			// Create topic with default partitions
			spec := &fluvio.TopicSpec{
				Name:       topic,
				Partitions: 3,
				Replication: 1,
			}

			if err := admin.CreateTopic(ctx, spec); err != nil {
				return fmt.Errorf("failed to create topic %s: %w", topic, err)
			}

			p.logger.Infof("Fluvio: Created topic: %s", topic)
		} else {
			p.logger.Infof("Fluvio: Topic already exists: %s", topic)
		}
	}

	return nil
}
