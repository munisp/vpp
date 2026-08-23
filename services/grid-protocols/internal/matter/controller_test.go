package matter

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sirupsen/logrus"
)

// fakeController is a stand-in for the Matter controller's WebSocket API. It is
// deliberately dumb: it answers only what a test tells it to, so a command this
// client sends wrongly produces a failure rather than a helpful guess.
type fakeController struct {
	t *testing.T

	mu       sync.Mutex
	received []command
	// answer returns the frame to send for a command, or nil to send nothing.
	answer func(cmd command) any
	// info overrides the server-info frame.
	info map[string]any

	conns   chan *websocket.Conn
	server  *httptest.Server
	upgrade websocket.Upgrader

	// writeMu serialises the harness's own writes: replies come from the serve
	// goroutine while pushed events come from the test goroutine.
	writeMu sync.Mutex
}

func (f *fakeController) writeJSON(conn *websocket.Conn, payload any) {
	f.writeMu.Lock()
	defer f.writeMu.Unlock()
	_ = conn.WriteJSON(payload)
}

func newFakeController(t *testing.T) *fakeController {
	t.Helper()
	f := &fakeController{t: t, conns: make(chan *websocket.Conn, 4)}
	f.server = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeController) url() string {
	return "ws" + strings.TrimPrefix(f.server.URL, "http")
}

func (f *fakeController) serve(w http.ResponseWriter, r *http.Request) {
	conn, err := f.upgrade.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	f.conns <- conn

	f.mu.Lock()
	info := f.info
	f.mu.Unlock()
	if info == nil {
		info = map[string]any{
			"fabric_id":                    1,
			"compressed_fabric_id":         2,
			"schema_version":               SchemaVersion,
			"min_supported_schema_version": 9,
			"sdk_version":                  "2026.1.0",
			"wifi_credentials_set":         true,
			"thread_credentials_set":       false,
			"bluetooth_enabled":            false,
		}
	}
	f.writeJSON(conn, info)

	for {
		var cmd command
		if err := conn.ReadJSON(&cmd); err != nil {
			return
		}
		f.mu.Lock()
		f.received = append(f.received, cmd)
		answer := f.answer
		f.mu.Unlock()
		if answer == nil {
			continue
		}
		if reply := answer(cmd); reply != nil {
			f.writeJSON(conn, reply)
		}
	}
}

func (f *fakeController) commands() []command {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]command, len(f.received))
	copy(out, f.received)
	return out
}

func (f *fakeController) push(event string, data any) {
	conn := <-f.conns
	f.conns <- conn
	f.writeJSON(conn, map[string]any{"event": event, "data": data})
}

func success(cmd command, result any) map[string]any {
	return map[string]any{"message_id": cmd.MessageID, "result": result}
}

type recordingPlatform struct {
	mu sync.Mutex

	nodes      [][]NodeData
	attributes []struct {
		NodeID int64
		Path   string
		Value  string
	}
	removed []int64
	err     error
}

func (p *recordingPlatform) MatterNodesReported(_ context.Context, _ uint64, nodes []NodeData) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.err != nil {
		return p.err
	}
	p.nodes = append(p.nodes, nodes)
	return nil
}

func (p *recordingPlatform) MatterAttributeReported(_ context.Context, nodeID int64, path string, value json.RawMessage) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.attributes = append(p.attributes, struct {
		NodeID int64
		Path   string
		Value  string
	}{nodeID, path, string(value)})
	return nil
}

func (p *recordingPlatform) MatterNodeRemoved(_ context.Context, nodeID int64) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.removed = append(p.removed, nodeID)
	return nil
}

func (p *recordingPlatform) attributeCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.attributes)
}

func quietLogger() *logrus.Logger {
	logger := logrus.New()
	logger.SetLevel(logrus.PanicLevel)
	return logger
}

// waterHeater is a node exposing On/Off, Level Control, power and energy
// measurement on endpoint 1, and nothing on endpoint 2.
func waterHeater(nodeID int64, available bool) NodeData {
	return NodeData{
		NodeID:    nodeID,
		Available: available,
		Attributes: map[string]any{
			"1/6/0":    true,
			"1/8/0":    float64(254),
			"1/144/10": float64(7_000_000),
			"1/145/1":  map[string]any{"energy": float64(12_000_000)},
		},
	}
}

