package metrics

import (
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	// MQTT metrics
	MQTTMessagesReceived = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "mqtt_messages_received_total",
			Help: "Total number of MQTT messages received",
		},
		[]string{"topic"},
	)

	MQTTConnectionStatus = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "mqtt_connection_status",
			Help: "MQTT connection status (1 = connected, 0 = disconnected)",
		},
	)

	// Fluvio metrics
	FluvioMessagesPublished = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "fluvio_messages_published_total",
			Help: "Total number of messages published to Fluvio",
		},
		[]string{"topic"},
	)

	FluvioPublishErrors = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "fluvio_publish_errors_total",
			Help: "Total number of Fluvio publish errors",
		},
		[]string{"topic", "error_type"},
	)

	// Processing metrics
	MessageProcessingDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "message_processing_duration_seconds",
			Help:    "Time taken to process a message",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"topic"},
	)

	ValidationErrors = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "validation_errors_total",
			Help: "Total number of validation errors",
		},
		[]string{"error_type"},
	)

	// Worker metrics
	ActiveWorkers = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "active_workers",
			Help: "Number of active worker goroutines",
		},
	)

	WorkerQueueSize = prometheus.NewGauge(
		prometheus.GaugeOpts{
			Name: "worker_queue_size",
			Help: "Current size of the worker queue",
		},
	)
)

func init() {
	// Register all metrics
	prometheus.MustRegister(
		MQTTMessagesReceived,
		MQTTConnectionStatus,
		FluvioMessagesPublished,
		FluvioPublishErrors,
		MessageProcessingDuration,
		ValidationErrors,
		ActiveWorkers,
		WorkerQueueSize,
	)
}

// StartMetricsServer serves the bridge's observability endpoints on their own
// mux: GET /metrics (Prometheus scrape target) and, when healthz is non-nil,
// GET /healthz (telemetry and MQTT connection status). It blocks until the
// server fails; run it in a goroutine.
func StartMetricsServer(addr string, healthz http.HandlerFunc) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	if healthz != nil {
		mux.HandleFunc("/healthz", healthz)
	}
	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	return server.ListenAndServe()
}
