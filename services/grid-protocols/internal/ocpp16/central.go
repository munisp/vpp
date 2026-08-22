package ocpp16

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sirupsen/logrus"
)

// ErrNotConnected is returned when a command targets a charge point that has no
// open WebSocket session. Commands are never buffered and reported as sent: the
// caller has to know the charger did not receive it.
var ErrNotConnected = errors.New("charge point is not connected")

// Backend is the platform side of the central system. Every authorization and
// transaction decision comes from here — the central system has no local
// allow-list and never invents an acceptance, an id tag or a transaction id.
type Backend interface {
	BootNotification(ctx context.Context, chargePointID string, req BootNotificationRequest) (BootNotificationResponse, error)
	Heartbeat(ctx context.Context, chargePointID string) error
	StatusNotification(ctx context.Context, chargePointID string, req StatusNotificationRequest) error
	MeterValues(ctx context.Context, chargePointID string, req MeterValuesRequest) error
	Authorize(ctx context.Context, chargePointID string, req AuthorizeRequest) (AuthorizeResponse, error)
	StartTransaction(ctx context.Context, chargePointID string, req StartTransactionRequest) (StartTransactionResponse, error)
	StopTransaction(ctx context.Context, chargePointID string, req StopTransactionRequest) (StopTransactionResponse, error)
}

// Options configures the central system.
type Options struct {
	// Authenticate is called before the WebSocket upgrade. Returning an error
	// rejects the connection. Required: an unauthenticated central system would
	// accept transactions from any host that can reach it.
	Authenticate func(r *http.Request, chargePointID string) error
	// HeartbeatInterval is advertised in BootNotification responses.
	HeartbeatInterval time.Duration
	// CallTimeout bounds how long an outbound command waits for its CALLRESULT.
	CallTimeout time.Duration
	// ReadLimit caps inbound frame size.
	ReadLimit int64
	// OnSessionOpen is called after a charge point session is registered. The
	// control supervisor uses it to re-assert the safe fallback profile, because a
	// charge point that rebooted may have dropped every profile it held.
	OnSessionOpen func(chargePointID string)
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

// CentralSystem is an OCPP 1.6J central system: it terminates charge point
// WebSocket sessions and issues commands back to them.
type CentralSystem struct {
	backend  Backend
	opts     Options
	upgrader websocket.Upgrader

	mu       sync.RWMutex
	sessions map[string]*session
}

func NewCentralSystem(backend Backend, opts Options) (*CentralSystem, error) {
	if backend == nil {
		return nil, errors.New("backend is required: the central system cannot decide authorization on its own")
	}
	opts = opts.withDefaults()
	if opts.Authenticate == nil {
		return nil, errors.New("Options.Authenticate is required: an open central system accepts transactions from anyone")
	}
	return &CentralSystem{
		backend:  backend,
		opts:     opts,
		sessions: make(map[string]*session),
		upgrader: websocket.Upgrader{
			Subprotocols:    []string{"ocpp1.6"},
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
		},
	}, nil
}

// ConnectedChargePoints lists the charge points with an open session.
func (cs *CentralSystem) ConnectedChargePoints() []string {
	cs.mu.RLock()
	defer cs.mu.RUnlock()
	ids := make([]string, 0, len(cs.sessions))
	for id := range cs.sessions {
		ids = append(ids, id)
	}
	return ids
}

// ServeHTTP upgrades /ocpp/<chargePointId> to an OCPP 1.6J session.
func (cs *CentralSystem) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	chargePointID := strings.Trim(strings.TrimPrefix(r.URL.Path, "/ocpp"), "/")
	if chargePointID == "" || strings.Contains(chargePointID, "/") {
		http.Error(w, "path must be /ocpp/<chargePointId>", http.StatusNotFound)
		return
	}
	if err := cs.opts.Authenticate(r, chargePointID); err != nil {
		cs.opts.Logger.WithError(err).WithField("charge_point", chargePointID).Warn("rejected OCPP connection")
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	// A charge point that does not offer the ocpp1.6 subprotocol is speaking a
	// different version; guessing would misparse every payload.
	if !hasSubprotocol(r, "ocpp1.6") {
		http.Error(w, "ocpp1.6 subprotocol required", http.StatusBadRequest)
		return
	}

	conn, err := cs.upgrader.Upgrade(w, r, nil)
	if err != nil {
		cs.opts.Logger.WithError(err).Warn("OCPP upgrade failed")
		return
	}
	conn.SetReadLimit(cs.opts.ReadLimit)

	sess := &session{
		chargePointID: chargePointID,
		conn:          conn,
		pending:       make(map[string]chan *Frame),
		logger:        cs.opts.Logger.WithField("charge_point", chargePointID),
	}
	cs.register(sess)
	defer cs.unregister(sess)

	sess.readLoop(r.Context(), cs)
}

func hasSubprotocol(r *http.Request, want string) bool {
	for _, offered := range websocket.Subprotocols(r) {
		if strings.EqualFold(offered, want) {
			return true
		}
	}
	return false
}

func (cs *CentralSystem) register(s *session) {
	cs.mu.Lock()
	if existing, ok := cs.sessions[s.chargePointID]; ok {
		// One physical charge point, one session: drop the stale one so commands
		// cannot be written to a half-open socket.
		existing.close()
	}
	cs.sessions[s.chargePointID] = s
	cs.mu.Unlock()
	s.logger.Info("OCPP session opened")
	if cs.opts.OnSessionOpen != nil {
		// Asynchronous: the hook commands the charge point over this very session,
		// which cannot be served until readLoop starts.
		go cs.opts.OnSessionOpen(s.chargePointID)
	}
}

func (cs *CentralSystem) unregister(s *session) {
	cs.mu.Lock()
	if cs.sessions[s.chargePointID] == s {
		delete(cs.sessions, s.chargePointID)
	}
	cs.mu.Unlock()
	s.close()
	s.logger.Info("OCPP session closed")
}

func (cs *CentralSystem) session(chargePointID string) (*session, error) {
	cs.mu.RLock()
	defer cs.mu.RUnlock()
	s, ok := cs.sessions[chargePointID]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrNotConnected, chargePointID)
	}
	return s, nil
}

