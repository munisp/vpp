package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	mqtt_client "github.com/eclipse/paho.mqtt.golang"
	"github.com/sirupsen/logrus"
	"github.com/vpp/mqtt-fluvio-bridge/config"
	"github.com/vpp/mqtt-fluvio-bridge/internal/metrics"
	"github.com/vpp/mqtt-fluvio-bridge/internal/models"
	"github.com/vpp/mqtt-fluvio-bridge/internal/mqtt"
	"github.com/vpp/mqtt-fluvio-bridge/internal/stream"
	"github.com/vpp/mqtt-fluvio-bridge/internal/telemetry"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// tracer is safe to resolve at package scope: the global provider delegates,
// so spans created before telemetry.Setup binds the SDK stay no-op until then.
var tracer = otel.Tracer("github.com/vpp/mqtt-fluvio-bridge/cmd")

// message pairs telemetry with the MQTT topic it arrived on, which selects the
// destination stream topic. ctx carries the receive span context so the
// produce span and the propagated traceparent join the same trace.
type message struct {
	ctx         context.Context
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

	// Telemetry never blocks startup: with no OTLP endpoint configured it
	// disables itself (loudly), and an unreachable collector only costs
	// background retries. Its state is reported on /healthz.
	tele := telemetry.Setup("mqtt-fluvio-bridge", func(format string, args ...any) {
		logger.Warnf(format, args...)
	})
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := tele.Shutdown(shutdownCtx); err != nil {
			logger.Warnf("telemetry shutdown failed: %v", err)
		}
	}()

	// Create bridge
	bridge, err := NewBridge(cfg, logger)
	if err != nil {
		logger.Fatalf("Failed to create bridge: %v", err)
	}

	// Start bridge
	if err := bridge.Start(); err != nil {
		logger.Fatalf("Failed to start bridge: %v", err)
	}

	// Serve Prometheus metrics and health. This is the scrape target the
	// monitoring stack has always pointed at (mqtt-fluvio-bridge:8080); it
	// used to be dead because StartMetricsServer was never called.
	go func() {
		logger.Infof("Metrics server listening on %s (/metrics, /healthz)", cfg.Bridge.MetricsAddr)
		if err := metrics.StartMetricsServer(cfg.Bridge.MetricsAddr, healthzHandler(bridge, tele)); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Errorf("Metrics server failed: %v", err)
		}
	}()

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
		// One consumer span per MQTT message; its context rides the queued
		// message into the worker, which parents the produce span to it and
		// propagates it as traceparent on the published record.
		ctx, span := tracer.Start(context.Background(), "mqtt.receive",
			trace.WithSpanKind(trace.SpanKindConsumer),
			trace.WithAttributes(
				attribute.String("messaging.system", "mqtt"),
				attribute.String("messaging.destination.name", msg.Topic()),
				attribute.Int("messaging.message.payload_size_bytes", len(msg.Payload())),
			),
		)
		defer span.End()

		b.logger.Debugf("Received MQTT message from topic: %s", msg.Topic())
		metrics.MQTTMessagesReceived.WithLabelValues(msg.Topic()).Inc()

		// Parse telemetry data
		telemetry, err := models.FromJSON(msg.Payload())
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, "unparseable telemetry payload")
			b.logger.Errorf("Failed to parse telemetry data: %v", err)
			return
		}

		// Validate if enabled
		if b.config.Bridge.EnableValidation {
			if err := telemetry.Validate(); err != nil {
				span.RecordError(err)
				span.SetStatus(codes.Error, "telemetry validation failed")
				metrics.ValidationErrors.WithLabelValues("field_range").Inc()
				b.logger.Errorf("Invalid telemetry data: %v", err)
				return
			}
		}

		// Send to worker pool
		select {
		case b.messageCh <- message{ctx: ctx, sourceTopic: msg.Topic(), telemetry: telemetry}:
			metrics.WorkerQueueSize.Set(float64(len(b.messageCh)))
		case <-b.ctx.Done():
			return
		default:
			span.SetStatus(codes.Error, "worker queue full, message dropped")
			b.logger.Warn("Message channel full, dropping message")
		}
	}
}

func (b *Bridge) worker(id int) {
	defer b.wg.Done()

	metrics.ActiveWorkers.Inc()
	defer metrics.ActiveWorkers.Dec()

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
			metrics.WorkerQueueSize.Set(float64(len(b.messageCh)))

			if err := b.processTelemetry(msg); err != nil {
				b.logger.Errorf("Worker %d: failed to process telemetry: %v", id, err)
			}
		}
	}
}

func (b *Bridge) processTelemetry(msg message) error {
	// Resolve the destination topic from the MQTT topic the record arrived on
	topic := resolveTopic(b.config, msg.sourceTopic)

	started := time.Now()

	// Producer span, child of the receive span: its context is what the stream
	// producers inject as traceparent (Kafka headers, Fluvio payload envelope).
	ctx, span := tracer.Start(msg.ctx, "stream.produce",
		trace.WithSpanKind(trace.SpanKindProducer),
		trace.WithAttributes(
			attribute.String("messaging.system", string(b.stream.Transport())),
			attribute.String("messaging.destination.name", topic),
			attribute.String("device.id", msg.telemetry.DeviceID),
		),
	)
	defer span.End()

	// Convert to JSON
	payload, err := msg.telemetry.ToJSON()
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return fmt.Errorf("failed to serialize telemetry: %w", err)
	}

	// Use device_id as partition key for ordered processing per device
	key := msg.telemetry.DeviceID

	// Publish with timeout
	sendCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	if err := b.stream.Send(sendCtx, topic, key, payload); err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		metrics.FluvioPublishErrors.WithLabelValues(topic, "publish").Inc()
		return fmt.Errorf("failed to publish to %s topic %s: %w", b.stream.Transport(), topic, err)
	}

	metrics.FluvioMessagesPublished.WithLabelValues(topic).Inc()
	metrics.MessageProcessingDuration.WithLabelValues(msg.sourceTopic).Observe(time.Since(started).Seconds())

	b.logger.Debugf("Published telemetry from device %s to %s topic %s",
		msg.telemetry.DeviceID, b.stream.Transport(), topic)
	return nil
}

// healthzHandler reports liveness with the two things an operator checks here:
// whether the telemetry pipeline is exporting, and whether the MQTT broker
// connection (which auto-reconnects) is currently up.
func healthzHandler(b *Bridge, tele *telemetry.Telemetry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		connected := b.mqtt.IsConnected()
		if connected {
			metrics.MQTTConnectionStatus.Set(1)
		} else {
			metrics.MQTTConnectionStatus.Set(0)
		}

		status := "ok"
		code := http.StatusOK
		if !connected {
			status = "degraded"
			code = http.StatusServiceUnavailable
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":    status,
			"mqtt":      map[string]any{"connected": connected},
			"telemetry": tele.Status(),
		})
	}
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
