// Package admin exposes the command API the VPP server calls to drive charge
// points: this is how optimizer dispatch reaches physical hardware.
package admin

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/vpp/grid-protocols/internal/ocpp16"
)

// maxClockSkew bounds how old a signed command may be, so a captured request
// cannot be replayed indefinitely.
const maxClockSkew = 5 * time.Minute

// API serves the command endpoints.
type API struct {
	central *ocpp16.CentralSystem
	secret  []byte
}

func New(central *ocpp16.CentralSystem, sharedSecret string) (*API, error) {
	if central == nil {
		return nil, errors.New("admin: central system is required")
	}
	if len(sharedSecret) < 32 {
		return nil, errors.New("admin: shared secret must be at least 32 characters")
	}
	return &API{central: central, secret: []byte(sharedSecret)}, nil
}

// Routes registers the command endpoints on a mux.
func (a *API) Routes(mux *http.ServeMux) {
	mux.HandleFunc("/admin/charge-points", a.handleChargePoints)
	mux.HandleFunc("/admin/remote-start", a.handleRemoteStart)
	mux.HandleFunc("/admin/remote-stop", a.handleRemoteStop)
	mux.HandleFunc("/admin/charging-profile", a.handleChargingProfile)
}

type remoteStartBody struct {
	ChargePointID string                               `json:"charge_point_id"`
	Request       ocpp16.RemoteStartTransactionRequest `json:"request"`
}

type remoteStopBody struct {
	ChargePointID string                              `json:"charge_point_id"`
	Request       ocpp16.RemoteStopTransactionRequest `json:"request"`
}

type chargingProfileBody struct {
	ChargePointID string                           `json:"charge_point_id"`
	Request       ocpp16.SetChargingProfileRequest `json:"request"`
}

func (a *API) handleChargePoints(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !a.authorized(w, r, nil) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"connected": a.central.ConnectedChargePoints()})
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
	status, err := a.central.RemoteStartTransaction(r.Context(), body.ChargePointID, body.Request)
	respond(w, status, err)
}

func (a *API) handleRemoteStop(w http.ResponseWriter, r *http.Request) {
	var body remoteStopBody
	if !a.decode(w, r, &body) {
		return
	}
	if body.Request.TransactionID == 0 {
		http.Error(w, "request.transactionId is required", http.StatusBadRequest)
		return
	}
	status, err := a.central.RemoteStopTransaction(r.Context(), body.ChargePointID, body.Request)
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
	status, err := a.central.SetChargingProfile(r.Context(), body.ChargePointID, body.Request)
	respond(w, status, err)
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
