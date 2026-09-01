package config

import (
	"fmt"
	"os"
	"strings"

	"github.com/joho/godotenv"
	"gopkg.in/yaml.v3"
)

type Config struct {
	MQTT   MQTTConfig   `yaml:"mqtt"`
	Stream StreamConfig `yaml:"stream"`
	Fluvio FluvioConfig `yaml:"fluvio"`
	Kafka  KafkaConfig  `yaml:"kafka"`
	Bridge BridgeConfig `yaml:"bridge"`
}

// Transport names the stream backend telemetry is published to.
type Transport string

const (
	TransportFluvio Transport = "fluvio"
	TransportKafka  Transport = "kafka"
)

type StreamConfig struct {
	Transport Transport `yaml:"transport"`
	// DefaultTopic receives records whose MQTT topic has no explicit mapping.
	DefaultTopic string `yaml:"default_topic"`
}

type MQTTConfig struct {
	BrokerURL    string   `yaml:"broker_url"`
	ClientID     string   `yaml:"client_id"`
	Username     string   `yaml:"username"`
	Password     string   `yaml:"password"`
	Topics       []string `yaml:"topics"`
	QoS          byte     `yaml:"qos"`
	CleanSession bool     `yaml:"clean_session"`
	UseTLS       bool     `yaml:"use_tls"`
	CAFile       string   `yaml:"ca_file"`
	CertFile     string   `yaml:"cert_file"`
	KeyFile      string   `yaml:"key_file"`
}

type FluvioConfig struct {
	Endpoint string            `yaml:"endpoint"`
	Topics   map[string]string `yaml:"topics"` // MQTT topic -> Fluvio topic mapping
	// CLIPath is the `fluvio` executable used to produce records. There is no
	// official Fluvio SDK for Go, so the CLI is the supported integration.
	CLIPath string `yaml:"cli_path"`
	// Profile selects a cluster from the local Fluvio config (`fluvio profile`).
	Profile string `yaml:"profile"`
	// Partitions is used when this bridge has to create a missing topic.
	Partitions int `yaml:"partitions"`
	// CreateMissingTopics allows the bridge to create mapped topics at startup.
	CreateMissingTopics bool `yaml:"create_missing_topics"`
}

type KafkaConfig struct {
	Brokers []string          `yaml:"brokers"`
	Topics  map[string]string `yaml:"topics"` // MQTT topic -> Kafka topic mapping
	TLS     bool              `yaml:"tls"`
	// SASLMechanism is empty (no SASL), "plain" or "scram-sha-256"/"scram-sha-512".
	SASLMechanism string `yaml:"sasl_mechanism"`
	SASLUsername  string `yaml:"sasl_username"`
	SASLPassword  string `yaml:"sasl_password"`
	// RequiredAcks: "all" (default), "one" or "none". "none" is rejected because
	// telemetry feeds billing and must not be fire-and-forget.
	RequiredAcks string `yaml:"required_acks"`
	// CreateMissingTopics allows the bridge to create mapped topics at startup.
	CreateMissingTopics bool `yaml:"create_missing_topics"`
	Partitions          int  `yaml:"partitions"`
	ReplicationFactor   int  `yaml:"replication_factor"`
}

type BridgeConfig struct {
	WorkerCount      int    `yaml:"worker_count"`
	BufferSize       int    `yaml:"buffer_size"`
	EnableValidation bool   `yaml:"enable_validation"`
	LogLevel         string `yaml:"log_level"`
	// MetricsAddr is the listen address of the Prometheus metrics and health
	// server (GET /metrics, GET /healthz). Empty means :8080, which is the
	// target the monitoring stack scrapes.
	MetricsAddr string `yaml:"metrics_addr"`
}

