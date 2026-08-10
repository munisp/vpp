package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	// Workflow Metrics
	WorkflowsStarted = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "vpp_workflows_started_total",
			Help: "Total number of workflows started",
		},
		[]string{"workflow_type", "user_id"},
	)

	WorkflowsCompleted = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "vpp_workflows_completed_total",
			Help: "Total number of workflows completed successfully",
		},
		[]string{"workflow_type", "user_id"},
	)

	WorkflowsFailed = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "vpp_workflows_failed_total",
			Help: "Total number of workflows that failed",
		},
		[]string{"workflow_type", "user_id", "error_type"},
	)

	WorkflowDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "vpp_workflow_duration_seconds",
			Help:    "Duration of workflow execution in seconds",
			Buckets: prometheus.ExponentialBuckets(1, 2, 10), // 1s to ~17min
		},
		[]string{"workflow_type"},
	)

	// Activity Metrics
	ActivitiesExecuted = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "vpp_activities_executed_total",
			Help: "Total number of activities executed",
		},
		[]string{"activity_name", "workflow_type"},
	)

	ActivitiesFailed = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "vpp_activities_failed_total",
			Help: "Total number of activities that failed",
		},
		[]string{"activity_name", "workflow_type", "error_type"},
	)

	ActivityDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "vpp_activity_duration_seconds",
			Help:    "Duration of activity execution in seconds",
			Buckets: prometheus.ExponentialBuckets(0.1, 2, 10), // 100ms to ~1.7min
		},
		[]string{"activity_name"},
	)

	// Trading Metrics
	TradesExecuted = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "vpp_trades_executed_total",
			Help: "Total number of trades executed",
		},
		[]string{"trade_type"}, // auto, manual, p2p
	)

	TradeVolume = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "vpp_trade_volume_kwh",
			Help: "Total energy traded in kWh",
		},
		[]string{"trade_type"},
	)

	TradeRevenue = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "vpp_trade_revenue_cents",
			Help: "Total revenue from trades in cents",
		},
		[]string{"trade_type"},
	)

	// DR Event Metrics
	DREventsEnrolled = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "vpp_dr_events_enrolled_total",
			Help: "Total number of DR event enrollments",
		},
	)

	DREventsCompleted = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "vpp_dr_events_completed_total",
			Help: "Total number of DR events completed",
		},
	)

	DRRewardsEarned = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "vpp_dr_rewards_earned_cents",
			Help: "Total DR rewards earned in cents",
		},
	)

	// Payment Metrics
	PaymentsProcessed = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "vpp_payments_processed_total",
			Help: "Total number of payments processed",
		},
		[]string{"payment_method"}, // mpesa, airtel, tigo
	)

	PaymentVolume = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "vpp_payment_volume_cents",
			Help: "Total payment volume in cents",
		},
		[]string{"payment_method"},
	)

	PaymentsFailed = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "vpp_payments_failed_total",
			Help: "Total number of failed payments",
		},
		[]string{"payment_method", "error_type"},
	)

	// Telemetry Metrics
	TelemetryDataPoints = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "vpp_telemetry_datapoints_total",
			Help: "Total number of telemetry data points processed",
		},
		[]string{"device_type"},
	)

	AnomaliesDetected = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "vpp_anomalies_detected_total",
			Help: "Total number of anomalies detected",
		},
		[]string{"anomaly_type"},
	)

	AlertsGenerated = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "vpp_alerts_generated_total",
			Help: "Total number of alerts generated",
		},
		[]string{"alert_severity"}, // low, medium, high, critical
	)

	// Middleware Integration Metrics
	KafkaMessagesPublished = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "vpp_kafka_messages_published_total",
			Help: "Total number of messages published to Kafka",
		},
		[]string{"topic"},
	)

	KafkaPublishErrors = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "vpp_kafka_publish_errors_total",
			Help: "Total number of Kafka publish errors",
		},
		[]string{"topic", "error_type"},
	)

	RedisOperations = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "vpp_redis_operations_total",
			Help: "Total number of Redis operations",
		},
		[]string{"operation"}, // get, set, delete, etc.
	)

	RedisErrors = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "vpp_redis_errors_total",
			Help: "Total number of Redis errors",
		},
		[]string{"operation", "error_type"},
	)

	TigerBeetleTransactions = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "vpp_tigerbeetle_transactions_total",
			Help: "Total number of TigerBeetle transactions",
		},
		[]string{"transaction_type"}, // transfer, lookup, etc.
	)

	TigerBeetleErrors = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "vpp_tigerbeetle_errors_total",
			Help: "Total number of TigerBeetle errors",
		},
		[]string{"transaction_type", "error_type"},
	)

	// System Metrics
	ActiveWorkflows = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "vpp_active_workflows",
			Help: "Number of currently active workflows",
		},
	)

	WorkerUtilization = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "vpp_worker_utilization_percent",
			Help: "Worker utilization percentage",
		},
	)

	MemoryUsage = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "vpp_memory_usage_bytes",
			Help: "Memory usage in bytes",
		},
	)

	// Gamification Metrics
	AchievementsAwarded = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "vpp_achievements_awarded_total",
			Help: "Total number of achievements awarded",
		},
	)

	LeaderboardUpdates = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "vpp_leaderboard_updates_total",
			Help: "Total number of leaderboard updates",
		},
	)
)

