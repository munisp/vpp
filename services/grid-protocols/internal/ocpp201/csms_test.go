package ocpp201

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/vpp/grid-protocols/internal/ocppj"
)

type stubBackend struct {
	mu sync.Mutex

	authorizeErr    error
	authorizeStatus string
	transactionResp TransactionEventResponse
	transactionErr  error

	events      []TransactionEventRequest
	meterValues []MeterValuesRequest
	heartbeats  int
}

func (s *stubBackend) BootNotification201(context.Context, string, BootNotificationRequest) (BootNotificationResponse, error) {
	return BootNotificationResponse{Status: RegistrationAccepted}, nil
}

func (s *stubBackend) Heartbeat201(context.Context, string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.heartbeats++
	return nil
}

func (s *stubBackend) StatusNotification201(context.Context, string, StatusNotificationRequest) error {
	return nil
}

func (s *stubBackend) MeterValues201(_ context.Context, _ string, req MeterValuesRequest) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.meterValues = append(s.meterValues, req)
	return nil
}

func (s *stubBackend) Authorize201(context.Context, string, AuthorizeRequest) (AuthorizeResponse, error) {
	if s.authorizeErr != nil {
		return AuthorizeResponse{}, s.authorizeErr
	}
	return AuthorizeResponse{IDTokenInfo: IDTokenInfo{Status: s.authorizeStatus}}, nil
}

func (s *stubBackend) TransactionEvent201(_ context.Context, _ string, req TransactionEventRequest) (TransactionEventResponse, error) {
	s.mu.Lock()
	s.events = append(s.events, req)
	s.mu.Unlock()
	if s.transactionErr != nil {
		return TransactionEventResponse{}, s.transactionErr
	}
	return s.transactionResp, nil
}

func (s *stubBackend) recordedEvents() []TransactionEventRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]TransactionEventRequest(nil), s.events...)
}

func newTestCSMS(t *testing.T, backend Backend) (*CSMS, *httptest.Server) {
	t.Helper()
	cs, err := NewCSMS(backend, Options{
		Authenticate: func(_ *http.Request, stationID string) error {
			if stationID != "CS-1" {
				return errors.New("unknown charging station")
			}
			return nil
		},
		CallTimeout: 2 * time.Second,
	})
	if err != nil {
		t.Fatalf("new CSMS: %v", err)
	}
	server := httptest.NewServer(cs)
	t.Cleanup(server.Close)
	return cs, server
}

func dial(t *testing.T, server *httptest.Server, stationID string) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/ocpp/" + stationID
	dialer := websocket.Dialer{Subprotocols: []string{Subprotocol}}
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

func sendCall(t *testing.T, conn *websocket.Conn, uniqueID, action string, payload any) *ocppj.Frame {
	t.Helper()
	data, err := ocppj.EncodeCall(uniqueID, action, payload)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	return sendRaw(t, conn, data)
}

func sendRaw(t *testing.T, conn *websocket.Conn, data []byte) *ocppj.Frame {
	t.Helper()
	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		t.Fatalf("write: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	_, raw, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	frame, err := ocppj.DecodeFrame(raw)
	if err != nil {
		t.Fatalf("decode response %s: %v", raw, err)
	}
	return frame
}

func startedEvent() TransactionEventRequest {
	return TransactionEventRequest{
		EventType:       TransactionEventStarted,
		Timestamp:       time.Now().UTC().Format(time.RFC3339),
		TriggerReason:   "Authorized",
		SeqNo:           0,
		TransactionInfo: TransactionInfo{TransactionID: "station-tx-7"},
		Evse:            &EVSE{ID: 1},
	}
}

func TestRequiresSubprotocolAndAuth(t *testing.T) {
	_, server := newTestCSMS(t, &stubBackend{})
	base := "ws" + strings.TrimPrefix(server.URL, "http")

	if _, resp, err := (&websocket.Dialer{}).Dial(base+"/ocpp/CS-1", nil); err == nil {
		t.Fatal("expected a connection without the ocpp2.0.1 subprotocol to be rejected")
	} else if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}

	// A 1.6 station must not be served the 2.0.1 message set.
	wrong := &websocket.Dialer{Subprotocols: []string{"ocpp1.6"}}
	if _, resp, err := wrong.Dial(base+"/ocpp/CS-1", nil); err == nil {
		t.Fatal("expected an ocpp1.6 subprotocol to be rejected by the 2.0.1 CSMS")
	} else if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}

	right := &websocket.Dialer{Subprotocols: []string{Subprotocol}}
	if _, resp, err := right.Dial(base+"/ocpp/CS-UNKNOWN", nil); err == nil {
		t.Fatal("expected an unprovisioned station to be rejected")
	} else if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

