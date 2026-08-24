package conformance

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"time"

	"github.com/vpp/grid-protocols/internal/ocpp16"
)

// The OCPP 1.6J vector set runs a simulated charge point against this service's
// real central system, over a real WebSocket. The central system is the code
// that runs in production; only the charge point and the platform behind it are
// simulated, so what these cases exercise is the framing, the strict payload
// decoding and the message semantics that a live station will hit.
//
// Each case asserts something a wrong implementation would get wrong quietly:
// accepting a connection with no OCPP subprotocol, answering a malformed frame
// with a CALLRESULT, swallowing an unknown action, or reporting a charging
// profile as set when the station rejected it.

// ocpp16Peer is the simulated station plus the central system under test.
type ocpp16Peer struct {
	*wsPeer
	central *ocpp16.CentralSystem
	backend *ocpp16Backend
}

// ocpp16Backend stands in for the platform. It is deliberately fixed rather than
// clever: the cases assert what the central system does with a known answer, so
// a backend that improvised would make failures unreadable.
type ocpp16Backend struct {
	mu           sync.Mutex
	meterValues  []ocpp16.MeterValuesRequest
	transactions int
	heartbeats   int
}

func (b *ocpp16Backend) BootNotification(_ context.Context, _ string, _ ocpp16.BootNotificationRequest) (ocpp16.BootNotificationResponse, error) {
	return ocpp16.BootNotificationResponse{Status: "Accepted"}, nil
}

func (b *ocpp16Backend) Heartbeat(_ context.Context, _ string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.heartbeats++
	return nil
}

func (b *ocpp16Backend) StatusNotification(_ context.Context, _ string, _ ocpp16.StatusNotificationRequest) error {
	return nil
}

func (b *ocpp16Backend) MeterValues(_ context.Context, _ string, req ocpp16.MeterValuesRequest) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.meterValues = append(b.meterValues, req)
	return nil
}

func (b *ocpp16Backend) Authorize(_ context.Context, _ string, req ocpp16.AuthorizeRequest) (ocpp16.AuthorizeResponse, error) {
	if req.IdTag == "BLOCKED-TAG" {
		return ocpp16.AuthorizeResponse{IdTagInfo: ocpp16.IdTagInfo{Status: "Blocked"}}, nil
	}
	return ocpp16.AuthorizeResponse{IdTagInfo: ocpp16.IdTagInfo{Status: "Accepted"}}, nil
}

func (b *ocpp16Backend) StartTransaction(_ context.Context, _ string, _ ocpp16.StartTransactionRequest) (ocpp16.StartTransactionResponse, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.transactions++
	return ocpp16.StartTransactionResponse{
		TransactionID: 1000 + b.transactions,
		IdTagInfo:     ocpp16.IdTagInfo{Status: "Accepted"},
	}, nil
}

func (b *ocpp16Backend) StopTransaction(_ context.Context, _ string, _ ocpp16.StopTransactionRequest) (ocpp16.StopTransactionResponse, error) {
	return ocpp16.StopTransactionResponse{IdTagInfo: &ocpp16.IdTagInfo{Status: "Accepted"}}, nil
}

const ocpp16StationID = "CONFORMANCE-CP-1"

