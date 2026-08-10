package config

import (
	"os"

	"github.com/joho/godotenv"
	"gopkg.in/yaml.v3"
)

type Config struct {
	MQTT   MQTTConfig   `yaml:"mqtt"`
	Fluvio FluvioConfig `yaml:"fluvio"`
	Bridge BridgeConfig `yaml:"bridge"`
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
}

type BridgeConfig struct {
	WorkerCount      int  `yaml:"worker_count"`
	BufferSize       int  `yaml:"buffer_size"`
	EnableValidation bool `yaml:"enable_validation"`
	LogLevel         string `yaml:"log_level"`
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

	return &config, nil
}