func TestBootHeartbeatStatusAndMeterValues(t *testing.T) {
	backend := &stubBackend{}
	_, server := newTestCSMS(t, backend)
	conn := dial(t, server, "CS-1")

	frame := sendCall(t, conn, "1", ActionBootNotification, BootNotificationRequest{
		Reason:          "PowerUp",
		ChargingStation: ChargingStation{VendorName: "vendor", Model: "model"},
	})
	if frame.Result == nil {
		t.Fatalf("expected a result, got %+v", frame)
	}
	var boot BootNotificationResponse
	if err := json.Unmarshal(frame.Result.Payload, &boot); err != nil {
		t.Fatalf("boot response: %v", err)
	}
	if boot.Status != RegistrationAccepted || boot.CurrentTime == "" || boot.Interval <= 0 {
		t.Fatalf("unexpected boot response %+v", boot)
	}

	if frame := sendCall(t, conn, "2", ActionHeartbeat, struct{}{}); frame.Result == nil {
		t.Fatalf("expected a heartbeat result, got %+v", frame)
	}
	if backend.heartbeats != 1 {
		t.Fatalf("expected 1 heartbeat, got %d", backend.heartbeats)
	}

	if frame := sendCall(t, conn, "3", ActionStatusNotification, StatusNotificationRequest{
		Timestamp: time.Now().UTC().Format(time.RFC3339), ConnectorStatus: "Available", EvseID: 1, ConnectorID: 1,
	}); frame.Result == nil {
		t.Fatalf("expected a status result, got %+v", frame)
	}

	multiplier := 3
	frame = sendCall(t, conn, "4", ActionMeterValues, MeterValuesRequest{
		EvseID: 1,
		MeterValue: []MeterValue{{
			Timestamp: time.Now().UTC().Format(time.RFC3339),
			SampledValue: []SampledValue{{
				Value:         12.5,
				Measurand:     "Energy.Active.Import.Register",
				UnitOfMeasure: &UnitOfMeasure{Unit: "Wh", Multiplier: &multiplier},
			}},
		}},
	})
	if frame.Result == nil {
		t.Fatalf("expected a meter values result, got %+v", frame)
	}
	if len(backend.meterValues) != 1 {
		t.Fatalf("expected 1 meter values message, got %d", len(backend.meterValues))
	}
	got := backend.meterValues[0].MeterValue[0].SampledValue[0]
	if got.UnitOfMeasure == nil || got.UnitOfMeasure.Multiplier == nil || *got.UnitOfMeasure.Multiplier != 3 {
		t.Fatalf("the unit multiplier must reach the platform: %+v", got.UnitOfMeasure)
	}
}

func TestBootRequiresStationIdentityAndReason(t *testing.T) {
	_, server := newTestCSMS(t, &stubBackend{})
	conn := dial(t, server, "CS-1")

	for name, payload := range map[string]BootNotificationRequest{
		"no vendor": {Reason: "PowerUp", ChargingStation: ChargingStation{Model: "model"}},
		"no model":  {Reason: "PowerUp", ChargingStation: ChargingStation{VendorName: "vendor"}},
		"no reason": {ChargingStation: ChargingStation{VendorName: "vendor", Model: "model"}},
	} {
		frame := sendCall(t, conn, "boot-"+name, ActionBootNotification, payload)
		if frame.Error == nil {
			t.Fatalf("%s: expected a CALLERROR, got %+v", name, frame)
		}
		if frame.Error.ErrorCode != ErrPropertyConstraintViolation {
			t.Fatalf("%s: expected %s, got %s", name, ErrPropertyConstraintViolation, frame.Error.ErrorCode)
		}
	}
}

