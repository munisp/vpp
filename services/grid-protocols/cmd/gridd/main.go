// Command gridd runs the grid protocol adapters: an OCPP 1.6J/2.0.1 central
// system, an OpenADR 2.0b VEN, an IEEE 2030.5 client and a Matter controller
// client. Each one speaks its real wire protocol; none of them reports a
// connection it does not have.
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/sirupsen/logrus"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
	metricnoop "go.opentelemetry.io/otel/metric/noop"
	"go.opentelemetry.io/otel/trace"

	"github.com/vpp/grid-protocols/config"
	"github.com/vpp/grid-protocols/internal/admin"
	"github.com/vpp/grid-protocols/internal/control"
	"github.com/vpp/grid-protocols/internal/matter"
	"github.com/vpp/grid-protocols/internal/ocpp16"
	"github.com/vpp/grid-protocols/internal/ocpp201"
	"github.com/vpp/grid-protocols/internal/ocppmux"
	"github.com/vpp/grid-protocols/internal/openadr"
	"github.com/vpp/grid-protocols/internal/platform"
	"github.com/vpp/grid-protocols/internal/sep2"
	"github.com/vpp/grid-protocols/internal/telemetry"
)

func main() {
	configPath := flag.String("config", "config.yaml", "path to the configuration file")
	flag.Parse()

	logger := logrus.New()
	logger.SetFormatter(&logrus.JSONFormatter{})

	if err := run(*configPath, logger); err != nil && !errors.Is(err, context.Canceled) {
		logger.WithError(err).Fatal("grid protocol service stopped")
	}
}

