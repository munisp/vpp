// Package matter drives Matter smart-home loads (water heaters, thermostats,
// switches, plugs) through a Matter controller.
//
// This service is not itself a Matter controller: Matter requires the certified
// CHIP stack, commissioning credentials and a fabric, and reimplementing that in
// Go would be a much larger and less trustworthy thing than speaking to a
// certified controller. It therefore talks to the Open Home Foundation Matter
// Server (python-matter-server) over its documented WebSocket API, and every
// device fact it reports comes from that controller.
//
// What it refuses to do:
//   - Run without a controller endpoint. There is no in-process simulation.
//   - Report a node as controllable before the controller has listed it as
//     available: a command to an unavailable node is refused here rather than
//     sent into the void.
//   - Drive the controller's synthetic test nodes (node ids >= 900000), for
//     which the controller answers commands successfully without touching any
//     hardware. Accepting those would fabricate plausible dispatch evidence.
//   - Treat a controller acknowledgement as a physical outcome. A successful
//     invoke means the node acknowledged the interaction; the resulting load is
//     only known from the attribute reports that follow.
package matter

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// The controller's WebSocket protocol: a command carries a client-generated
// message id and the result echoes it, so responses are correlated rather than
// assumed to arrive in order.
type command struct {
	MessageID string         `json:"message_id"`
	Command   string         `json:"command"`
	Args      map[string]any `json:"args,omitempty"`
}

// Controller API commands used here. The controller exposes more; only the ones
// with a caller are listed, so an unimplemented command cannot be typo'd into a
// silent no-op.
const (
	cmdStartListening = "start_listening"
	cmdGetNodes       = "get_nodes"
	cmdDeviceCommand  = "device_command"
	cmdReadAttribute  = "read_attribute"
	cmdWriteAttribute = "write_attribute"
	cmdPingNode       = "ping_node"
)

// Event types the controller pushes. Anything else is logged and ignored rather
// than mapped onto a guess.
const (
	eventAttributeUpdated = "attribute_updated"
	eventNodeAdded        = "node_added"
	eventNodeUpdated      = "node_updated"
	eventNodeRemoved      = "node_removed"
	eventServerShutdown   = "server_shutdown"
)

// serverInfo is the first frame the controller sends on connect. The schema
// version is checked: a controller newer than this client may have changed the
// payloads we decode, and silently continuing would mean acting on
// misinterpreted device state.
type serverInfo struct {
	FabricID                  uint64 `json:"fabric_id"`
	CompressedFabricID        uint64 `json:"compressed_fabric_id"`
	SchemaVersion             int    `json:"schema_version"`
	MinSupportedSchemaVersion int    `json:"min_supported_schema_version"`
	SDKVersion                string `json:"sdk_version"`
	BluetoothEnabled          bool   `json:"bluetooth_enabled"`
}

// SchemaVersion is the controller schema this client is written against.
const SchemaVersion = 11

// frame is any inbound message: a command result, an error result or an event.
// The three are distinguished by which fields are present, so a malformed frame
// cannot be read as an empty success.
type frame struct {
	MessageID string          `json:"message_id"`
	Result    json.RawMessage `json:"result"`
	ErrorCode *int            `json:"error_code"`
	Details   *string         `json:"details"`
	Event     string          `json:"event"`
	Data      json.RawMessage `json:"data"`

	// Present only on the initial server-info frame.
	SchemaVersion             *int   `json:"schema_version"`
	MinSupportedSchemaVersion *int   `json:"min_supported_schema_version"`
	FabricID                  *int64 `json:"fabric_id"`

	// raw is the frame as received, kept so a frame this client cannot classify
	// can be logged verbatim rather than described from a partial decode.
	raw []byte
	// transportErr is set when a waiting command is failed by the connection
	// dropping rather than by a controller answer.
	transportErr error
}

// NodeData is the controller's view of a commissioned node.
type NodeData struct {
	NodeID     int64          `json:"node_id"`
	Available  bool           `json:"available"`
	IsBridge   bool           `json:"is_bridge"`
	Attributes map[string]any `json:"attributes"`
}