func TestAuthorizeFailsWhenPlatformIsUnavailable(t *testing.T) {
	backend := &stubBackend{authorizeErr: errors.New("platform unreachable")}
	_, server := newTestCSMS(t, backend)
	conn := dial(t, server, "CS-1")

	frame := sendCall(t, conn, "1", ActionAuthorize, AuthorizeRequest{
		IDToken: IDToken{IDToken: "TOKEN", Type: "ISO14443"},
	})
	if frame.Error == nil {
		t.Fatalf("an unreachable platform must not authorize charging: %+v", frame)
	}
}

func TestAuthorizeReturnsPlatformDecision(t *testing.T) {
	backend := &stubBackend{authorizeStatus: AuthBlocked}
	_, server := newTestCSMS(t, backend)
	conn := dial(t, server, "CS-1")

	frame := sendCall(t, conn, "1", ActionAuthorize, AuthorizeRequest{
		IDToken: IDToken{IDToken: "TOKEN", Type: "ISO14443"},
	})
	if frame.Result == nil {
		t.Fatalf("expected a result, got %+v", frame)
	}
	var resp AuthorizeResponse
	if err := json.Unmarshal(frame.Result.Payload, &resp); err != nil {
		t.Fatalf("authorize response: %v", err)
	}
	if resp.IDTokenInfo.Status != AuthBlocked {
		t.Fatalf("expected the platform's Blocked decision, got %q", resp.IDTokenInfo.Status)
	}
}

func TestAuthorizeRequiresTypedToken(t *testing.T) {
	_, server := newTestCSMS(t, &stubBackend{authorizeStatus: AuthAccepted})
	conn := dial(t, server, "CS-1")

	frame := sendCall(t, conn, "1", ActionAuthorize, AuthorizeRequest{IDToken: IDToken{IDToken: "TOKEN"}})
	if frame.Error == nil || frame.Error.ErrorCode != ErrPropertyConstraintViolation {
		t.Fatalf("an untyped id token must be refused: %+v", frame)
	}
}

func TestTransactionEventKeepsStationTransactionIdentity(t *testing.T) {
	backend := &stubBackend{transactionResp: TransactionEventResponse{
		IDTokenInfo: &IDTokenInfo{Status: AuthAccepted},
	}}
	_, server := newTestCSMS(t, backend)
	conn := dial(t, server, "CS-1")

	event := startedEvent()
	event.IDToken = &IDToken{IDToken: "TOKEN", Type: "ISO14443"}
	frame := sendCall(t, conn, "1", ActionTransactionEvent, event)
	if frame.Result == nil {
		t.Fatalf("expected a result, got %+v", frame)
	}

	events := backend.recordedEvents()
	if len(events) != 1 {
		t.Fatalf("expected 1 transaction event, got %d", len(events))
	}
	if events[0].TransactionInfo.TransactionID != "station-tx-7" {
		t.Fatalf("the station's transaction id must be forwarded unchanged, got %q",
			events[0].TransactionInfo.TransactionID)
	}
}

