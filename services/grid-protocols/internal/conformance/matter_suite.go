package conformance

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/vpp/grid-protocols/internal/matter"
)

// The Matter vector set runs this service's real controller client against a
// simulated Matter controller (the python-matter-server WebSocket API this
// service speaks) with two commissioned nodes: a metered smart plug and an
// energy-manageable water heater.
//
// The cases target the scaling and capability rules a wrong implementation gets
// wrong invisibly: levels are 0-254 rather than percent, Device Energy
// Management power is milliwatts and carries its own duration, Electrical Power
// Measurement reports milliwatts, a load control the node's clusters cannot
// express must be refused rather than substituted, and the controller's
// synthetic test nodes must never be dispatched.

const (
	matterPlugNodeID   int64 = 11
	matterHeaterNodeID int64 = 12
	matterTestNodeID   int64 = matter.TestNodeIDStart + 1
)

// matterSimulator is the controller side of the WebSocket API: it answers
// commands from a fixed node inventory. Every answer is what the real controller
// would send for that command, so a client that misreads a payload fails here.
type matterSimulator struct {
	server *httptest.Server

	mu        sync.Mutex
	commands  []simulatedCommand
	attribute map[string]any
	// failInvoke makes device_command answer with an error, so a case can prove a
	// refused dispatch is reported as refused.
	failInvoke bool
	// nullPower makes the plug report a null active power, which is unknown
	// rather than zero.
	nullPower bool

	writeMu sync.Mutex
}

type simulatedCommand struct {
	Command string
	Args    map[string]any
}

func newMatterSimulator() *matterSimulator {
	sim := &matterSimulator{attribute: map[string]any{}}
	sim.server = httptest.NewServer(http.HandlerFunc(sim.serve))
	return sim
}

func (s *matterSimulator) url() string {
	return "ws" + strings.TrimPrefix(s.server.URL, "http")
}

func (s *matterSimulator) write(conn *websocket.Conn, payload any) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_ = conn.WriteJSON(payload)
}

func (s *matterSimulator) serve(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	s.write(conn, map[string]any{
		"fabric_id":                    1,
		"compressed_fabric_id":         2,
		"schema_version":               matter.SchemaVersion,
		"min_supported_schema_version": 9,
		"sdk_version":                  "conformance-simulator",
		"bluetooth_enabled":            false,
	})

	for {
		var inbound struct {
			MessageID string         `json:"message_id"`
			Command   string         `json:"command"`
			Args      map[string]any `json:"args"`
		}
		if err := conn.ReadJSON(&inbound); err != nil {
			return
		}
		s.mu.Lock()
		s.commands = append(s.commands, simulatedCommand{Command: inbound.Command, Args: inbound.Args})
		failInvoke := s.failInvoke
		nullPower := s.nullPower
		s.mu.Unlock()

		switch inbound.Command {
		case "start_listening", "get_nodes":
			s.write(conn, map[string]any{"message_id": inbound.MessageID, "result": s.nodes(nullPower)})
		case "device_command":
			if failInvoke {
				s.write(conn, map[string]any{
					"message_id": inbound.MessageID,
					"error_code": 1,
					"details":    "node did not respond to the interaction",
				})
				continue
			}
			s.write(conn, map[string]any{"message_id": inbound.MessageID, "result": map[string]any{"Status": 0}})
		case "write_attribute":
			s.write(conn, map[string]any{"message_id": inbound.MessageID, "result": map[string]any{"Status": 0}})
		case "read_attribute":
			s.write(conn, map[string]any{"message_id": inbound.MessageID, "result": s.readAttribute(inbound.Args, nullPower)})
		case "ping_node":
			s.write(conn, map[string]any{"message_id": inbound.MessageID, "result": map[string]any{"1": true}})
		default:
			s.write(conn, map[string]any{
				"message_id": inbound.MessageID,
				"error_code": 2,
				"details":    "unknown command " + inbound.Command,
			})
		}
	}
}

// nodes is the fabric inventory. Attribute keys are the controller's
// endpoint/cluster/attribute paths, which is also how it advertises clusters.
func (s *matterSimulator) nodes(nullPower bool) []map[string]any {
	plugPower := any(1500000) // milliwatts
	if nullPower {
		plugPower = nil
	}
	return []map[string]any{
		{
			"node_id":   matterPlugNodeID,
			"available": true,
			"is_bridge": false,
			"attributes": map[string]any{
				"1/6/0":    true,
				"1/8/0":    254,
				"1/144/10": plugPower,
				"1/145/1":  map[string]any{"energy": 4200000},
			},
		},
		{
			"node_id":   matterHeaterNodeID,
			"available": true,
			"is_bridge": false,
			"attributes": map[string]any{
				"1/6/0":   true,
				"1/152/2": 1,
				"1/145/1": map[string]any{"energy": 9000000},
			},
		},
		{
			"node_id":   matterTestNodeID,
			"available": true,
			"is_bridge": false,
			"attributes": map[string]any{
				"1/6/0": true,
			},
		},
	}
}

