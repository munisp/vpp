package matter

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// WindowEnforcement records who holds a control's expiry, which decides whether
// the platform has to restore the load itself when the window ends.
type WindowEnforcement string

const (
	// EnforcementDevice means the node was given the duration and will end the
	// adjustment on its own (Device Energy Management PowerAdjustRequest).
	EnforcementDevice WindowEnforcement = "device"
	// EnforcementPlatform means the cluster used has no expiry — On/Off and
	// Level Control do not — so the load stays as commanded until something
	// commands it back. The platform's control sweeper owns that restoration;
	// the window is not enforced at the device and must not be reported as if it
	// were.
	EnforcementPlatform WindowEnforcement = "platform"
)

// Capability is what the controller's reported attributes say a node can do. It
// is derived only from clusters the node actually exposes: a load is never
// assumed to be dimmable or energy-manageable because its type suggests it.
type Capability struct {
	NodeID   int64
	Endpoint uint16
	// Clusters present on the endpoint.
	OnOff             bool
	LevelControl      bool
	Thermostat        bool
	EnergyManagement  bool
	PowerMeasurement  bool
	EnergyMeasurement bool
}

// Capabilities reads the node's cluster set out of the attributes the controller
// reported. A node with no attributes yet yields no capabilities rather than a
// guess, so a load that has not been interviewed cannot be dispatched.
func (c *Controller) Capabilities(nodeID int64) ([]Capability, error) {
	value, ok := c.nodes.Load(nodeID)
	if !ok {
		return nil, fmt.Errorf("matter: node %d is not commissioned on this fabric", nodeID)
	}
	node := value.(NodeData)
	byEndpoint := make(map[uint16]*Capability)
	for path := range node.Attributes {
		parsed, err := ParseAttributePath(path)
		if err != nil {
			continue
		}
		capability, ok := byEndpoint[parsed.Endpoint]
		if !ok {
			capability = &Capability{NodeID: nodeID, Endpoint: parsed.Endpoint}
			byEndpoint[parsed.Endpoint] = capability
		}
		switch parsed.ClusterID {
		case ClusterOnOff:
			capability.OnOff = true
		case ClusterLevelControl:
			capability.LevelControl = true
		case ClusterThermostat:
			capability.Thermostat = true
		case ClusterDeviceEnergyManagement:
			capability.EnergyManagement = true
		case ClusterElectricalPowerMeasurement:
			capability.PowerMeasurement = true
		case ClusterElectricalEnergyMeasureme:
			capability.EnergyMeasurement = true
		}
	}
	capabilities := make([]Capability, 0, len(byEndpoint))
	for _, capability := range byEndpoint {
		capabilities = append(capabilities, *capability)
	}
	return capabilities, nil
}

// LoadCommand is a bounded load control, expressed the way the platform's
// control path expresses every other protocol's controls.
type LoadCommand struct {
	NodeID   int64
	Endpoint uint16
	// Action is one of the actions below.
	Action string
	// LevelPercent is required by ActionSetLevel: 0-100.
	LevelPercent *int
	// SetpointCelsius is required by ActionSetHeatingSetpoint.
	SetpointCelsius *float64
	// PowerAdjustW is required by ActionAdjustPower: the absolute power the node
	// should draw.
	PowerAdjustW *float64
	// Window is how long the control is meant to hold. Required for
	// ActionAdjustPower, which carries it to the device; for the other actions it
	// is what the platform will enforce.
	Window time.Duration
}

// Load control actions.
const (
	ActionTurnOn             = "turn_on"
	ActionTurnOff            = "turn_off"
	ActionSetLevel           = "set_level"
	ActionSetHeatingSetpoint = "set_heating_setpoint"
	ActionAdjustPower        = "adjust_power"
)

// LoadResult is the evidence a control produced. Acknowledged means the node
// answered the interaction; it is deliberately not called "applied".
type LoadResult struct {
	NodeID      int64             `json:"node_id"`
	Endpoint    uint16            `json:"endpoint_id"`
	Action      string            `json:"action"`
	Enforcement WindowEnforcement `json:"window_enforcement"`
	// Acknowledged is true when the controller reported no error. The load's
	// actual power is only known from a subsequent attribute report.
	Acknowledged bool `json:"acknowledged"`
	// ControllerResult is the controller's raw answer, kept as evidence.
	ControllerResult json.RawMessage `json:"controller_result,omitempty"`
	AcknowledgedAt   time.Time       `json:"acknowledged_at"`
}

