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

	"github.com/vpp/grid-protocols/internal/ocpp201"
	"github.com/vpp/grid-protocols/internal/ocppj"
)

// The OCPP 2.0.1 vector set exercises what actually differs from 1.6, because
// that is where a shared implementation goes quietly wrong: the station owns
// transaction identity, TransactionEvent replaces Start/StopTransaction,
// sampled values carry a power-of-ten multiplier, the format error code is
// spelled FormatViolation, and connector statuses are a different enumeration.

type ocpp201Peer struct {
	*wsPeer
	csms    *ocpp201.CSMS
	backend *ocpp201Backend
}

type ocpp201Backend struct {
	mu          sync.Mutex
	meterValues []ocpp201.MeterValuesRequest
	events      []ocpp201.TransactionEventRequest
	statuses    []ocpp201.StatusNotificationRequest
}

func (b *ocpp201Backend) BootNotification201(_ context.Context, _ string, _ ocpp201.BootNotificationRequest) (ocpp201.BootNotificationResponse, error) {
	return ocpp201.BootNotificationResponse{Status: ocpp201.RegistrationAccepted}, nil
}

func (b *ocpp201Backend) Heartbeat201(_ context.Context, _ string) error { return nil }

func (b *ocpp201Backend) StatusNotification201(_ context.Context, _ string, req ocpp201.StatusNotificationRequest) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.statuses = append(b.statuses, req)
	return nil
}

func (b *ocpp201Backend) MeterValues201(_ context.Context, _ string, req ocpp201.MeterValuesRequest) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.meterValues = append(b.meterValues, req)
	return nil
}

func (b *ocpp201Backend) Authorize201(_ context.Context, _ string, req ocpp201.AuthorizeRequest) (ocpp201.AuthorizeResponse, error) {
	if req.IDToken.IDToken == "BLOCKED-TOKEN" {
		return ocpp201.AuthorizeResponse{IDTokenInfo: ocpp201.IDTokenInfo{Status: ocpp201.AuthBlocked}}, nil
	}
	return ocpp201.AuthorizeResponse{IDTokenInfo: ocpp201.IDTokenInfo{Status: ocpp201.AuthAccepted}}, nil
}

func (b *ocpp201Backend) TransactionEvent201(_ context.Context, _ string, req ocpp201.TransactionEventRequest) (ocpp201.TransactionEventResponse, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.events = append(b.events, req)
	if req.IDToken != nil {
		return ocpp201.TransactionEventResponse{
			IDTokenInfo: &ocpp201.IDTokenInfo{Status: ocpp201.AuthAccepted},
		}, nil
	}
	return ocpp201.TransactionEventResponse{}, nil
}

const ocpp201StationID = "CONFORMANCE-CS-1"

