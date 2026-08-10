"""
Prometheus metrics for Python consumers
"""

from prometheus_client import Counter, Gauge, Histogram, start_http_server


# Fluvio consumer metrics
messages_consumed = Counter(
    "fluvio_messages_consumed_total",
    "Total number of messages consumed from Fluvio",
    ["topic", "consumer"]
)

messages_processed = Counter(
    "messages_processed_total",
    "Total number of messages successfully processed",
    ["consumer"]
)

processing_errors = Counter(
    "processing_errors_total",
    "Total number of processing errors",
    ["consumer", "error_type"]
)

processing_duration = Histogram(
    "message_processing_duration_seconds",
    "Time taken to process a message",
    ["consumer"],
    buckets=(0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0)
)

# Database consumer metrics
database_inserts = Counter(
    "database_inserts_total",
    "Total number of database inserts",
    ["table"]
)

database_errors = Counter(
    "database_errors_total",
    "Total number of database errors",
    ["operation", "error_type"]
)

database_connection_status = Gauge(
    "database_connection_status",
    "Database connection status (1 = connected, 0 = disconnected)"
)

# Analytics consumer metrics
window_aggregations = Counter(
    "window_aggregations_total",
    "Total number of window aggregations computed"
)

active_windows = Gauge(
    "active_windows",
    "Number of active time windows"
)

records_per_window = Histogram(
    "records_per_window",
    "Number of records in each window",
    buckets=(1, 5, 10, 25, 50, 100, 250, 500, 1000)
)


def start_metrics_server(port: int = 8000):
    """Start Prometheus metrics HTTP server"""
    start_http_server(port)
