// Command gridd runs the grid protocol adapters: an OCPP 1.6J central system,
// an OpenADR 2.0b VEN and an IEEE 2030.5 client. Each one speaks its real wire
// protocol; none of them reports a connection it does not have.
package main

import (
	"context"
	"crypto/subtle"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/sirupsen/logrus"

	"github.com/vpp/grid-protocols/config"
	"github.com/vpp/grid-protocols/internal/admin"
	"github.com/vpp/grid-protocols/internal/ocpp16"
	"github.com/vpp/grid-protocols/internal/openadr"
	"github.com/vpp/grid-protocols/internal/platform"
	"github.com/vpp/grid-protocols/internal/sep2"
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

	if cfg.OCPP.Enabled {
		central, err := ocpp16.NewCentralSystem(client, ocpp16.Options{
			Authenticate:      basicAuthenticator(cfg.OCPP.ChargePoints),
			HeartbeatInterval: cfg.OCPP.HeartbeatInterval,
			CallTimeout:       cfg.OCPP.CallTimeout,
			Logger:            logger,
		})
		if err != nil {
			return err
		}
		commands, err := admin.New(central, cfg.Platform.SharedSecret)
		if err != nil {
			return err
		}
		mux.Handle("/ocpp/", central)
		commands.Routes(mux)
		logger.WithField("charge_points", len(cfg.OCPP.ChargePoints)).Info("OCPP 1.6J central system enabled")
	}

	errs := make(chan error, 2)

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

	server := &http.Server{
		Addr:              cfg.Listen,
		Handler:           mux,
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
