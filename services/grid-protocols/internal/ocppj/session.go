package ocppj

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
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

// Instrumentation is resolved lazily on the first inbound call so it binds to
// the providers gridd installs at boot; before that (or with the SDK disabled)
// every handle here is a no-op.
var (
	tracer = otel.Tracer("github.com/vpp/grid-protocols/internal/ocppj")

	metricsOnce   sync.Once
	actionsTotal  metric.Int64Counter
	dispatchTimer metric.Float64Histogram
)

func instruments() (metric.Int64Counter, metric.Float64Histogram) {
	metricsOnce.Do(func() {
		meter := otel.Meter("github.com/vpp/grid-protocols/internal/ocppj")
		actionsTotal, _ = meter.Int64Counter("ocpp.actions.total",
			metric.WithDescription("OCPP actions received from charge points, by action and dispatch result"))
		dispatchTimer, _ = meter.Float64Histogram("ocpp.dispatch.duration.seconds",
			metric.WithDescription("Time spent dispatching an OCPP action to the platform"),
			metric.WithUnit("s"))
	})
	return actionsTotal, dispatchTimer
}

// ErrNotConnected is returned when a command targets a charge point that has no
// open WebSocket session. Commands are never buffered and reported as sent: the
// caller has to know the charger did not receive it.
var ErrNotConnected = errors.New("charge point is not connected")

// Handler answers the calls a charge point sends. It returns either the response
// payload, or an error; a *CallError error carries its own OCPP error code, and
// anything else becomes InternalError. A handler that cannot reach the platform
// must return an error rather than a plausible acceptance.
type Handler interface {
	Dispatch(ctx context.Context, chargePointID string, call *Call) (any, error)
	// ErrorCodeForMalformedFrame is the code used when a frame does not decode.
	// 1.6 spells it FormationViolation, 2.0.1 spells it FormatViolation.
	ErrorCodeForMalformedFrame() string
}

// HasSubprotocol reports whether the client offered the given WebSocket
// subprotocol. A charge point that offers none of the versions we speak is
// rejected rather than guessed at: misparsing payloads would misattribute
// transactions and meter readings.
func HasSubprotocol(r *http.Request, want string) bool {
	for _, offered := range websocket.Subprotocols(r) {
		if strings.EqualFold(offered, want) {
			return true
		}
	}
	return false
}

// Session is one charge point's OCPP-J connection: it correlates outbound calls
// with their responses and serves inbound calls through a Handler.
type Session struct {
	chargePointID string
	conn          *websocket.Conn
	logger        *logrus.Entry
	handler       Handler

	writeMu sync.Mutex

	pendingMu sync.Mutex
	pending   map[string]chan *Frame
	counter   uint64

	closeOnce sync.Once
}

// NewSession wraps an upgraded WebSocket connection.
func NewSession(chargePointID string, conn *websocket.Conn, handler Handler, logger *logrus.Entry) *Session {
	return &Session{
		chargePointID: chargePointID,
		conn:          conn,
		logger:        logger,
		handler:       handler,
		pending:       make(map[string]chan *Frame),
	}
}

// ChargePointID is the identity the session authenticated as.
func (s *Session) ChargePointID() string { return s.chargePointID }

// Logger is the session's log entry, already tagged with the charge point.
func (s *Session) Logger() *logrus.Entry { return s.logger }

// Close tears down the connection and fails every in-flight call, so a caller
// never waits forever on a response that can no longer arrive.
func (s *Session) Close() {
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

func (s *Session) write(data []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.conn.WriteMessage(websocket.TextMessage, data)
}

// Call sends an action to the charge point and waits for its CALLRESULT. A
// CALLERROR comes back as an error, so a refused command is never mistaken for
// an applied one, and a timeout says delivery is unconfirmed rather than failed.
func (s *Session) Call(ctx context.Context, action string, payload any, timeout time.Duration) (json.RawMessage, error) {
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

// ReadLoop serves the session until the connection ends.
func (s *Session) ReadLoop(ctx context.Context) {
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
			// Without a unique id there is nobody to answer, and a session that
			// cannot be answered is desynchronised, so it is torn down.
			if id := UniqueIDOf(data); id != "" {
				if reply, encErr := EncodeCallError(id, s.handler.ErrorCodeForMalformedFrame(), err.Error()); encErr == nil {
					_ = s.write(reply)
					continue
				}
			}
			return
		}

		switch {
		case frame.Call != nil:
			s.handleCall(ctx, frame.Call)
		case frame.Result != nil:
			s.deliver(frame.Result.UniqueID, frame)
		case frame.Error != nil:
			s.deliver(frame.Error.UniqueID, frame)
		}
	}
}

func (s *Session) deliver(uniqueID string, frame *Frame) {
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

func (s *Session) handleCall(ctx context.Context, call *Call) {
	// One server span per OCPP action, around the dispatch to the platform.
	// The span context rides ctx into the platform client, whose transport
	// injects it as traceparent on the HTTPS call to the server.
	ctx, span := tracer.Start(ctx, "ocpp "+call.Action,
		trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(
			attribute.String("ocpp.action", call.Action),
			attribute.String("ocpp.charge_point_id", s.chargePointID),
			attribute.String("ocpp.unique_id", call.UniqueID),
			attribute.String("messaging.system", "ocpp"),
		),
	)
	defer span.End()

	actions, timer := instruments()
	actionAttr := attribute.String("ocpp.action", call.Action)
	started := time.Now()

	payload, err := s.handler.Dispatch(ctx, s.chargePointID, call)
	result := "ok"
	if err != nil {
		result = "error"
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	}
	actions.Add(ctx, 1, metric.WithAttributes(actionAttr, attribute.String("result", result)))
	timer.Record(ctx, time.Since(started).Seconds(), metric.WithAttributes(actionAttr))

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

// Registry holds one live session per charge point.
type Registry struct {
	mu       sync.RWMutex
	sessions map[string]*Session
}

func NewRegistry() *Registry {
	return &Registry{sessions: make(map[string]*Session)}
}

// Add registers a session, replacing any existing one for the same charge point:
// one physical charge point has one session, so the stale socket is dropped
// rather than left to receive commands nobody reads.
func (r *Registry) Add(s *Session) {
	r.mu.Lock()
	if existing, ok := r.sessions[s.chargePointID]; ok {
		existing.Close()
	}
	r.sessions[s.chargePointID] = s
	r.mu.Unlock()
}

// Remove drops a session if it is still the current one for its charge point.
func (r *Registry) Remove(s *Session) {
	r.mu.Lock()
	if r.sessions[s.chargePointID] == s {
		delete(r.sessions, s.chargePointID)
	}
	r.mu.Unlock()
	s.Close()
}

// Get returns the live session, or ErrNotConnected.
func (r *Registry) Get(chargePointID string) (*Session, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s, ok := r.sessions[chargePointID]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrNotConnected, chargePointID)
	}
	return s, nil
}

// IDs lists the charge points with an open session.
func (r *Registry) IDs() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ids := make([]string, 0, len(r.sessions))
	for id := range r.sessions {
		ids = append(ids, id)
	}
	return ids
}

// DecodeStrict rejects unknown fields so a charge point speaking a different
// profile or version is not silently half-understood.
func DecodeStrict(payload json.RawMessage, target any, malformedCode string) error {
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return &CallError{ErrorCode: malformedCode, ErrorDescription: err.Error()}
	}
	return nil
}
