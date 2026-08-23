package matter

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/vpp/grid-protocols/internal/signed"
)

// API serves the Matter command endpoints the VPP server calls. Every request is
// signed with the same shared secret as the charge point commands.
type API struct {
	controller *Controller
	supervisor *Supervisor
	secret     []byte
}

func NewAPI(controller *Controller, supervisor *Supervisor, sharedSecret string) (*API, error) {
	if controller == nil {
		return nil, errors.New("matter: a controller is required")
	}
	if supervisor == nil {
		return nil, errors.New("matter: a supervisor is required: without it a load control window would never be closed")
	}
	if len(sharedSecret) < 32 {
		return nil, errors.New("matter: shared secret must be at least 32 characters")
	}
	return &API{controller: controller, supervisor: supervisor, secret: []byte(sharedSecret)}, nil
}

// Routes registers the endpoints on a mux.
func (a *API) Routes(mux *http.ServeMux) {
	mux.HandleFunc("/matter/nodes", a.handleNodes)
	mux.HandleFunc("/matter/load", a.handleLoad)
	mux.HandleFunc("/matter/read-load", a.handleReadLoad)
	mux.HandleFunc("/matter/control-state", a.handleControlState)
}

type loadBody struct {
	NodeID   int64  `json:"node_id"`
	Endpoint uint16 `json:"endpoint_id"`
	Action   string `json:"action"`
	// WindowSeconds is how long the control holds. It is required: a Matter
	// On/Off or Level command has no expiry of its own.
	WindowSeconds   int      `json:"window_seconds"`
	LevelPercent    *int     `json:"level_percent,omitempty"`
	SetpointCelsius *float64 `json:"setpoint_celsius,omitempty"`
	PowerAdjustW    *float64 `json:"power_adjust_w,omitempty"`
	// Fallback is the control to issue when the window closes.
	Fallback *struct {
		Action          string   `json:"action"`
		LevelPercent    *int     `json:"level_percent,omitempty"`
		SetpointCelsius *float64 `json:"setpoint_celsius,omitempty"`
	} `json:"fallback,omitempty"`
}

type readLoadBody struct {
	NodeID   int64  `json:"node_id"`
	Endpoint uint16 `json:"endpoint_id"`
}

func (a *API) handleNodes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !a.authorized(w, r, nil) {
		return
	}
	if !a.controller.Connected() {
		// An empty node list from a disconnected controller would read as "no
		// smart-home loads", which is a different statement from "unknown".
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": ErrNotConnected.Error(),
		})
		return
	}
	nodes := a.controller.KnownNodes()
	capabilities := make([]Capability, 0, len(nodes))
	for _, node := range nodes {
		perNode, err := a.controller.Capabilities(node.NodeID)
		if err != nil {
			continue
		}
		capabilities = append(capabilities, perNode...)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"fabric_id":    a.controller.FabricID(),
		"nodes":        nodes,
		"capabilities": capabilities,
	})
}

func (a *API) handleLoad(w http.ResponseWriter, r *http.Request) {
	var body loadBody
	if !a.decode(w, r, &body) {
		return
	}
	if body.NodeID == 0 {
		http.Error(w, "node_id is required", http.StatusBadRequest)
		return
	}
	if body.WindowSeconds <= 0 {
		http.Error(w, "window_seconds is required: a Matter load command carries no expiry of its own", http.StatusBadRequest)
		return
	}

	cmd := LoadCommand{
		NodeID:          body.NodeID,
		Endpoint:        body.Endpoint,
		Action:          body.Action,
		LevelPercent:    body.LevelPercent,
		SetpointCelsius: body.SetpointCelsius,
		PowerAdjustW:    body.PowerAdjustW,
		Window:          time.Duration(body.WindowSeconds) * time.Second,
	}
	var fallback *LoadCommand
	if body.Fallback != nil {
		fallback = &LoadCommand{
			NodeID:          body.NodeID,
			Endpoint:        body.Endpoint,
			Action:          body.Fallback.Action,
			LevelPercent:    body.Fallback.LevelPercent,
			SetpointCelsius: body.Fallback.SetpointCelsius,
			// The fallback restores the load; it is not itself a bounded control.
			Window: time.Duration(body.WindowSeconds) * time.Second,
		}
	}

	result, err := a.supervisor.Apply(r.Context(), cmd, fallback)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *API) handleReadLoad(w http.ResponseWriter, r *http.Request) {
	var body readLoadBody
	if !a.decode(w, r, &body) {
		return
	}
	if body.NodeID == 0 {
		http.Error(w, "node_id is required", http.StatusBadRequest)
		return
	}
	telemetry, err := a.controller.ReadLoadTelemetry(r.Context(), body.NodeID, body.Endpoint)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, telemetry)
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

// writeError maps a failure to a status. A load the platform could not reach is
// 503 and a load the controller or node refused is 502: neither may be recorded
// as a dispatch that happened.
func writeError(w http.ResponseWriter, err error) {
	var controllerErr *ControllerError
	switch {
	case errors.Is(err, ErrNotConnected), errors.Is(err, ErrNodeUnavailable):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
	case errors.As(err, &controllerErr):
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error":      err.Error(),
			"error_code": controllerErr.Code,
		})
	case errors.Is(err, ErrTestNode):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
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
	return true
}

func (a *API) authorized(w http.ResponseWriter, r *http.Request, body []byte) bool {
	if err := signed.Verify(a.secret, r, body); err != nil {
		http.Error(w, err.Error(), signed.Status(err))
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
