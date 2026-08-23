package ocppmux

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

	"github.com/vpp/grid-protocols/internal/ocpp16"
	"github.com/vpp/grid-protocols/internal/ocpp201"
	"github.com/vpp/grid-protocols/internal/ocppj"
)

type backend16 struct{}

func (backend16) BootNotification(context.Context, string, ocpp16.BootNotificationRequest) (ocpp16.BootNotificationResponse, error) {
	return ocpp16.BootNotificationResponse{Status: ocpp16.RegistrationAccepted}, nil
}
func (backend16) Heartbeat(context.Context, string) error { return nil }
func (backend16) StatusNotification(context.Context, string, ocpp16.StatusNotificationRequest) error {
	return nil
}
func (backend16) MeterValues(context.Context, string, ocpp16.MeterValuesRequest) error { return nil }
func (backend16) Authorize(context.Context, string, ocpp16.AuthorizeRequest) (ocpp16.AuthorizeResponse, error) {
	return ocpp16.AuthorizeResponse{IdTagInfo: ocpp16.IdTagInfo{Status: ocpp16.AuthAccepted}}, nil
}
func (backend16) StartTransaction(context.Context, string, ocpp16.StartTransactionRequest) (ocpp16.StartTransactionResponse, error) {
	return ocpp16.StartTransactionResponse{TransactionID: 1, IdTagInfo: ocpp16.IdTagInfo{Status: ocpp16.AuthAccepted}}, nil
}
func (backend16) StopTransaction(context.Context, string, ocpp16.StopTransactionRequest) (ocpp16.StopTransactionResponse, error) {
	return ocpp16.StopTransactionResponse{}, nil
}

type backend201 struct{}

func (backend201) BootNotification201(context.Context, string, ocpp201.BootNotificationRequest) (ocpp201.BootNotificationResponse, error) {
	return ocpp201.BootNotificationResponse{Status: ocpp201.RegistrationAccepted}, nil
}
func (backend201) Heartbeat201(context.Context, string) error { return nil }
func (backend201) StatusNotification201(context.Context, string, ocpp201.StatusNotificationRequest) error {
	return nil
}
func (backend201) MeterValues201(context.Context, string, ocpp201.MeterValuesRequest) error {
	return nil
}
func (backend201) Authorize201(context.Context, string, ocpp201.AuthorizeRequest) (ocpp201.AuthorizeResponse, error) {
	return ocpp201.AuthorizeResponse{IDTokenInfo: ocpp201.IDTokenInfo{Status: ocpp201.AuthAccepted}}, nil
}
func (backend201) TransactionEvent201(context.Context, string, ocpp201.TransactionEventRequest) (ocpp201.TransactionEventResponse, error) {
	return ocpp201.TransactionEventResponse{}, nil
}

func newMux(t *testing.T, with16, with201 bool) (*Mux, *httptest.Server) {
	t.Helper()
	var v16 V16
	if with16 {
		central, err := ocpp16.NewCentralSystem(backend16{}, ocpp16.Options{
			Authenticate: func(*http.Request, string) error { return nil },
			CallTimeout:  2 * time.Second,
		})
		if err != nil {
			t.Fatalf("central system: %v", err)
		}
		v16 = central
	}
	var v201 V201
	if with201 {
		csms, err := ocpp201.NewCSMS(backend201{}, ocpp201.Options{
			Authenticate: func(*http.Request, string) error { return nil },
			CallTimeout:  2 * time.Second,
		})
		if err != nil {
			t.Fatalf("csms: %v", err)
		}
		v201 = csms
	}
	mux, err := New(v16, v201, nil)
	if err != nil {
		t.Fatalf("mux: %v", err)
	}
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return mux, server
}

func dial(t *testing.T, server *httptest.Server, stationID string, subprotocols ...string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	dialer := websocket.Dialer{Subprotocols: subprotocols}
	conn, resp, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ocpp/"+stationID, nil)
	if conn != nil {
		t.Cleanup(func() { _ = conn.Close() })
	}
	return conn, resp, err
}

func TestNewRequiresAVersion(t *testing.T) {
	if _, err := New(nil, nil, nil); err == nil {
		t.Fatal("a mux with no protocol version enabled must be rejected")
	}
}

