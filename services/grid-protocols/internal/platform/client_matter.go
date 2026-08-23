package platform

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/vpp/grid-protocols/internal/matter"
)

// The Matter endpoints carry the controller's own view of the fabric. Nothing is
// derived here: a node the controller did not report is not sent, and an
// attribute is forwarded as the raw JSON the node produced so the platform can
// store a value this service cannot interpret rather than coercing it.

type matterNodesBody struct {
	FabricID string            `json:"fabric_id"`
	Nodes    []matter.NodeData `json:"nodes"`
}

func (c *Client) MatterNodesReported(ctx context.Context, fabricID uint64, nodes []matter.NodeData) error {
	// The fabric id is sent as a string: it is a 64-bit identifier and JSON
	// numbers lose precision above 2^53 in the platform's runtime.
	return c.post(ctx, "/api/grid/matter/nodes", matterNodesBody{
		FabricID: strconv.FormatUint(fabricID, 10),
		Nodes:    nodes,
	}, nil)
}

type matterAttributeBody struct {
	NodeID int64           `json:"node_id"`
	Path   string          `json:"attribute_path"`
	Value  json.RawMessage `json:"value"`
}

func (c *Client) MatterAttributeReported(ctx context.Context, nodeID int64, path string, value json.RawMessage) error {
	return c.post(ctx, "/api/grid/matter/attribute", matterAttributeBody{
		NodeID: nodeID,
		Path:   path,
		Value:  value,
	}, nil)
}

func (c *Client) MatterNodeRemoved(ctx context.Context, nodeID int64) error {
	return c.post(ctx, "/api/grid/matter/node-removed", map[string]int64{"node_id": nodeID}, nil)
}
