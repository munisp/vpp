package ocpp16

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type stubBackend struct {
	authorizeErr    error
	authorizeStatus string
	transactionID   int
	startErr        error
	meterValues     []MeterValuesRequest
	heartbeats      int
}

func (s *stubBackend) BootNotification(ctx context.Context, id string, req BootNotificationRequest) (BootNotificationResponse, error) {
	return BootNotificationResponse{Status: RegistrationAccepted}, nil
}

func (s *stubBackend) Heartbeat(ctx context.Context, id string) error {
	s.heartbeats++
	return nil
}

func (s *stubBackend) StatusNotification(ctx context.Context, id string, req StatusNotificationRequest) error {
	return nil
}

func (s *stubBackend) MeterValues(ctx context.Context, id string, req MeterValuesRequest) error {
	s.meterValues = append(s.meterValues, req)
	return nil
}

func (s *stubBackend) Authorize(ctx context.Context, id string, req AuthorizeRequest) (AuthorizeResponse, error) {
	if s.authorizeErr != nil {
		return AuthorizeResponse{}, s.authorizeErr
	}
	return AuthorizeResponse{IdTagInfo: IdTagInfo{Status: s.authorizeStatus}}, nil
}

func (s *stubBackend) StartTransaction(ctx context.Context, id string, req StartTransactionRequest) (StartTransactionResponse, error) {
	if s.startErr != nil {
		return StartTransactionResponse{}, s.startErr
	}
	return StartTransactionResponse{
		TransactionID: s.transactionID,
		IdTagInfo:     IdTagInfo{Status: AuthAccepted},
	}, nil
}

func (s *stubBackend) StopTransaction(ctx context.Context, id string, req StopTransactionRequest) (StopTransactionResponse, error) {
	return StopTransactionResponse{IdTagInfo: &IdTagInfo{Status: AuthAccepted}}, nil
}

func newTestSystem(t *testing.T, backend Backend) (*CentralSystem, *httptest.Server) {
	t.Helper()
	cs, err := NewCentralSystem(backend, Options{
		Authenticate: func(r *http.Request, chargePointID string) error {
			if chargePointID != "CP-1" {
				return errors.New("unknown charge point")
			}
			return nil
		},
		CallTimeout: 2 * time.Second,
	})
	if err != nil {
		t.Fatalf("new central system: %v", err)
	}
	server := httptest.NewServer(cs)
	t.Cleanup(server.Close)
	return cs, server
}

func dial(t *testing.T, server *httptest.Server, chargePointID string) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/ocpp/" + chargePointID
	dialer := websocket.Dialer{Subprotocols: []string{"ocpp1.6"}}
	conn, resp, err := dialer.Dial(url, nil)
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		t.Fatalf("dial %s: %v (http %d)", url, err, status)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func sendCall(t *testing.T, conn *websocket.Conn, uniqueID, action string, payload any) *Frame {
	t.Helper()
	data, err := EncodeCall(uniqueID, action, payload)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, raw, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	frame, err := DecodeFrame(raw)
	if err != nil {
		t.Fatalf("decode response %s: %v", raw, err)
	}
	return frame
}

func TestRequiresSubprotocolAndAuth(t *testing.T) {
	_, server := newTestSystem(t, &stubBackend{})

	dialer := websocket.Dialer{}
	if _, resp, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ocpp/CP-1", nil); err == nil {
		t.Fatal("expected connection without ocpp1.6 subprotocol to be rejected")
	} else if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}

	authDialer := websocket.Dialer{Subprotocols: []string{"ocpp1.6"}}
	if _, resp, err := authDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ocpp/CP-UNKNOWN", nil); err == nil {
		t.Fatal("expected unknown charge point to be rejected")
	} else if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