func TestTransactionEventValidation(t *testing.T) {
	_, server := newTestCSMS(t, &stubBackend{})
	conn := dial(t, server, "CS-1")

	withoutTransactionID := startedEvent()
	withoutTransactionID.TransactionInfo.TransactionID = "  "

	unknownType := startedEvent()
	unknownType.EventType = "Finished"

	negativeSeq := startedEvent()
	negativeSeq.SeqNo = -1

	noEvse := startedEvent()
	noEvse.Evse = nil

	noTrigger := startedEvent()
	noTrigger.TriggerReason = ""

	cases := map[string]TransactionEventRequest{
		"missing transaction id": withoutTransactionID,
		"unknown event type":     unknownType,
		"negative seqNo":         negativeSeq,
		"started without evse":   noEvse,
		"missing triggerReason":  noTrigger,
	}
	for name, event := range cases {
		frame := sendCall(t, conn, "tx-"+name, ActionTransactionEvent, event)
		if frame.Error == nil {
			t.Fatalf("%s: expected a CALLERROR, got %+v", name, frame)
		}
		if frame.Error.ErrorCode != ErrPropertyConstraintViolation {
			t.Fatalf("%s: expected %s, got %s", name, ErrPropertyConstraintViolation, frame.Error.ErrorCode)
		}
	}
}

func TestReplayedOfflineEventIsForwardedAsLateEvidence(t *testing.T) {
	backend := &stubBackend{}
	_, server := newTestCSMS(t, backend)
	conn := dial(t, server, "CS-1")

	event := startedEvent()
	event.EventType = TransactionEventUpdated
	event.Evse = nil
	event.Offline = true
	event.SeqNo = 4
	event.Timestamp = time.Now().UTC().Add(-2 * time.Hour).Format(time.RFC3339)

	if frame := sendCall(t, conn, "1", ActionTransactionEvent, event); frame.Result == nil {
		t.Fatalf("a buffered offline event is real evidence and must be accepted: %+v", frame)
	}
	events := backend.recordedEvents()
	if len(events) != 1 || !events[0].Offline || events[0].SeqNo != 4 {
		t.Fatalf("offline and seqNo must reach the platform: %+v", events)
	}
}

func TestAuthorizingTransactionEventNeedsAPlatformDecision(t *testing.T) {
	// The platform answered without an idTokenInfo: accepting would let the
	// station charge on its own judgement while the platform authorized nothing.
	backend := &stubBackend{}
	_, server := newTestCSMS(t, backend)
	conn := dial(t, server, "CS-1")

	event := startedEvent()
	event.IDToken = &IDToken{IDToken: "TOKEN", Type: "ISO14443"}
	if frame := sendCall(t, conn, "1", ActionTransactionEvent, event); frame.Error == nil {
		t.Fatalf("expected a CALLERROR, got %+v", frame)
	}
}

func TestTransactionEventFailsWhenPlatformFails(t *testing.T) {
	backend := &stubBackend{transactionErr: errors.New("database unavailable")}
	_, server := newTestCSMS(t, backend)
	conn := dial(t, server, "CS-1")

	if frame := sendCall(t, conn, "1", ActionTransactionEvent, startedEvent()); frame.Error == nil {
		t.Fatalf("a failed platform write must not be answered with an acceptance: %+v", frame)
	}
}

func TestUnknownActionAndUnknownFieldsAreRejected(t *testing.T) {
	_, server := newTestCSMS(t, &stubBackend{})
	conn := dial(t, server, "CS-1")

	frame := sendCall(t, conn, "1", "DataTransfer", map[string]string{"vendorId": "v"})
	if frame.Error == nil || frame.Error.ErrorCode != ErrNotImplemented {
		t.Fatalf("expected %s, got %+v", ErrNotImplemented, frame)
	}

	frame = sendCall(t, conn, "2", ActionStatusNotification, map[string]any{
		"timestamp":       time.Now().UTC().Format(time.RFC3339),
		"connectorStatus": "Available",
		"evseId":          1,
		"connectorId":     1,
		"vendorExtension": "unmapped",
	})
	if frame.Error == nil || frame.Error.ErrorCode != ErrFormatViolation {
		t.Fatalf("expected %s for an unknown field, got %+v", ErrFormatViolation, frame)
	}
}

