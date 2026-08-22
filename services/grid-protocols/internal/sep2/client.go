package sep2

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/sirupsen/logrus"
)

// Config describes the 2030.5 server and this client's certificate.
type Config struct {
	// BaseURL is the server root, e.g. https://utility.example.com/dcap
	BaseURL string
	// IEEE 2030.5 mandates TLS with client certificates; there is no password
	// authentication in the standard, so these are required.
	ClientCertFile string
	ClientKeyFile  string
	CAFile         string
	RequestTimeout time.Duration
	Logger         *logrus.Logger
}

// Client is an IEEE 2030.5 client.
type Client struct {
	baseURL *url.URL
	http    *http.Client
	logger  *logrus.Logger
	lfdi    string
}

// NewClient builds a client. Missing certificates are refused rather than
// downgraded to plain TLS: an unauthenticated 2030.5 session cannot receive
// DER controls, and pretending otherwise would hide the misconfiguration.
func NewClient(cfg Config) (*Client, error) {
	if strings.TrimSpace(cfg.BaseURL) == "" {
		return nil, errors.New("sep2: base_url is required")
	}
	parsed, err := url.Parse(cfg.BaseURL)
	if err != nil {
		return nil, fmt.Errorf("sep2: base_url is not a URL: %w", err)
	}
	if parsed.Scheme != "https" {
		return nil, fmt.Errorf("sep2: base_url must be https (got %q)", parsed.Scheme)
	}
	if cfg.ClientCertFile == "" || cfg.ClientKeyFile == "" {
		return nil, errors.New("sep2: client_cert_file and client_key_file are required; 2030.5 has no other authentication")
	}
	if cfg.RequestTimeout <= 0 {
		cfg.RequestTimeout = 30 * time.Second
	}
	if cfg.Logger == nil {
		cfg.Logger = logrus.StandardLogger()
	}

	cert, err := tls.LoadX509KeyPair(cfg.ClientCertFile, cfg.ClientKeyFile)
	if err != nil {
		return nil, fmt.Errorf("sep2: load client certificate: %w", err)
	}
	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
	}
	if cfg.CAFile != "" {
		pem, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, fmt.Errorf("sep2: read ca file: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("sep2: ca file %s contains no certificates", cfg.CAFile)
		}
		tlsConfig.RootCAs = pool
	}

	lfdi, err := LFDIFromCertificate(cert)
	if err != nil {
		return nil, err
	}

	return &Client{
		baseURL: parsed,
		http: &http.Client{
			Timeout:   cfg.RequestTimeout,
			Transport: &http.Transport{TLSClientConfig: tlsConfig},
		},
		logger: cfg.Logger,
		lfdi:   lfdi,
	}, nil
}

// LFDI is this client's Long Form Device Identifier, derived from its
// certificate exactly as IEEE 2030.5 section 8.3.2 specifies: the first 160
// bits of the SHA-256 hash of the DER-encoded certificate.
func (c *Client) LFDI() string { return c.lfdi }

// LFDIFromCertificate computes the LFDI of a loaded certificate.
func LFDIFromCertificate(cert tls.Certificate) (string, error) {
	if len(cert.Certificate) == 0 {
		return "", errors.New("sep2: certificate chain is empty")
	}
	sum := sha256.Sum256(cert.Certificate[0])
	return strings.ToUpper(hex.EncodeToString(sum[:20])), nil
}

// DeviceCapability fetches the /dcap resource, the entry point for discovery.
func (c *Client) DeviceCapability(ctx context.Context) (*DeviceCapability, error) {
	var dcap DeviceCapability
	if err := c.get(ctx, c.baseURL.Path, &dcap); err != nil {
		return nil, err
	}
	return &dcap, nil
}

// EndDevices lists the end devices this client is allowed to see.
func (c *Client) EndDevices(ctx context.Context, dcap *DeviceCapability) ([]EndDevice, error) {
	if dcap.EndDeviceListLink == nil || dcap.EndDeviceListLink.Href == "" {
		return nil, errors.New("sep2: DeviceCapability has no EndDeviceListLink")
	}
	var list EndDeviceList
	if err := c.get(ctx, dcap.EndDeviceListLink.Href, &list); err != nil {
		return nil, err
	}
	return list.EndDevices, nil
}