// ApplyLoad performs a bounded load control. The cluster used is chosen from the
// node's reported capabilities, and a control the node cannot express is refused
// rather than substituted with a weaker one: switching a water heater off is not
// the same as trimming it to 1 kW, and the platform must not settle flexibility
// against a control it did not actually issue.
func (c *Controller) ApplyLoad(ctx context.Context, cmd LoadCommand) (LoadResult, error) {
	if err := c.requireCommandable(cmd.NodeID); err != nil {
		return LoadResult{}, err
	}
	capability, err := c.capabilityFor(cmd.NodeID, cmd.Endpoint)
	if err != nil {
		return LoadResult{}, err
	}

	switch cmd.Action {
	case ActionTurnOn, ActionTurnOff:
		if !capability.OnOff {
			return LoadResult{}, fmt.Errorf("matter: node %d endpoint %d exposes no On/Off cluster", cmd.NodeID, cmd.Endpoint)
		}
		name := "On"
		if cmd.Action == ActionTurnOff {
			name = "Off"
		}
		return c.invokeLoad(ctx, cmd, capability, ClusterOnOff, name, map[string]any{}, EnforcementPlatform)

	case ActionSetLevel:
		if cmd.LevelPercent == nil {
			return LoadResult{}, errors.New("matter: set_level requires a level percent")
		}
		if *cmd.LevelPercent < 0 || *cmd.LevelPercent > 100 {
			return LoadResult{}, fmt.Errorf("matter: level percent %d is outside 0-100", *cmd.LevelPercent)
		}
		if !capability.LevelControl {
			return LoadResult{}, fmt.Errorf("matter: node %d endpoint %d exposes no Level Control cluster", cmd.NodeID, cmd.Endpoint)
		}
		// Matter levels are 0-254; the percent is scaled rather than passed
		// through, since a percent written as a level would silently halve the
		// requested load.
		level := int(float64(*cmd.LevelPercent) * 254.0 / 100.0)
		return c.invokeLoad(ctx, cmd, capability, ClusterLevelControl, "MoveToLevelWithOnOff", map[string]any{
			"level":           level,
			"transitionTime":  0,
			"optionsMask":     0,
			"optionsOverride": 0,
		}, EnforcementPlatform)

	case ActionSetHeatingSetpoint:
		if cmd.SetpointCelsius == nil {
			return LoadResult{}, errors.New("matter: set_heating_setpoint requires a setpoint")
		}
		if !capability.Thermostat {
			return LoadResult{}, fmt.Errorf("matter: node %d endpoint %d exposes no Thermostat cluster", cmd.NodeID, cmd.Endpoint)
		}
		// Thermostat setpoints are signed hundredths of a degree Celsius.
		hundredths := int(*cmd.SetpointCelsius * 100)
		path := AttributePath{Endpoint: cmd.Endpoint, ClusterID: ClusterThermostat, AttrID: AttrOccupiedHeatingSetpoint}
		if err := c.WriteAttribute(ctx, cmd.NodeID, path, hundredths); err != nil {
			return LoadResult{}, err
		}
		return LoadResult{
			NodeID:         cmd.NodeID,
			Endpoint:       cmd.Endpoint,
			Action:         cmd.Action,
			Enforcement:    EnforcementPlatform,
			Acknowledged:   true,
			AcknowledgedAt: time.Now().UTC(),
		}, nil

	case ActionAdjustPower:
		if cmd.PowerAdjustW == nil {
			return LoadResult{}, errors.New("matter: adjust_power requires a power in watts")
		}
		if cmd.Window <= 0 {
			return LoadResult{}, errors.New("matter: adjust_power requires a window; the duration is part of the device request")
		}
		if !capability.EnergyManagement {
			return LoadResult{}, fmt.Errorf(
				"matter: node %d endpoint %d exposes no Device Energy Management cluster, so a power adjustment cannot be requested; use a load control the node supports",
				cmd.NodeID, cmd.Endpoint,
			)
		}
		// PowerAdjustRequest carries its own duration, so this is the one load
		// control whose window the device itself enforces. Power is milliwatts.
		return c.invokeLoad(ctx, cmd, capability, ClusterDeviceEnergyManagement, "PowerAdjustRequest", map[string]any{
			"power":    int64(*cmd.PowerAdjustW * 1000),
			"duration": int(cmd.Window / time.Second),
			"cause":    0,
		}, EnforcementDevice)

	default:
		return LoadResult{}, fmt.Errorf("matter: unknown load action %q", cmd.Action)
	}
}

func (c *Controller) capabilityFor(nodeID int64, endpoint uint16) (Capability, error) {
	capabilities, err := c.Capabilities(nodeID)
	if err != nil {
		return Capability{}, err
	}
	for _, capability := range capabilities {
		if capability.Endpoint == endpoint {
			return capability, nil
		}
	}
	return Capability{}, fmt.Errorf(
		"matter: node %d has reported no attributes on endpoint %d, so its clusters are unknown; it cannot be dispatched until the controller has interviewed it",
		nodeID, endpoint,
	)
}