func TestMalformedFrameIsAnsweredWithFormatViolation(t *testing.T) {
	_, server := newTestCSMS(t, &stubBackend{})
	conn := dial(t, server, "CS-1")

	// A CALL missing its payload: the framing is broken, but the message id is
	// recoverable, so the station gets a correlated CALLERROR in 2.0.1's spelling.
	frame := sendRaw(t, conn, []byte(`[2,"9","Heartbeat"]`))
	if frame.Error == nil {
		t.Fatalf("expected a CALLERROR, got %+v", frame)
	}
	if frame.Error.UniqueID != "9" {
		t.Fatalf("the CALLERROR must be correlated to the request, got %q", frame.Error.UniqueID)
	}
	if frame.Error.ErrorCode != ErrFormatViolation {
		t.Fatalf("2.0.1 spells this FormatViolation, got %s", frame.Error.ErrorCode)
	}
}

// station answers CSMS-initiated calls the way a charging station does, so the
// command paths are exercised over a real socket rather than a stubbed session.
type station struct {
	conn    *websocket.Conn
	respond func(call *ocppj.Call) [][]byte
}

func (s *station) serve() {
	for {
		_, raw, err := s.conn.ReadMessage()
		if err != nil {
			return
		}
		frame, err := ocppj.DecodeFrame(raw)
		if err != nil || frame.Call == nil {
			continue
		}
		for _, reply := range s.respond(frame.Call) {
			if err := s.conn.WriteMessage(websocket.TextMessage, reply); err != nil {
				return
			}
		}
	}
}

func newStation(t *testing.T, server *httptest.Server, respond func(call *ocppj.Call) [][]byte) {
	t.Helper()
	conn := dial(t, server, "CS-1")
	s := &station{conn: conn, respond: respond}
	go s.serve()
}

func TestSetChargingProfileAcceptedRejectedAndErrored(t *testing.T) {
	cs, server := newTestCSMS(t, &stubBackend{})

	responses := make(chan string, 1)
	newStation(t, server, func(call *ocppj.Call) [][]byte {
		switch <-responses {
		case "accepted":
			data, _ := ocppj.EncodeCallResult(call.UniqueID, StatusResponse{Status: "Accepted"})
			return [][]byte{data}
		case "rejected":
			data, _ := ocppj.EncodeCallResult(call.UniqueID, StatusResponse{Status: "Rejected"})
			return [][]byte{data}
		default:
			data, _ := ocppj.EncodeCallError(call.UniqueID, ErrInternalError, "profile storage full")
			return [][]byte{data}
		}
	})
	waitForSession(t, cs, "CS-1")

	profile := SetChargingProfileRequest{
		EvseID: 1,
		ChargingProfile: ChargingProfile{
			ID: 1, StackLevel: 1, ChargingProfilePurpose: "TxProfile", ChargingProfileKind: "Absolute",
			ChargingSchedule: []ChargingSchedule{{
				ID: 1, ChargingRateUnit: "W",
				ChargingSchedulePeriod: []ChargingSchedulePeriod{{StartPeriod: 0, Limit: 7000}},
			}},
		},
	}

	responses <- "accepted"
	status, err := cs.SetChargingProfile(context.Background(), "CS-1", profile)
	if err != nil || status.Status != "Accepted" {
		t.Fatalf("expected Accepted, got %+v (%v)", status, err)
	}

	responses <- "rejected"
	status, err = cs.SetChargingProfile(context.Background(), "CS-1", profile)
	if err != nil {
		t.Fatalf("a rejection is a status, not a transport error: %v", err)
	}
	if status.Status != "Rejected" {
		t.Fatalf("expected Rejected, got %+v", status)
	}

	responses <- "error"
	if _, err := cs.SetChargingProfile(context.Background(), "CS-1", profile); err == nil {
		t.Fatal("a CALLERROR must not be reported as an applied profile")
	}
}

func TestCommandToDisconnectedStationFails(t *testing.T) {
	cs, _ := newTestCSMS(t, &stubBackend{})
	_, err := cs.RequestStopTransaction(context.Background(), "CS-1", RequestStopTransactionRequest{TransactionID: "tx"})
	if !errors.Is(err, ErrNotConnected) {
		t.Fatalf("expected ErrNotConnected, got %v", err)
	}
}

