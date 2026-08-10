package mqtt

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
	"time"

	mqtt "github.com/eclipse/paho.mqtt.golang"
	"github.com/sirupsen/logrus"
	"github.com/vpp/mqtt-fluvio-bridge/config"
)

type Client struct {
	client mqtt.Client
	config *config.MQTTConfig
	logger *logrus.Logger
}

// NewClient creates a new MQTT client
func NewClient(cfg *config.MQTTConfig, logger *logrus.Logger) (*Client, error) {
	opts := mqtt.NewClientOptions()
	opts.AddBroker(cfg.BrokerURL)
	opts.SetClientID(cfg.ClientID)
	opts.SetUsername(cfg.Username)
	opts.SetPassword(cfg.Password)
	opts.SetCleanSession(cfg.CleanSession)
	opts.SetAutoReconnect(true)
	opts.SetConnectRetry(true)
	opts.SetConnectRetryInterval(5 * time.Second)
	opts.SetMaxReconnectInterval(60 * time.Second)

	// TLS configuration
	if cfg.UseTLS {
		tlsConfig, err := newTLSConfig(cfg)
		if err != nil {
			return nil, fmt.Errorf("failed to create TLS config: %w", err)
		}
		opts.SetTLSConfig(tlsConfig)
	}

	// Connection handlers
	opts.SetOnConnectHandler(func(c mqtt.Client) {
		logger.Info("MQTT: Connected to broker")
	})

	opts.SetConnectionLostHandler(func(c mqtt.Client, err error) {
		logger.Warnf("MQTT: Connection lost: %v", err)
	})

	opts.SetReconnectingHandler(func(c mqtt.Client, opts *mqtt.ClientOptions) {
		logger.Info("MQTT: Reconnecting to broker...")
	})

	client := mqtt.NewClient(opts)

	return &Client{
		client: client,
		config: cfg,
		logger: logger,
	}, nil
}

// Connect establishes connection to MQTT broker
func (c *Client) Connect() error {
	c.logger.Infof("MQTT: Connecting to %s", c.config.BrokerURL)

	token := c.client.Connect()
	if token.Wait() && token.Error() != nil {
		return fmt.Errorf("failed to connect: %w", token.Error())
	}

	c.logger.Info("MQTT: Successfully connected")
	return nil
}

// Subscribe subscribes to MQTT topics with a message handler
func (c *Client) Subscribe(topics []string, handler mqtt.MessageHandler) error {
	for _, topic := range topics {
		c.logger.Infof("MQTT: Subscribing to topic: %s", topic)

		token := c.client.Subscribe(topic, c.config.QoS, handler)
		if token.Wait() && token.Error() != nil {
			return fmt.Errorf("failed to subscribe to %s: %w", topic, token.Error())
		}

		c.logger.Infof("MQTT: Successfully subscribed to %s", topic)
	}

	return nil
}

// Publish publishes a message to an MQTT topic
func (c *Client) Publish(topic string, payload []byte) error {
	token := c.client.Publish(topic, c.config.QoS, false, payload)
	if token.Wait() && token.Error() != nil {
		return fmt.Errorf("failed to publish: %w", token.Error())
	}
	return nil
}

// Disconnect disconnects from MQTT broker
func (c *Client) Disconnect() {
	c.logger.Info("MQTT: Disconnecting from broker")
	c.client.Disconnect(250)
}

// IsConnected returns connection status
func (c *Client) IsConnected() bool {
	return c.client.IsConnected()
}

// newTLSConfig creates TLS configuration for secure MQTT connection
func newTLSConfig(cfg *config.MQTTConfig) (*tls.Config, error) {
	tlsConfig := &tls.Config{}

	// Load CA certificate
	if cfg.CAFile != "" {
		caCert, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, fmt.Errorf("failed to read CA file: %w", err)
		}

		caCertPool := x509.NewCertPool()
		if !caCertPool.AppendCertsFromPEM(caCert) {
			return nil, fmt.Errorf("failed to parse CA certificate")
		}

		tlsConfig.RootCAs = caCertPool
	}

	// Load client certificate and key
	if cfg.CertFile != "" && cfg.KeyFile != "" {
		cert, err := tls.LoadX509KeyPair(cfg.CertFile, cfg.KeyFile)
		if err != nil {
			return nil, fmt.Errorf("failed to load client certificate: %w", err)
		}

		tlsConfig.Certificates = []tls.Certificate{cert}
	}

	return tlsConfig, nil
}
