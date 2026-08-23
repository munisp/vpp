// Package admin exposes the command API the VPP server calls to drive charge
// points: this is how optimizer dispatch reaches physical hardware.
package admin

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/vpp/grid-protocols/internal/control"
	"github.com/vpp/grid-protocols/internal/ocpp16"
)

// maxClockSkew bounds how old a signed command may be, so a captured request
// cannot be replayed indefinitely.
const maxClockSkew = 5 * time.Minute

// ControlSupervisor tracks control windows and re-asserts safe fallbacks.
type ControlSupervisor interface {
	RegisterBounded(chargePointID string, req ocpp16.SetChargingProfileRequest, validFrom, validTo time.Time) error
	RegisterFallback(chargePointID string, req ocpp16.SetChargingProfileRequest)
	MaxValidity() time.Duration
	State() []control.TargetState
}

// Commander is the charge point command surface, which for a deployment running
// both OCPP versions is the version mux. Commands are expressed in the 1.6 shape
// the platform stores; translation to 2.0.1 happens behind this interface, and a
// command with no faithful 2.0.1 equivalent is refused there rather than guessed.
type Commander interface {
	ConnectedChargePoints() []string
	// ProtocolVersion is "" for a station with no session.
	ProtocolVersion(chargePointID string) string
	RemoteStart(ctx context.Context, chargePointID string, req ocpp16.RemoteStartTransactionRequest, remoteStartID int, idTokenType string) (ocpp16.StatusResponse, error)
	RemoteStop(ctx context.Context, chargePointID string, req ocpp16.RemoteStopTransactionRequest, transactionID201 string) (ocpp16.StatusResponse, error)
	SetChargingProfile(ctx context.Context, chargePointID string, req ocpp16.SetChargingProfileRequest) (ocpp16.StatusResponse, error)
	ClearChargingProfile(ctx context.Context, chargePointID string, req ocpp16.ClearChargingProfileRequest) (ocpp16.StatusResponse, error)
}

// API serves the command endpoints.
type API struct {
	central    Commander
	secret     []byte
	supervisor ControlSupervisor
}

func New(central Commander, sharedSecret string, supervisor ControlSupervisor) (*API, error) {
	if central == nil {
		return nil, errors.New("admin: charge point commander is required")
	}
	if len(sharedSecret) < 32 {
		return nil, errors.New("admin: shared secret must be at least 32 characters")
	}
	if supervisor == nil {
		return nil, errors.New("admin: control supervisor is required: without it an expired control window would never be closed")
	}
	return &API{central: central, secret: []byte(sharedSecret), supervisor: supervisor}, nil
}

// Routes registers the command endpoints on a mux.
func (a *API) Routes(mux *http.ServeMux) {
	mux.HandleFunc("/admin/charge-points", a.handleChargePoints)
	mux.HandleFunc("/admin/remote-start", a.handleRemoteStart)
	mux.HandleFunc("/admin/remote-stop", a.handleRemoteStop)
	mux.HandleFunc("/admin/charging-profile", a.handleChargingProfile)
	mux.HandleFunc("/admin/clear-charging-profile", a.handleClearChargingProfile)
	mux.HandleFunc("/admin/control-state", a.handleControlState)
}

type remoteStartBody struct {
	ChargePointID string                               `json:"charge_point_id"`
	Request       ocpp16.RemoteStartTransactionRequest `json:"request"`
	// IDTokenType and RemoteStartID are only meaningful on OCPP 2.0.1, where id
	// tokens are typed and the station ties the transaction it creates back to
	// this request.
	IDTokenType   string `json:"id_token_type"`
	RemoteStartID int    `json:"remote_start_id"`
}

type remoteStopBody struct {
	ChargePointID string                              `json:"charge_point_id"`
	Request       ocpp16.RemoteStopTransactionRequest `json:"request"`
	// TransactionID201 is the station's own transaction id, which is the only
	// identifier a 2.0.1 station recognises; the platform's integer session id
	// means nothing to it.
	TransactionID201 string `json:"transaction_id_201"`
}

type chargingProfileBody struct {
	ChargePointID string                           `json:"charge_point_id"`
	Request       ocpp16.SetChargingProfileRequest `json:"request"`
	// Fallback marks the standing safe-limit profile. It is the only profile
	// allowed to be unbounded, must sit at stack level 0, and is what the charge
	// point degrades to when a bounded window closes or the platform goes away.
	Fallback bool `json:"fallback"`
}

