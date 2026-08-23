package ocpp201

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sirupsen/logrus"

	"github.com/vpp/grid-protocols/internal/ocppj"
)

// Subprotocol is the WebSocket subprotocol a 2.0.1 station must offer.
const Subprotocol = "ocpp2.0.1"

// ErrNotConnected is returned when a command targets a station with no open
// session. Commands are never buffered and reported as sent.
var ErrNotConnected = ocppj.ErrNotConnected

// Backend is the platform side of the CSMS. Every authorization and transaction
// decision comes from there: this service has no local allow-list and never
// invents an acceptance or an authorization status.
//
// TransactionEvent returns the platform's response, which may carry an
// idTokenInfo when the station asked for authorization as part of the event.
type Backend interface {
	BootNotification201(ctx context.Context, stationID string, req BootNotificationRequest) (BootNotificationResponse, error)
	Heartbeat201(ctx context.Context, stationID string) error
	StatusNotification201(ctx context.Context, stationID string, req StatusNotificationRequest) error
	MeterValues201(ctx context.Context, stationID string, req MeterValuesRequest) error
	Authorize201(ctx context.Context, stationID string, req AuthorizeRequest) (AuthorizeResponse, error)
	TransactionEvent201(ctx context.Context, stationID string, req TransactionEventRequest) (TransactionEventResponse, error)
}

// Options configures the CSMS.
type Options struct {
	// Authenticate runs before the WebSocket upgrade; returning an error rejects
	// the connection. Required, as an open CSMS would accept transactions from
	// any host that can reach it.
	Authenticate func(r *http.Request, stationID string) error
	// HeartbeatInterval is advertised in BootNotification responses.
	HeartbeatInterval time.Duration
	// CallTimeout bounds how long an outbound command waits for its CALLRESULT.
	CallTimeout time.Duration
	// ReadLimit caps inbound frame size.
	ReadLimit int64
	// OnSessionOpen is called after a session is registered; the control
	// supervisor uses it to re-assert the safe fallback profile, because a
	// station that rebooted may hold no profiles.
	OnSessionOpen func(stationID string)
	Logger        *logrus.Logger
}

func (o Options) withDefaults() Options {
	if o.HeartbeatInterval <= 0 {
		o.HeartbeatInterval = 5 * time.Minute
	}
	if o.CallTimeout <= 0 {
		o.CallTimeout = 30 * time.Second
	}
	if o.ReadLimit <= 0 {
		o.ReadLimit = 1 << 20
	}
	if o.Logger == nil {
		o.Logger = logrus.StandardLogger()
	}
	return o
}

// CSMS terminates OCPP 2.0.1 charging station sessions and issues commands back
// to them.
type CSMS struct {
	backend  Backend
	opts     Options
	upgrader websocket.Upgrader
	sessions *ocppj.Registry
}

func NewCSMS(backend Backend, opts Options) (*CSMS, error) {
	if backend == nil {
		return nil, errors.New("backend is required: the CSMS cannot decide authorization on its own")
	}
	opts = opts.withDefaults()
	if opts.Authenticate == nil {
		return nil, errors.New("Options.Authenticate is required: an open CSMS accepts transactions from anyone")
	}
	return &CSMS{
		backend:  backend,
		opts:     opts,
		sessions: ocppj.NewRegistry(),
		upgrader: websocket.Upgrader{
			Subprotocols:    []string{Subprotocol},
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
		},
	}, nil
}

// ConnectedChargePoints lists the stations with an open 2.0.1 session.
func (cs *CSMS) ConnectedChargePoints() []string { return cs.sessions.IDs() }

// ServeHTTP upgrades /ocpp/<stationId> to an OCPP 2.0.1 session. A station that
// does not offer the ocpp2.0.1 subprotocol is rejected rather than parsed as
// some other version: the two message sets share field names with different
// meanings, so guessing would misread transactions.
func (cs *CSMS) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	stationID := strings.Trim(strings.TrimPrefix(r.URL.Path, "/ocpp"), "/")
	if stationID == "" || strings.Contains(stationID, "/") {
		http.Error(w, "path must be /ocpp/<stationId>", http.StatusNotFound)
		return
	}
	if !HasSubprotocol(r) {
		http.Error(w, "ocpp2.0.1 subprotocol required", http.StatusBadRequest)
		return
	}
	cs.Serve(w, r, stationID)
}