// Helper functions to record metrics

func RecordWorkflowStart(workflowType, userID string) {
	WorkflowsStarted.WithLabelValues(workflowType, userID).Inc()
	ActiveWorkflows.Inc()
}

func RecordWorkflowComplete(workflowType, userID string, durationSeconds float64) {
	WorkflowsCompleted.WithLabelValues(workflowType, userID).Inc()
	WorkflowDuration.WithLabelValues(workflowType).Observe(durationSeconds)
	ActiveWorkflows.Dec()
}

func RecordWorkflowFailed(workflowType, userID, errorType string) {
	WorkflowsFailed.WithLabelValues(workflowType, userID, errorType).Inc()
	ActiveWorkflows.Dec()
}

func RecordActivityExecution(activityName, workflowType string, durationSeconds float64) {
	ActivitiesExecuted.WithLabelValues(activityName, workflowType).Inc()
	ActivityDuration.WithLabelValues(activityName).Observe(durationSeconds)
}

func RecordActivityFailure(activityName, workflowType, errorType string) {
	ActivitiesFailed.WithLabelValues(activityName, workflowType, errorType).Inc()
}

func RecordTrade(tradeType string, volumeKwh float64, revenueCents int64) {
	TradesExecuted.WithLabelValues(tradeType).Inc()
	TradeVolume.WithLabelValues(tradeType).Add(volumeKwh)
	TradeRevenue.WithLabelValues(tradeType).Add(float64(revenueCents))
}

func RecordPayment(paymentMethod string, amountCents int64) {
	PaymentsProcessed.WithLabelValues(paymentMethod).Inc()
	PaymentVolume.WithLabelValues(paymentMethod).Add(float64(amountCents))
}

func RecordPaymentFailure(paymentMethod, errorType string) {
	PaymentsFailed.WithLabelValues(paymentMethod, errorType).Inc()
}

func RecordKafkaPublish(topic string) {
	KafkaMessagesPublished.WithLabelValues(topic).Inc()
}

func RecordKafkaError(topic, errorType string) {
	KafkaPublishErrors.WithLabelValues(topic, errorType).Inc()
}

func RecordRedisOperation(operation string) {
	RedisOperations.WithLabelValues(operation).Inc()
}

func RecordRedisError(operation, errorType string) {
	RedisErrors.WithLabelValues(operation, errorType).Inc()
}

func RecordTigerBeetleTransaction(transactionType string) {
	TigerBeetleTransactions.WithLabelValues(transactionType).Inc()
}

func RecordTigerBeetleError(transactionType, errorType string) {
	TigerBeetleErrors.WithLabelValues(transactionType, errorType).Inc()
}

func RecordAnomaly(anomalyType string) {
	AnomaliesDetected.WithLabelValues(anomalyType).Inc()
}

func RecordAlert(severity string) {
	AlertsGenerated.WithLabelValues(severity).Inc()
}

func RecordAchievement() {
	AchievementsAwarded.Inc()
}

func RecordLeaderboardUpdate() {
	LeaderboardUpdates.Inc()
}