func TestCommandTimesOutWithoutAResponse(t *testing.T) {
	cs, server := newTestCSMS(t, &stubBackend{})
	cs.opts.CallTimeout = 200 * time.Millisecond
	newStation(t, server, func(*ocppj.Call) [][]byte { return nil })
	waitForSession(t, cs, "CS-1")

	if _, err := cs.Reset(context.Background(), "CS-1", ResetRequest{Type: "OnIdle"}); err == nil {
		t.Fatal("a silent station must not be reported as having accepted a reset")
	} else if !strings.Contains(err.Error(), "unconfirmed") {
		t.Fatalf("the error must say delivery is unconfirmed, got %v", err)
	}
}

func TestDuplicateResponseIsIgnored(t *testing.T) {
	cs, server := newTestCSMS(t, &stubBackend{})
	newStation(t, server, func(call *ocppj.Call) [][]byte {
		data, _ := ocppj.EncodeCallResult(call.UniqueID, StatusResponse{Status: "Accepted"})
		// The duplicate has no pending request to satisfy; the session must stay
		// usable rather than mis-correlate it with the next command.
		return [][]byte{data, data}
	})
	waitForSession(t, cs, "CS-1")

	for i := 0; i < 2; i++ {
		if _, err := cs.Reset(context.Background(), "CS-1", ResetRequest{Type: "OnIdle"}); err != nil {
			t.Fatalf("command %d failed: %v", i, err)
		}
	}
}

func TestOneSessionPerStation(t *testing.T) {
	cs, server := newTestCSMS(t, &stubBackend{})
	first := dial(t, server, "CS-1")
	waitForSession(t, cs, "CS-1")

	second := dial(t, server, "CS-1")
	go func() {
		for {
			_, raw, err := second.ReadMessage()
			if err != nil {
				return
			}
			frame, err := ocppj.DecodeFrame(raw)
			if err != nil || frame.Call == nil {
				continue
			}
			data, _ := ocppj.EncodeCallResult(frame.Call.UniqueID, StatusResponse{Status: "Accepted"})
			_ = second.WriteMessage(websocket.TextMessage, data)
		}
	}()

	// The replaced socket is closed, so the stale connection cannot keep
	// answering for the station.
	_ = first.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := first.ReadMessage(); err == nil {
		t.Fatal("expected the replaced session to be closed")
	}

	if _, err := cs.Reset(context.Background(), "CS-1", ResetRequest{Type: "OnIdle"}); err != nil {
		t.Fatalf("the surviving session must serve commands: %v", err)
	}
	if ids := cs.ConnectedChargePoints(); len(ids) != 1 {
		t.Fatalf("expected exactly 1 session for one station, got %v", ids)
	}
}

func TestGetVariablesRequiresAResultPerVariable(t *testing.T) {
	cs, server := newTestCSMS(t, &stubBackend{})
	newStation(t, server, func(call *ocppj.Call) [][]byte {
		data, _ := ocppj.EncodeCallResult(call.UniqueID, GetVariablesResponse{
			GetVariableResult: []GetVariableResult{{AttributeStatus: "Accepted", AttributeValue: "22000"}},
		})
		return [][]byte{data}
	})
	waitForSession(t, cs, "CS-1")

	req := GetVariablesRequest{GetVariableData: []GetVariableData{
		{Component: Component{Name: "SmartChargingCtrlr"}, Variable: Variable{Name: "Enabled"}},
		{Component: Component{Name: "SmartChargingCtrlr"}, Variable: Variable{Name: "ACPhaseSwitchingSupported"}},
	}}
	if _, err := cs.GetVariables(context.Background(), "CS-1", req); err == nil {
		t.Fatal("a short result list must not be reported as two variables read")
	}
}

func waitForSession(t *testing.T, cs *CSMS, stationID string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		for _, id := range cs.ConnectedChargePoints() {
			if id == stationID {
				return
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("station %s never registered a session", stationID)
}
