package admin

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/vpp/grid-protocols/internal/control"
	"github.com/vpp/grid-protocols/internal/ocpp16"
	"github.com/vpp/grid-protocols/internal/ocppmux"
)

const testSecret = "0123456789abcdef0123456789abcdef"

type nopBackend struct{}

func (nopBackend) BootNotification(context.Context, string, ocpp16.BootNotificationRequest) (ocpp16.BootNotificationResponse, error) {
	return ocpp16.BootNotificationResponse{Status: ocpp16.RegistrationAccepted}, nil
}
func (nopBackend) Heartbeat(context.Context, string) error { return nil }
func (nopBackend) StatusNotification(context.Context, string, ocpp16.StatusNotificationRequest) error {
	return nil
}
func (nopBackend) MeterValues(context.Context, string, ocpp16.MeterValuesRequest) error { return nil }
func (nopBackend) Authorize(context.Context, string, ocpp16.AuthorizeRequest) (ocpp16.AuthorizeResponse, error) {
	return ocpp16.AuthorizeResponse{IdTagInfo: ocpp16.IdTagInfo{Status: ocpp16.AuthAccepted}}, nil
}
func (nopBackend) StartTransaction(context.Context, string, ocpp16.StartTransactionRequest) (ocpp16.StartTransactionResponse, error) {
	return ocpp16.StartTransactionResponse{TransactionID: 1, IdTagInfo: ocpp16.IdTagInfo{Status: ocpp16.AuthAccepted}}, nil
}
func (nopBackend) StopTransaction(context.Context, string, ocpp16.StopTransactionRequest) (ocpp16.StopTransactionResponse, error) {
	return ocpp16.StopTransactionResponse{}, nil
}

