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
//
// Fabric and node ids are sent as decimal strings. They are 64-bit Matter
// identifiers and JSON numbers lose precision above 2^53 in the platform's
// runtime, which would silently merge two nodes into one row.

type matterNode struct {
	NodeID     string         `json:"node_id"`
	Available  bool           `json:"available"`
	IsBridge   bool           `json:"is_bridge"`
	IsTestNode bool           `json:"is_test_node"`
	Attributes map[string]any `json:"attributes"`
}

type matterNodesBody struct {
	FabricID string       `json:"fabric_id"`
	Nodes    []matterNode `json:"nodes"`
}

func toMatterNode(node matter.NodeData) matterNode {
	return matterNode{
		NodeID:     strconv.FormatInt(node.NodeID, 10),
		Available:  node.Available,
		IsBridge:   node.IsBridge,
		IsTestNode: node.NodeID >= matter.TestNodeIDStart,
		Attributes: node.Attributes,
	}
}

// MatterNodesReported sends a complete inventory. The platform reconciles
// against it, so every node the controller currently reports must be present:
// one the caller omits is taken to have left the fabric.
func (c *Client) MatterNodesReported(ctx context.Context, fabricID uint64, nodes []matter.NodeData) error {
	body := matterNodesBody{FabricID: strconv.FormatUint(fabricID, 10), Nodes: make([]matterNode, 0, len(nodes))}
	for _, node := range nodes {
		body.Nodes = append(body.Nodes, toMatterNode(node))
	}
	return c.post(ctx, "/api/grid/matter/nodes", body, nil)
}

type matterNodeBody struct {
	FabricID string     `json:"fabric_id"`
	Node     matterNode `json:"node"`
}

// MatterNodeReported sends one node the controller announced or updated. It says
// nothing about the rest of the fabric, so it must not go to the inventory
// endpoint: that would read as an inventory of one and retire every other
// commissioned load.
func (c *Client) MatterNodeReported(ctx context.Context, fabricID uint64, node matter.NodeData) error {
	return c.post(ctx, "/api/grid/matter/node", matterNodeBody{
		FabricID: strconv.FormatUint(fabricID, 10),
		Node:     toMatterNode(node),
	}, nil)
}

type matterAttributeBody struct {
	NodeID string          `json:"node_id"`
	Path   string          `json:"attribute_path"`
	Value  json.RawMessage `json:"value"`
}

func (c *Client) MatterAttributeReported(ctx context.Context, nodeID int64, path string, value json.RawMessage) error {
	return c.post(ctx, "/api/grid/matter/attribute", matterAttributeBody{
		NodeID: strconv.FormatInt(nodeID, 10),
		Path:   path,
		Value:  value,
	}, nil)
}

func (c *Client) MatterNodeRemoved(ctx context.Context, nodeID int64) error {
	return c.post(ctx, "/api/grid/matter/node-removed",
		map[string]string{"node_id": strconv.FormatInt(nodeID, 10)}, nil)
}
