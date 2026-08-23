// Package config loads the grid protocol service configuration. Every protocol
// is opt-in and every enabled protocol must be fully configured: a half
// configured protocol would come up "connected" without being able to act.
package config

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/joho/godotenv"
	"gopkg.in/yaml.v3"
)

type Config struct {
	Listen   string         `yaml:"listen"`
	Platform PlatformConfig `yaml:"platform"`
	OCPP     OCPPConfig     `yaml:"ocpp"`
	Control  ControlConfig  `yaml:"control"`
	OpenADR  OpenADRConfig  `yaml:"openadr"`
	SEP2     SEP2Config     `yaml:"sep2"`
	LogLevel string         `yaml:"log_level"`
}

type PlatformConfig struct {
	BaseURL      string        `yaml:"base_url"`
	SharedSecret string        `yaml:"shared_secret"`
	Timeout      time.Duration `yaml:"timeout"`
}

type OCPPConfig struct {
	Enabled bool `yaml:"enabled"`
	// Versions lists the OCPP versions this deployment accepts, "1.6" and/or
	// "2.0.1". A station is routed by the WebSocket subprotocol it offers, so a
	// version that is not listed is refused rather than served with the other
	// version's message set. Defaults to 1.6 only.
	Versions []string `yaml:"versions"`
	// ChargePoints maps charge point identity to its HTTP basic auth password.
	// OCPP 1.6 security profile 1 is basic auth over TLS; an empty map means no
	// charger can connect, which is preferable to accepting all of them.
	ChargePoints      map[string]string `yaml:"charge_points"`
	HeartbeatInterval time.Duration     `yaml:"heartbeat_interval"`
	CallTimeout       time.Duration     `yaml:"call_timeout"`
}

// ControlConfig bounds how long a dispatched setpoint may apply and how often
// closed windows are swept. These are safety limits, not tuning knobs: a long
// max_validity is how a charge point ends up holding a stale setpoint through an
// outage.
type ControlConfig struct {
	MaxValidity   time.Duration `yaml:"max_validity"`
	SweepInterval time.Duration `yaml:"sweep_interval"`
}

type OpenADRConfig struct {
	Enabled        bool          `yaml:"enabled"`
	VTNBaseURL     string        `yaml:"vtn_base_url"`
	VenName        string        `yaml:"ven_name"`
	VenID          string        `yaml:"ven_id"`
	RegistrationID string        `yaml:"registration_id"`
	Username       string        `yaml:"username"`
	Password       string        `yaml:"password"`
	ClientCertFile string        `yaml:"client_cert_file"`
	ClientKeyFile  string        `yaml:"client_key_file"`
	CAFile         string        `yaml:"ca_file"`
	PollInterval   time.Duration `yaml:"poll_interval"`
}

type SEP2Config struct {
	Enabled        bool          `yaml:"enabled"`
	BaseURL        string        `yaml:"base_url"`
	ClientCertFile string        `yaml:"client_cert_file"`
	ClientKeyFile  string        `yaml:"client_key_file"`
	CAFile         string        `yaml:"ca_file"`
	PollInterval   time.Duration `yaml:"poll_interval"`
}

// The OCPP versions this service can terminate.
const (
	OCPPVersion16  = "1.6"
	OCPPVersion201 = "2.0.1"
)

// Speaks reports whether an OCPP version is enabled.
func (o OCPPConfig) Speaks(version string) bool {
	for _, enabled := range o.Versions {
		if enabled == version {
			return true
		}
	}
	return false
}

// Load reads a YAML file, applies environment overrides and validates.
func Load(path string) (*Config, error) {
	_ = godotenv.Load()

	cfg := &Config{}
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		if err := yaml.Unmarshal(data, cfg); err != nil {
			return nil, err
		}
	}

	if v := os.Getenv("GRID_PROTOCOLS_LISTEN"); v != "" {
		cfg.Listen = v
	}
	if v := os.Getenv("PLATFORM_BASE_URL"); v != "" {
		cfg.Platform.BaseURL = v
	}
	if v := os.Getenv("GRID_PROTOCOL_SHARED_SECRET"); v != "" {
		cfg.Platform.SharedSecret = v
	}
	if v := os.Getenv("OPENADR_VTN_URL"); v != "" {
		cfg.OpenADR.VTNBaseURL = v
	}
	if v := os.Getenv("OPENADR_VEN_ID"); v != "" {
		cfg.OpenADR.VenID = v
	}
	if v := os.Getenv("OPENADR_USERNAME"); v != "" {
		cfg.OpenADR.Username = v
	}
	if v := os.Getenv("OPENADR_PASSWORD"); v != "" {
		cfg.OpenADR.Password = v
	}
	if v := os.Getenv("SEP2_BASE_URL"); v != "" {
		cfg.SEP2.BaseURL = v
	}
	if v := os.Getenv("SEP2_CLIENT_CERT_FILE"); v != "" {
		cfg.SEP2.ClientCertFile = v
	}
	if v := os.Getenv("SEP2_CLIENT_KEY_FILE"); v != "" {
		cfg.SEP2.ClientKeyFile = v
	}

	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