// Serve runs a 2.0.1 session for an already-routed station identity. The version
// mux calls this once it has picked 2.0.1 out of the offered subprotocols.
func (cs *CSMS) Serve(w http.ResponseWriter, r *http.Request, stationID string) {
	if err := cs.opts.Authenticate(r, stationID); err != nil {
		cs.opts.Logger.WithError(err).WithField("station", stationID).Warn("rejected OCPP 2.0.1 connection")
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := cs.upgrader.Upgrade(w, r, nil)
	if err != nil {
		cs.opts.Logger.WithError(err).Warn("OCPP 2.0.1 upgrade failed")
		return
	}
	conn.SetReadLimit(cs.opts.ReadLimit)

	sess := ocppj.NewSession(stationID, conn, cs,
		cs.opts.Logger.WithFields(logrus.Fields{"charge_point": stationID, "ocpp_version": "2.0.1"}))
	cs.sessions.Add(sess)
	sess.Logger().Info("OCPP 2.0.1 session opened")
	if cs.opts.OnSessionOpen != nil {
		// Asynchronous: the hook commands the station over this very session,
		// which cannot be served until the read loop starts.
		go cs.opts.OnSessionOpen(stationID)
	}
	defer func() {
		cs.sessions.Remove(sess)
		sess.Logger().Info("OCPP 2.0.1 session closed")
	}()

	sess.ReadLoop(r.Context())
}

// HasSubprotocol reports whether the request offers the 2.0.1 subprotocol.
func HasSubprotocol(r *http.Request) bool {
	return ocppj.HasSubprotocol(r, Subprotocol)
}

// Call sends a command and waits for its CALLRESULT. A CALLERROR is returned as
// an error, so a rejected command is never mistaken for an applied one.
func (cs *CSMS) Call(ctx context.Context, stationID, action string, payload any) (json.RawMessage, error) {
	sess, err := cs.sessions.Get(stationID)
	if err != nil {
		return nil, err
	}
	return sess.Call(ctx, action, payload, cs.opts.CallTimeout)
}

// RequestStartTransaction asks the station to start charging. In 2.0.1 the
// station decides the transaction id, so acceptance here is not a transaction:
// the transaction exists once a TransactionEvent(Started) arrives.
func (cs *CSMS) RequestStartTransaction(ctx context.Context, stationID string, req RequestStartTransactionRequest) (StatusResponse, error) {
	return callStatus(ctx, cs, stationID, ActionRequestStartTransaction, req)
}

// RequestStopTransaction asks the station to stop a transaction it named.
func (cs *CSMS) RequestStopTransaction(ctx context.Context, stationID string, req RequestStopTransactionRequest) (StatusResponse, error) {
	return callStatus(ctx, cs, stationID, ActionRequestStopTransaction, req)
}

// SetChargingProfile applies a power/current limit schedule; negative limits
// discharge V2G-capable equipment.
func (cs *CSMS) SetChargingProfile(ctx context.Context, stationID string, req SetChargingProfileRequest) (StatusResponse, error) {
	return callStatus(ctx, cs, stationID, ActionSetChargingProfile, req)
}

// ClearChargingProfile revokes previously installed profiles. `Unknown` means
// the station holds no matching profile, a valid end state for a revocation, and
// is returned rather than treated as a failure.
func (cs *CSMS) ClearChargingProfile(ctx context.Context, stationID string, req ClearChargingProfileRequest) (StatusResponse, error) {
	return callStatus(ctx, cs, stationID, ActionClearChargingProfile, req)
}

// TriggerMessage requests an unsolicited message from the station.
func (cs *CSMS) TriggerMessage(ctx context.Context, stationID string, req TriggerMessageRequest) (StatusResponse, error) {
	return callStatus(ctx, cs, stationID, ActionTriggerMessage, req)
}

// Reset reboots the station or one of its EVSEs.
func (cs *CSMS) Reset(ctx context.Context, stationID string, req ResetRequest) (StatusResponse, error) {
	return callStatus(ctx, cs, stationID, ActionReset, req)
}

// GetVariables reads station configuration. Results are returned as the station
// reported them, including per-variable statuses: a variable the station refused
// is not reported as read.
func (cs *CSMS) GetVariables(ctx context.Context, stationID string, req GetVariablesRequest) (GetVariablesResponse, error) {
	raw, err := cs.Call(ctx, stationID, ActionGetVariables, req)
	if err != nil {
		return GetVariablesResponse{}, err
	}
	var resp GetVariablesResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return GetVariablesResponse{}, fmt.Errorf("%s response is not a GetVariablesResponse: %w", ActionGetVariables, err)
	}
	if len(resp.GetVariableResult) != len(req.GetVariableData) {
		return GetVariablesResponse{}, fmt.Errorf("%s returned %d results for %d requested variables",
			ActionGetVariables, len(resp.GetVariableResult), len(req.GetVariableData))
	}
	return resp, nil
}