// readAttribute answers the way the controller does: a map keyed by the
// requested attribute path, so a client that reads the wrong key fails rather
// than picking up whatever single value came back.
func (s *matterSimulator) readAttribute(args map[string]any, nullPower bool) map[string]any {
	path, _ := args["attribute_path"].(string)
	switch path {
	case "1/144/10":
		if nullPower {
			return map[string]any{path: nil}
		}
		return map[string]any{path: 1500000}
	case "1/145/1":
		return map[string]any{path: map[string]any{"energy": 4200000}}
	case "1/6/0":
		return map[string]any{path: true}
	default:
		return map[string]any{}
	}
}

func (s *matterSimulator) issued() []simulatedCommand {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]simulatedCommand, len(s.commands))
	copy(out, s.commands)
	return out
}

func (s *matterSimulator) lastDeviceCommand() (simulatedCommand, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := len(s.commands) - 1; i >= 0; i-- {
		if s.commands[i].Command == "device_command" {
			return s.commands[i], true
		}
	}
	return simulatedCommand{}, false
}

func (s *matterSimulator) setFailInvoke(fail bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failInvoke = fail
}

func (s *matterSimulator) setNullPower(null bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nullPower = null
}

// matterRecorder is the platform side. It records what the controller reported
// without interpreting it.
type matterRecorder struct {
	mu       sync.Mutex
	nodeSets [][]matter.NodeData
	removed  []int64
}

func (r *matterRecorder) MatterNodesReported(_ context.Context, _ uint64, nodes []matter.NodeData) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.nodeSets = append(r.nodeSets, nodes)
	return nil
}

func (r *matterRecorder) MatterNodeReported(context.Context, uint64, matter.NodeData) error {
	return nil
}

func (r *matterRecorder) MatterAttributeReported(context.Context, int64, string, json.RawMessage) error {
	return nil
}

func (r *matterRecorder) MatterNodeRemoved(_ context.Context, nodeID int64) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.removed = append(r.removed, nodeID)
	return nil
}

type matterPeer struct {
	sim        *matterSimulator
	controller *matter.Controller
	recorder   *matterRecorder
}

func newMatterPeer(ctx context.Context) (*matterPeer, func(), error) {
	sim := newMatterSimulator()
	recorder := &matterRecorder{}
	controller, err := matter.NewController(matter.Config{
		URL:               sim.url(),
		CallTimeout:       5 * time.Second,
		ReconnectInterval: time.Second,
	}, recorder)
	if err != nil {
		sim.server.Close()
		return nil, nil, fmt.Errorf("controller: %w", err)
	}

	runCtx, cancel := context.WithCancel(ctx)
	go func() { _ = controller.Run(runCtx) }()

	// Wait for the handshake and the node inventory: a suite that started before
	// the fabric was known would test a client with no nodes.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if controller.Connected() && len(controller.KnownNodes()) > 0 {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			sim.server.Close()
			return nil, nil, errors.New("simulated controller did not report a fabric within 5s")
		}
		time.Sleep(20 * time.Millisecond)
	}

	return &matterPeer{sim: sim, controller: controller, recorder: recorder}, func() {
		cancel()
		sim.server.Close()
	}, nil
}

