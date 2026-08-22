// Package platform is the client for the VPP server's protocol-facing API. All
// authorization, transaction and demand-response decisions are made there; this
// service only speaks the wire protocols.
package platform

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/vpp/grid-protocols/internal/ocpp16"
	"github.com/vpp/grid-protocols/internal/openadr"
	"github.com/vpp/grid-protocols/internal/sep2"
)

// Config points at the VPP server.
type Config struct {
	BaseURL string
	// SharedSecret signs request bodies (HMAC-SHA256) so the server can tell
	// this service apart from anything else that can reach it.
	SharedSecret string
	Timeout      time.Duration
}

// Client talks to the VPP server.
type Client struct {
	baseURL string
	secret  []byte
	http    *http.Client
}

func NewClient(cfg Config) (*Client, error) {
	base := strings.TrimSuffix(strings.TrimSpace(cfg.BaseURL), "/")
	if base == "" {
		return nil, errors.New("platform: base_url is required")
	}
	if len(cfg.SharedSecret) < 32 {
		return nil, errors.New("platform: shared_secret must be at least 32 characters")
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	return &Client{baseURL: base, secret: []byte(cfg.SharedSecret), http: &http.Client{Timeout: timeout}}, nil
}

func (c *Client) post(ctx context.Context, path string, payload any, out any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("platform: marshal %s payload: %w", path, err)
	}

	timestamp := strconv.FormatInt(time.Now().UTC().Unix(), 10)
	mac := hmac.New(sha256.New, c.secret)
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write(body)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-grid-timestamp", timestamp)
	req.Header.Set("x-grid-signature", hex.EncodeToString(mac.Sum(nil)))

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("platform: POST %s failed: %w", path, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("platform: reading %s response: %w", path, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("platform: POST %s returned HTTP %d: %s", path, resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("platform: %s response is not JSON: %w", path, err)
	}
	return nil
}

type chargePointEnvelope[T any] struct {
	ChargePointID string `json:"charge_point_id"`
	Payload       T      `json:"payload"`
}

func (c *Client) BootNotification(ctx context.Context, chargePointID string, req ocpp16.BootNotificationRequest) (ocpp16.BootNotificationResponse, error) {
	var resp ocpp16.BootNotificationResponse
	err := c.post(ctx, "/api/grid/ocpp/boot-notification",
		chargePointEnvelope[ocpp16.BootNotificationRequest]{chargePointID, req}, &resp)
	if err != nil {
		return ocpp16.BootNotificationResponse{}, err
	}
	if resp.Status == "" {
		return ocpp16.BootNotificationResponse{}, errors.New("platform: boot notification response has no registration status")
	}
	return resp, nil
}

func (c *Client) Heartbeat(ctx context.Context, chargePointID string) error {
	return c.post(ctx, "/api/grid/ocpp/heartbeat", map[string]string{"charge_point_id": chargePointID}, nil)
}

func (c *Client) StatusNotification(ctx context.Context, chargePointID string, req ocpp16.StatusNotificationRequest) error {
	return c.post(ctx, "/api/grid/ocpp/status-notification",
		chargePointEnvelope[ocpp16.StatusNotificationRequest]{chargePointID, req}, nil)
}

func (c *Client) MeterValues(ctx context.Context, chargePointID string, req ocpp16.MeterValuesRequest) error {
	return c.post(ctx, "/api/grid/ocpp/meter-values",
		chargePointEnvelope[ocpp16.MeterValuesRequest]{chargePointID, req}, nil)
}

func (c *Client) Authorize(ctx context.Context, chargePointID string, req ocpp16.AuthorizeRequest) (ocpp16.AuthorizeResponse, error) {
	var resp ocpp16.AuthorizeResponse
	err := c.post(ctx, "/api/grid/ocpp/authorize",
		chargePointEnvelope[ocpp16.AuthorizeRequest]{chargePointID, req}, &resp)
	if err != nil {
		return ocpp16.AuthorizeResponse{}, err
	}
	if resp.IdTagInfo.Status == "" {
		return ocpp16.AuthorizeResponse{}, errors.New("platform: authorize response has no status")
	}
	return resp, nil
}

func (c *Client) StartTransaction(ctx context.Context, chargePointID string, req ocpp16.StartTransactionRequest) (ocpp16.StartTransactionResponse, error) {
	var resp ocpp16.StartTransactionResponse
	err := c.post(ctx, "/api/grid/ocpp/start-transaction",
		chargePointEnvelope[ocpp16.StartTransactionRequest]{chargePointID, req}, &resp)
	if err != nil {
		return ocpp16.StartTransactionResponse{}, err
	}
	return resp, nil
}

func (c *Client) StopTransaction(ctx context.Context, chargePointID string, req ocpp16.StopTransactionRequest) (ocpp16.StopTransactionResponse, error) {
	var resp ocpp16.StopTransactionResponse
	err := c.post(ctx, "/api/grid/ocpp/stop-transaction",
		chargePointEnvelope[ocpp16.StopTransactionRequest]{chargePointID, req}, &resp)
	if err != nil {
		return ocpp16.StopTransactionResponse{}, err
	}
	return resp, nil
}

type openADRDecision struct {
	OptType string `json:"optType"`
	Reason  string `json:"reason"`
}

// Durations cross the wire as whole seconds rather than Go's nanosecond
// encoding of time.Duration, which the server would have to guess at.
type openADRInterval struct {
	Start           string  `json:"start"`
	DurationSeconds int     `json:"durationSeconds"`
	Value           float64 `json:"value"`
}

type openADRSignal struct {
	Name      string            `json:"name"`
	Type      string            `json:"type"`
	Intervals []openADRInterval `json:"intervals"`
}

type openADREvent struct {
	EventID            string          `json:"eventId"`
	ModificationNumber int             `json:"modificationNumber"`
	MarketContext      string          `json:"marketContext"`
	Status             string          `json:"status"`
	Priority           int             `json:"priority"`
	TestEvent          bool            `json:"testEvent"`
	Start              string          `json:"start"`
	DurationSeconds    int             `json:"durationSeconds"`
	Signals            []openADRSignal `json:"signals"`
}

type sep2Control struct {
	MRID            string   `json:"mrid"`
	ProgramMRID     string   `json:"programMrid"`
	Status          int      `json:"status"`
	Primacy         int      `json:"primacy"`
	Start           string   `json:"start"`
	DurationSeconds int      `json:"durationSeconds"`
	TargetWatts     *float64 `json:"targetWatts,omitempty"`
	MaxLimitPercent *float64 `json:"maxLimitPercent,omitempty"`
	FixedPercent    *float64 `json:"fixedPercent,omitempty"`
}

// HandleEvent forwards an OpenADR event and returns the platform's opt
// decision. A transport failure opts out: the VEN must not claim participation
// the platform never accepted.
func (c *Client) HandleEvent(ctx context.Context, instruction openadr.Instruction) (string, error) {
	event := openADREvent{
		EventID:            instruction.EventID,
		ModificationNumber: instruction.ModificationNumber,
		MarketContext:      instruction.MarketContext,
		Status:             instruction.Status,
		Priority:           instruction.Priority,
		TestEvent:          instruction.TestEvent,
		Start:              instruction.Start.UTC().Format(time.RFC3339),
		DurationSeconds:    int(instruction.Duration / time.Second),
		Signals:            make([]openADRSignal, 0, len(instruction.Signals)),
	}
	for _, signal := range instruction.Signals {
		converted := openADRSignal{
			Name:      signal.SignalName,
			Type:      signal.SignalType,
			Intervals: make([]openADRInterval, 0, len(signal.Intervals)),
		}
		for _, interval := range signal.Intervals {
			converted.Intervals = append(converted.Intervals, openADRInterval{
				Start:           interval.Start.UTC().Format(time.RFC3339),
				DurationSeconds: int(interval.Duration / time.Second),
				Value:           interval.Value,
			})
		}
		event.Signals = append(event.Signals, converted)
	}

	var decision openADRDecision
	if err := c.post(ctx, "/api/grid/openadr/event", event, &decision); err != nil {
		return openadr.OptOut, err
	}
	switch decision.OptType {
	case openadr.OptIn:
		return openadr.OptIn, nil
	case openadr.OptOut:
		return openadr.OptOut, nil
	default:
		return openadr.OptOut, fmt.Errorf("platform: unknown opt decision %q", decision.OptType)
	}
}

// DERControls forwards IEEE 2030.5 controls to the platform.
func (c *Client) DERControls(ctx context.Context, instructions []sep2.Instruction) error {
	controls := make([]sep2Control, 0, len(instructions))
	for _, instruction := range instructions {
		controls = append(controls, sep2Control{
			MRID:            instruction.MRID,
			ProgramMRID:     instruction.ProgramMRID,
			Status:          instruction.Status,
			Primacy:         instruction.Primacy,
			Start:           instruction.Start.UTC().Format(time.RFC3339),
			DurationSeconds: int(instruction.Duration / time.Second),
			TargetWatts:     instruction.TargetWatts,
			MaxLimitPercent: instruction.MaxLimitPercent,
			FixedPercent:    instruction.FixedPercent,
		})
	}
	return c.post(ctx, "/api/grid/sep2/controls", map[string]any{"controls": controls}, nil)
}