// SetVariables writes station configuration.
func (cs *CSMS) SetVariables(ctx context.Context, stationID string, req SetVariablesRequest) (SetVariablesResponse, error) {
	raw, err := cs.Call(ctx, stationID, ActionSetVariables, req)
	if err != nil {
		return SetVariablesResponse{}, err
	}
	var resp SetVariablesResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return SetVariablesResponse{}, fmt.Errorf("%s response is not a SetVariablesResponse: %w", ActionSetVariables, err)
	}
	if len(resp.SetVariableResult) != len(req.SetVariableData) {
		return SetVariablesResponse{}, fmt.Errorf("%s returned %d results for %d written variables",
			ActionSetVariables, len(resp.SetVariableResult), len(req.SetVariableData))
	}
	return resp, nil
}

func callStatus(ctx context.Context, cs *CSMS, stationID, action string, payload any) (StatusResponse, error) {
	raw, err := cs.Call(ctx, stationID, action, payload)
	if err != nil {
		return StatusResponse{}, err
	}
	var status StatusResponse
	if err := json.Unmarshal(raw, &status); err != nil {
		return StatusResponse{}, fmt.Errorf("%s response is not a status: %w", action, err)
	}
	if status.Status == "" {
		return StatusResponse{}, fmt.Errorf("%s response has no status field", action)
	}
	return status, nil
}

