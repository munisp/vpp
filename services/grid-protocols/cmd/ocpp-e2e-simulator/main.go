// Command ocpp-e2e-simulator is an isolated OCPP 1.6J charge-point simulator.
//
// It exists only for the repository's grid end-to-end test topology. It connects
// to gridd over the real OCPP WebSocket, records received command frames, and
// can be switched between accepted, rejected, and timeout responses. It is not a
// physical-device emulator and must never be deployed in a production network.
package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	ocppCall       = 2
	ocppCallResult = 3
	ocppSubproto   = "ocpp1.6"
)

type mode string

const (
	modeAccept  mode = "accept"
	modeReject  mode = "reject"
	modeTimeout mode = "timeout"
)

type event struct {
	At        string          `json:"at"`
	Type      string          `json:"type"`
	Action    string          `json:"action,omitempty"`
	UniqueID  string          `json:"unique_id,omitempty"`
	Status    string          `json:"status,omitempty"`
	ProfileID int             `json:"profile_id,omitempty"`
	ValidFrom string          `json:"valid_from,omitempty"`
	ValidTo   string          `json:"valid_to,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	Detail    string          `json:"detail,omitempty"`
}

type profile struct {
	ID        int
	ValidFrom string
	ValidTo   string
}

type simulator struct {
	endpoint string
	username string
	password string

	mu                sync.Mutex
	writeMu           sync.Mutex
	conn              *websocket.Conn
	connecting        bool
	desiredConnection bool
	responseMode      mode
	events            []event
	profiles          map[int]profile
}

func main() {
	s := &simulator{
		endpoint:          required("OCPP_E2E_URL"),
		username:          required("OCPP_E2E_USERNAME"),
		password:          required("OCPP_E2E_PASSWORD"),
		desiredConnection: true,
		responseMode:      modeAccept,
		profiles:          make(map[int]profile),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/events", s.handleEvents)
	mux.HandleFunc("/mode", s.handleMode)
	mux.HandleFunc("/disconnect", s.handleDisconnect)
	mux.HandleFunc("/connect", s.handleConnect)
	mux.HandleFunc("/reset", s.handleReset)

	go s.ensureConnected()
	addr := env("OCPP_E2E_LISTEN", ":9200")
	log.Printf("ocpp e2e simulator listening on %s and connecting to %s", addr, s.endpoint)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

func required(name string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		log.Fatalf("%s is required", name)
	}
	return value
}

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func (s *simulator) record(next event) {
	next.At = time.Now().UTC().Format(time.RFC3339Nano)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, next)
}

func (s *simulator) desired() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.desiredConnection
}

func (s *simulator) ensureConnected() {
	s.mu.Lock()
	if s.connecting || !s.desiredConnection || s.conn != nil {
		s.mu.Unlock()
		return
	}
	s.connecting = true
	s.mu.Unlock()

	go func() {
		defer func() {
			s.mu.Lock()
			s.connecting = false
			s.mu.Unlock()
		}()

		for s.desired() {
			if s.connected() {
				return
			}
			if err := s.connectOnce(); err != nil {
				s.record(event{Type: "connection_failed", Detail: err.Error()})
				time.Sleep(250 * time.Millisecond)
				continue
			}
			return
		}
	}()
}

func (s *simulator) connected() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn != nil
}

func (s *simulator) connectOnce() error {
	headers := http.Header{}
	credentials := base64.StdEncoding.EncodeToString([]byte(s.username + ":" + s.password))
	headers.Set("Authorization", "Basic "+credentials)
	dialer := websocket.Dialer{Subprotocols: []string{ocppSubproto}, HandshakeTimeout: 3 * time.Second}
	conn, response, err := dialer.Dial(s.endpoint, headers)
	if err != nil {
		if response != nil {
			return fmt.Errorf("dial %s: %w (HTTP %d)", s.endpoint, err, response.StatusCode)
		}
		return fmt.Errorf("dial %s: %w", s.endpoint, err)
	}

	s.mu.Lock()
	if !s.desiredConnection {
		s.mu.Unlock()
		_ = conn.Close()
		return errors.New("connection was disabled while dialling")
	}
	s.conn = conn
	s.mu.Unlock()
	s.record(event{Type: "connected"})
	go s.readLoop(conn)
	return nil
}

func (s *simulator) readLoop(conn *websocket.Conn) {
	defer func() {
		_ = conn.Close()
		s.mu.Lock()
		if s.conn == conn {
			s.conn = nil
		}
		shouldReconnect := s.desiredConnection
		s.mu.Unlock()
		s.record(event{Type: "disconnected"})
		if shouldReconnect {
			time.AfterFunc(250*time.Millisecond, s.ensureConnected)
		}
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if err := s.handleFrame(conn, raw); err != nil {
			s.record(event{Type: "frame_error", Detail: err.Error(), Payload: raw})
		}
	}
}

func (s *simulator) handleFrame(conn *websocket.Conn, raw []byte) error {
	var frame []json.RawMessage
	if err := json.Unmarshal(raw, &frame); err != nil {
		return fmt.Errorf("decode OCPP frame: %w", err)
	}
	if len(frame) < 2 {
		return errors.New("OCPP frame is missing a type or unique id")
	}

	var messageType int
	var uniqueID string
	if err := json.Unmarshal(frame[0], &messageType); err != nil {
		return fmt.Errorf("decode OCPP message type: %w", err)
	}
	if err := json.Unmarshal(frame[1], &uniqueID); err != nil {
		return fmt.Errorf("decode OCPP unique id: %w", err)
	}
	if messageType != ocppCall {
		s.record(event{Type: "non_call_frame", UniqueID: uniqueID, Payload: raw})
		return nil
	}
	if len(frame) != 4 {
		return fmt.Errorf("OCPP CALL has %d fields; expected 4", len(frame))
	}

	var action string
	if err := json.Unmarshal(frame[2], &action); err != nil {
		return fmt.Errorf("decode OCPP action: %w", err)
	}
	payload := append(json.RawMessage(nil), frame[3]...)
	profileID, validFrom, validTo := profileDetails(action, payload)
	s.record(event{
		Type: "command", Action: action, UniqueID: uniqueID, ProfileID: profileID,
		ValidFrom: validFrom, ValidTo: validTo, Payload: payload,
	})

	if action == "SetChargingProfile" && profileID != 0 {
		s.mu.Lock()
		s.profiles[profileID] = profile{ID: profileID, ValidFrom: validFrom, ValidTo: validTo}
		s.mu.Unlock()
		if validTo != "" {
			s.scheduleLocalExpiry(profileID, validTo)
		}
	}
	if action == "ClearChargingProfile" {
		s.clearProfiles(payload)
	}

	s.mu.Lock()
	currentMode := s.responseMode
	s.mu.Unlock()
	switch currentMode {
	case modeTimeout:
		s.record(event{Type: "response_withheld", Action: action, UniqueID: uniqueID, ProfileID: profileID})
		return nil
	case modeReject:
		s.record(event{Type: "response", Action: action, UniqueID: uniqueID, ProfileID: profileID, Status: "Rejected"})
		return s.writeResult(conn, uniqueID, map[string]string{"status": "Rejected"})
	default:
		s.record(event{Type: "response", Action: action, UniqueID: uniqueID, ProfileID: profileID, Status: "Accepted"})
		return s.writeResult(conn, uniqueID, map[string]string{"status": "Accepted"})
	}
}

func (s *simulator) writeResult(conn *websocket.Conn, uniqueID string, payload any) error {
	encoded, err := json.Marshal([]any{ocppCallResult, uniqueID, payload})
	if err != nil {
		return err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return conn.WriteMessage(websocket.TextMessage, encoded)
}

func profileDetails(action string, payload json.RawMessage) (id int, validFrom, validTo string) {
	if action != "SetChargingProfile" {
		return 0, "", ""
	}
	var body struct {
		Profiles struct {
			ID        int    `json:"chargingProfileId"`
			ValidFrom string `json:"validFrom"`
			ValidTo   string `json:"validTo"`
		} `json:"csChargingProfiles"`
	}
	if err := json.Unmarshal(payload, &body); err != nil {
		return 0, "", ""
	}
	return body.Profiles.ID, body.Profiles.ValidFrom, body.Profiles.ValidTo
}

func (s *simulator) clearProfiles(payload json.RawMessage) {
	var body struct {
		ID *int `json:"id"`
	}
	if err := json.Unmarshal(payload, &body); err != nil || body.ID == nil {
		return
	}
	s.mu.Lock()
	delete(s.profiles, *body.ID)
	s.mu.Unlock()
}

func (s *simulator) scheduleLocalExpiry(profileID int, validTo string) {
	expiresAt, err := time.Parse(time.RFC3339, validTo)
	if err != nil {
		s.record(event{Type: "local_expiry_invalid", ProfileID: profileID, Detail: err.Error()})
		return
	}
	delay := time.Until(expiresAt)
	if delay < 0 {
		delay = 0
	}
	time.AfterFunc(delay, func() {
		s.mu.Lock()
		stored, ok := s.profiles[profileID]
		if ok && stored.ValidTo == validTo {
			delete(s.profiles, profileID)
		}
		s.mu.Unlock()
		if ok && stored.ValidTo == validTo {
			s.record(event{Type: "local_profile_expired", ProfileID: profileID, ValidTo: validTo})
		}
	})
}

func (s *simulator) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "connected": s.connected()})
}

func (s *simulator) handleEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	// A non-nil empty array keeps the test API stable before the first command.
	events := append([]event{}, s.events...)
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}

func (s *simulator) handleMode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var request struct {
		Mode string `json:"mode"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&request); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	next := mode(request.Mode)
	if next != modeAccept && next != modeReject && next != modeTimeout {
		http.Error(w, "mode must be accept, reject, or timeout", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	s.responseMode = next
	s.mu.Unlock()
	s.record(event{Type: "mode", Detail: string(next)})
	writeJSON(w, http.StatusOK, map[string]string{"mode": string(next)})
}

func (s *simulator) handleDisconnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	s.desiredConnection = false
	conn := s.conn
	s.conn = nil
	s.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
	s.record(event{Type: "disconnect_requested"})
	writeJSON(w, http.StatusOK, map[string]bool{"connected": false})
}

func (s *simulator) handleConnect(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	s.desiredConnection = true
	s.mu.Unlock()
	s.ensureConnected()
	writeJSON(w, http.StatusAccepted, map[string]bool{"connecting": true})
}

func (s *simulator) handleReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	s.events = nil
	s.responseMode = modeAccept
	s.profiles = make(map[int]profile)
	s.desiredConnection = true
	s.mu.Unlock()
	s.ensureConnected()
	writeJSON(w, http.StatusOK, map[string]string{"mode": string(modeAccept)})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func parseInt(value string) int {
	parsed, _ := strconv.Atoi(value)
	return parsed
}