func newOCPP201Peer() (*ocpp201Peer, func(), error) {
	backend := &ocpp201Backend{}
	csms, err := ocpp201.NewCSMS(backend, ocpp201.Options{
		Authenticate: func(_ *http.Request, stationID string) error {
			if stationID != ocpp201StationID {
				return fmt.Errorf("unknown station %q", stationID)
			}
			return nil
		},
		CallTimeout: 5 * time.Second,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("csms: %w", err)
	}

	server := httptest.NewServer(csms)
	peer := &ocpp201Peer{
		wsPeer:  newWSPeer(server, ocpp201.Subprotocol, ocpp201StationID),
		csms:    csms,
		backend: backend,
	}
	return peer, func() {
		peer.close()
		server.Close()
	}, nil
}

// OCPP201Suite is the OCPP 2.0.1 vector set.
func OCPP201Suite() Suite {
	return Suite{
		Adapter:          AdapterOCPP201,
		VectorSetID:      "vpp-ocpp201-core",
		VectorSetVersion: "1",
		ProtocolVersion:  "2.0.1",
		DeviceModel:      "vpp-ocpp201-station-simulator",
		Setup: func(_ context.Context) (*Env, func(), error) {
			peer, teardown, err := newOCPP201Peer()
			if err != nil {
				return nil, nil, err
			}
			return &Env{Peer: peer, Target: TargetSimulator}, teardown, nil
		},
		Cases: []Case{
			{
				ID:          "ocpp201-001-subprotocol-required",
				Name:        "A station offering only ocpp1.6 is refused by the 2.0.1 endpoint",
				Requirement: "OCPP 2.0.1 part 4 §3.1.2: the subprotocol selects the message set; 1.6 and 2.0.1 share field names with different meanings",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*ocpp201Peer)
					conn, resp, err := peer.dial([]string{"ocpp1.6"}, ocpp201StationID)
					if err == nil {
						_ = conn.Close()
						return nil, errors.New("the 2.0.1 endpoint accepted a station offering only ocpp1.6")
					}
					status := 0
					if resp != nil {
						status = resp.StatusCode
					}
					return map[string]any{"http_status": status}, nil
				},
			},
			{
				ID:          "ocpp201-002-boot-notification",
				Name:        "BootNotification is answered with a 2.0.1 registration status and interval",
				Requirement: "OCPP 2.0.1 part 2 §B01: the response carries status, currentTime and interval",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*ocpp201Peer)
					frame, err := peer.call(ocpp201.ActionBootNotification, ocpp201.BootNotificationRequest{
						Reason: "PowerUp",
						ChargingStation: ocpp201.ChargingStation{
							Model:      "ConformanceSimulator",
							VendorName: "VPP",
						},
					})
					if err != nil {
						return nil, err
					}
					if frame.Result == nil {
						return frame, errors.New("BootNotification was not answered with a CALLRESULT")
					}
					var resp ocpp201.BootNotificationResponse
					if err := json.Unmarshal(frame.Result.Payload, &resp); err != nil {
						return frame.Result, err
					}
					if resp.Status != ocpp201.RegistrationAccepted {
						return resp, fmt.Errorf("registration status is %q", resp.Status)
					}
					if resp.Interval <= 0 || resp.CurrentTime == "" {
						return resp, errors.New("response is missing currentTime or a positive interval")
					}
					return resp, nil
				},
			},
			{
				ID:          "ocpp201-003-format-violation-code",
				Name:        "A malformed frame is answered FormatViolation, not 1.6's FormationViolation",
				Requirement: "OCPP 2.0.1 part 4 §4.2.3: the code is FormatViolation; a 1.6 code sent to a 2.0.1 station is a protocol error, not a synonym",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*ocpp201Peer)
					frame, err := peer.raw([]byte(`[2,"bad-201","BootNotification","not-an-object"]`), "bad-201")
					if err != nil {
						return nil, err
					}
					if frame.Error == nil {
						return frame, errors.New("malformed frame did not produce a CALLERROR")
					}
					if frame.Error.ErrorCode == "FormationViolation" {
						return frame.Error, errors.New("the 2.0.1 endpoint answered with 1.6's FormationViolation code")
					}
					if frame.Error.ErrorCode != ocpp201.ErrFormatViolation &&
						frame.Error.ErrorCode != ocpp201.ErrPropertyConstraintViolation &&
						frame.Error.ErrorCode != ocpp201.ErrTypeConstraintViolation {
						return frame.Error, fmt.Errorf("CALLERROR code is %q", frame.Error.ErrorCode)
					}
					return frame.Error, nil
				},
			},
			{
				ID:          "ocpp201-004-transaction-id-owned-by-station",
				Name:        "The station's transactionId is stored, not replaced by a server id",
				Requirement: "OCPP 2.0.1 part 2 §E01: the charging station generates transactionId; a CSMS-invented id would detach charged energy from its billing record",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*ocpp201Peer)
					stationTxID := "STATION-TX-9f3c"
					evseID := 1
					connector := 1
					frame, err := peer.call(ocpp201.ActionTransactionEvent, ocpp201.TransactionEventRequest{
						EventType:     ocpp201.TransactionEventStarted,
						Timestamp:     time.Now().UTC().Format(time.RFC3339),
						TriggerReason: "Authorized",
						SeqNo:         0,
						TransactionInfo: ocpp201.TransactionInfo{
							TransactionID: stationTxID,
							ChargingState: "Charging",
						},
						Evse:    &ocpp201.EVSE{ID: evseID, ConnectorID: &connector},
						IDToken: &ocpp201.IDToken{IDToken: "CONF-TOKEN", Type: "ISO14443"},
					})
					if err != nil {
						return nil, err
					}
					if frame.Result == nil {
						return frame, errors.New("TransactionEvent was not answered with a CALLRESULT")
					}

					peer.backend.mu.Lock()
					defer peer.backend.mu.Unlock()
					if len(peer.backend.events) == 0 {
						return nil, errors.New("the CSMS answered but delivered no transaction event to the platform")
					}
					delivered := peer.backend.events[len(peer.backend.events)-1]
					if delivered.TransactionInfo.TransactionID != stationTxID {
						return delivered.TransactionInfo, fmt.Errorf(
							"transaction reached the platform as %q, not the station's %q",
							delivered.TransactionInfo.TransactionID, stationTxID)
					}
					var resp ocpp201.TransactionEventResponse
					if err := json.Unmarshal(frame.Result.Payload, &resp); err != nil {
						return frame.Result, err
					}
					if resp.IDTokenInfo == nil || resp.IDTokenInfo.Status != ocpp201.AuthAccepted {
						return resp, errors.New("an event carrying an idToken was not answered with an authorization status")
					}
					return map[string]any{"transaction_id": delivered.TransactionInfo.TransactionID}, nil
				},
			},
			{
				ID:          "ocpp201-005-transaction-event-requires-identity",
				Name:        "A transaction event with no transactionId is refused",
				Requirement: "OCPP 2.0.1 part 2 §E01: transactionInfo.transactionId is required; accepting the event would attach energy to no session",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*ocpp201Peer)
					frame, err := peer.call(ocpp201.ActionTransactionEvent, ocpp201.TransactionEventRequest{
						EventType:     ocpp201.TransactionEventUpdated,
						Timestamp:     time.Now().UTC().Format(time.RFC3339),
						TriggerReason: "MeterValuePeriodic",
						SeqNo:         3,
					})
					if err != nil {
						return nil, err
					}
					if frame.Error == nil {
						return frame, errors.New("an event with no transaction identity was accepted")
					}
					return frame.Error, nil
				},
			},
			{
				ID:          "ocpp201-006-negative-seqno-refused",
				Name:        "A negative seqNo is refused",
				Requirement: "OCPP 2.0.1 part 2 §E01: seqNo orders events and makes offline replay detectable; a negative value makes ordering meaningless",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*ocpp201Peer)
					frame, err := peer.call(ocpp201.ActionTransactionEvent, ocpp201.TransactionEventRequest{
						EventType:       ocpp201.TransactionEventUpdated,
						Timestamp:       time.Now().UTC().Format(time.RFC3339),
						TriggerReason:   "MeterValuePeriodic",
						SeqNo:           -1,
						TransactionInfo: ocpp201.TransactionInfo{TransactionID: "STATION-TX-9f3c"},
					})
					if err != nil {
						return nil, err
					}
					if frame.Error == nil {
						return frame, errors.New("a negative seqNo was accepted")
					}
					return frame.Error, nil
				},
			},
			{
				ID:          "ocpp201-007-meter-multiplier-preserved",
				Name:        "A sampled value's unit multiplier reaches the platform",
				Requirement: "OCPP 2.0.1 part 2 §J01: unitOfMeasure carries a power-of-ten multiplier; ignoring it misreads kWh as Wh",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*ocpp201Peer)
					multiplier := 3
					frame, err := peer.call(ocpp201.ActionMeterValues, ocpp201.MeterValuesRequest{
						EvseID: 1,
						MeterValue: []ocpp201.MeterValue{{
							Timestamp: time.Now().UTC().Format(time.RFC3339),
							SampledValue: []ocpp201.SampledValue{{
								Value:         7.35,
								Measurand:     "Energy.Active.Import.Register",
								UnitOfMeasure: &ocpp201.UnitOfMeasure{Unit: "Wh", Multiplier: &multiplier},
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
						return nil, errors.New("the CSMS answered but delivered nothing to the platform")
					}
					sample := peer.backend.meterValues[len(peer.backend.meterValues)-1].MeterValue[0].SampledValue[0]
					if sample.UnitOfMeasure == nil || sample.UnitOfMeasure.Multiplier == nil {
						return sample, errors.New("the multiplier was dropped on the way to the platform")
					}
					if *sample.UnitOfMeasure.Multiplier != multiplier {
						return sample, fmt.Errorf("multiplier arrived as %d", *sample.UnitOfMeasure.Multiplier)
					}
					if sample.Value != 7.35 {
						return sample, fmt.Errorf("value arrived as %v", sample.Value)
					}
					return sample, nil
				},
			},
			{
				ID:          "ocpp201-008-connector-status-enumeration",
				Name:        "A 1.6 connector status is refused by the 2.0.1 endpoint",
				Requirement: "OCPP 2.0.1 part 2 §G01: ConnectorStatusEnumType is Available/Occupied/Reserved/Unavailable/Faulted; 1.6's Charging is not a member",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*ocpp201Peer)
					frame, err := peer.call(ocpp201.ActionStatusNotification, ocpp201.StatusNotificationRequest{
						Timestamp:       time.Now().UTC().Format(time.RFC3339),
						ConnectorStatus: "Charging",
						EvseID:          1,
						ConnectorID:     1,
					})
					if err != nil {
						return nil, err
					}
					if frame.Error == nil {
						return frame, errors.New("a 1.6-only connector status was accepted as 2.0.1")
					}
					return frame.Error, nil
				},
			},
			{
				ID:          "ocpp201-009-blocked-token",
				Name:        "A blocked idToken is reported blocked",
				Requirement: "OCPP 2.0.1 part 2 §C01: the CSMS authorization decision is returned verbatim",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*ocpp201Peer)
					frame, err := peer.call(ocpp201.ActionAuthorize, ocpp201.AuthorizeRequest{
						IDToken: ocpp201.IDToken{IDToken: "BLOCKED-TOKEN", Type: "ISO14443"},
					})
					if err != nil {
						return nil, err
					}
					if frame.Result == nil {
						return frame, errors.New("Authorize was not answered with a CALLRESULT")
					}
					var resp ocpp201.AuthorizeResponse
					if err := json.Unmarshal(frame.Result.Payload, &resp); err != nil {
						return frame.Result, err
					}
					if resp.IDTokenInfo.Status != ocpp201.AuthBlocked {
						return resp, fmt.Errorf("a blocked token was answered %q", resp.IDTokenInfo.Status)
					}
					return resp, nil
				},
			},
			{
				ID:          "ocpp201-010-profile-rejection-surfaces",
				Name:        "A station's rejection of a charging profile is reported as a rejection",
				Requirement: "OCPP 2.0.1 part 2 §K01: SetChargingProfile returns the station's status; a fabricated Accepted leaves a limit nobody is holding",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*ocpp201Peer)
					conn, err := peer.session()
					if err != nil {
						return nil, err
					}
					peer.setAnswer(func(call *ocppj.Call) (any, *ocppj.CallError) {
						if call.Action == ocpp201.ActionSetChargingProfile {
							return map[string]string{"status": "Rejected"}, nil
						}
						return map[string]string{"status": "Accepted"}, nil
					})
					defer peer.setAnswer(nil)
					peer.serve(ctx, conn)

					resp, err := peer.csms.SetChargingProfile(ctx, ocpp201StationID, ocpp201.SetChargingProfileRequest{
						EvseID: 1,
						ChargingProfile: ocpp201.ChargingProfile{
							ID:                     11,
							StackLevel:             1,
							ChargingProfilePurpose: "TxDefaultProfile",
							ChargingProfileKind:    "Absolute",
							ChargingSchedule: []ocpp201.ChargingSchedule{{
								ID:               1,
								ChargingRateUnit: "W",
								ChargingSchedulePeriod: []ocpp201.ChargingSchedulePeriod{
									{StartPeriod: 0, Limit: 3300},
								},
							}},
						},
					})
					if err != nil {
						return nil, fmt.Errorf("SetChargingProfile: %w", err)
					}
					if resp.Status != "Rejected" {
						return resp, fmt.Errorf("station rejected the profile but the CSMS reported %q", resp.Status)
					}
					return resp, nil
				},
			},
		},
	}
}