// dispatch routes an inbound call to the backend. Backend failures surface as
// CALLERROR, which makes the station retry (and buffer, per 2.0.1's offline
// behaviour); answering "Accepted" on a failed platform lookup would authorize
// energy nobody agreed to pay for.
func (cs *CSMS) Dispatch(ctx context.Context, stationID string, call *ocppj.Call) (any, error) {
	switch call.Action {
	case ActionBootNotification:
		var req BootNotificationRequest
		if err := decodeStrict(call.Payload, &req); err != nil {
			return nil, err
		}
		if req.ChargingStation.VendorName == "" || req.ChargingStation.Model == "" {
			return nil, violation("chargingStation.vendorName and chargingStation.model are required")
		}
		if req.Reason == "" {
			return nil, violation("reason is required")
		}
		resp, err := cs.backend.BootNotification201(ctx, stationID, req)
		if err != nil {
			return nil, err
		}
		if resp.Status == "" {
			return nil, errors.New("platform returned no registration status")
		}
		if resp.CurrentTime == "" {
			resp.CurrentTime = utcNow()
		}
		if resp.Interval == 0 {
			resp.Interval = int(cs.opts.HeartbeatInterval.Seconds())
		}
		return resp, nil

	case ActionHeartbeat:
		if err := cs.backend.Heartbeat201(ctx, stationID); err != nil {
			return nil, err
		}
		return HeartbeatResponse{CurrentTime: utcNow()}, nil

	case ActionStatusNotification:
		var req StatusNotificationRequest
		if err := decodeStrict(call.Payload, &req); err != nil {
			return nil, err
		}
		if req.ConnectorStatus == "" || req.Timestamp == "" {
			return nil, violation("connectorStatus and timestamp are required")
		}
		if !validConnectorStatus(req.ConnectorStatus) {
			return nil, violation("connectorStatus must be one of " + strings.Join(connectorStatuses[:], ", "))
		}
		if req.EvseID <= 0 || req.ConnectorID <= 0 {
			return nil, violation("evseId and connectorId must be positive")
		}
		if err := cs.backend.StatusNotification201(ctx, stationID, req); err != nil {
			return nil, err
		}
		return struct{}{}, nil

	case ActionMeterValues:
		var req MeterValuesRequest
		if err := decodeStrict(call.Payload, &req); err != nil {
			return nil, err
		}
		if len(req.MeterValue) == 0 {
			return nil, violation("meterValue must not be empty")
		}
		if err := cs.backend.MeterValues201(ctx, stationID, req); err != nil {
			return nil, err
		}
		return struct{}{}, nil

	case ActionAuthorize:
		var req AuthorizeRequest
		if err := decodeStrict(call.Payload, &req); err != nil {
			return nil, err
		}
		if req.IDToken.IDToken == "" || req.IDToken.Type == "" {
			return nil, violation("idToken.idToken and idToken.type are required")
		}
		resp, err := cs.backend.Authorize201(ctx, stationID, req)
		if err != nil {
			return nil, err
		}
		if resp.IDTokenInfo.Status == "" {
			return nil, errors.New("platform returned no authorization status")
		}
		return resp, nil

	case ActionTransactionEvent:
		var req TransactionEventRequest
		if err := decodeStrict(call.Payload, &req); err != nil {
			return nil, err
		}
		if err := validateTransactionEvent(req); err != nil {
			return nil, err
		}
		resp, err := cs.backend.TransactionEvent201(ctx, stationID, req)
		if err != nil {
			return nil, err
		}
		// A Started event that asked for authorization must come back with a
		// decision; an empty response would let the station charge on its own
		// judgement while the platform believes it authorized nothing.
		if req.EventType == TransactionEventStarted && req.IDToken != nil && resp.IDTokenInfo == nil {
			return nil, errors.New("platform returned no idTokenInfo for an authorizing transaction event")
		}
		return resp, nil

	default:
		return nil, &ocppj.CallError{
			ErrorCode:        ErrNotImplemented,
			ErrorDescription: "action " + call.Action + " is not implemented",
		}
	}
}

func validateTransactionEvent(req TransactionEventRequest) error {
	switch req.EventType {
	case TransactionEventStarted, TransactionEventUpdated, TransactionEventEnded:
	case "":
		return violation("eventType is required")
	default:
		return violation("unknown eventType " + req.EventType)
	}
	if req.Timestamp == "" {
		return violation("timestamp is required")
	}
	if req.TriggerReason == "" {
		return violation("triggerReason is required")
	}
	// The station owns transaction identity; without its id the event cannot be
	// attached to a session, and inventing one would detach charged energy from
	// its billing record.
	if strings.TrimSpace(req.TransactionInfo.TransactionID) == "" {
		return violation("transactionInfo.transactionId is required")
	}
	// seqNo is what makes replay after an offline period detectable. A negative
	// value would make ordering meaningless.
	if req.SeqNo < 0 {
		return violation("seqNo must not be negative")
	}
	if req.EventType == TransactionEventStarted && req.Evse == nil {
		return violation("evse is required on a Started event")
	}
	return nil
}

func violation(description string) error {
	return &ocppj.CallError{ErrorCode: ErrPropertyConstraintViolation, ErrorDescription: description}
}

// ErrorCodeForMalformedFrame is 2.0.1's spelling of the format error code:
// FormatViolation, where 1.6 says FormationViolation.
func (cs *CSMS) ErrorCodeForMalformedFrame() string { return ErrFormatViolation }

// decodeStrict rejects unknown fields so a station speaking a different profile
// is not silently half-understood.
func decodeStrict(payload json.RawMessage, target any) error {
	return ocppj.DecodeStrict(payload, target, ErrFormatViolation)
}