func TestRoutesByOfferedSubprotocol(t *testing.T) {
	mux, server := newMux(t, true, true)

	conn201, resp, err := dial(t, server, "CS-201", ocpp201.Subprotocol)
	if err != nil {
		t.Fatalf("dial 2.0.1: %v", err)
	}
	if got := resp.Header.Get("Sec-WebSocket-Protocol"); got != ocpp201.Subprotocol {
		t.Fatalf("expected the ocpp2.0.1 subprotocol to be negotiated, got %q", got)
	}
	// A 2.0.1 BootNotification would be a formation violation on 1.6, so a
	// successful exchange proves the session was routed by version.
	reply := exchange(t, conn201, "1", ocpp201.ActionBootNotification, ocpp201.BootNotificationRequest{
		Reason:          "PowerUp",
		ChargingStation: ocpp201.ChargingStation{VendorName: "vendor", Model: "model"},
	})
	if reply.Result == nil {
		t.Fatalf("expected a 2.0.1 boot result, got %+v", reply)
	}

	conn16, _, err := dial(t, server, "CP-16", "ocpp1.6")
	if err != nil {
		t.Fatalf("dial 1.6: %v", err)
	}
	reply = exchange(t, conn16, "1", "BootNotification", ocpp16.BootNotificationRequest{
		ChargePointVendor: "vendor", ChargePointModel: "model",
	})
	if reply.Result == nil {
		t.Fatalf("expected a 1.6 boot result, got %+v", reply)
	}

	waitForVersion(t, mux, "CS-201", Version201)
	waitForVersion(t, mux, "CP-16", Version16)
}

func TestUnofferedAndUnknownSubprotocolsAreRefused(t *testing.T) {
	_, server := newMux(t, true, true)

	if _, resp, err := dial(t, server, "CS-1"); err == nil {
		t.Fatal("a station offering no OCPP subprotocol must be refused")
	} else if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}

	if _, resp, err := dial(t, server, "CS-1", "ocpp1.5"); err == nil {
		t.Fatal("an unsupported OCPP version must be refused rather than downgraded")
	} else if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestDisabledVersionIsRefusedRatherThanServedByTheOther(t *testing.T) {
	_, server := newMux(t, true, false)

	if _, resp, err := dial(t, server, "CS-1", ocpp201.Subprotocol); err == nil {
		t.Fatal("2.0.1 is not enabled on this deployment and must be refused")
	} else if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestOneStationCannotHoldBothVersions(t *testing.T) {
	mux, server := newMux(t, true, true)

	if _, _, err := dial(t, server, "CS-1", ocpp201.Subprotocol); err != nil {
		t.Fatalf("dial 2.0.1: %v", err)
	}
	waitForVersion(t, mux, "CS-1", Version201)

	if _, resp, err := dial(t, server, "CS-1", "ocpp1.6"); err == nil {
		t.Fatal("the same station id must not hold a session on both versions")
	} else if resp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409, got %d", resp.StatusCode)
	}
}

func TestCommandsToADisconnectedStationFail(t *testing.T) {
	mux, _ := newMux(t, true, true)

	_, err := mux.SetChargingProfile(context.Background(), "CS-1", profile16())
	if !errors.Is(err, ocpp16.ErrNotConnected) {
		t.Fatalf("expected ErrNotConnected, got %v", err)
	}
	if mux.ProtocolVersion("CS-1") != "" {
		t.Fatal("an unconnected station must report no protocol version")
	}
}

