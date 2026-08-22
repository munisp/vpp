package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	mqtt_client "github.com/eclipse/paho.mqtt.golang"
	"github.com/sirupsen/logrus"
	"github.com/vpp/mqtt-fluvio-bridge/config"
	"github.com/vpp/mqtt-fluvio-bridge/internal/models"
	"github.com/vpp/mqtt-fluvio-bridge/internal/mqtt"
	"github.com/vpp/mqtt-fluvio-bridge/internal/stream"
)

// message pairs telemetry with the MQTT topic it arrived on, which selects the
// destination stream topic.
type message struct {
	sourceTopic string
	telemetry   *models.TelemetryData
}

type Bridge struct {
	mqtt      *mqtt.Client
	stream    stream.Producer
	config    *config.Config
	logger    *logrus.Logger
	messageCh chan message
	wg        sync.WaitGroup
	ctx       context.Context
	cancel    context.CancelFunc
}

func main() {
	configPath := flag.String("config", "config/config.yaml", "Path to configuration file")
	flag.Parse()

	// Initialize logger
	logger := logrus.New()
	logger.SetFormatter(&logrus.JSONFormatter{})
	logger.SetLevel(logrus.InfoLevel)

	// Load configuration
	cfg, err := config.LoadConfig(*configPath)
	if err != nil {
		logger.Fatalf("Failed to load configuration: %v", err)
	}

	// Set log level
	level, err := logrus.ParseLevel(cfg.Bridge.LogLevel)
	if err == nil {
		logger.SetLevel(level)
	}

	logger.Info("Starting MQTT-Fluvio Bridge")

	// Create bridge
	bridge, err := NewBridge(cfg, logger)
	if err != nil {
		logger.Fatalf("Failed to create bridge: %v", err)
	}

	// Start bridge
	if err := bridge.Start(); err != nil {
		logger.Fatalf("Failed to start bridge: %v", err)
	}

	// Wait for termination signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	logger.Info("Shutting down bridge...")
	bridge.Stop()
	logger.Info("Bridge stopped")
}

func NewBridge(cfg *config.Config, logger *logrus.Logger) (*Bridge, error) {
	ctx, cancel := context.WithCancel(context.Background())

	// Create MQTT client
	mqttClient, err := mqtt.NewClient(&cfg.MQTT, logger)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to create MQTT client: %w", err)
	}

	// Create the stream producer for the configured transport
	streamProducer, err := stream.NewProducer(cfg, logger)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to create %s producer: %w", cfg.Stream.Transport, err)
	}

	return &Bridge{
		mqtt:      mqttClient,
		stream:    streamProducer,
		config:    cfg,
		logger:    logger,
		messageCh: make(chan message, cfg.Bridge.BufferSize),
		ctx:       ctx,
		cancel:    cancel,
	}, nil
}

func (b *Bridge) Start() error {
	// Connect to MQTT broker
	if err := b.mqtt.Connect(); err != nil {
		return fmt.Errorf("failed to connect to MQTT: %w", err)
	}

	// Ensure destination topics exist before accepting any telemetry
	if err := b.stream.EnsureTopics(b.ctx, stream.TopicsFor(b.config)); err != nil {
		return fmt.Errorf("failed to ensure %s topics: %w", b.config.Stream.Transport, err)
	}

	// Start worker pool
	for i := 0; i < b.config.Bridge.WorkerCount; i++ {
		b.wg.Add(1)
		go b.worker(i)
	}

	// Subscribe to MQTT topics
	handler := b.createMessageHandler()
	if err := b.mqtt.Subscribe(b.config.MQTT.Topics, handler); err != nil {
		return fmt.Errorf("failed to subscribe to MQTT topics: %w", err)
	}

	b.logger.Info("Bridge started successfully")
	return nil
}

func (b *Bridge) Stop() {
	b.logger.Info("Stopping bridge...")

	// Cancel context to stop workers
	b.cancel()

	// Close message channel
	close(b.messageCh)

	// Wait for workers to finish
	b.wg.Wait()

	// Disconnect MQTT
	b.mqtt.Disconnect()

	// Close the stream producer
	if err := b.stream.Close(); err != nil {
		b.logger.Errorf("Error closing %s producer: %v", b.config.Stream.Transport, err)
	}

	b.logger.Info("Bridge stopped")
}

func (b *Bridge) createMessageHandler() mqtt_client.MessageHandler {
	return func(client mqtt_client.Client, msg mqtt_client.Message) {
		b.logger.Debugf("Received MQTT message from topic: %s", msg.Topic())

		// Parse telemetry data
		telemetry, err := models.FromJSON(msg.Payload())
		if err != nil {
			b.logger.Errorf("Failed to parse telemetry data: %v", err)
			return
		}

		// Validate if enabled
		if b.config.Bridge.EnableValidation {
			if err := telemetry.Validate(); err != nil {
				b.logger.Errorf("Invalid telemetry data: %v", err)
				return
			}
		}

		// Send to worker pool
		select {
		case b.messageCh <- message{sourceTopic: msg.Topic(), telemetry: telemetry}:
		case <-b.ctx.Done():
			return
		default:
			b.logger.Warn("Message channel full, dropping message")
		}
	}
}

func (b *Bridge) worker(id int) {
	defer b.wg.Done()

	b.logger.Infof("Worker %d started", id)

	for {
		select {
		case <-b.ctx.Done():
			b.logger.Infof("Worker %d stopping", id)
			return

		case msg, ok := <-b.messageCh:
			if !ok {
				b.logger.Infof("Worker %d: message channel closed", id)
				return
			}

			if err := b.processTelemetry(msg); err != nil {
				b.logger.Errorf("Worker %d: failed to process telemetry: %v", id, err)
			}
		}
	}
}

func (b *Bridge) processTelemetry(msg message) error {
	// Resolve the destination topic from the MQTT topic the record arrived on
	topic := resolveTopic(b.config, msg.sourceTopic)

	// Convert to JSON
	payload, err := msg.telemetry.ToJSON()
	if err != nil {
		return fmt.Errorf("failed to serialize telemetry: %w", err)
	}

	// Use device_id as partition key for ordered processing per device
	key := msg.telemetry.DeviceID

	// Publish with timeout
	ctx, cancel := context.WithTimeout(b.ctx, 5*time.Second)
	defer cancel()

	if err := b.stream.Send(ctx, topic, key, payload); err != nil {
		return fmt.Errorf("failed to publish to %s topic %s: %w", b.stream.Transport(), topic, err)
	}

	b.logger.Debugf("Published telemetry from device %s to %s topic %s",
		msg.telemetry.DeviceID, b.stream.Transport(), topic)
	return nil
}

// resolveTopic maps an MQTT topic to its configured stream topic, honouring MQTT
// wildcards, and falls back to the configured default topic.
func resolveTopic(cfg *config.Config, sourceTopic string) string {
	mapping := cfg.StreamTopics()
	if topic, ok := mapping[sourceTopic]; ok && topic != "" {
		return topic
	}
	for pattern, topic := range mapping {
		if topic != "" && mqtt.TopicMatches(pattern, sourceTopic) {
			return topic
		}
	}
	return cfg.Stream.DefaultTopic
}