// ActiveControls returns every DER control the server currently publishes,
// normalised and ordered by program primacy (lower primacy wins in 2030.5).
// Controls that cannot be interpreted are returned as errors alongside the
// usable ones, so the caller can log them instead of applying a guess.
func (c *Client) ActiveControls(ctx context.Context, dcap *DeviceCapability) ([]Instruction, []error, error) {
	if dcap.DERProgramListLink == nil || dcap.DERProgramListLink.Href == "" {
		return nil, nil, errors.New("sep2: DeviceCapability has no DERProgramListLink")
	}
	var programs DERProgramList
	if err := c.get(ctx, dcap.DERProgramListLink.Href, &programs); err != nil {
		return nil, nil, err
	}

	instructions := make([]Instruction, 0)
	var problems []error

	for _, program := range programs.Programs {
		if program.DERControlListLink == nil || program.DERControlListLink.Href == "" {
			continue
		}
		var controls DERControlList
		if err := c.get(ctx, program.DERControlListLink.Href, &controls); err != nil {
			return nil, problems, fmt.Errorf("sep2: reading controls of program %s: %w", program.MRID, err)
		}
		for _, control := range controls.Controls {
			instruction, err := toInstruction(program, control)
			if err != nil {
				problems = append(problems, err)
				continue
			}
			instructions = append(instructions, instruction)
		}
	}

	sortByPrimacyThenStart(instructions)
	return instructions, problems, nil
}

func sortByPrimacyThenStart(instructions []Instruction) {
	for i := 1; i < len(instructions); i++ {
		for j := i; j > 0; j-- {
			a, b := instructions[j-1], instructions[j]
			if a.Primacy < b.Primacy || (a.Primacy == b.Primacy && !a.Start.After(b.Start)) {
				break
			}
			instructions[j-1], instructions[j] = b, a
		}
	}
}

// PostMirrorReading mirrors a meter reading to a MirrorUsagePoint. The server's
// 201/204 response is the only evidence the reading was accepted; anything else
// is an error so telemetry gaps stay visible.
func (c *Client) PostMirrorReading(ctx context.Context, mirrorUsagePointHref string, reading MirrorMeterReading) error {
	if mirrorUsagePointHref == "" {
		return errors.New("sep2: mirror usage point href is required")
	}
	body, err := xml.Marshal(reading)
	if err != nil {
		return fmt.Errorf("sep2: marshal MirrorMeterReading: %w", err)
	}
	target, err := c.resolve(mirrorUsagePointHref)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(append([]byte(xml.Header), body...)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/sep+xml")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("sep2: POST %s failed: %w", target, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))

	switch resp.StatusCode {
	case http.StatusCreated, http.StatusNoContent, http.StatusOK:
		return nil
	default:
		return fmt.Errorf("sep2: POST %s returned HTTP %d: %s", target, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
}

func (c *Client) resolve(href string) (string, error) {
	ref, err := url.Parse(href)
	if err != nil {
		return "", fmt.Errorf("sep2: href %q is not a URL: %w", href, err)
	}
	resolved := c.baseURL.ResolveReference(ref)
	if resolved.Host != c.baseURL.Host {
		// Following an href to another host would send this client's
		// certificate somewhere the operator never configured.
		return "", fmt.Errorf("sep2: refusing to follow href %q to host %s", href, resolved.Host)
	}
	return resolved.String(), nil
}

func (c *Client) get(ctx context.Context, href string, target any) error {
	url, err := c.resolve(href)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/sep+xml")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("sep2: GET %s failed: %w", url, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return fmt.Errorf("sep2: reading %s: %w", url, err)
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("sep2: GET %s returned HTTP %d: %s", url, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if err := xml.Unmarshal(raw, target); err != nil {
		return fmt.Errorf("sep2: %s returned an unparsable body: %w", url, err)
	}
	return nil
}