type clearChargingProfileBody struct {
	ChargePointID string                             `json:"charge_point_id"`
	Request       ocpp16.ClearChargingProfileRequest `json:"request"`
}

func (a *API) handleChargePoints(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !a.authorized(w, r, nil) {
		return
	}
	connected := a.central.ConnectedChargePoints()
	versions := make(map[string]string, len(connected))
	for _, id := range connected {
		versions[id] = a.central.ProtocolVersion(id)
	}
	writeJSON(w, http.StatusOK, map[string]any{"connected": connected, "versions": versions})
}

func (a *API) handleRemoteStart(w http.ResponseWriter, r *http.Request) {
	var body remoteStartBody
	if !a.decode(w, r, &body) {
		return
	}
	if body.Request.IdTag == "" {
		http.Error(w, "request.idTag is required", http.StatusBadRequest)
		return
	}
	status, err := a.central.RemoteStart(r.Context(), body.ChargePointID, body.Request, body.RemoteStartID, body.IDTokenType)
	respond(w, status, err)
}

func (a *API) handleRemoteStop(w http.ResponseWriter, r *http.Request) {
	var body remoteStopBody
	if !a.decode(w, r, &body) {
		return
	}
	if body.Request.TransactionID == 0 && body.TransactionID201 == "" {
		http.Error(w, "request.transactionId or transaction_id_201 is required", http.StatusBadRequest)
		return
	}
	status, err := a.central.RemoteStop(r.Context(), body.ChargePointID, body.Request, body.TransactionID201)
	respond(w, status, err)
}

func (a *API) handleChargingProfile(w http.ResponseWriter, r *http.Request) {
	var body chargingProfileBody
	if !a.decode(w, r, &body) {
		return
	}
	if len(body.Request.CsChargingProfiles.ChargingSchedule.ChargingSchedulePeriod) == 0 {
		http.Error(w, "charging schedule must contain at least one period", http.StatusBadRequest)
		return
	}

	profile := body.Request.CsChargingProfiles
	var validFrom, validTo time.Time
	if body.Fallback {
		// The safe profile is the floor a charge point falls back to, so it is
		// deliberately permanent — but it must not be able to masquerade as an
		// optimizer setpoint that outranks a bounded profile.
		if profile.StackLevel != 0 {
			http.Error(w, "a fallback profile must sit at stackLevel 0 so bounded profiles override it", http.StatusBadRequest)
			return
		}
		if profile.ChargingProfilePurpose != "TxDefaultProfile" && profile.ChargingProfilePurpose != "ChargePointMaxProfile" {
			http.Error(w, "a fallback profile must be a TxDefaultProfile or ChargePointMaxProfile", http.StatusBadRequest)
			return
		}
		if profile.ValidTo != "" {
			http.Error(w, "a fallback profile must not expire: it is the state the charge point degrades to", http.StatusBadRequest)
			return
		}
	} else {
		var err error
		validFrom, validTo, err = a.validateWindow(profile)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}

	status, err := a.central.SetChargingProfile(r.Context(), body.ChargePointID, body.Request)
	if err == nil && status.Status == "Accepted" {
		// Only a profile the charge point actually took is tracked; registering a
		// rejected one would make the supervisor assert a fallback for a setpoint
		// that was never installed.
		if body.Fallback {
			a.supervisor.RegisterFallback(body.ChargePointID, body.Request)
		} else if regErr := a.supervisor.RegisterBounded(body.ChargePointID, body.Request, validFrom, validTo); regErr != nil {
			http.Error(w, regErr.Error(), http.StatusInternalServerError)
			return
		}
	}
	respond(w, status, err)
}