func (c *Config) Validate() error {
	if c.Listen == "" {
		c.Listen = ":9100"
	}
	if c.LogLevel == "" {
		c.LogLevel = "info"
	}
	if strings.TrimSpace(c.Platform.BaseURL) == "" {
		return fmt.Errorf("platform.base_url is required: protocol messages have nowhere to go without it")
	}
	if len(c.Platform.SharedSecret) < 32 {
		return fmt.Errorf("platform.shared_secret must be at least 32 characters")
	}

	if !c.OCPP.Enabled && !c.OpenADR.Enabled && !c.SEP2.Enabled {
		return fmt.Errorf("no protocol is enabled: enable at least one of ocpp, openadr, sep2")
	}

	if c.OCPP.Enabled {
		if len(c.OCPP.ChargePoints) == 0 {
			return fmt.Errorf("ocpp.charge_points is empty: every charge point needs credentials before it can connect")
		}
		for id, password := range c.OCPP.ChargePoints {
			if len(password) < 16 {
				return fmt.Errorf("ocpp.charge_points[%s]: password must be at least 16 characters", id)
			}
		}
		if c.OCPP.HeartbeatInterval <= 0 {
			c.OCPP.HeartbeatInterval = 5 * time.Minute
		}
		if c.OCPP.CallTimeout <= 0 {
			c.OCPP.CallTimeout = 30 * time.Second
		}
		if len(c.OCPP.Versions) == 0 {
			c.OCPP.Versions = []string{OCPPVersion16}
		}
		for _, version := range c.OCPP.Versions {
			if version != OCPPVersion16 && version != OCPPVersion201 {
				return fmt.Errorf("ocpp.versions: %q is not a supported OCPP version (%s, %s)", version, OCPPVersion16, OCPPVersion201)
			}
		}
	}

	if c.Control.MaxValidity <= 0 {
		c.Control.MaxValidity = time.Hour
	}
	if c.Control.MaxValidity > 24*time.Hour {
		return fmt.Errorf("control.max_validity %s exceeds 24h: a setpoint nobody refreshes for a day is not a control window", c.Control.MaxValidity)
	}
	if c.Control.SweepInterval <= 0 {
		c.Control.SweepInterval = 30 * time.Second
	}
	if c.Control.SweepInterval >= c.Control.MaxValidity {
		return fmt.Errorf("control.sweep_interval %s must be shorter than control.max_validity %s", c.Control.SweepInterval, c.Control.MaxValidity)
	}

	if c.OpenADR.Enabled {
		if strings.TrimSpace(c.OpenADR.VTNBaseURL) == "" {
			return fmt.Errorf("openadr.vtn_base_url is required when openadr is enabled")
		}
		if strings.TrimSpace(c.OpenADR.VenName) == "" {
			return fmt.Errorf("openadr.ven_name is required when openadr is enabled")
		}
		if (c.OpenADR.ClientCertFile == "") != (c.OpenADR.ClientKeyFile == "") {
			return fmt.Errorf("openadr.client_cert_file and openadr.client_key_file must be set together")
		}
		if c.OpenADR.Username == "" && c.OpenADR.ClientCertFile == "" {
			return fmt.Errorf("openadr needs either basic auth credentials or a client certificate")
		}
		if c.OpenADR.PollInterval <= 0 {
			c.OpenADR.PollInterval = time.Minute
		}
	}

	if c.SEP2.Enabled {
		if strings.TrimSpace(c.SEP2.BaseURL) == "" {
			return fmt.Errorf("sep2.base_url is required when sep2 is enabled")
		}
		if c.SEP2.ClientCertFile == "" || c.SEP2.ClientKeyFile == "" {
			return fmt.Errorf("sep2 requires a client certificate and key: IEEE 2030.5 has no other authentication")
		}
		if c.SEP2.PollInterval <= 0 {
			c.SEP2.PollInterval = 5 * time.Minute
		}
	}

	return nil
}
