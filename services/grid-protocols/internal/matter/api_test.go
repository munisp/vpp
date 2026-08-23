package matter

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

const testSecret = "0123456789abcdef0123456789abcdef"

func signedRequest(t *testing.T, method, path string, body []byte) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	timestamp := strconv.FormatInt(time.Now().UTC().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(testSecret))
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write(body)
	req.Header.Set("x-grid-timestamp", timestamp)
	req.Header.Set("x-grid-signature", hex.EncodeToString(mac.Sum(nil)))
	return req
}

// apiHarness serves the Matter endpoints over a live fake controller, so the
// tests exercise the same path a platform dispatch takes.
func apiHarness(t *testing.T, answer func(cmd command) any) (*http.ServeMux, *Controller) {
	t.Helper()
	fake := newFakeController(t)
	fake.answer = answer
	platform := &recordingPlatform{}
	controller, cancel := startController(t, fake, platform, nil)
	t.Cleanup(cancel)

	supervisor, err := NewSupervisor(controller, SupervisorOptions{
		MaxValidity: time.Hour, SweepInterval: time.Second, CommandTimeout: time.Second, Logger: quietLogger(),
	})
	if err != nil {
		t.Fatalf("NewSupervisor: %v", err)
	}
	api, err := NewAPI(controller, supervisor, testSecret)
	if err != nil {
		t.Fatalf("NewAPI: %v", err)
	}
	mux := http.NewServeMux()
	api.Routes(mux)
	return mux, controller
}

func defaultAnswers(cmd command) any {
	if cmd.Command == cmdStartListening {
		return success(cmd, []NodeData{waterHeater(4, true)})
	}
	return success(cmd, nil)
}

func TestAPIRequiresASignature(t *testing.T) {
	mux, _ := apiHarness(t, defaultAnswers)

	for _, path := range []string{"/matter/nodes", "/matter/control-state"} {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("%s served an unsigned request with %d", path, recorder.Code)
		}
	}

	body := []byte(`{"node_id":4,"endpoint_id":1,"action":"turn_off","window_seconds":60}`)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/matter/load", bytes.NewReader(body)))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("an unsigned load command was served with %d", recorder.Code)
	}

	// A signature over a different body must not authorize this one: the request
	// is signed over a short body and then sent with the real command.
	tampered := signedRequest(t, http.MethodPost, "/matter/load", []byte(`{"node_id":4}`))
	tampered.Body = io.NopCloser(bytes.NewReader(body))
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, tampered)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("a body that does not match its signature was served with %d", recorder.Code)
	}
}

func TestLoadEndpointRequiresAWindowAndAFallback(t *testing.T) {
	mux, _ := apiHarness(t, defaultAnswers)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, signedRequest(t, http.MethodPost, "/matter/load",
		[]byte(`{"node_id":4,"endpoint_id":1,"action":"turn_off"}`)))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected a load command with no window to be refused, got %d: %s", recorder.Code, recorder.Body)
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, signedRequest(t, http.MethodPost, "/matter/load",
		[]byte(`{"node_id":4,"endpoint_id":1,"action":"turn_off","window_seconds":60}`)))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected an On/Off control with no fallback to be refused, got %d: %s", recorder.Code, recorder.Body)
	}
}

func TestLoadEndpointReportsAcknowledgementNotDelivery(t *testing.T) {
	mux, _ := apiHarness(t, defaultAnswers)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, signedRequest(t, http.MethodPost, "/matter/load", []byte(
		`{"node_id":4,"endpoint_id":1,"action":"turn_off","window_seconds":60,"fallback":{"action":"turn_on"}}`)))
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected the load command to be accepted, got %d: %s", recorder.Code, recorder.Body)
	}
	var result LoadResult
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatalf("response is not a load result: %v", err)
	}
	if !result.Acknowledged || result.Enforcement != EnforcementPlatform {
		t.Fatalf("unexpected result %+v", result)
	}

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, signedRequest(t, http.MethodGet, "/matter/control-state", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("control state returned %d", recorder.Code)
	}
	var state struct {
		Targets []TargetState `json:"targets"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &state); err != nil {
		t.Fatalf("control state is not JSON: %v", err)
	}
	if len(state.Targets) != 1 || state.Targets[0].Fallback == nil {
		t.Fatalf("expected the tracked window and its fallback, got %+v", state.Targets)
	}
}

func TestAnUnreachableNodeIsNotAnAcceptedCommand(t *testing.T) {
	mux, _ := apiHarness(t, func(cmd command) any {
		if cmd.Command == cmdStartListening {
			return success(cmd, []NodeData{waterHeater(4, false)})
		}
		return success(cmd, nil)
	})

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, signedRequest(t, http.MethodPost, "/matter/load", []byte(
		`{"node_id":4,"endpoint_id":1,"action":"turn_off","window_seconds":60,"fallback":{"action":"turn_on"}}`)))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected an unavailable node to yield 503, got %d: %s", recorder.Code, recorder.Body)
	}
}

func TestAControllerRejectionIsABadGateway(t *testing.T) {
	mux, _ := apiHarness(t, func(cmd command) any {
		if cmd.Command == cmdStartListening {
			return success(cmd, []NodeData{waterHeater(4, true)})
		}
		return map[string]any{"message_id": cmd.MessageID, "error_code": 2, "details": "InvalidCommand"}
	})

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, signedRequest(t, http.MethodPost, "/matter/load", []byte(
		`{"node_id":4,"endpoint_id":1,"action":"turn_off","window_seconds":60,"fallback":{"action":"turn_on"}}`)))
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("expected the controller's rejection to yield 502, got %d: %s", recorder.Code, recorder.Body)
	}
}

func TestNodesEndpointServesCapabilities(t *testing.T) {
	mux, _ := apiHarness(t, defaultAnswers)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, signedRequest(t, http.MethodGet, "/matter/nodes", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("nodes returned %d: %s", recorder.Code, recorder.Body)
	}
	var payload struct {
		FabricID     uint64       `json:"fabric_id"`
		Nodes        []NodeData   `json:"nodes"`
		Capabilities []Capability `json:"capabilities"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("nodes response is not JSON: %v", err)
	}
	if len(payload.Nodes) != 1 || len(payload.Capabilities) != 1 {
		t.Fatalf("unexpected payload %+v", payload)
	}
	capability := payload.Capabilities[0]
	if !capability.OnOff || !capability.LevelControl || !capability.PowerMeasurement || capability.Thermostat {
		t.Fatalf("capabilities must come from the clusters the node reported, got %+v", capability)
	}
}