// validateWindow enforces that every dispatched profile expires on the charge
// point's own clock. Without this, a charge point that loses the platform keeps
// executing the last optimizer setpoint indefinitely.
func (a *API) validateWindow(profile ocpp16.ChargingProfile) (time.Time, time.Time, error) {
	if profile.ValidTo == "" {
		return time.Time{}, time.Time{}, errors.New(
			"csChargingProfiles.validTo is required: an unbounded profile keeps running after the platform is gone " +
				"(send fallback:true for the standing safe profile)")
	}
	validTo, err := time.Parse(time.RFC3339, profile.ValidTo)
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("csChargingProfiles.validTo must be RFC3339: %w", err)
	}
	now := time.Now().UTC()
	validFrom := now
	if profile.ValidFrom != "" {
		validFrom, err = time.Parse(time.RFC3339, profile.ValidFrom)
		if err != nil {
			return time.Time{}, time.Time{}, fmt.Errorf("csChargingProfiles.validFrom must be RFC3339: %w", err)
		}
	}
	if !validTo.After(validFrom) {
		return time.Time{}, time.Time{}, errors.New("csChargingProfiles.validTo must be after validFrom")
	}
	if !validTo.After(now) {
		return time.Time{}, time.Time{}, errors.New("csChargingProfiles.validTo is already in the past")
	}
	if window := validTo.Sub(validFrom); window > a.supervisor.MaxValidity() {
		return time.Time{}, time.Time{}, fmt.Errorf(
			"control window %s exceeds the configured maximum %s", window, a.supervisor.MaxValidity())
	}
	return validFrom, validTo, nil
}

func (a *API) handleClearChargingProfile(w http.ResponseWriter, r *http.Request) {
	var body clearChargingProfileBody
	if !a.decode(w, r, &body) {
		return
	}
	req := body.Request
	if req.ID == nil && req.ConnectorID == nil && req.ChargingProfilePurpose == "" && req.StackLevel == nil {
		http.Error(w, "at least one selector is required: an empty request clears every profile on the charge point", http.StatusBadRequest)
		return
	}
	status, err := a.central.ClearChargingProfile(r.Context(), body.ChargePointID, req)
	// Unknown means the charge point holds no matching profile, which is the
	// desired end state for a revocation.
	if err == nil && status.Status == "Unknown" {
		writeJSON(w, http.StatusOK, map[string]string{"status": status.Status})
		return
	}
	respond(w, status, err)
}

func (a *API) handleControlState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !a.authorized(w, r, nil) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"targets": a.supervisor.State()})
}

// respond maps command outcomes. A charge point that is offline or rejected the
// command yields a non-2xx status: the caller must never record a setpoint as
// applied when the hardware never accepted it.
func respond(w http.ResponseWriter, status ocpp16.StatusResponse, err error) {
	switch {
	case errors.Is(err, ocpp16.ErrNotConnected):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
	case err != nil:
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
	case status.Status != "Accepted":
		writeJSON(w, http.StatusConflict, map[string]string{
			"error":  "charge point did not accept the command",
			"status": status.Status,
		})
	default:
		writeJSON(w, http.StatusOK, map[string]string{"status": status.Status})
	}
}

func (a *API) decode(w http.ResponseWriter, r *http.Request, target any) bool {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "cannot read body", http.StatusBadRequest)
		return false
	}
	if !a.authorized(w, r, raw) {
		return false
	}
	if err := json.Unmarshal(raw, target); err != nil {
		http.Error(w, "body is not valid JSON", http.StatusBadRequest)
		return false
	}
	if id := chargePointIDOf(raw); id == "" {
		http.Error(w, "charge_point_id is required", http.StatusBadRequest)
		return false
	}
	return true
}

func chargePointIDOf(raw []byte) string {
	var probe struct {
		ChargePointID string `json:"charge_point_id"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return ""
	}
	return probe.ChargePointID
}

// authorized verifies the HMAC the VPP server attaches to every command.
func (a *API) authorized(w http.ResponseWriter, r *http.Request, body []byte) bool {
	timestamp := r.Header.Get("x-grid-timestamp")
	signature := r.Header.Get("x-grid-signature")
	if timestamp == "" || signature == "" {
		http.Error(w, "missing signature", http.StatusUnauthorized)
		return false
	}
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		http.Error(w, "invalid timestamp", http.StatusUnauthorized)
		return false
	}
	age := time.Since(time.Unix(seconds, 0))
	if age > maxClockSkew || age < -maxClockSkew {
		http.Error(w, "stale signature", http.StatusUnauthorized)
		return false
	}

	mac := hmac.New(sha256.New, a.secret)
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))

	if subtle.ConstantTimeCompare([]byte(expected), []byte(signature)) != 1 {
		http.Error(w, "invalid signature", http.StatusUnauthorized)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