func startController(t *testing.T, fake *fakeController, platform Platform, mutate func(*Config)) (*Controller, context.CancelFunc) {
	t.Helper()
	cfg := Config{URL: fake.url(), CallTimeout: 2 * time.Second, ReconnectInterval: 20 * time.Millisecond, Logger: quietLogger()}
	if mutate != nil {
		mutate(&cfg)
	}
	controller, err := NewController(cfg, platform)
	if err != nil {
		t.Fatalf("NewController: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = controller.Run(ctx) }()
	deadline := time.Now().Add(2 * time.Second)
	for !controller.Connected() {
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("controller never connected")
		}
		time.Sleep(5 * time.Millisecond)
	}
	return controller, cancel
}

func TestNewControllerRefusesAnUnusableConfig(t *testing.T) {
	platform := &recordingPlatform{}
	if _, err := NewController(Config{}, platform); err == nil {
		t.Fatal("expected a missing url to be refused; there is no built-in Matter stack to fall back to")
	}
	if _, err := NewController(Config{URL: "http://matter:5580/ws"}, platform); err == nil {
		t.Fatal("expected a non-WebSocket scheme to be refused")
	}
	if _, err := NewController(Config{URL: "ws://matter:5580/ws"}, nil); err == nil {
		t.Fatal("expected a missing platform to be refused; reports must be persisted")
	}
}

func TestPublishesTheControllerNodeInventory(t *testing.T) {
	fake := newFakeController(t)
	fake.answer = func(cmd command) any {
		if cmd.Command == cmdStartListening {
			return success(cmd, []NodeData{waterHeater(4, true)})
		}
		return nil
	}
	platform := &recordingPlatform{}
	_, cancel := startController(t, fake, platform, nil)
	defer cancel()

	deadline := time.Now().Add(time.Second)
	for {
		platform.mu.Lock()
		count := len(platform.nodes)
		platform.mu.Unlock()
		if count > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("node inventory was never published to the platform")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if platform.nodes[0][0].NodeID != 4 {
		t.Fatalf("unexpected inventory %+v", platform.nodes[0])
	}
}

func TestRefusesAControllerRequiringANewerSchema(t *testing.T) {
	fake := newFakeController(t)
	fake.info = map[string]any{
		"fabric_id":                    1,
		"compressed_fabric_id":         2,
		"schema_version":               SchemaVersion + 5,
		"min_supported_schema_version": SchemaVersion + 5,
		"sdk_version":                  "2027.1.0",
	}
	platform := &recordingPlatform{}
	controller, err := NewController(Config{
		URL: fake.url(), CallTimeout: time.Second, ReconnectInterval: time.Hour, Logger: quietLogger(),
	}, platform)
	if err != nil {
		t.Fatalf("NewController: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	_ = controller.Run(ctx)

	if controller.Connected() {
		t.Fatal("expected an unsupported controller schema to leave the client disconnected rather than reading device payloads it may misinterpret")
	}
	platform.mu.Lock()
	defer platform.mu.Unlock()
	if len(platform.nodes) != 0 {
		t.Fatal("expected no inventory from a controller whose schema is unsupported")
	}
}

func TestForwardsAttributeReportsAndDropsUnusableOnes(t *testing.T) {
	fake := newFakeController(t)
	fake.answer = func(cmd command) any {
		if cmd.Command == cmdStartListening {
			return success(cmd, []NodeData{waterHeater(4, true)})
		}
		return nil
	}
	platform := &recordingPlatform{}
	_, cancel := startController(t, fake, platform, nil)
	defer cancel()

	fake.push(eventAttributeUpdated, []any{4, "1/144/10", 3_500_000})
	// A wildcard path cannot be attributed to one attribute, so it must not be
	// stored against a guessed one.
	fake.push(eventAttributeUpdated, []any{4, "1/144/*", 1})
	fake.push(eventAttributeUpdated, []any{4, "1/6/0", false})

	deadline := time.Now().Add(time.Second)
	for platform.attributeCount() < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("expected 2 usable attribute reports, got %d", platform.attributeCount())
		}
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	if got := platform.attributeCount(); got != 2 {
		t.Fatalf("expected the wildcard report to be dropped, got %d reports", got)
	}
	platform.mu.Lock()
	defer platform.mu.Unlock()
	if platform.attributes[0].Path != "1/144/10" || platform.attributes[0].Value != "3500000" {
		t.Fatalf("unexpected first report %+v", platform.attributes[0])
	}
}

func TestRefusesToCommandNodesItCannotProveAreThere(t *testing.T) {
	fake := newFakeController(t)
	fake.answer = func(cmd command) any {
		switch cmd.Command {
		case cmdStartListening:
			return success(cmd, []NodeData{
				waterHeater(4, true),
				waterHeater(5, false),
				waterHeater(TestNodeIDStart+1, true),
			})
		default:
			return success(cmd, nil)
		}
	}
	platform := &recordingPlatform{}
	controller, cancel := startController(t, fake, platform, nil)
	defer cancel()
	ctx := context.Background()

	if _, err := controller.ApplyLoad(ctx, LoadCommand{NodeID: 99, Endpoint: 1, Action: ActionTurnOff}); err == nil {
		t.Fatal("expected an uncommissioned node to be refused")
	}
	_, err := controller.ApplyLoad(ctx, LoadCommand{NodeID: 5, Endpoint: 1, Action: ActionTurnOff})
	if !errors.Is(err, ErrNodeUnavailable) {
		t.Fatalf("expected an unavailable node to be refused, got %v", err)
	}
	_, err = controller.ApplyLoad(ctx, LoadCommand{NodeID: TestNodeIDStart + 1, Endpoint: 1, Action: ActionTurnOff})
	if !errors.Is(err, ErrTestNode) {
		t.Fatalf("expected the controller's synthetic node to be refused, got %v", err)
	}
	// Endpoint 2 has reported nothing, so its clusters are unknown.
	if _, err := controller.ApplyLoad(ctx, LoadCommand{NodeID: 4, Endpoint: 2, Action: ActionTurnOff}); err == nil {
		t.Fatal("expected an endpoint with no reported attributes to be refused")
	}
}

func TestAllowsSyntheticNodesOnlyWhenExplicitlyEnabled(t *testing.T) {
	fake := newFakeController(t)
	fake.answer = func(cmd command) any {
		if cmd.Command == cmdStartListening {
			return success(cmd, []NodeData{waterHeater(TestNodeIDStart+2, true)})
		}
		return success(cmd, nil)
	}
	platform := &recordingPlatform{}
	controller, cancel := startController(t, fake, platform, func(cfg *Config) { cfg.AllowTestNodes = true })
	defer cancel()

	result, err := controller.ApplyLoad(context.Background(), LoadCommand{
		NodeID: TestNodeIDStart + 2, Endpoint: 1, Action: ActionTurnOff,
	})
	if err != nil {
		t.Fatalf("ApplyLoad: %v", err)
	}
	if !result.Acknowledged {
		t.Fatal("expected the synthetic node command to be acknowledged when test nodes are enabled")
	}
}

func TestLoadControlsUseTheClustersTheNodeExposes(t *testing.T) {
	fake := newFakeController(t)
	fake.answer = func(cmd command) any {
		if cmd.Command == cmdStartListening {
			return success(cmd, []NodeData{waterHeater(4, true)})
		}
		return success(cmd, nil)
	}
	platform := &recordingPlatform{}
	controller, cancel := startController(t, fake, platform, nil)
	defer cancel()
	ctx := context.Background()

	level := 50
	result, err := controller.ApplyLoad(ctx, LoadCommand{
		NodeID: 4, Endpoint: 1, Action: ActionSetLevel, LevelPercent: &level, Window: time.Hour,
	})
	if err != nil {
		t.Fatalf("ApplyLoad: %v", err)
	}
	if result.Enforcement != EnforcementPlatform {
		t.Fatalf("Level Control has no expiry, so the window is the platform's: got %q", result.Enforcement)
	}
	var invoke command
	for _, cmd := range fake.commands() {
		if cmd.Command == cmdDeviceCommand {
			invoke = cmd
		}
	}
	if invoke.Args["command_name"] != "MoveToLevelWithOnOff" {
		t.Fatalf("unexpected command %+v", invoke.Args)
	}
	payload, ok := invoke.Args["payload"].(map[string]any)
	if !ok {
		t.Fatalf("payload missing from %+v", invoke.Args)
	}
	// 50% of the 0-254 Matter level range, not the percent itself.
	if payload["level"] != float64(127) {
		t.Fatalf("expected level 127 for 50%%, got %v", payload["level"])
	}

	if _, err := controller.ApplyLoad(ctx, LoadCommand{
		NodeID: 4, Endpoint: 1, Action: ActionSetHeatingSetpoint, SetpointCelsius: ptr(21.5),
	}); err == nil {
		t.Fatal("expected a thermostat setpoint on a node with no Thermostat cluster to be refused")
	}

	watts := 1_500.0
	if _, err := controller.ApplyLoad(ctx, LoadCommand{
		NodeID: 4, Endpoint: 1, Action: ActionAdjustPower, PowerAdjustW: &watts, Window: 30 * time.Minute,
	}); err == nil {
		t.Fatal("expected a power adjustment on a node with no Device Energy Management cluster to be refused rather than substituted with an On/Off command")
	}

	badLevel := 140
	if _, err := controller.ApplyLoad(ctx, LoadCommand{
		NodeID: 4, Endpoint: 1, Action: ActionSetLevel, LevelPercent: &badLevel,
	}); err == nil {
		t.Fatal("expected an out-of-range level to be refused")
	}
}

func TestPowerAdjustmentCarriesItsWindowToTheDevice(t *testing.T) {
	fake := newFakeController(t)
	node := waterHeater(4, true)
	node.Attributes["1/152/2"] = float64(1) // Device Energy Management ESAState
	fake.answer = func(cmd command) any {
		if cmd.Command == cmdStartListening {
			return success(cmd, []NodeData{node})
		}
		return success(cmd, nil)
	}
	platform := &recordingPlatform{}
	controller, cancel := startController(t, fake, platform, nil)
	defer cancel()

	watts := 1_500.0
	result, err := controller.ApplyLoad(context.Background(), LoadCommand{
		NodeID: 4, Endpoint: 1, Action: ActionAdjustPower, PowerAdjustW: &watts, Window: 30 * time.Minute,
	})
	if err != nil {
		t.Fatalf("ApplyLoad: %v", err)
	}
	if result.Enforcement != EnforcementDevice {
		t.Fatalf("PowerAdjustRequest carries a duration, so the device holds the window: got %q", result.Enforcement)
	}
	var payload map[string]any
	for _, cmd := range fake.commands() {
		if cmd.Command == cmdDeviceCommand {
			payload, _ = cmd.Args["payload"].(map[string]any)
		}
	}
	if payload["duration"] != float64(1800) {
		t.Fatalf("expected the 30 minute window as 1800 seconds, got %v", payload["duration"])
	}
	if payload["power"] != float64(1_500_000) {
		t.Fatalf("expected 1500 W as milliwatts, got %v", payload["power"])
	}

	if _, err := controller.ApplyLoad(context.Background(), LoadCommand{
		NodeID: 4, Endpoint: 1, Action: ActionAdjustPower, PowerAdjustW: &watts,
	}); err == nil {
		t.Fatal("expected a power adjustment with no window to be refused; the duration is part of the device request")
	}
}

func TestControllerErrorsAndTimeoutsAreNotSuccess(t *testing.T) {
	fake := newFakeController(t)
	fake.answer = func(cmd command) any {
		switch cmd.Command {
		case cmdStartListening:
			return success(cmd, []NodeData{waterHeater(4, true)})
		case cmdDeviceCommand:
			return map[string]any{"message_id": cmd.MessageID, "error_code": 3, "details": "NodeNotReady"}
		default:
			// No answer at all: the command must time out rather than resolve.
			return nil
		}
	}
	platform := &recordingPlatform{}
	controller, cancel := startController(t, fake, platform, func(cfg *Config) { cfg.CallTimeout = 150 * time.Millisecond })
	defer cancel()
	ctx := context.Background()

	_, err := controller.ApplyLoad(ctx, LoadCommand{NodeID: 4, Endpoint: 1, Action: ActionTurnOff})
	var controllerErr *ControllerError
	if !errors.As(err, &controllerErr) || controllerErr.Code != 3 {
		t.Fatalf("expected the controller's error to surface, got %v", err)
	}

	start := time.Now()
	if _, err := controller.ReadAttribute(ctx, 4, AttributePath{Endpoint: 1, ClusterID: ClusterOnOff, AttrID: AttrOnOff}); err == nil {
		t.Fatal("expected an unanswered read to fail rather than return a zero value")
	}
	if elapsed := time.Since(start); elapsed < 100*time.Millisecond {
		t.Fatalf("expected the read to wait for its timeout, returned after %s", elapsed)
	}
}

func TestPendingCommandsFailWhenTheControllerDisconnects(t *testing.T) {
	fake := newFakeController(t)
	fake.answer = func(cmd command) any {
		if cmd.Command == cmdStartListening {
			return success(cmd, []NodeData{waterHeater(4, true)})
		}
		return nil
	}
	platform := &recordingPlatform{}
	controller, cancel := startController(t, fake, platform, func(cfg *Config) { cfg.CallTimeout = 5 * time.Second })
	defer cancel()

	done := make(chan error, 1)
	go func() {
		_, err := controller.ApplyLoad(context.Background(), LoadCommand{NodeID: 4, Endpoint: 1, Action: ActionTurnOff})
		done <- err
	}()

	time.Sleep(100 * time.Millisecond)
	conn := <-fake.conns
	_ = conn.Close()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected a command in flight when the controller dropped to fail, not to be reported as sent")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a command in flight was never failed after the controller dropped")
	}
}

func TestReadLoadTelemetryReportsOnlyWhatTheNodeAnswers(t *testing.T) {
	fake := newFakeController(t)
	fake.answer = func(cmd command) any {
		if cmd.Command == cmdStartListening {
			return success(cmd, []NodeData{waterHeater(4, true)})
		}
		if cmd.Command != cmdReadAttribute {
			return success(cmd, nil)
		}
		switch cmd.Args["attribute_path"] {
		case "1/144/10":
			return success(cmd, map[string]any{"1/144/10": nil})
		case "1/145/1":
			return success(cmd, map[string]any{"1/145/1": map[string]any{"energy": 12_000_000}})
		case "1/6/0":
			return success(cmd, map[string]any{"1/6/0": true})
		default:
			return success(cmd, map[string]any{})
		}
	}
	platform := &recordingPlatform{}
	controller, cancel := startController(t, fake, platform, nil)
	defer cancel()

	telemetry, err := controller.ReadLoadTelemetry(context.Background(), 4, 1)
	if err != nil {
		t.Fatalf("ReadLoadTelemetry: %v", err)
	}
	if telemetry.ActivePowerW != nil {
		t.Fatalf("a node reporting a null power is unknown, not zero: got %v", *telemetry.ActivePowerW)
	}
	if telemetry.EnergyImportedWh == nil || *telemetry.EnergyImportedWh != 12_000 {
		t.Fatalf("expected 12000 Wh from 12000000 mWh, got %v", telemetry.EnergyImportedWh)
	}
	if telemetry.OnOff == nil || !*telemetry.OnOff {
		t.Fatalf("expected the reported OnOff state, got %v", telemetry.OnOff)
	}
}

func TestAReadThatOmitsThePathIsAnError(t *testing.T) {
	fake := newFakeController(t)
	fake.answer = func(cmd command) any {
		if cmd.Command == cmdStartListening {
			return success(cmd, []NodeData{waterHeater(4, true)})
		}
		// Answers with a different path than the one requested.
		return success(cmd, map[string]any{"1/6/1": true})
	}
	platform := &recordingPlatform{}
	controller, cancel := startController(t, fake, platform, nil)
	defer cancel()

	if _, err := controller.ReadAttribute(context.Background(), 4, AttributePath{
		Endpoint: 1, ClusterID: ClusterOnOff, AttrID: AttrOnOff,
	}); err == nil {
		t.Fatal("expected a response that omits the requested attribute to be an error, not a zero value")
	}
}

func TestNodeRemovalReachesThePlatform(t *testing.T) {
	fake := newFakeController(t)
	fake.answer = func(cmd command) any {
		if cmd.Command == cmdStartListening {
			return success(cmd, []NodeData{waterHeater(4, true)})
		}
		return success(cmd, nil)
	}
	platform := &recordingPlatform{}
	controller, cancel := startController(t, fake, platform, nil)
	defer cancel()

	fake.push(eventNodeRemoved, 4)
	deadline := time.Now().Add(time.Second)
	for {
		platform.mu.Lock()
		removed := len(platform.removed)
		platform.mu.Unlock()
		if removed == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("node removal never reached the platform")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, err := controller.ApplyLoad(context.Background(), LoadCommand{NodeID: 4, Endpoint: 1, Action: ActionTurnOff}); err == nil {
		t.Fatal("expected a removed node to be uncommandable")
	}
}

func ptr[T any](value T) *T { return &value }