func newOCPP16Peer() (*ocpp16Peer, func(), error) {
	backend := &ocpp16Backend{}
	central, err := ocpp16.NewCentralSystem(backend, ocpp16.Options{
		Authenticate: func(_ *http.Request, chargePointID string) error {
			if chargePointID != ocpp16StationID {
				return fmt.Errorf("unknown charge point %q", chargePointID)
			}
			return nil
		},
		CallTimeout: 5 * time.Second,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("central system: %w", err)
	}

	server := httptest.NewServer(central)
	peer := &ocpp16Peer{
		wsPeer:  newWSPeer(server, ocpp16.Subprotocol, ocpp16StationID),
		central: central,
		backend: backend,
	}
	return peer, func() {
		peer.close()
		server.Close()
	}, nil
}

// OCPP16Suite is the OCPP 1.6J vector set.
func OCPP16Suite() Suite {
	return Suite{
		Adapter:          AdapterOCPP16,
		VectorSetID:      "vpp-ocpp16-core",
		VectorSetVersion: "1",
		ProtocolVersion:  "1.6",
		DeviceModel:      "vpp-ocpp16-station-simulator",
		Setup: func(_ context.Context) (*Env, func(), error) {
			peer, teardown, err := newOCPP16Peer()
			if err != nil {
				return nil, nil, err
			}
			return &Env{Peer: peer, Target: TargetSimulator}, teardown, nil
		},
		Cases: []Case{
			{
				ID:          "ocpp16-001-subprotocol-required",
				Name:        "Connection without the ocpp1.6 subprotocol is refused",
				Requirement: "OCPP-J 1.6 §3.1.1: the client shall offer the ocpp1.6 subprotocol; a server accepting a connection without it cannot know what message set is being spoken",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*ocpp16Peer)
					conn, resp, err := peer.dial(nil, ocpp16StationID)
					if err == nil {
						_ = conn.Close()
						return nil, errors.New("central system accepted a connection offering no subprotocol")
					}
					status := 0
					if resp != nil {
						status = resp.StatusCode
					}
					return map[string]any{"http_status": status, "error": err.Error()}, nil
				},
			},
			{
				ID:          "ocpp16-002-authentication-required",
				Name:        "Unknown charge point identity is refused before upgrade",
				Requirement: "An unauthenticated central system would accept transactions and meter values from any host that can reach it",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*ocpp16Peer)
					conn, resp, err := peer.dial([]string{ocpp16.Subprotocol}, "NOT-REGISTERED")
					if err == nil {
						_ = conn.Close()
						return nil, errors.New("central system accepted an unregistered charge point identity")
					}
					status := 0
					if resp != nil {
						status = resp.StatusCode
					}
					return map[string]any{"http_status": status}, nil
				},
			},
			{
				ID:          "ocpp16-003-boot-notification",
				Name:        "BootNotification is answered with a registration status and interval",
				Requirement: "OCPP 1.6 §4.1: the response carries status, currentTime and heartbeatInterval",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*ocpp16Peer)
					frame, err := peer.call("BootNotification", ocpp16.BootNotificationRequest{
						ChargePointVendor: "VPP",
						ChargePointModel:  "ConformanceSimulator",
					})
					if err != nil {
						return nil, err
					}
					if frame.Result == nil {
						return frame, errors.New("BootNotification was not answered with a CALLRESULT")
					}
					var resp ocpp16.BootNotificationResponse
					if err := json.Unmarshal(frame.Result.Payload, &resp); err != nil {
						return frame.Result, fmt.Errorf("decode response: %w", err)
					}
					if resp.Status == "" {
						return resp, errors.New("response carries no registration status")
					}
					if resp.CurrentTime == "" {
						return resp, errors.New("response carries no currentTime, so the station cannot set its clock")
					}
					if resp.Interval <= 0 {
						return resp, fmt.Errorf("response heartbeat interval is %d; a station would never heartbeat", resp.Interval)
					}
					return resp, nil
				},
			},
			{
				ID:          "ocpp16-004-malformed-frame-call-error",
				Name:        "A malformed frame is answered with a FormationViolation CALLERROR",
				Requirement: "OCPP-J 1.6 §4.2.3: a message that cannot be parsed must produce a CALLERROR, never a CALLRESULT",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*ocpp16Peer)
					// Valid JSON, invalid frame: three elements but the payload is
					// not an object, so it cannot be decoded as any action.
					frame, err := peer.raw([]byte(`[2,"bad-frame","BootNotification","not-an-object"]`), "bad-frame")
					if err != nil {
						return nil, err
					}
					if frame.Error == nil {
						return frame, errors.New("malformed frame did not produce a CALLERROR")
					}
					if frame.Error.ErrorCode != ocpp16.ErrFormationViolation &&
						frame.Error.ErrorCode != ocpp16.ErrPropertyConstraintViolation {
						return frame.Error, fmt.Errorf("CALLERROR code is %q, expected a formation or property constraint violation", frame.Error.ErrorCode)
					}
					return frame.Error, nil
				},
			},
			{
				ID:          "ocpp16-005-unknown-action-not-implemented",
				Name:        "An unimplemented action is refused with NotImplemented",
				Requirement: "OCPP-J 1.6 §4.2.3: an unsupported action must be answered NotImplemented rather than silently accepted",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*ocpp16Peer)
					frame, err := peer.call("DiagnosticsStatusNotification", map[string]string{"status": "Idle"})
					if err != nil {
						return nil, err
					}
					if frame.Error == nil {
						return frame, errors.New("an unimplemented action was answered as if it had been handled")
					}
					if frame.Error.ErrorCode != ocpp16.ErrNotImplemented {
						return frame.Error, fmt.Errorf("CALLERROR code is %q, expected NotImplemented", frame.Error.ErrorCode)
					}
					return frame.Error, nil
				},
			},
			{
				ID:          "ocpp16-006-authorize-blocked-tag",
				Name:        "A blocked idTag is reported blocked, not accepted",
				Requirement: "OCPP 1.6 §4.3: the central system's authorization decision is returned verbatim; a station must be able to refuse energy",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*ocpp16Peer)
					frame, err := peer.call("Authorize", ocpp16.AuthorizeRequest{IdTag: "BLOCKED-TAG"})
					if err != nil {
						return nil, err
					}
					if frame.Result == nil {
						return frame, errors.New("Authorize was not answered with a CALLRESULT")
					}
					var resp ocpp16.AuthorizeResponse
					if err := json.Unmarshal(frame.Result.Payload, &resp); err != nil {
						return frame.Result, err
					}
					if resp.IdTagInfo.Status != "Blocked" {
						return resp, fmt.Errorf("blocked tag was answered %q", resp.IdTagInfo.Status)
					}
					return resp, nil
				},
			},
			{
				ID:          "ocpp16-007-transaction-lifecycle",
				Name:        "StartTransaction returns an id the stop message can cite",
				Requirement: "OCPP 1.6 §4.8/4.10: the central system owns transaction identity and the station echoes it on stop",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*ocpp16Peer)
					startFrame, err := peer.call("StartTransaction", ocpp16.StartTransactionRequest{
						ConnectorID: 1,
						IdTag:       "CONF-TAG",
						MeterStart:  1000,
						Timestamp:   time.Now().UTC().Format(time.RFC3339),
					})
					if err != nil {
						return nil, err
					}
					if startFrame.Result == nil {
						return startFrame, errors.New("StartTransaction was not answered with a CALLRESULT")
					}
					var start ocpp16.StartTransactionResponse
					if err := json.Unmarshal(startFrame.Result.Payload, &start); err != nil {
						return startFrame.Result, err
					}
					if start.TransactionID <= 0 {
						return start, fmt.Errorf("transaction id is %d; the station has nothing to cite on stop", start.TransactionID)
					}

					stopFrame, err := peer.call("StopTransaction", ocpp16.StopTransactionRequest{
						TransactionID: start.TransactionID,
						MeterStop:     4200,
						Timestamp:     time.Now().UTC().Format(time.RFC3339),
					})
					if err != nil {
						return start, err
					}
					if stopFrame.Result == nil {
						return stopFrame, errors.New("StopTransaction was not answered with a CALLRESULT")
					}
					return map[string]any{"transaction_id": start.TransactionID}, nil
				},
			},
			{
				ID:          "ocpp16-008-meter-values-preserved",
				Name:        "Meter values reach the platform with their unit and measurand intact",
				Requirement: "OCPP 1.6 §4.7: sampled values carry measurand and unit; dropping either turns Wh into W somewhere downstream",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*ocpp16Peer)
					frame, err := peer.call("MeterValues", ocpp16.MeterValuesRequest{
						ConnectorID: 1,
						MeterValue: []ocpp16.MeterValue{{
							Timestamp: time.Now().UTC().Format(time.RFC3339),
							SampledValue: []ocpp16.SampledValue{{
								Value:     "7350.5",
								Measurand: "Energy.Active.Import.Register",
								Unit:      "Wh",
							}},
						}},
					})
					if err != nil {
						return nil, err
					}
					if frame.Result == nil {
						return frame, errors.New("MeterValues was not answered with a CALLRESULT")
					}

					peer.backend.mu.Lock()
					defer peer.backend.mu.Unlock()
					if len(peer.backend.meterValues) == 0 {
						return nil, errors.New("the central system answered but delivered nothing to the platform")
					}
					delivered := peer.backend.meterValues[len(peer.backend.meterValues)-1]
					sample := delivered.MeterValue[0].SampledValue[0]
					if sample.Unit != "Wh" || sample.Measurand != "Energy.Active.Import.Register" {
						return sample, fmt.Errorf("sample reached the platform as measurand=%q unit=%q", sample.Measurand, sample.Unit)
					}
					if sample.Value != "7350.5" {
						return sample, fmt.Errorf("sample value arrived as %q", sample.Value)
					}
					return sample, nil
				},
			},
			{
				ID:          "ocpp16-009-charging-profile-rejection-surfaces",
				Name:        "A station's rejection of a charging profile is reported as a rejection",
				Requirement: "OCPP 1.6 §5.16: SetChargingProfile returns the station's status; reporting Accepted for a rejected limit would leave a setpoint nobody is holding",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*ocpp16Peer)
					conn, err := peer.session()
					if err != nil {
						return nil, err
					}
					peer.setAnswer(func(call *ocpp16.Call) (any, *ocpp16.CallError) {
						if call.Action == "SetChargingProfile" {
							return map[string]string{"status": "Rejected"}, nil
						}
						return map[string]string{"status": "Accepted"}, nil
					})
					defer peer.setAnswer(nil)
					peer.serve(ctx, conn)

					resp, err := peer.central.SetChargingProfile(ctx, ocpp16StationID, ocpp16.SetChargingProfileRequest{
						ConnectorID: 1,
						CsChargingProfiles: ocpp16.ChargingProfile{
							ChargingProfileID:      7,
							StackLevel:             1,
							ChargingProfilePurpose: "TxDefaultProfile",
							ChargingProfileKind:    "Absolute",
							ChargingSchedule: ocpp16.ChargingSchedule{
								ChargingRateUnit:       "W",
								ChargingSchedulePeriod: []ocpp16.ChargingSchedulePeriod{{StartPeriod: 0, Limit: 3300}},
							},
						},
					})
					if err != nil {
						return nil, fmt.Errorf("SetChargingProfile: %w", err)
					}
					if resp.Status != "Rejected" {
						return resp, fmt.Errorf("station rejected the profile but the central system reported %q", resp.Status)
					}
					return resp, nil
				},
			},
			{
				ID:          "ocpp16-010-call-error-from-station-is-an-error",
				Name:        "A CALLERROR from the station fails the command",
				Requirement: "OCPP-J 1.6 §4.2.3: a CALLERROR is a failure; treating it as a result would report a dispatch that never happened",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*ocpp16Peer)
					conn, err := peer.session()
					if err != nil {
						return nil, err
					}
					peer.setAnswer(func(_ *ocpp16.Call) (any, *ocpp16.CallError) {
						return nil, &ocpp16.CallError{
							ErrorCode:        ocpp16.ErrNotImplemented,
							ErrorDescription: "this station does not implement remote start",
						}
					})
					defer peer.setAnswer(nil)
					peer.serve(ctx, conn)

					_, err = peer.central.RemoteStartTransaction(ctx, ocpp16StationID, ocpp16.RemoteStartTransactionRequest{
						IdTag: "CONF-TAG",
					})
					if err == nil {
						return nil, errors.New("a station CALLERROR was reported to the caller as success")
					}
					return map[string]string{"error": err.Error()}, nil
				},
			},
		},
	}
}