// MatterSuite is the Matter vector set.
func MatterSuite() Suite {
	return Suite{
		Adapter:          AdapterMatter,
		VectorSetID:      "vpp-matter-load-control",
		VectorSetVersion: "1",
		ProtocolVersion:  fmt.Sprintf("controller-schema-%d", matter.SchemaVersion),
		DeviceModel:      "vpp-matter-controller-simulator",
		Setup: func(ctx context.Context) (*Env, func(), error) {
			peer, teardown, err := newMatterPeer(ctx)
			if err != nil {
				return nil, nil, err
			}
			return &Env{Peer: peer, Target: TargetSimulator}, teardown, nil
		},
		Cases: []Case{
			{
				ID:          "matter-001-capabilities-from-clusters",
				Name:        "Capabilities come from the clusters the node exposes",
				Requirement: "Matter device types are advisory; a load is dimmable only if it exposes Level Control (cluster 0x0008)",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*matterPeer)
					plug, err := peer.controller.Capabilities(matterPlugNodeID)
					if err != nil {
						return nil, err
					}
					heater, err := peer.controller.Capabilities(matterHeaterNodeID)
					if err != nil {
						return nil, err
					}
					if len(plug) == 0 || len(heater) == 0 {
						return nil, errors.New("a commissioned node yielded no capabilities")
					}
					if !plug[0].LevelControl {
						return plug, errors.New("the plug exposes Level Control but was not read as dimmable")
					}
					if heater[0].LevelControl {
						return heater, errors.New("the heater exposes no Level Control but was read as dimmable")
					}
					if !heater[0].EnergyManagement {
						return heater, errors.New("the heater exposes Device Energy Management but was not read as energy-manageable")
					}
					return map[string]any{"plug": plug[0], "heater": heater[0]}, nil
				},
			},
			{
				ID:          "matter-002-level-percent-scaled",
				Name:        "A level percent is scaled to Matter's 0-254 range",
				Requirement: "Matter Level Control levels are 0-254; passing a percent through would run a load at ~40% of the requested level",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*matterPeer)
					percent := 50
					result, err := peer.controller.ApplyLoad(ctx, matter.LoadCommand{
						NodeID:       matterPlugNodeID,
						Endpoint:     1,
						Action:       matter.ActionSetLevel,
						LevelPercent: &percent,
						Window:       15 * time.Minute,
					})
					if err != nil {
						return nil, err
					}
					if !result.Acknowledged {
						return result, errors.New("the controller did not acknowledge the level command")
					}
					issued, ok := peer.sim.lastDeviceCommand()
					if !ok {
						return nil, errors.New("no device command reached the controller")
					}
					payload, _ := issued.Args["payload"].(map[string]any)
					level, ok := payload["level"].(float64)
					if !ok {
						return issued.Args, errors.New("the command carried no level")
					}
					if int(level) != 127 {
						return issued.Args, fmt.Errorf("50%% was sent as level %d, expected 127", int(level))
					}
					return map[string]any{"level": int(level), "enforcement": result.Enforcement}, nil
				},
			},
			{
				ID:          "matter-003-level-window-enforced-by-platform",
				Name:        "A Level Control window is reported as platform-enforced",
				Requirement: "Level Control has no expiry; reporting the window as device-enforced would leave a load trimmed after the window with nobody restoring it",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*matterPeer)
					percent := 30
					result, err := peer.controller.ApplyLoad(ctx, matter.LoadCommand{
						NodeID:       matterPlugNodeID,
						Endpoint:     1,
						Action:       matter.ActionSetLevel,
						LevelPercent: &percent,
						Window:       10 * time.Minute,
					})
					if err != nil {
						return nil, err
					}
					if result.Enforcement != matter.EnforcementPlatform {
						return result, fmt.Errorf("enforcement reported as %q", result.Enforcement)
					}
					return result, nil
				},
			},
			{
				ID:          "matter-004-power-adjust-milliwatts-and-duration",
				Name:        "A power adjustment is sent in milliwatts with its own duration",
				Requirement: "Matter Device Energy Management PowerAdjustRequest takes milliwatts and seconds; watts would request a thousandth of the intended adjustment",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*matterPeer)
					watts := 1200.0
					result, err := peer.controller.ApplyLoad(ctx, matter.LoadCommand{
						NodeID:       matterHeaterNodeID,
						Endpoint:     1,
						Action:       matter.ActionAdjustPower,
						PowerAdjustW: &watts,
						Window:       30 * time.Minute,
					})
					if err != nil {
						return nil, err
					}
					if result.Enforcement != matter.EnforcementDevice {
						return result, fmt.Errorf("a PowerAdjustRequest carries its own duration but enforcement was %q", result.Enforcement)
					}
					issued, ok := peer.sim.lastDeviceCommand()
					if !ok {
						return nil, errors.New("no device command reached the controller")
					}
					payload, _ := issued.Args["payload"].(map[string]any)
					power, powerOK := payload["power"].(float64)
					duration, durationOK := payload["duration"].(float64)
					if !powerOK || !durationOK {
						return issued.Args, errors.New("the command carried no power or duration")
					}
					if int64(power) != 1200000 {
						return issued.Args, fmt.Errorf("1200 W was sent as %d mW", int64(power))
					}
					if int(duration) != 1800 {
						return issued.Args, fmt.Errorf("a 30 minute window was sent as %d seconds", int(duration))
					}
					return map[string]any{"power_mw": int64(power), "duration_s": int(duration)}, nil
				},
			},
			{
				ID:          "matter-005-unsupported-control-refused",
				Name:        "A power adjustment to a node with no energy-management cluster is refused",
				Requirement: "Substituting a weaker control (switching off instead of trimming) would settle flexibility against a control that was never issued",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*matterPeer)
					before := len(peer.sim.issued())
					watts := 800.0
					_, err := peer.controller.ApplyLoad(ctx, matter.LoadCommand{
						NodeID:       matterPlugNodeID,
						Endpoint:     1,
						Action:       matter.ActionAdjustPower,
						PowerAdjustW: &watts,
						Window:       15 * time.Minute,
					})
					if err == nil {
						return nil, errors.New("a power adjustment was accepted for a node exposing no Device Energy Management cluster")
					}
					after := peer.sim.issued()
					for _, one := range after[before:] {
						if one.Command == "device_command" {
							return one, errors.New("a refused control still sent a command to the fabric")
						}
					}
					return map[string]string{"error": err.Error()}, nil
				},
			},
			{
				ID:          "matter-006-synthetic-test-node-refused",
				Name:        "The controller's synthetic test nodes are refused",
				Requirement: "The controller acknowledges commands to its synthetic nodes without performing them; dispatching one would fabricate a delivered control",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*matterPeer)
					_, err := peer.controller.ApplyLoad(ctx, matter.LoadCommand{
						NodeID:   matterTestNodeID,
						Endpoint: 1,
						Action:   matter.ActionTurnOff,
						Window:   10 * time.Minute,
					})
					if err == nil {
						return nil, errors.New("a command to a synthetic test node was accepted")
					}
					if !errors.Is(err, matter.ErrTestNode) {
						return nil, fmt.Errorf("refused for the wrong reason: %v", err)
					}
					return map[string]string{"error": err.Error()}, nil
				},
			},
			{
				ID:          "matter-007-controller-error-is-not-a-dispatch",
				Name:        "A controller error is reported as a failure, not an acknowledgement",
				Requirement: "A node that did not answer the interaction has not been dispatched; reporting success would credit an undelivered control",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*matterPeer)
					peer.sim.setFailInvoke(true)
					defer peer.sim.setFailInvoke(false)

					result, err := peer.controller.ApplyLoad(ctx, matter.LoadCommand{
						NodeID:   matterPlugNodeID,
						Endpoint: 1,
						Action:   matter.ActionTurnOff,
						Window:   10 * time.Minute,
					})
					if err == nil {
						return result, errors.New("a controller error was reported as an acknowledged control")
					}
					var controllerErr *matter.ControllerError
					if !errors.As(err, &controllerErr) {
						return nil, fmt.Errorf("failed for the wrong reason: %v", err)
					}
					return map[string]any{"code": controllerErr.Code, "error": err.Error()}, nil
				},
			},
			{
				ID:          "matter-008-power-measurement-milliwatts",
				Name:        "Electrical Power Measurement is converted from milliwatts to watts",
				Requirement: "Matter Electrical Power Measurement reports milliwatts; storing the raw value would report a 1.5 kW load as 1.5 MW",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*matterPeer)
					telemetry, err := peer.controller.ReadLoadTelemetry(ctx, matterPlugNodeID, 1)
					if err != nil {
						return nil, err
					}
					if telemetry.ActivePowerW == nil {
						return telemetry, errors.New("the plug reports active power but none reached the platform")
					}
					if *telemetry.ActivePowerW != 1500 {
						return telemetry, fmt.Errorf("1500000 mW was read as %v W", *telemetry.ActivePowerW)
					}
					if telemetry.EnergyImportedWh == nil || *telemetry.EnergyImportedWh != 4200 {
						return telemetry, errors.New("cumulative energy was not converted from milliwatt-hours")
					}
					return telemetry, nil
				},
			},
			{
				ID:          "matter-009-null-attribute-is-unknown",
				Name:        "A null power attribute is unknown, not zero",
				Requirement: "A node reporting null has not reported zero watts; a zero would be settled and forecast as a load that stopped drawing",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*matterPeer)
					peer.sim.setNullPower(true)
					defer peer.sim.setNullPower(false)

					telemetry, err := peer.controller.ReadLoadTelemetry(ctx, matterPlugNodeID, 1)
					if err != nil {
						return nil, err
					}
					if telemetry.ActivePowerW != nil {
						return telemetry, fmt.Errorf("a null attribute was read as %v W", *telemetry.ActivePowerW)
					}
					return map[string]any{"active_power_w": nil}, nil
				},
			},
		},
	}
}
