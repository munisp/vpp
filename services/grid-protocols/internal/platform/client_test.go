package platform

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/vpp/grid-protocols/internal/openadr"
	"github.com/vpp/grid-protocols/internal/sep2"
)

const testSecret = "0123456789abcdef0123456789abcdef"

func TestNewClientRequiresBaseURLAndStrongSecret(t *testing.T) {
	if _, err := NewClient(Config{SharedSecret: testSecret}); err == nil {
		t.Fatal("expected an error without a base URL")
	}
	if _, err := NewClient(Config{BaseURL: "https://vpp.example.com", SharedSecret: "short"}); err == nil {
		t.Fatal("expected an error for a weak shared secret")
	}
}

// The server must be able to verify the signature over the exact bytes it
// received, so the client signs the marshalled body and nothing else.
func TestRequestsAreSignedOverTheBody(t *testing.T) {
	var verified bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("reading body: %v", err)
		}
		timestamp := r.Header.Get("x-grid-timestamp")
		seconds, err := strconv.ParseInt(timestamp, 10, 64)
		if err != nil {
			t.Fatalf("timestamp %q is not a unix time", timestamp)
		}
		if age := time.Since(time.Unix(seconds, 0)); age > time.Minute || age < -time.Minute {
			t.Fatalf("timestamp is %s old", age)
		}
		mac := hmac.New(sha256.New, []byte(testSecret))
		mac.Write([]byte(timestamp))
		mac.Write([]byte("."))
		mac.Write(body)
		if got, want := r.Header.Get("x-grid-signature"), hex.EncodeToString(mac.Sum(nil)); got != want {
			t.Fatalf("signature mismatch: got %s want %s", got, want)
		}
		verified = true
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	client, err := NewClient(Config{BaseURL: server.URL, SharedSecret: testSecret})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	if err := client.Heartbeat(context.Background(), "CP-1"); err != nil {
		t.Fatalf("Heartbeat: %v", err)
	}
	if !verified {
		t.Fatal("the server never verified a signature")
	}
}

func TestHandleEventSendsSecondsAndReturnsThePlatformDecision(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatalf("decoding event: %v", err)
		}
		_, _ = w.Write([]byte(`{"optType":"optIn","reason":"12 participants"}`))
	}))
	defer server.Close()

	client, err := NewClient(Config{BaseURL: server.URL, SharedSecret: testSecret})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	start := time.Date(2026, 8, 22, 17, 0, 0, 0, time.UTC)
	opt, err := client.HandleEvent(context.Background(), openadr.Instruction{
		EventID:  "evt-1",
		Status:   openadr.StatusActive,
		Start:    start,
		Duration: 90 * time.Minute,
		Signals: []openadr.Signal{{
			SignalName: "SIMPLE",
			SignalType: "level",
			Intervals: []openadr.SignalInterval{{
				Start:    start,
				Duration: 30 * time.Minute,
				Value:    2,
			}},
		}},
	})
	if err != nil {
		t.Fatalf("HandleEvent: %v", err)
	}
	if opt != openadr.OptIn {
		t.Fatalf("expected optIn, got %s", opt)
	}
	if got := received["durationSeconds"]; got != float64(5400) {
		t.Fatalf("durationSeconds = %v, want 5400", got)
	}
	signals, ok := received["signals"].([]any)
	if !ok || len(signals) != 1 {
		t.Fatalf("expected one signal, got %v", received["signals"])
	}
	signal := signals[0].(map[string]any)
	interval := signal["intervals"].([]any)[0].(map[string]any)
	if got := interval["durationSeconds"]; got != float64(1800) {
		t.Fatalf("interval durationSeconds = %v, want 1800", got)
	}
}

// An unrecognised decision must not be read as participation.
func TestHandleEventRejectsUnknownDecisions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"optType":"maybe"}`))
	}))
	defer server.Close()

	client, err := NewClient(Config{BaseURL: server.URL, SharedSecret: testSecret})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	opt, err := client.HandleEvent(context.Background(), openadr.Instruction{EventID: "evt-2"})
	if err == nil {
		t.Fatal("expected an error for an unknown decision")
	}
	if opt != openadr.OptOut {
		t.Fatalf("expected optOut on error, got %s", opt)
	}
}

func TestHandleEventOptsOutWhenThePlatformIsUnreachable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	client, err := NewClient(Config{BaseURL: server.URL, SharedSecret: testSecret})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	opt, err := client.HandleEvent(context.Background(), openadr.Instruction{EventID: "evt-3"})
	if err == nil {
		t.Fatal("expected an error when the platform returns HTTP 500")
	}
	if opt != openadr.OptOut {
		t.Fatalf("expected optOut, got %s", opt)
	}
}

func TestDERControlsSendExplicitSecondsAndSetpoints(t *testing.T) {
	var received struct {
		Controls []struct {
			MRID            string   `json:"mrid"`
			DurationSeconds int      `json:"durationSeconds"`
			TargetWatts     *float64 `json:"targetWatts"`
			Start           string   `json:"start"`
		} `json:"controls"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatalf("decoding controls: %v", err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client, err := NewClient(Config{BaseURL: server.URL, SharedSecret: testSecret})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}

	target := -4200.0
	start := time.Date(2026, 8, 22, 18, 30, 0, 0, time.UTC)
	if err := client.DERControls(context.Background(), []sep2.Instruction{{
		MRID:        "ctl-1",
		ProgramMRID: "prg-1",
		Start:       start,
		Duration:    15 * time.Minute,
		TargetWatts: &target,
	}}); err != nil {
		t.Fatalf("DERControls: %v", err)
	}
	if len(received.Controls) != 1 {
		t.Fatalf("expected one control, got %d", len(received.Controls))
	}
	control := received.Controls[0]
	if control.DurationSeconds != 900 {
		t.Fatalf("durationSeconds = %d, want 900", control.DurationSeconds)
	}
	if control.TargetWatts == nil || *control.TargetWatts != target {
		t.Fatalf("targetWatts = %v, want %v (a charge setpoint must stay negative)", control.TargetWatts, target)
	}
	if control.Start != "2026-08-22T18:30:00Z" {
		t.Fatalf("start = %s", control.Start)
	}
}
