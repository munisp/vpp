package config

import (
	"strings"
	"testing"
	"time"
)

const secret = "0123456789abcdef0123456789abcdef"

func baseConfig() *Config {
	return &Config{
		Platform: PlatformConfig{BaseURL: "https://vpp.example.com", SharedSecret: secret},
		OCPP: OCPPConfig{
			Enabled:      true,
			ChargePoints: map[string]string{"CP-1": "abcdefghijklmnop"},
		},
	}
}

func TestValidateAppliesDefaults(t *testing.T) {
	cfg := baseConfig()
	if err := cfg.Validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if cfg.Listen == "" || cfg.OCPP.CallTimeout <= 0 || cfg.OCPP.HeartbeatInterval <= 0 {
		t.Fatalf("defaults were not applied: %+v", cfg)
	}
}

func TestValidateRejectsIncompleteConfigurations(t *testing.T) {
	cases := map[string]func(*Config){
		"no platform url":            func(c *Config) { c.Platform.BaseURL = "" },
		"short secret":               func(c *Config) { c.Platform.SharedSecret = "short" },
		"no protocol":                func(c *Config) { c.OCPP.Enabled = false },
		"no charge points":           func(c *Config) { c.OCPP.ChargePoints = nil },
		"weak charge point password": func(c *Config) { c.OCPP.ChargePoints["CP-1"] = "1234" },
		"openadr without url": func(c *Config) {
			c.OpenADR = OpenADRConfig{Enabled: true, VenName: "vpp", Username: "u"}
		},
		"openadr without credentials": func(c *Config) {
			c.OpenADR = OpenADRConfig{Enabled: true, VTNBaseURL: "https://vtn", VenName: "vpp"}
		},
		"openadr half certificate": func(c *Config) {
			c.OpenADR = OpenADRConfig{Enabled: true, VTNBaseURL: "https://vtn", VenName: "vpp", ClientCertFile: "cert.pem"}
		},
		"sep2 without certificate": func(c *Config) {
			c.SEP2 = SEP2Config{Enabled: true, BaseURL: "https://utility/dcap"}
		},
		"sep2 without url": func(c *Config) {
			c.SEP2 = SEP2Config{Enabled: true, ClientCertFile: "c.pem", ClientKeyFile: "k.pem"}
		},
	}

	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			cfg := baseConfig()
			mutate(cfg)
			if err := cfg.Validate(); err == nil {
				t.Fatalf("expected %s to be rejected", name)
			}
		})
	}
}

func TestValidAdditionalProtocols(t *testing.T) {
	cfg := baseConfig()
	cfg.OpenADR = OpenADRConfig{
		Enabled: true, VTNBaseURL: "https://vtn.example.com/OpenADR2/Simple/2.0b",
		VenName: "vpp", Username: "user", Password: "pass",
	}
	cfg.SEP2 = SEP2Config{Enabled: true, BaseURL: "https://utility/dcap", ClientCertFile: "c.pem", ClientKeyFile: "k.pem"}

	if err := cfg.Validate(); err != nil {
		t.Fatalf("validate: %v", err)
	}
	if cfg.OpenADR.PollInterval != time.Minute || cfg.SEP2.PollInterval != 5*time.Minute {
		t.Fatalf("poll defaults were not applied: %+v", cfg)
	}
}

func TestLoadRequiresAFile(t *testing.T) {
	if _, err := Load("does-not-exist.yaml"); err == nil || !strings.Contains(err.Error(), "does-not-exist") {
		t.Fatalf("expected a missing config file to fail, got %v", err)
	}
}