func run(configPath string, logger *logrus.Logger) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}
	if level, err := logrus.ParseLevel(cfg.LogLevel); err == nil {
		logger.SetLevel(level)
	}

	// Telemetry never blocks startup: with no OTLP endpoint configured it
	// disables itself (loudly), and an unreachable collector only costs
	// background retries. Its state is reported on /healthz.
	tele := telemetry.Setup("grid-protocols", func(format string, args ...any) {
		logger.Warnf(format, args...)
	})
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := tele.Shutdown(shutdownCtx); err != nil {
			logger.WithError(err).Warn("telemetry shutdown failed")
		}
	}()

	client, err := platform.NewClient(platform.Config{
		BaseURL:      cfg.Platform.BaseURL,
		SharedSecret: cfg.Platform.SharedSecret,
		Timeout:      cfg.Platform.Timeout,
	})
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":    "ok",
			"telemetry": tele.Status(),
		})
	})
	// INFRA scrapes this exact path. The OTel Prometheus exporter registers
	// into the default registry, so one handler serves both the SDK metrics
	// (request spans' counters, OCPP action counters) and the Go collector.
	mux.Handle("/metrics", promhttp.Handler())

	errs := make(chan error, 4)

	if cfg.OCPP.Enabled {
		// The supervisor needs the central system and the central system needs the
		// supervisor's session hook. The hook is published atomically because charge
		// point sessions are handled on other goroutines: a reconnect that races
		// startup finds no supervisor yet rather than a torn pointer, and the sweep
		// re-asserts its fallback on the next pass.
		var supervisorRef atomic.Pointer[control.Supervisor]
		onSessionOpen := func(chargePointID string) {
			if s := supervisorRef.Load(); s != nil {
				s.OnSessionOpen(chargePointID)
			}
		}

		var central16 ocppmux.V16
		if cfg.OCPP.Speaks(config.OCPPVersion16) {
			central, err := ocpp16.NewCentralSystem(client, ocpp16.Options{
				Authenticate:      basicAuthenticator(cfg.OCPP.ChargePoints),
				HeartbeatInterval: cfg.OCPP.HeartbeatInterval,
				CallTimeout:       cfg.OCPP.CallTimeout,
				OnSessionOpen:     onSessionOpen,
				Logger:            logger,
			})
			if err != nil {
				return err
			}
			central16 = central
		}

		var csms201 ocppmux.V201
		if cfg.OCPP.Speaks(config.OCPPVersion201) {
			csms, err := ocpp201.NewCSMS(client, ocpp201.Options{
				Authenticate:      basicAuthenticator(cfg.OCPP.ChargePoints),
				HeartbeatInterval: cfg.OCPP.HeartbeatInterval,
				CallTimeout:       cfg.OCPP.CallTimeout,
				OnSessionOpen:     onSessionOpen,
				Logger:            logger,
			})
			if err != nil {
				return err
			}
			csms201 = csms
		}

		central, err := ocppmux.New(central16, csms201, logger)
		if err != nil {
			return err
		}
		supervisor, err := control.New(central, control.Options{
			MaxValidity:    cfg.Control.MaxValidity,
			SweepInterval:  cfg.Control.SweepInterval,
			CommandTimeout: cfg.OCPP.CallTimeout,
			Logger:         logger,
		})
		if err != nil {
			return err
		}
		supervisorRef.Store(supervisor)
		commands, err := admin.New(central, cfg.Platform.SharedSecret, supervisor)
		if err != nil {
			return err
		}
		mux.Handle("/ocpp/", central)
		commands.Routes(mux)
		go supervisor.Run(ctx)
		logger.WithFields(logrus.Fields{
			"charge_points":  len(cfg.OCPP.ChargePoints),
			"versions":       cfg.OCPP.Versions,
			"max_validity":   cfg.Control.MaxValidity,
			"sweep_interval": cfg.Control.SweepInterval,
		}).Info("OCPP central system enabled with bounded control windows")
	}

	if cfg.OpenADR.Enabled {
		ven, err := openadr.NewVEN(openadr.Config{
			VTNBaseURL:     cfg.OpenADR.VTNBaseURL,
			VenName:        cfg.OpenADR.VenName,
			VenID:          cfg.OpenADR.VenID,
			RegistrationID: cfg.OpenADR.RegistrationID,
			Username:       cfg.OpenADR.Username,
			Password:       cfg.OpenADR.Password,
			ClientCertFile: cfg.OpenADR.ClientCertFile,
			ClientKeyFile:  cfg.OpenADR.ClientKeyFile,
			CAFile:         cfg.OpenADR.CAFile,
			PollInterval:   cfg.OpenADR.PollInterval,
			Logger:         logger,
		})
		if err != nil {
			return err
		}
		go func() { errs <- ven.Run(ctx, client) }()
		logger.WithField("vtn", cfg.OpenADR.VTNBaseURL).Info("OpenADR 2.0b VEN enabled")
	}

	if cfg.SEP2.Enabled {
		sepClient, err := sep2.NewClient(sep2.Config{
			BaseURL:        cfg.SEP2.BaseURL,
			ClientCertFile: cfg.SEP2.ClientCertFile,
			ClientKeyFile:  cfg.SEP2.ClientKeyFile,
			CAFile:         cfg.SEP2.CAFile,
			Logger:         logger,
		})
		if err != nil {
			return err
		}
		logger.WithFields(logrus.Fields{"server": cfg.SEP2.BaseURL, "lfdi": sepClient.LFDI()}).
			Info("IEEE 2030.5 client enabled")
		go func() { errs <- pollSEP2(ctx, sepClient, client, cfg.SEP2.PollInterval, logger) }()
	}

	if cfg.Matter.Enabled {
		controller, err := matter.NewController(matter.Config{
			URL:               cfg.Matter.URL,
			CallTimeout:       cfg.Matter.CallTimeout,
			ReconnectInterval: cfg.Matter.ReconnectInterval,
			AllowTestNodes:    cfg.Matter.AllowTestNodes,
			Logger:            logger,
		}, client)
		if err != nil {
			return err
		}
		// Matter On/Off and Level commands carry no expiry, so the window is held
		// here: without this supervisor a trimmed load would stay trimmed after the
		// platform stopped talking to it.
		supervisor, err := matter.NewSupervisor(controller, matter.SupervisorOptions{
			MaxValidity:    cfg.Control.MaxValidity,
			SweepInterval:  cfg.Control.SweepInterval,
			CommandTimeout: cfg.Matter.CallTimeout,
			Logger:         logger,
		})
		if err != nil {
			return err
		}
		loads, err := matter.NewAPI(controller, supervisor, cfg.Platform.SharedSecret)
		if err != nil {
			return err
		}
		loads.Routes(mux)
		go supervisor.Run(ctx)
		go func() { errs <- controller.Run(ctx) }()
		logger.WithFields(logrus.Fields{
			"controller":       cfg.Matter.URL,
			"allow_test_nodes": cfg.Matter.AllowTestNodes,
			"max_validity":     cfg.Control.MaxValidity,
		}).Info("Matter controller client enabled with bounded load control windows")
		if cfg.Matter.AllowTestNodes {
			logger.Warn("matter.allow_test_nodes is on: the controller's synthetic nodes acknowledge commands that no device performs")
		}
	}

	server := &http.Server{
		Addr:              cfg.Listen,
		Handler:           tracingHandler(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		logger.WithField("listen", cfg.Listen).Info("HTTP listener started")
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errs <- err
		}
	}()

	select {
	case <-ctx.Done():
	case err := <-errs:
		if err != nil && !errors.Is(err, context.Canceled) {
			shutdown(server, logger)
			return err
		}
	}

	shutdown(server, logger)
	return ctx.Err()
}