func (c *Controller) invokeLoad(
	ctx context.Context,
	cmd LoadCommand,
	capability Capability,
	clusterID uint32,
	commandName string,
	payload map[string]any,
	enforcement WindowEnforcement,
) (LoadResult, error) {
	result, err := c.InvokeCommand(ctx, cmd.NodeID, capability.Endpoint, clusterID, commandName, payload)
	if err != nil {
		return LoadResult{}, err
	}
	return LoadResult{
		NodeID:           cmd.NodeID,
		Endpoint:         capability.Endpoint,
		Action:           cmd.Action,
		Enforcement:      enforcement,
		Acknowledged:     true,
		ControllerResult: result,
		AcknowledgedAt:   time.Now().UTC(),
	}, nil
}

// LoadTelemetry is what a node reports about its own consumption. Every field is
// optional: a node that does not expose Electrical Power Measurement reports no
// power, and the platform must treat that as unknown rather than zero.
type LoadTelemetry struct {
	NodeID           int64     `json:"node_id"`
	Endpoint         uint16    `json:"endpoint_id"`
	ActivePowerW     *float64  `json:"active_power_w,omitempty"`
	EnergyImportedWh *float64  `json:"energy_imported_wh,omitempty"`
	OnOff            *bool     `json:"on_off,omitempty"`
	ReadAt           time.Time `json:"read_at"`
}

// ReadLoadTelemetry reads what the node exposes. Absent clusters yield absent
// fields; an attribute the node fails to answer is an error, so a read failure
// cannot be recorded as a zero-power load.
func (c *Controller) ReadLoadTelemetry(ctx context.Context, nodeID int64, endpoint uint16) (LoadTelemetry, error) {
	capability, err := c.capabilityFor(nodeID, endpoint)
	if err != nil {
		return LoadTelemetry{}, err
	}
	telemetry := LoadTelemetry{NodeID: nodeID, Endpoint: endpoint, ReadAt: time.Now().UTC()}

	if capability.PowerMeasurement {
		raw, err := c.ReadAttribute(ctx, nodeID, AttributePath{
			Endpoint: endpoint, ClusterID: ClusterElectricalPowerMeasurement, AttrID: AttrActivePower,
		})
		if err != nil {
			return LoadTelemetry{}, err
		}
		// Electrical Power Measurement reports milliwatts.
		milliwatts, err := decodeNumber(raw)
		if err != nil {
			return LoadTelemetry{}, fmt.Errorf("matter: node %d active power: %w", nodeID, err)
		}
		if milliwatts != nil {
			watts := *milliwatts / 1000
			telemetry.ActivePowerW = &watts
		}
	}

	if capability.EnergyMeasurement {
		raw, err := c.ReadAttribute(ctx, nodeID, AttributePath{
			Endpoint: endpoint, ClusterID: ClusterElectricalEnergyMeasureme, AttrID: AttrCumulativeEnergyImported,
		})
		if err != nil {
			return LoadTelemetry{}, err
		}
		// Cumulative energy is a struct with milliwatt-hours; only the energy
		// member is read, and a shape this client does not recognise is an error
		// rather than a dropped reading.
		milliwattHours, err := decodeEnergyMeasurement(raw)
		if err != nil {
			return LoadTelemetry{}, fmt.Errorf("matter: node %d cumulative energy: %w", nodeID, err)
		}
		if milliwattHours != nil {
			wattHours := *milliwattHours / 1000
			telemetry.EnergyImportedWh = &wattHours
		}
	}

	if capability.OnOff {
		raw, err := c.ReadAttribute(ctx, nodeID, AttributePath{
			Endpoint: endpoint, ClusterID: ClusterOnOff, AttrID: AttrOnOff,
		})
		if err != nil {
			return LoadTelemetry{}, err
		}
		var on bool
		if err := json.Unmarshal(raw, &on); err != nil {
			return LoadTelemetry{}, fmt.Errorf("matter: node %d OnOff attribute is not a boolean: %s", nodeID, strings.TrimSpace(string(raw)))
		}
		telemetry.OnOff = &on
	}

	return telemetry, nil
}

// decodeNumber reads a numeric attribute. JSON null means the node reported the
// attribute as null, which is unknown, not zero.
func decodeNumber(raw json.RawMessage) (*float64, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil, nil
	}
	value, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return nil, fmt.Errorf("attribute value %q is not a number", trimmed)
	}
	return &value, nil
}

// decodeEnergyMeasurement reads an EnergyMeasurementStruct's energy member.
func decodeEnergyMeasurement(raw json.RawMessage) (*float64, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil, nil
	}
	var measurement struct {
		Energy *float64 `json:"energy"`
	}
	if err := json.Unmarshal(raw, &measurement); err != nil {
		return nil, fmt.Errorf("attribute value %q is not an energy measurement struct", trimmed)
	}
	if measurement.Energy == nil {
		return nil, errors.New("energy measurement struct carries no energy member")
	}
	return measurement.Energy, nil
}