// LoadConfig loads configuration from file and environment variables
func LoadConfig(configPath string) (*Config, error) {
	// Load .env file if it exists
	_ = godotenv.Load()

	// Read config file
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, err
	}

	var config Config
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, err
	}

	// Override with environment variables
	if brokerURL := os.Getenv("MQTT_BROKER_URL"); brokerURL != "" {
		config.MQTT.BrokerURL = brokerURL
	}
	if username := os.Getenv("MQTT_USERNAME"); username != "" {
		config.MQTT.Username = username
	}
	if password := os.Getenv("MQTT_PASSWORD"); password != "" {
		config.MQTT.Password = password
	}
	if endpoint := os.Getenv("FLUVIO_ENDPOINT"); endpoint != "" {
		config.Fluvio.Endpoint = endpoint
	}
	if cli := os.Getenv("FLUVIO_CLI_PATH"); cli != "" {
		config.Fluvio.CLIPath = cli
	}
	if profile := os.Getenv("FLUVIO_PROFILE"); profile != "" {
		config.Fluvio.Profile = profile
	}
	if transport := os.Getenv("STREAM_TRANSPORT"); transport != "" {
		config.Stream.Transport = Transport(transport)
	}
	if brokers := os.Getenv("KAFKA_BROKERS"); brokers != "" {
		config.Kafka.Brokers = splitAndTrim(brokers)
	}
	if os.Getenv("KAFKA_SSL") == "true" {
		config.Kafka.TLS = true
	}
	if os.Getenv("KAFKA_SASL_ENABLED") == "true" && config.Kafka.SASLMechanism == "" {
		config.Kafka.SASLMechanism = "plain"
	}
	if username := os.Getenv("KAFKA_SASL_USERNAME"); username != "" {
		config.Kafka.SASLUsername = username
	}
	if password := os.Getenv("KAFKA_SASL_PASSWORD"); password != "" {
		config.Kafka.SASLPassword = password
	}
	if addr := os.Getenv("METRICS_ADDR"); addr != "" {
		config.Bridge.MetricsAddr = addr
	}
	if config.Bridge.MetricsAddr == "" {
		config.Bridge.MetricsAddr = ":8080"
	}

	if err := config.Validate(); err != nil {
		return nil, err
	}

	return &config, nil
}

func splitAndTrim(value string) []string {
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// Validate rejects configurations that would start a bridge unable to publish.
// Telemetry drives billing and settlement, so a misconfigured transport has to
// stop the process instead of silently discarding records.
func (c *Config) Validate() error {
	switch c.Stream.Transport {
	case TransportFluvio:
		if c.Fluvio.CLIPath == "" {
			c.Fluvio.CLIPath = "fluvio"
		}
		if c.Fluvio.Partitions <= 0 {
			c.Fluvio.Partitions = 1
		}
	case TransportKafka:
		if len(c.Kafka.Brokers) == 0 {
			return fmt.Errorf("kafka.brokers must be set when stream.transport is %q", TransportKafka)
		}
		switch strings.ToLower(c.Kafka.RequiredAcks) {
		case "", "all", "one":
		case "none":
			return fmt.Errorf("kafka.required_acks=none would acknowledge telemetry that was never stored")
		default:
			return fmt.Errorf("kafka.required_acks must be one of all, one (got %q)", c.Kafka.RequiredAcks)
		}
		switch strings.ToLower(c.Kafka.SASLMechanism) {
		case "", "plain", "scram-sha-256", "scram-sha-512":
		default:
			return fmt.Errorf("kafka.sasl_mechanism %q is not supported", c.Kafka.SASLMechanism)
		}
		if c.Kafka.Partitions <= 0 {
			c.Kafka.Partitions = 1
		}
		if c.Kafka.ReplicationFactor <= 0 {
			c.Kafka.ReplicationFactor = 1
		}
	case "":
		return fmt.Errorf("stream.transport must be set to %q or %q", TransportFluvio, TransportKafka)
	default:
		return fmt.Errorf("unknown stream.transport %q: expected %q or %q", c.Stream.Transport, TransportFluvio, TransportKafka)
	}

	if c.Stream.DefaultTopic == "" {
		return fmt.Errorf("stream.default_topic must be set: unmapped MQTT topics would otherwise be dropped")
	}
	return nil
}

// StreamTopics returns the MQTT topic -> stream topic mapping for the selected
// transport.
func (c *Config) StreamTopics() map[string]string {
	if c.Stream.Transport == TransportKafka {
		return c.Kafka.Topics
	}
	return c.Fluvio.Topics
}