func TestBootHeartbeatAndMeterValues(t *testing.T) {
	backend := &stubBackend{authorizeStatus: AuthAccepted, transactionID: 991}
	_, server := newTestSystem(t, backend)
	conn := dial(t, server, "CP-1")

	frame := sendCall(t, conn, "1", ActionBootNotification, BootNotificationRequest{
		ChargePointVendor: "vendor", ChargePointModel: "model",
	})
	if frame.Result == nil {
		t.Fatalf("expected result, got %+v", frame)
	}
	var boot BootNotificationResponse
	if err := json.Unmarshal(frame.Result.Payload, &boot); err != nil {
		t.Fatalf("unmarshal boot: %v", err)
	}
	if boot.Status != RegistrationAccepted || boot.CurrentTime == "" || boot.Interval == 0 {
		t.Fatalf("unexpected boot response %+v", boot)
	}

	if frame = sendCall(t, conn, "2", ActionHeartbeat, struct{}{}); frame.Result == nil {
		t.Fatalf("heartbeat failed: %+v", frame)
	}
	if backend.heartbeats != 1 {
		t.Fatalf("expected 1 heartbeat, got %d", backend.heartbeats)
	}

	frame = sendCall(t, conn, "3", ActionMeterValues, MeterValuesRequest{
		ConnectorID: 1,
		MeterValue: []MeterValue{{
			Timestamp:    time.Now().UTC().Format(time.RFC3339),
			SampledValue: []SampledValue{{Value: "1234", Measurand: "Energy.Active.Import.Register", Unit: "Wh"}},
		}},
	})
	if frame.Result == nil {
		t.Fatalf("meter values failed: %+v", frame)
	}
	if len(backend.meterValues) != 1 || len(backend.meterValues[0].MeterValue) != 1 {
		t.Fatalf("backend did not receive the meter values: %+v", backend.meterValues)
	}
}

func TestBootNotificationRequiresVendorAndModel(t *testing.T) {
	_, server := newTestSystem(t, &stubBackend{})
	conn := dial(t, server, "CP-1")

	frame := sendCall(t, conn, "1", ActionBootNotification, BootNotificationRequest{})
	if frame.Error == nil {
		t.Fatalf("expected CALLERROR, got %+v", frame)
	}
	if frame.Error.ErrorCode != ErrPropertyConstraintViolation {
		t.Fatalf("unexpected error code %q", frame.Error.ErrorCode)
	}
}

// A platform lookup failure must not become an "Accepted" authorization: that
// would let a charger deliver energy nobody agreed to pay for.
func TestAuthorizeFailsClosedWhenPlatformUnavailable(t *testing.T) {
	backend := &stubBackend{authorizeErr: errors.New("platform unreachable")}
	_, server := newTestSystem(t, backend)
	conn := dial(t, server, "CP-1")

	frame := sendCall(t, conn, "1", ActionAuthorize, AuthorizeRequest{IdTag: "TAG"})
	if frame.Error == nil {
		t.Fatalf("expected CALLERROR, got %+v", frame)
	}
	if !strings.Contains(frame.Error.ErrorDescription, "platform unreachable") {
		t.Fatalf("error should name the cause, got %q", frame.Error.ErrorDescription)
	}
}

