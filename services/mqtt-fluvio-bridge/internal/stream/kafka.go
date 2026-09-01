package stream

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/segmentio/kafka-go"
	"github.com/segmentio/kafka-go/sasl"
	"github.com/segmentio/kafka-go/sasl/plain"
	"github.com/segmentio/kafka-go/sasl/scram"
	"github.com/sirupsen/logrus"
	"github.com/vpp/mqtt-fluvio-bridge/config"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/trace"
)

// headerCarrier adapts Kafka record headers to propagation.TextMapCarrier.
type headerCarrier struct {
	headers *[]kafka.Header
}

func (c headerCarrier) Get(key string) string {
	for _, h := range *c.headers {
		if strings.EqualFold(h.Key, key) {
			return string(h.Value)
		}
	}
	return ""
}

func (c headerCarrier) Set(key, value string) {
	for i, h := range *c.headers {
		if strings.EqualFold(h.Key, key) {
			(*c.headers)[i].Value = []byte(value)
			return
		}
	}
	*c.headers = append(*c.headers, kafka.Header{Key: key, Value: []byte(value)})
}

func (c headerCarrier) Keys() []string {
	keys := make([]string, 0, len(*c.headers))
	for _, h := range *c.headers {
		keys = append(keys, h.Key)
	}
	return keys
}

// traceHeaders carries the W3C trace context of ctx into Kafka record headers,
// so consumers (the platform's event consumer, lakehouse loaders) continue the
// trace that started at the MQTT message. Without a recording span there is
// nothing to propagate and the record ships with no extra headers.
func traceHeaders(ctx context.Context) []kafka.Header {
	if !trace.SpanContextFromContext(ctx).IsValid() {
		return nil
	}
	var headers []kafka.Header
	otel.GetTextMapPropagator().Inject(ctx, headerCarrier{headers: &headers})
	return headers
}

// KafkaProducer publishes telemetry to the platform's Kafka topics.
type KafkaProducer struct {
	cfg       *config.KafkaConfig
	logger    *logrus.Logger
	writer    *kafka.Writer
	transport *kafka.Transport
}

// NewKafkaProducer builds a synchronous, acknowledged Kafka writer.
func NewKafkaProducer(cfg *config.KafkaConfig, logger *logrus.Logger) (*KafkaProducer, error) {
	if len(cfg.Brokers) == 0 {
		return nil, errors.New("kafka.brokers is empty")
	}

	mechanism, err := saslMechanism(cfg)
	if err != nil {
		return nil, err
	}

	transport := &kafka.Transport{
		DialTimeout: 10 * time.Second,
		SASL:        mechanism,
	}
	if cfg.TLS {
		transport.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
	}

	writer := &kafka.Writer{
		Addr:                   kafka.TCP(cfg.Brokers...),
		Balancer:               &kafka.Hash{}, // same key -> same partition, so per-device order holds
		RequiredAcks:           requiredAcks(cfg.RequiredAcks),
		AllowAutoTopicCreation: false,
		// Send synchronously: Write must not return before the broker
		// acknowledges, otherwise a dropped record would look delivered.
		Async:     false,
		Transport: transport,
	}

	return &KafkaProducer{cfg: cfg, logger: logger, writer: writer, transport: transport}, nil
}

func requiredAcks(value string) kafka.RequiredAcks {
	if strings.EqualFold(value, "one") {
		return kafka.RequireOne
	}
	return kafka.RequireAll
}

func saslMechanism(cfg *config.KafkaConfig) (sasl.Mechanism, error) {
	switch strings.ToLower(cfg.SASLMechanism) {
	case "":
		return nil, nil
	case "plain":
		if cfg.SASLUsername == "" || cfg.SASLPassword == "" {
			return nil, errors.New("kafka SASL/PLAIN requires kafka.sasl_username and kafka.sasl_password")
		}
		return plain.Mechanism{Username: cfg.SASLUsername, Password: cfg.SASLPassword}, nil
	case "scram-sha-256":
		return scram.Mechanism(scram.SHA256, cfg.SASLUsername, cfg.SASLPassword)
	case "scram-sha-512":
		return scram.Mechanism(scram.SHA512, cfg.SASLUsername, cfg.SASLPassword)
	default:
		return nil, fmt.Errorf("unsupported kafka.sasl_mechanism %q", cfg.SASLMechanism)
	}
}