// tracingHandler wraps the mux with one server span per request. The span is
// named and tagged with a low-cardinality route (charge point identities are
// collapsed) rather than the raw path. /metrics is not traced: scrapes would
// drown the request traces the operator actually reads.
func tracingHandler(mux *http.ServeMux) http.Handler {
	return otelhttp.NewHandler(routeTagging(stableSemconvMetrics(mux)), "gridd",
		otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string {
			return r.Method + " " + routePattern(r)
		}),
		otelhttp.WithFilter(func(r *http.Request) bool {
			return r.URL.Path != "/metrics"
		}),
		// otelhttp v0.49 still measures with the legacy http.server.duration
		// metric; that series is suppressed because the platform's dashboards
		// are built on the stable semconv histogram recorded by
		// stableSemconvMetrics below.
		otelhttp.WithMeterProvider(metricnoop.NewMeterProvider()),
	)
}

var (
	httpDurationOnce sync.Once
	httpDuration     metric.Float64Histogram
)

func httpDurationHistogram() metric.Float64Histogram {
	httpDurationOnce.Do(func() {
		httpDuration, _ = otel.Meter("github.com/vpp/grid-protocols/cmd/gridd").Float64Histogram(
			"http.server.request.duration",
			metric.WithDescription("Duration of HTTP server requests."),
			metric.WithUnit("s"),
		)
	})
	return httpDuration
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// stableSemconvMetrics records the OTel stable HTTP semantic-convention
// server histogram, exported to Prometheus as
// http_server_request_duration_seconds_* with labels http_request_method,
// http_response_status_code, http_route (plus service_name and tenant.id
// from the exporter's resource constant labels). /metrics scrapes are not
// measured.
func stableSemconvMetrics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/metrics" {
			next.ServeHTTP(w, r)
			return
		}
		started := time.Now()
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, r)
		httpDurationHistogram().Record(r.Context(), time.Since(started).Seconds(),
			metric.WithAttributes(
				attribute.String("http.request.method", r.Method),
				attribute.Int("http.response.status_code", recorder.status),
				attribute.String("http.route", routePattern(r)),
			))
	})
}

// routeTagging stamps the normalised route onto the request span as
// http.route, so backends can group by route instead of raw path.
func routeTagging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		span := trace.SpanFromContext(r.Context())
		span.SetAttributes(attribute.String("http.route", routePattern(r)))
		next.ServeHTTP(w, r)
	})
}

// routePattern collapses the one high-cardinality path this service serves:
// /ocpp/<chargePointId>. Everything else is already a fixed literal.
func routePattern(r *http.Request) string {
	if rest, ok := strings.CutPrefix(r.URL.Path, "/ocpp/"); ok && rest != "" {
		return "/ocpp/{chargePointId}"
	}
	return r.URL.Path
}

func shutdown(server *http.Server, logger *logrus.Logger) {
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		logger.WithError(err).Warn("HTTP shutdown failed")
	}
}

// pollSEP2 fetches DER controls and forwards them to the platform.
func pollSEP2(ctx context.Context, client *sep2.Client, sink *platform.Client, interval time.Duration, logger *logrus.Logger) error {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		dcap, err := client.DeviceCapability(ctx)
		if err != nil {
			logger.WithError(err).Warn("IEEE 2030.5 discovery failed")
		} else {
			instructions, problems, err := client.ActiveControls(ctx, dcap)
			for _, problem := range problems {
				logger.WithError(problem).Warn("skipping uninterpretable DERControl")
			}
			switch {
			case err != nil:
				logger.WithError(err).Warn("IEEE 2030.5 control retrieval failed")
			case len(instructions) > 0:
				if err := sink.DERControls(ctx, instructions); err != nil {
					logger.WithError(err).Warn("forwarding DER controls to the platform failed")
				}
			}
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// basicAuthenticator implements OCPP 1.6 security profile 1: HTTP basic auth
// where the username is the charge point identity.
func basicAuthenticator(credentials map[string]string) func(*http.Request, string) error {
	return func(r *http.Request, chargePointID string) error {
		username, password, ok := r.BasicAuth()
		if !ok {
			return errors.New("basic auth credentials are required")
		}
		if username != chargePointID {
			return fmt.Errorf("basic auth user %q does not match charge point %q", username, chargePointID)
		}
		expected, known := credentials[chargePointID]
		if !known {
			return fmt.Errorf("charge point %q is not provisioned", chargePointID)
		}
		if subtle.ConstantTimeCompare([]byte(expected), []byte(password)) != 1 {
			return fmt.Errorf("wrong password for charge point %q", chargePointID)
		}
		return nil
	}
}
