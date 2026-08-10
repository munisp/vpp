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
	"github.com/vpp/mqtt-fluvio-bridge/internal/fluvio"
	"github.com/vpp/mqtt-fluvio-bridge/internal/models"
	"github.com/vpp/mqtt-fluvio-bridge/internal/mqtt"
)

type Bridge struct {
	mqtt      *mqtt.Client
	fluvio    *fluvio.Producer
	config    *config.Config
	logger    *logrus.Logger
	messageCh chan *models.TelemetryData
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

	// Create Fluvio producer
	fluvioProducer, err := fluvio.NewProducer(&cfg.Fluvio, logger)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("failed to create Fluvio producer: %w", err)
	}

	return &Bridge{
		mqtt:      mqttClient,
		fluvio:    fluvioProducer,
		config:    cfg,
		logger:    logger,
		messageCh: make(chan *models.TelemetryData, cfg.Bridge.BufferSize),
		ctx:       ctx,
		cancel:    cancel,
	}, nil
}

func (b *Bridge) Start() error {
	// Connect to MQTT broker
	if err := b.mqtt.Connect(); err != nil {
		return fmt.Errorf("failed to connect to MQTT: %w", err)
	}

	// Ensure Fluvio topics exist
	if err := b.fluvio.EnsureTopics(b.ctx); err != nil {
		return fmt.Errorf("failed to ensure Fluvio topics: %w", err)
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

	// Close Fluvio producer
	if err := b.fluvio.Close(); err != nil {
		b.logger.Errorf("Error closing Fluvio producer: %v", err)
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
		case b.messageCh <- telemetry:
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

		case telemetry, ok := <-b.messageCh:
			if !ok {
				b.logger.Infof("Worker %d: message channel closed", id)
				return
			}

			if err := b.processTelemetry(telemetry); err != nil {
				b.logger.Errorf("Worker %d: failed to process telemetry: %v", id, err)
			}
		}
	}
}

func (b *Bridge) processTelemetry(telemetry *models.TelemetryData) error {
	// Determine Fluvio topic based on MQTT topic mapping
	fluvioTopic := "telemetry" // Default topic

	// Convert to JSON
	payload, err := telemetry.ToJSON()
	if err != nil {
		return fmt.Errorf("failed to serialize telemetry: %w", err)
	}

	// Use device_id as partition key for ordered processing per device
	key := telemetry.DeviceID

	// Send to Fluvio with timeout
	ctx, cancel := context.WithTimeout(b.ctx, 5*time.Second)
	defer cancel()

	if err := b.fluvio.Send(ctx, fluvioTopic, key, payload); err != nil {
		return fmt.Errorf("failed to send to Fluvio: %w", err)
	}

	b.logger.Debugf("Processed telemetry from device %s", telemetry.DeviceID)
	return nil
}