func newAPI(t *testing.T) *httptest.Server {
	t.Helper()
	central, err := ocpp16.NewCentralSystem(nopBackend{}, ocpp16.Options{
		Authenticate: func(*http.Request, string) error { return nil },
	})
	if err != nil {
		t.Fatalf("central system: %v", err)
	}
	commander, err := ocppmux.New(central, nil, nil)
	if err != nil {
		t.Fatalf("mux: %v", err)
	}
	supervisor, err := control.New(commander, control.Options{})
	if err != nil {
		t.Fatalf("supervisor: %v", err)
	}
	api, err := New(commander, testSecret, supervisor)
	if err != nil {
		t.Fatalf("api: %v", err)
	}
	mux := http.NewServeMux()
	api.Routes(mux)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

func signedRequest(t *testing.T, method, url string, body []byte, timestamp int64) *http.Request {
	t.Helper()
	stamp := strconv.FormatInt(timestamp, 10)
	mac := hmac.New(sha256.New, []byte(testSecret))
	mac.Write([]byte(stamp))
	mac.Write([]byte("."))
	mac.Write(body)

	req, err := http.NewRequest(method, url, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	req.Header.Set("x-grid-timestamp", stamp)
	req.Header.Set("x-grid-signature", hex.EncodeToString(mac.Sum(nil)))
	return req
}

func do(t *testing.T, req *http.Request) *http.Response {
	t.Helper()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

func TestUnsignedCommandsAreRejected(t *testing.T) {
	server := newAPI(t)
	resp, err := http.Post(server.URL+"/admin/remote-start", "application/json",
		bytes.NewReader([]byte(`{"charge_point_id":"CP-1","request":{"idTag":"TAG"}}`)))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

func TestTamperedBodyIsRejected(t *testing.T) {
	server := newAPI(t)
	body := []byte(`{"charge_point_id":"CP-1","request":{"idTag":"TAG"}}`)
	req := signedRequest(t, http.MethodPost, server.URL+"/admin/remote-start", body, time.Now().Unix())
	req.Body = http.NoBody
	tampered := []byte(`{"charge_point_id":"CP-2","request":{"idTag":"TAG"}}`)
	req = mutateBody(t, req, tampered)

	if resp := do(t, req); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for a tampered body, got %d", resp.StatusCode)
	}
}

func mutateBody(t *testing.T, req *http.Request, body []byte) *http.Request {
	t.Helper()
	replacement, err := http.NewRequest(req.Method, req.URL.String(), bytes.NewReader(body))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	replacement.Header = req.Header.Clone()
	return replacement
}

func TestStaleSignatureIsRejected(t *testing.T) {
	server := newAPI(t)
	body := []byte(`{"charge_point_id":"CP-1","request":{"idTag":"TAG"}}`)
	req := signedRequest(t, http.MethodPost, server.URL+"/admin/remote-start", body,
		time.Now().Add(-time.Hour).Unix())
	if resp := do(t, req); resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for a replayed signature, got %d", resp.StatusCode)
	}
}

// A command for a charge point with no session must fail loudly: the caller
// records dispatch only when the hardware actually received it.
func TestCommandForOfflineChargePointIsUnavailable(t *testing.T) {
	server := newAPI(t)
	body := []byte(`{"charge_point_id":"CP-OFFLINE","request":{"idTag":"TAG"}}`)
	req := signedRequest(t, http.MethodPost, server.URL+"/admin/remote-start", body, time.Now().Unix())
	if resp := do(t, req); resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d", resp.StatusCode)
	}
}

func profileBody(validFrom, validTo string, stackLevel int, purpose string, fallback bool) string {
	profile := map[string]any{
		"chargingProfileId":      7,
		"stackLevel":             stackLevel,
		"chargingProfilePurpose": purpose,
		"chargingProfileKind":    "Relative",
		"chargingSchedule": map[string]any{
			"chargingRateUnit":       "W",
			"chargingSchedulePeriod": []map[string]any{{"startPeriod": 0, "limit": 3600}},
		},
	}
	if validFrom != "" {
		profile["validFrom"] = validFrom
	}
	if validTo != "" {
		profile["validTo"] = validTo
	}
	body, err := json.Marshal(map[string]any{
		"charge_point_id": "CP-1",
		"fallback":        fallback,
		"request":         map[string]any{"connectorId": 1, "csChargingProfiles": profile},
	})
	if err != nil {
		panic(err)
	}
	return string(body)
}

func TestValidationErrors(t *testing.T) {
	server := newAPI(t)
	cases := map[string]struct {
		path string
		body string
	}{
		"missing charge point": {"/admin/remote-start", `{"request":{"idTag":"TAG"}}`},
		"missing id tag":       {"/admin/remote-start", `{"charge_point_id":"CP-1","request":{}}`},
		"missing transaction":  {"/admin/remote-stop", `{"charge_point_id":"CP-1","request":{}}`},
		"empty schedule": {"/admin/charging-profile",
			`{"charge_point_id":"CP-1","request":{"connectorId":1,"csChargingProfiles":{"chargingSchedule":{"chargingRateUnit":"W","chargingSchedulePeriod":[]}}}}`},
		// A profile with no validTo would keep running on the charge point after the
		// platform is gone, so it never reaches the hardware.
		"unbounded profile": {"/admin/charging-profile", profileBody("", "", 1, "TxDefaultProfile", false)},
		"expired window": {"/admin/charging-profile",
			profileBody("", time.Now().Add(-time.Minute).UTC().Format(time.RFC3339), 1, "TxDefaultProfile", false)},
		"inverted window": {"/admin/charging-profile",
			profileBody(time.Now().Add(30*time.Minute).UTC().Format(time.RFC3339),
				time.Now().Add(10*time.Minute).UTC().Format(time.RFC3339), 1, "TxDefaultProfile", false)},
		"window beyond the maximum": {"/admin/charging-profile",
			profileBody("", time.Now().Add(6*time.Hour).UTC().Format(time.RFC3339), 1, "TxDefaultProfile", false)},
		// The standing fallback must not outrank a bounded profile.
		"fallback above stack level 0": {"/admin/charging-profile",
			profileBody("", "", 3, "TxDefaultProfile", true)},
		"fallback that expires": {"/admin/charging-profile",
			profileBody("", time.Now().Add(10*time.Minute).UTC().Format(time.RFC3339), 0, "TxDefaultProfile", true)},
		"fallback as a transaction profile": {"/admin/charging-profile",
			profileBody("", "", 0, "TxProfile", true)},
		// An unfiltered clear would wipe every profile including the fallback.
		"clear with no selector": {"/admin/clear-charging-profile",
			`{"charge_point_id":"CP-1","request":{}}`},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			req := signedRequest(t, http.MethodPost, server.URL+tc.path, []byte(tc.body), time.Now().Unix())
			if resp := do(t, req); resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d", resp.StatusCode)
			}
		})
	}
}

func TestNewRequiresSecretAndCentralSystem(t *testing.T) {
	if _, err := New(nil, testSecret, nil); err == nil {
		t.Fatal("expected a missing central system to be rejected")
	}
	central, err := ocpp16.NewCentralSystem(nopBackend{}, ocpp16.Options{
		Authenticate: func(*http.Request, string) error { return nil },
	})
	if err != nil {
		t.Fatalf("central system: %v", err)
	}
	commander, err := ocppmux.New(central, nil, nil)
	if err != nil {
		t.Fatalf("mux: %v", err)
	}
	supervisor, err := control.New(commander, control.Options{})
	if err != nil {
		t.Fatalf("supervisor: %v", err)
	}
	if _, err := New(commander, "short", supervisor); err == nil {
		t.Fatal("expected a short shared secret to be rejected")
	}
	// Without a supervisor nothing would ever close an expired control window.
	if _, err := New(commander, testSecret, nil); err == nil {
		t.Fatal("expected a missing control supervisor to be rejected")
	}
}
