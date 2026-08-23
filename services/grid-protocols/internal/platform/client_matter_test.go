package platform

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vpp/grid-protocols/internal/matter"
)

func captureBody(t *testing.T, call func(*Client) error) (string, []byte) {
	t.Helper()
	var path string
	var body []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		read, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("reading body: %v", err)
		}
		body = read
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	client, err := NewClient(Config{BaseURL: server.URL, SharedSecret: testSecret})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	if err := call(client); err != nil {
		t.Fatalf("call: %v", err)
	}
	return path, body
}

// A Matter node id can exceed 2^53, which a JSON number cannot carry through the
// platform's runtime without rounding — and two node ids that round to the same
// float would be stored as one appliance.
func TestMatterIdentifiersAreSentAsDecimalStrings(t *testing.T) {
	const nodeID int64 = 9007199254740993 // 2^53 + 1
	path, body := captureBody(t, func(c *Client) error {
		return c.MatterNodesReported(context.Background(), 18446744073709551615-1, []matter.NodeData{
			{NodeID: nodeID, Available: true},
		})
	})
	if path != "/api/grid/matter/nodes" {
		t.Fatalf("unexpected path %s", path)
	}
	if !strings.Contains(string(body), `"node_id":"9007199254740993"`) {
		t.Fatalf("node id was not sent as a decimal string: %s", body)
	}
	if !strings.Contains(string(body), `"fabric_id":"18446744073709551614"`) {
		t.Fatalf("fabric id was not sent as a decimal string: %s", body)
	}
}

// The controller's own test nodes acknowledge commands no appliance performs, so
// the platform is told which nodes those are rather than having to guess.
func TestMatterNodesReportedFlagsSyntheticNodes(t *testing.T) {
	_, body := captureBody(t, func(c *Client) error {
		return c.MatterNodesReported(context.Background(), 1, []matter.NodeData{
			{NodeID: 4, Available: true},
			{NodeID: matter.TestNodeIDStart, Available: true},
		})
	})

	var payload struct {
		Nodes []struct {
			NodeID     string `json:"node_id"`
			IsTestNode bool   `json:"is_test_node"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("decoding body: %v", err)
	}
	if len(payload.Nodes) != 2 {
		t.Fatalf("expected 2 nodes, got %d", len(payload.Nodes))
	}
	if payload.Nodes[0].IsTestNode {
		t.Fatalf("node %s was flagged synthetic", payload.Nodes[0].NodeID)
	}
	if !payload.Nodes[1].IsTestNode {
		t.Fatalf("node %s was not flagged synthetic", payload.Nodes[1].NodeID)
	}
}

// An attribute this service cannot interpret still has to reach the platform
// intact, and a null must stay null: stored as 0 it would read as a load drawing
// no power rather than a load that said nothing.
func TestMatterAttributeIsForwardedRaw(t *testing.T) {
	for _, raw := range []string{`null`, `{"value":{"nested":[1,2]}}`, `"unparsed"`} {
		_, body := captureBody(t, func(c *Client) error {
			return c.MatterAttributeReported(context.Background(), 4, "1/144/10", json.RawMessage(raw))
		})
		var payload struct {
			NodeID string          `json:"node_id"`
			Path   string          `json:"attribute_path"`
			Value  json.RawMessage `json:"value"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatalf("decoding body: %v", err)
		}
		if payload.NodeID != "4" || payload.Path != "1/144/10" {
			t.Fatalf("unexpected identity: %+v", payload)
		}
		if string(payload.Value) != raw {
			t.Fatalf("value was rewritten: got %s want %s", payload.Value, raw)
		}
	}
}

func TestMatterNodeRemovedNamesTheNode(t *testing.T) {
	path, body := captureBody(t, func(c *Client) error {
		return c.MatterNodeRemoved(context.Background(), 4)
	})
	if path != "/api/grid/matter/node-removed" {
		t.Fatalf("unexpected path %s", path)
	}
	if string(body) != `{"node_id":"4"}` {
		t.Fatalf("unexpected body %s", body)
	}
}