func (p *KafkaProducer) Transport() config.Transport { return config.TransportKafka }

func (p *KafkaProducer) Send(ctx context.Context, topic string, key string, value []byte) error {
	return p.SendBatch(ctx, topic, []Record{{Key: key, Value: value}})
}

func (p *KafkaProducer) SendBatch(ctx context.Context, topic string, records []Record) error {
	if topic == "" {
		return errors.New("kafka topic is empty")
	}
	if len(records) == 0 {
		return nil
	}

	headers := traceHeaders(ctx)
	messages := make([]kafka.Message, 0, len(records))
	for _, record := range records {
		messages = append(messages, kafka.Message{
			Topic:   topic,
			Key:     []byte(record.Key),
			Value:   record.Value,
			Headers: headers,
			Time:    time.Now().UTC(),
		})
	}

	if err := p.writer.WriteMessages(ctx, messages...); err != nil {
		return fmt.Errorf("kafka write to %s: %w", topic, err)
	}
	return nil
}

// EnsureTopics fails unless every topic exists, creating them only when
// kafka.create_missing_topics is enabled.
func (p *KafkaProducer) EnsureTopics(ctx context.Context, topics []string) error {
	conn, err := p.dialController(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	partitions, err := conn.ReadPartitions()
	if err != nil {
		return fmt.Errorf("kafka read partitions: %w", err)
	}
	existing := make(map[string]bool, len(partitions))
	for _, partition := range partitions {
		existing[partition.Topic] = true
	}

	var missing []kafka.TopicConfig
	for _, topic := range topics {
		if existing[topic] {
			continue
		}
		if !p.cfg.CreateMissingTopics {
			return fmt.Errorf("kafka topic %q does not exist and kafka.create_missing_topics is false", topic)
		}
		missing = append(missing, kafka.TopicConfig{
			Topic:             topic,
			NumPartitions:     p.cfg.Partitions,
			ReplicationFactor: p.cfg.ReplicationFactor,
		})
	}

	if len(missing) == 0 {
		return nil
	}
	if err := conn.CreateTopics(missing...); err != nil {
		return fmt.Errorf("kafka create topics: %w", err)
	}
	for _, topic := range missing {
		p.logger.Infof("Kafka: created topic %s (%d partitions, replication %d)",
			topic.Topic, topic.NumPartitions, topic.ReplicationFactor)
	}
	return nil
}

func (p *KafkaProducer) dialController(ctx context.Context) (*kafka.Conn, error) {
	dialer := &kafka.Dialer{Timeout: 10 * time.Second, DualStack: true}
	if p.cfg.TLS {
		dialer.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	mechanism, err := saslMechanism(p.cfg)
	if err != nil {
		return nil, err
	}
	dialer.SASLMechanism = mechanism

	var lastErr error
	for _, broker := range p.cfg.Brokers {
		conn, err := dialer.DialContext(ctx, "tcp", broker)
		if err != nil {
			lastErr = err
			continue
		}
		controller, err := conn.Controller()
		if err != nil {
			conn.Close()
			lastErr = err
			continue
		}
		controllerConn, err := dialer.DialContext(ctx, "tcp",
			fmt.Sprintf("%s:%d", controller.Host, controller.Port))
		conn.Close()
		if err != nil {
			lastErr = err
			continue
		}
		return controllerConn, nil
	}
	return nil, fmt.Errorf("kafka: no reachable broker in %v: %w", p.cfg.Brokers, lastErr)
}

func (p *KafkaProducer) Close() error {
	return p.writer.Close()
}