// Call sends a command to a charge point and waits for its CALLRESULT. A
// CALLERROR is returned as an error, so a rejected command is never mistaken
// for an applied one.
func (cs *CentralSystem) Call(ctx context.Context, chargePointID, action string, payload any) (json.RawMessage, error) {
	sess, err := cs.session(chargePointID)
	if err != nil {
		return nil, err
	}
	return sess.call(ctx, action, payload, cs.opts.CallTimeout)
}

// RemoteStartTransaction asks the charge point to start charging.
func (cs *CentralSystem) RemoteStartTransaction(ctx context.Context, chargePointID string, req RemoteStartTransactionRequest) (StatusResponse, error) {
	return callStatus(ctx, cs, chargePointID, ActionRemoteStartTransaction, req)
}

// RemoteStopTransaction asks the charge point to stop a transaction.
func (cs *CentralSystem) RemoteStopTransaction(ctx context.Context, chargePointID string, req RemoteStopTransactionRequest) (StatusResponse, error) {
	return callStatus(ctx, cs, chargePointID, ActionRemoteStopTransaction, req)
}

// SetChargingProfile applies a power/current limit schedule. This is how
// optimizer dispatch reaches EV chargers, including negative limits for V2G.
func (cs *CentralSystem) SetChargingProfile(ctx context.Context, chargePointID string, req SetChargingProfileRequest) (StatusResponse, error) {
	return callStatus(ctx, cs, chargePointID, ActionSetChargingProfile, req)
}

// ClearChargingProfile revokes previously installed profiles. `Unknown` means
// the charge point holds no matching profile, which is a valid end state for a
// revocation and is returned to the caller rather than treated as an error.
func (cs *CentralSystem) ClearChargingProfile(ctx context.Context, chargePointID string, req ClearChargingProfileRequest) (StatusResponse, error) {
	return callStatus(ctx, cs, chargePointID, ActionClearChargingProfile, req)
}

// TriggerMessage requests an unsolicited message (e.g. MeterValues) from the
// charge point.
func (cs *CentralSystem) TriggerMessage(ctx context.Context, chargePointID string, req TriggerMessageRequest) (StatusResponse, error) {
	return callStatus(ctx, cs, chargePointID, ActionTriggerMessage, req)
}

// Reset reboots the charge point.
func (cs *CentralSystem) Reset(ctx context.Context, chargePointID string, req ResetRequest) (StatusResponse, error) {
	return callStatus(ctx, cs, chargePointID, ActionReset, req)
}

