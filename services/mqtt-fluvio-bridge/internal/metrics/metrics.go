package metrics

import (
	"net/http"

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

// StartMetricsServer starts the Prometheus metrics HTTP server
func StartMetricsServer(addr string) error {
	http.Handle("/metrics", promhttp.Handler())
	return http.ListenAndServe(addr, nil)
}
