package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/vpp-platform/orchestrator/config"
	"github.com/vpp-platform/orchestrator/services"
	"github.com/vpp-platform/orchestrator/telemetry"
	"github.com/vpp-platform/orchestrator/workflows"
	"go.temporal.io/sdk/client"
	contribotel "go.temporal.io/sdk/contrib/opentelemetry"
	"go.temporal.io/sdk/interceptor"
	"go.temporal.io/sdk/worker"
)

// temporalHealthy flips true once the Temporal client dialled successfully.
// The worker fatals if it cannot start, so after boot this stays true; it
// exists so /healthz has a real dependency signal rather than a static "ok".
var temporalHealthy atomic.Bool

func main() {
	// Load configuration
	cfg, err := config.LoadConfig()
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Telemetry never blocks startup: with no OTLP endpoint configured it
	// disables itself (loudly), and an unreachable collector only costs
	// background retries. Its state is reported on /healthz.
	tele := telemetry.Setup("orchestrator", func(format string, args ...any) {
		log.Printf("WARN: "+format, args...)
	})
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := tele.Shutdown(shutdownCtx); err != nil {
			log.Printf("WARN: telemetry shutdown failed: %v", err)
		}
	}()

	// Serve the promauto registry (metrics/prometheus.go) over HTTP. Nothing
	// used to serve it, so every vpp_* metric was invisible. METRICS_PORT
	// selects the port (default 9464).
	startObservabilityServer(metricsAddr(), tele)

	// The Temporal contrib tracing interceptor wires workflow and activity
	// spans into the SDK's tracer provider and propagates context through
	// workflow history. Only installed when telemetry is actually exporting;
	// contrib/opentelemetry v0.5.x is API-compatible with go.temporal.io/sdk
	// v1.25.1.
	var clientInterceptors []interceptor.ClientInterceptor
	var workerInterceptors []interceptor.WorkerInterceptor
	if tele.Enabled() {
		tracingInterceptor, err := contribotel.NewTracingInterceptor(contribotel.TracerOptions{})
		if err != nil {
			log.Printf("WARN: temporal tracing interceptor unavailable, continuing without it: %v", err)
		} else {
			clientInterceptors = []interceptor.ClientInterceptor{tracingInterceptor}
			workerInterceptors = []interceptor.WorkerInterceptor{tracingInterceptor}
		}
	}

	// Initialize Temporal client
	temporalClient, err := client.Dial(client.Options{
		HostPort:     cfg.Temporal.HostPort,
		Namespace:    cfg.Temporal.Namespace,
		Interceptors: clientInterceptors,
	})
	if err != nil {
		log.Fatalf("Failed to create Temporal client: %v", err)
	}
	defer temporalClient.Close()
	temporalHealthy.Store(true)

	// Initialize middleware services
	svc, err := services.NewServices(cfg)
	if err != nil {
		log.Fatalf("Failed to initialize services: %v", err)
	}
	defer svc.Close()

	// Create Temporal worker
	w := worker.New(temporalClient, cfg.Temporal.TaskQueue, worker.Options{
		Interceptors: workerInterceptors,
	})

	// Register workflows
	workflows.RegisterWorkflows(w)

	// Register activities with services
	workflows.RegisterActivities(w, svc)

	// Start worker
	err = w.Start()
	if err != nil {
		log.Fatalf("Failed to start worker: %v", err)
	}
	defer w.Stop()

	log.Printf("Temporal worker started on task queue: %s", cfg.Temporal.TaskQueue)

	// Wait for interrupt signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	<-sigCh

	log.Println("Shutting down orchestrator...")
}

// metricsAddr resolves the metrics/health listen address from METRICS_PORT
// (default 9464).
func metricsAddr() string {
	port := os.Getenv("METRICS_PORT")
	if port == "" {
		port = "9464"
	}
	return ":" + port
}

// startObservabilityServer serves GET /metrics (the promauto registry) and
// GET /healthz (telemetry pipeline + Temporal connectivity) in the
// background. A failure to bind is logged, not fatal: the worker's job is
// executing workflows, and it must not die because an observability port was
// taken.
func startObservabilityServer(addr string, tele *telemetry.Telemetry) {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		status := "ok"
		code := http.StatusOK
		if !temporalHealthy.Load() {
			status = "degraded"
			code = http.StatusServiceUnavailable
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":    status,
			"temporal":  map[string]any{"connected": temporalHealthy.Load()},
			"telemetry": tele.Status(),
		})
	})
	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Printf("Metrics server listening on %s (/metrics, /healthz)", addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("WARN: metrics server failed: %v", err)
		}
	}()
}