func callStatus(ctx context.Context, cs *CentralSystem, chargePointID, action string, payload any) (StatusResponse, error) {
	raw, err := cs.Call(ctx, chargePointID, action, payload)
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

type session struct {
	chargePointID string
	conn          *websocket.Conn
	logger        *logrus.Entry

	writeMu sync.Mutex

	pendingMu sync.Mutex
	pending   map[string]chan *Frame
	counter   uint64

	closeOnce sync.Once
}

func (s *session) close() {
	s.closeOnce.Do(func() {
		_ = s.conn.Close()
		s.pendingMu.Lock()
		for id, ch := range s.pending {
			close(ch)
			delete(s.pending, id)
		}
		s.pendingMu.Unlock()
	})
}

func (s *session) write(data []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.conn.WriteMessage(websocket.TextMessage, data)
}

func (s *session) call(ctx context.Context, action string, payload any, timeout time.Duration) (json.RawMessage, error) {
	s.pendingMu.Lock()
	s.counter++
	uniqueID := fmt.Sprintf("cs-%d-%d", time.Now().UnixNano(), s.counter)
	replies := make(chan *Frame, 1)
	s.pending[uniqueID] = replies
	s.pendingMu.Unlock()

	defer func() {
		s.pendingMu.Lock()
		delete(s.pending, uniqueID)
		s.pendingMu.Unlock()
	}()

	data, err := EncodeCall(uniqueID, action, payload)
	if err != nil {
		return nil, err
	}
	if err := s.write(data); err != nil {
		return nil, fmt.Errorf("send %s to %s: %w", action, s.chargePointID, err)
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return nil, fmt.Errorf("%s to %s timed out after %s: delivery is unconfirmed", action, s.chargePointID, timeout)
	case frame, ok := <-replies:
		if !ok {
			return nil, fmt.Errorf("%s to %s: session closed before a response arrived", action, s.chargePointID)
		}
		if frame.Error != nil {
			return nil, frame.Error
		}
		return frame.Result.Payload, nil
	}
}

func (s *session) readLoop(ctx context.Context, cs *CentralSystem) {
	for {
		_, data, err := s.conn.ReadMessage()
		if err != nil {
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
				s.logger.WithError(err).Debug("OCPP read ended")
			}
			return
		}

		frame, err := DecodeFrame(data)
		if err != nil {
			s.logger.WithError(err).Warn("malformed OCPP frame")
			// Without a unique id there is nobody to answer; RFC-wise the frame
			// is unusable, so the session is torn down rather than desynchronised.
			if id := uniqueIDOf(data); id != "" {
				if reply, encErr := EncodeCallError(id, ErrFormationViolation, err.Error()); encErr == nil {
					_ = s.write(reply)
					continue
				}
			}
			return
		}

		switch {
		case frame.Call != nil:
			s.handleCall(ctx, cs, frame.Call)
		case frame.Result != nil:
			s.deliver(frame.Result.UniqueID, frame)
		case frame.Error != nil:
			s.deliver(frame.Error.UniqueID, frame)
		}
	}
}

func uniqueIDOf(data []byte) string {
	var raw []json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil || len(raw) < 2 {
		return ""
	}
	var id string
	if err := json.Unmarshal(raw[1], &id); err != nil {
		return ""
	}
	return id
}

func (s *session) deliver(uniqueID string, frame *Frame) {
	s.pendingMu.Lock()
	ch, ok := s.pending[uniqueID]
	if ok {
		delete(s.pending, uniqueID)
	}
	s.pendingMu.Unlock()
	if !ok {
		s.logger.WithField("unique_id", uniqueID).Warn("response for unknown request")
		return
	}
	ch <- frame
}

func (s *session) handleCall(ctx context.Context, cs *CentralSystem, call *Call) {
	payload, err := cs.dispatch(ctx, s.chargePointID, call)
	if err != nil {
		code := ErrInternalError
		var callErr *CallError
		if errors.As(err, &callErr) {
			code = callErr.ErrorCode
		}
		s.logger.WithError(err).WithField("action", call.Action).Warn("OCPP call failed")
		if reply, encErr := EncodeCallError(call.UniqueID, code, err.Error()); encErr == nil {
			_ = s.write(reply)
		}
		return
	}
	reply, err := EncodeCallResult(call.UniqueID, payload)
	if err != nil {
		s.logger.WithError(err).Error("failed to encode OCPP result")
		return
	}
	if err := s.write(reply); err != nil {
		s.logger.WithError(err).Warn("failed to write OCPP result")
	}
}