// TestNodeIDStart is where the controller's synthetic nodes begin. The
// controller answers commands for these without any network interaction, so this
// service refuses them: a "successful" dispatch to a node that does not exist is
// exactly the mockware this platform does not ship.
const TestNodeIDStart int64 = 900000

// Matter cluster ids this service understands. Matter identifies everything
// numerically; naming them here keeps the mapping auditable.
const (
	ClusterOnOff                      uint32 = 0x0006
	ClusterLevelControl               uint32 = 0x0008
	ClusterThermostat                 uint32 = 0x0201
	ClusterElectricalPowerMeasurement uint32 = 0x0090
	ClusterElectricalEnergyMeasureme  uint32 = 0x0091
	ClusterDeviceEnergyManagement     uint32 = 0x0098
	ClusterWaterHeaterManagement      uint32 = 0x0094
)

// Attribute ids read for telemetry and load state.
const (
	AttrOnOff                    uint32 = 0x0000
	AttrCurrentLevel             uint32 = 0x0000
	AttrLocalTemperature         uint32 = 0x0000
	AttrOccupiedHeatingSetpoint  uint32 = 0x0012
	AttrOccupiedCoolingSetpoint  uint32 = 0x0011
	AttrActivePower              uint32 = 0x000A
	AttrCumulativeEnergyImported uint32 = 0x0001
	AttrESAState                 uint32 = 0x0002
	AttrOptOutState              uint32 = 0x0008
)

// AttributePath is the controller's "<endpoint>/<cluster>/<attribute>" key.
type AttributePath struct {
	Endpoint  uint16
	ClusterID uint32
	AttrID    uint32
}

func (p AttributePath) String() string {
	return fmt.Sprintf("%d/%d/%d", p.Endpoint, p.ClusterID, p.AttrID)
}

// ParseAttributePath reads an "<endpoint>/<cluster>/<attribute>" path. Wildcard
// paths are rejected: a report this service cannot attribute to one attribute
// must not be stored against a guessed one.
func ParseAttributePath(raw string) (AttributePath, error) {
	parts := strings.Split(raw, "/")
	if len(parts) != 3 {
		return AttributePath{}, fmt.Errorf("matter: attribute path %q is not endpoint/cluster/attribute", raw)
	}
	endpoint, err := strconv.ParseUint(parts[0], 10, 16)
	if err != nil {
		return AttributePath{}, fmt.Errorf("matter: attribute path %q has a non-numeric endpoint", raw)
	}
	cluster, err := strconv.ParseUint(parts[1], 10, 32)
	if err != nil {
		return AttributePath{}, fmt.Errorf("matter: attribute path %q has a non-numeric cluster", raw)
	}
	attribute, err := strconv.ParseUint(parts[2], 10, 32)
	if err != nil {
		return AttributePath{}, fmt.Errorf("matter: attribute path %q has a non-numeric attribute", raw)
	}
	return AttributePath{Endpoint: uint16(endpoint), ClusterID: uint32(cluster), AttrID: uint32(attribute)}, nil
}

// attributeReport is the payload of an attribute_updated event, which the
// controller sends as the tuple [node_id, attribute_path, value].
type attributeReport struct {
	NodeID int64
	Path   AttributePath
	Value  json.RawMessage
}

func parseAttributeReport(data json.RawMessage) (attributeReport, error) {
	var tuple []json.RawMessage
	if err := json.Unmarshal(data, &tuple); err != nil {
		return attributeReport{}, fmt.Errorf("matter: attribute_updated payload is not a tuple: %w", err)
	}
	if len(tuple) != 3 {
		return attributeReport{}, fmt.Errorf("matter: attribute_updated payload has %d elements, want 3", len(tuple))
	}
	var nodeID int64
	if err := json.Unmarshal(tuple[0], &nodeID); err != nil {
		return attributeReport{}, fmt.Errorf("matter: attribute_updated node id: %w", err)
	}
	var rawPath string
	if err := json.Unmarshal(tuple[1], &rawPath); err != nil {
		return attributeReport{}, fmt.Errorf("matter: attribute_updated path: %w", err)
	}
	path, err := ParseAttributePath(rawPath)
	if err != nil {
		return attributeReport{}, err
	}
	return attributeReport{NodeID: nodeID, Path: path, Value: tuple[2]}, nil
}