func TestAuthorizeReturnsPlatformDecision(t *testing.T) {
	backend := &stubBackend{authorizeStatus: AuthBlocked}
	_, server := newTestSystem(t, backend)
	conn := dial(t, server, "CP-1")

	frame := sendCall(t, conn, "1", ActionAuthorize, AuthorizeRequest{IdTag: "TAG"})
	if frame.Result == nil {
		t.Fatalf("expected result, got %+v", frame)
	}
	var resp AuthorizeResponse
	if err := json.Unmarshal(frame.Result.Payload, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.IdTagInfo.Status != AuthBlocked {
		t.Fatalf("expected the platform's Blocked decision, got %q", resp.IdTagInfo.Status)
	}
}

// Transaction identity belongs to the platform; a locally invented id would
// detach the charging session from its billing record.
func TestStartTransactionRejectsMissingPlatformTransactionID(t *testing.T) {
	_, server := newTestSystem(t, &stubBackend{transactionID: 0})
	conn := dial(t, server, "CP-1")

	frame := sendCall(t, conn, "1", ActionStartTransaction, StartTransactionRequest{
		ConnectorID: 1, IdTag: "TAG", MeterStart: 0, Timestamp: time.Now().UTC().Format(time.RFC3339),
	})
	if frame.Error == nil {
		t.Fatalf("expected CALLERROR, got %+v", frame)
	}
	if !strings.Contains(frame.Error.ErrorDescription, "transaction id") {
		t.Fatalf("unexpected description %q", frame.Error.ErrorDescription)
	}
}

func TestUnknownActionIsNotImplemented(t *testing.T) {
	_, server := newTestSystem(t, &stubBackend{})
	conn := dial(t, server, "CP-1")

	frame := sendCall(t, conn, "1", "DiagnosticsStatusNotification", map[string]string{"status": "Idle"})
	if frame.Error == nil || frame.Error.ErrorCode != ErrNotImplemented {
		t.Fatalf("expected NotImplemented, got %+v", frame)
	}
}

func TestUnknownFieldsAreRejected(t *testing.T) {
	_, server := newTestSystem(t, &stubBackend{})
	conn := dial(t, server, "CP-1")

	frame := sendCall(t, conn, "1", ActionStatusNotification, map[string]any{
		"connectorId": 1, "errorCode": "NoError", "status": "Available", "unknownField": true,
	})
	if frame.Error == nil || frame.Error.ErrorCode != ErrFormationViolation {
		t.Fatalf("expected FormationViolation, got %+v", frame)
	}
}

func TestSetChargingProfileReturnsChargePointStatus(t *testing.T) {
	cs, server := newTestSystem(t, &stubBackend{})
	conn := dial(t, server, "CP-1")

	// Answer the central system's command the way a charge point would.
	go func() {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		frame, err := DecodeFrame(raw)
		if err != nil || frame.Call == nil {
			return
		}
		reply, err := EncodeCallResult(frame.Call.UniqueID, StatusResponse{Status: "Accepted"})
		if err == nil {
			_ = conn.WriteMessage(websocket.TextMessage, reply)
		}
	}()

	waitConnected(t, cs, "CP-1")

	limit := -7000.0 // negative: V2G discharge
	status, err := cs.SetChargingProfile(context.Background(), "CP-1", SetChargingProfileRequest{
		ConnectorID: 1,
		CsChargingProfiles: ChargingProfile{
			ChargingProfileID:      1,
			StackLevel:             0,
			ChargingProfilePurpose: "TxDefaultProfile",
			ChargingProfileKind:    "Absolute",
			ChargingSchedule: ChargingSchedule{
				ChargingRateUnit:       "W",
				ChargingSchedulePeriod: []ChargingSchedulePeriod{{StartPeriod: 0, Limit: limit}},
			},
		},
	})
	if err != nil {
		t.Fatalf("set charging profile: %v", err)
	}
	if status.Status != "Accepted" {
		t.Fatalf("unexpected status %q", status.Status)
	}
}

func TestCommandToDisconnectedChargePointFails(t *testing.T) {
	cs, _ := newTestSystem(t, &stubBackend{})
	_, err := cs.RemoteStopTransaction(context.Background(), "CP-404", RemoteStopTransactionRequest{TransactionID: 1})
	if !errors.Is(err, ErrNotConnected) {
		t.Fatalf("expected ErrNotConnected, got %v", err)
	}
}

func TestCommandRejectionIsAnError(t *testing.T) {
	cs, server := newTestSystem(t, &stubBackend{})
	conn := dial(t, server, "CP-1")

	go func() {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		frame, err := DecodeFrame(raw)
		if err != nil || frame.Call == nil {
			return
		}
		reply, err := EncodeCallError(frame.Call.UniqueID, ErrNotSupported, "no remote start")
		if err == nil {
			_ = conn.WriteMessage(websocket.TextMessage, reply)
		}
	}()

	waitConnected(t, cs, "CP-1")

	_, err := cs.RemoteStartTransaction(context.Background(), "CP-1", RemoteStartTransactionRequest{IdTag: "TAG"})
	var callErr *CallError
	if !errors.As(err, &callErr) {
		t.Fatalf("expected a CALLERROR, got %v", err)
	}
	if callErr.ErrorCode != ErrNotSupported {
		t.Fatalf("unexpected error code %q", callErr.ErrorCode)
	}
}

func TestCommandTimesOutWhenChargePointIsSilent(t *testing.T) {
	backend := &stubBackend{}
	cs, err := NewCentralSystem(backend, Options{
		Authenticate: func(*http.Request, string) error { return nil },
		CallTimeout:  150 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("new central system: %v", err)
	}
	server := httptest.NewServer(cs)
	defer server.Close()
	dial(t, server, "CP-1")
	waitConnected(t, cs, "CP-1")

	_, err = cs.Reset(context.Background(), "CP-1", ResetRequest{Type: "Soft"})
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected a timeout error, got %v", err)
	}
}

func waitConnected(t *testing.T, cs *CentralSystem, chargePointID string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, id := range cs.ConnectedChargePoints() {
			if id == chargePointID {
				return
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("charge point %s never registered a session", chargePointID)
}