func TestProfileIsTranslatedForA201Station(t *testing.T) {
	mux, server := newMux(t, true, true)

	conn, _, err := dial(t, server, "CS-1", ocpp201.Subprotocol)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	calls := make(chan *ocppj.Call, 1)
	go func() {
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			frame, err := ocppj.DecodeFrame(raw)
			if err != nil || frame.Call == nil {
				continue
			}
			calls <- frame.Call
			data, _ := ocppj.EncodeCallResult(frame.Call.UniqueID, ocpp201.StatusResponse{Status: "Accepted"})
			_ = conn.WriteMessage(websocket.TextMessage, data)
		}
	}()
	waitForVersion(t, mux, "CS-1", Version201)

	status, err := mux.SetChargingProfile(context.Background(), "CS-1", profile16())
	if err != nil || status.Status != "Accepted" {
		t.Fatalf("expected Accepted, got %+v (%v)", status, err)
	}

	call := <-calls
	if call.Action != ocpp201.ActionSetChargingProfile {
		t.Fatalf("expected %s, got %s", ocpp201.ActionSetChargingProfile, call.Action)
	}
	var sent ocpp201.SetChargingProfileRequest
	if err := json.Unmarshal(call.Payload, &sent); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if len(sent.ChargingProfile.ChargingSchedule) != 1 {
		t.Fatalf("expected one translated schedule, got %+v", sent.ChargingProfile.ChargingSchedule)
	}
	schedule := sent.ChargingProfile.ChargingSchedule[0]
	if schedule.ChargingRateUnit != "W" || schedule.ChargingSchedulePeriod[0].Limit != 7000 {
		t.Fatalf("limits must carry over unchanged, got %+v", schedule)
	}
	if sent.ChargingProfile.ValidTo != profile16().CsChargingProfiles.ValidTo {
		t.Fatalf("the validity window must carry over, got %q", sent.ChargingProfile.ValidTo)
	}
}

func TestTransactionScopedProfileIsNotTranslated(t *testing.T) {
	transactionID := 42
	req := profile16()
	req.CsChargingProfiles.TransactionID = &transactionID
	if _, err := ToProfile201(req); err == nil {
		t.Fatal("a platform transaction id names nothing on a 2.0.1 station and must be refused")
	}
}

func TestPurposeIsRenamedForA201Station(t *testing.T) {
	req := profile16()
	req.CsChargingProfiles.ChargingProfilePurpose = "ChargePointMaxProfile"
	translated, err := ToProfile201(req)
	if err != nil {
		t.Fatalf("translate: %v", err)
	}
	if translated.ChargingProfile.ChargingProfilePurpose != "ChargingStationMaxProfile" {
		t.Fatalf("expected ChargingStationMaxProfile, got %q", translated.ChargingProfile.ChargingProfilePurpose)
	}
}

func TestRemoteStartAndStopRefuseGuessworkOn201(t *testing.T) {
	mux, server := newMux(t, true, true)
	if _, _, err := dial(t, server, "CS-1", ocpp201.Subprotocol); err != nil {
		t.Fatalf("dial: %v", err)
	}
	waitForVersion(t, mux, "CS-1", Version201)

	// An untyped id token could authorize the wrong credential.
	if _, err := mux.RemoteStart(context.Background(), "CS-1",
		ocpp16.RemoteStartTransactionRequest{IdTag: "TOKEN", ConnectorID: intPtr(1)}, 1, ""); err == nil {
		t.Fatal("a 2.0.1 remote start without an id token type must be refused")
	}

	// The station owns transaction identity; the platform's integer id is not it.
	if _, err := mux.RemoteStop(context.Background(), "CS-1",
		ocpp16.RemoteStopTransactionRequest{TransactionID: 7}, ""); err == nil {
		t.Fatal("stopping a 2.0.1 transaction without the station's transaction id must be refused")
	}
}

func exchange(t *testing.T, conn *websocket.Conn, uniqueID, action string, payload any) *ocppj.Frame {
	t.Helper()
	data, err := ocppj.EncodeCall(uniqueID, action, payload)
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
	frame, err := ocppj.DecodeFrame(raw)
	if err != nil {
		t.Fatalf("decode %s: %v", raw, err)
	}
	return frame
}

func waitForVersion(t *testing.T, mux *Mux, stationID string, want Version) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if mux.Version(stationID) == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("station %s never reported version %s (got %q)", stationID, want, mux.Version(stationID))
}

func profile16() ocpp16.SetChargingProfileRequest {
	return ocpp16.SetChargingProfileRequest{
		ConnectorID: 1,
		CsChargingProfiles: ocpp16.ChargingProfile{
			ChargingProfileID:      1,
			StackLevel:             1,
			ChargingProfilePurpose: "TxDefaultProfile",
			ChargingProfileKind:    "Absolute",
			ValidTo:                "2026-01-01T00:15:00Z",
			ChargingSchedule: ocpp16.ChargingSchedule{
				ChargingRateUnit: "W",
				ChargingSchedulePeriod: []ocpp16.ChargingSchedulePeriod{
					{StartPeriod: 0, Limit: 7000},
				},
			},
		},
	}
}

func intPtr(v int) *int { return &v }