// dispatch routes an inbound call to the backend. Backend failures surface as
// CALLERROR: refusing the charge point is correct, whereas answering "Accepted"
// on a failed platform lookup would authorize energy nobody agreed to pay for.
func (cs *CentralSystem) dispatch(ctx context.Context, chargePointID string, call *Call) (any, error) {
	switch call.Action {
	case ActionBootNotification:
		var req BootNotificationRequest
		if err := decodeStrict(call.Payload, &req); err != nil {
			return nil, err
		}
		if req.ChargePointVendor == "" || req.ChargePointModel == "" {
			return nil, &CallError{ErrorCode: ErrPropertyConstraintViolation, ErrorDescription: "chargePointVendor and chargePointModel are required"}
		}
		resp, err := cs.backend.BootNotification(ctx, chargePointID, req)
		if err != nil {
			return nil, err
		}
		if resp.CurrentTime == "" {
			resp.CurrentTime = utcNow()
		}
		if resp.Interval == 0 {
			resp.Interval = int(cs.opts.HeartbeatInterval.Seconds())
		}
		return resp, nil

	case ActionHeartbeat:
		if err := cs.backend.Heartbeat(ctx, chargePointID); err != nil {
			return nil, err
		}
		return HeartbeatResponse{CurrentTime: utcNow()}, nil

	case ActionStatusNotification:
		var req StatusNotificationRequest
		if err := decodeStrict(call.Payload, &req); err != nil {
			return nil, err
		}
		if req.Status == "" || req.ErrorCode == "" {
			return nil, &CallError{ErrorCode: ErrPropertyConstraintViolation, ErrorDescription: "status and errorCode are required"}
		}
		if err := cs.backend.StatusNotification(ctx, chargePointID, req); err != nil {
			return nil, err
		}
		return struct{}{}, nil

	case ActionMeterValues:
		var req MeterValuesRequest
		if err := decodeStrict(call.Payload, &req); err != nil {
			return nil, err
		}
		if len(req.MeterValue) == 0 {
			return nil, &CallError{ErrorCode: ErrPropertyConstraintViolation, ErrorDescription: "meterValue must not be empty"}
		}
		if err := cs.backend.MeterValues(ctx, chargePointID, req); err != nil {
			return nil, err
		}
		return struct{}{}, nil

	case ActionAuthorize:
		var req AuthorizeRequest
		if err := decodeStrict(call.Payload, &req); err != nil {
			return nil, err
		}
		if req.IdTag == "" {
			return nil, &CallError{ErrorCode: ErrPropertyConstraintViolation, ErrorDescription: "idTag is required"}
		}
		resp, err := cs.backend.Authorize(ctx, chargePointID, req)
		if err != nil {
			return nil, err
		}
		if resp.IdTagInfo.Status == "" {
			return nil, errors.New("backend returned no authorization status")
		}
		return resp, nil

	case ActionStartTransaction:
		var req StartTransactionRequest
		if err := decodeStrict(call.Payload, &req); err != nil {
			return nil, err
		}
		if req.IdTag == "" || req.ConnectorID <= 0 {
			return nil, &CallError{ErrorCode: ErrPropertyConstraintViolation, ErrorDescription: "connectorId and idTag are required"}
		}
		resp, err := cs.backend.StartTransaction(ctx, chargePointID, req)
		if err != nil {
			return nil, err
		}
		// The platform owns transaction identity; a locally invented id would
		// detach the charging session from its billing record.
		if resp.TransactionID == 0 {
			return nil, errors.New("backend returned no transaction id")
		}
		if resp.IdTagInfo.Status == "" {
			return nil, errors.New("backend returned no authorization status")
		}
		return resp, nil

	case ActionStopTransaction:
		var req StopTransactionRequest
		if err := decodeStrict(call.Payload, &req); err != nil {
			return nil, err
		}
		if req.TransactionID == 0 {
			return nil, &CallError{ErrorCode: ErrPropertyConstraintViolation, ErrorDescription: "transactionId is required"}
		}
		resp, err := cs.backend.StopTransaction(ctx, chargePointID, req)
		if err != nil {
			return nil, err
		}
		return resp, nil

	default:
		return nil, &CallError{ErrorCode: ErrNotImplemented, ErrorDescription: "action " + call.Action + " is not implemented"}
	}
}

// decodeStrict rejects unknown fields so a charge point speaking a different
// profile is not silently half-understood.
func decodeStrict(payload json.RawMessage, target any) error {
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return &CallError{ErrorCode: ErrFormationViolation, ErrorDescription: err.Error()}
	}
	return nil
}
