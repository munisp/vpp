package matter

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sirupsen/logrus"
)

// ErrNotConnected is returned when a call is made with no controller session
// open. Calls are never buffered and reported as sent.
var ErrNotConnected = errors.New("matter: not connected to a controller")

// ErrNodeUnavailable is returned when the controller has not listed the node as
// available. A Matter node that is off the network cannot be commanded, and
// answering the caller with success would fabricate a dispatch.
var ErrNodeUnavailable = errors.New("matter: node is not available on the fabric")

// ErrTestNode is returned for the controller's synthetic node ids. The
// controller answers commands for those without any network interaction.
var ErrTestNode = errors.New("matter: node id is in the controller's synthetic test range")

// ControllerError is an error the controller itself reported, carrying its
// numeric code so a caller can tell a node problem from a bad request.
type ControllerError struct {
	Code    int
	Details string
	Command string
}

func (e *ControllerError) Error() string {
	if e.Details == "" {
		return fmt.Sprintf("matter: controller rejected %s with code %d", e.Command, e.Code)
	}
	return fmt.Sprintf("matter: controller rejected %s with code %d: %s", e.Command, e.Code, e.Details)
}

// Platform receives what the controller reports. Nothing here is invented by
// this service: node inventory comes from the controller's node list and load
// state comes from its attribute reports.
type Platform interface {
	// MatterNodesReported publishes the controller's full node inventory, which
	// is also the only statement of which nodes are reachable.
	MatterNodesReported(ctx context.Context, fabricID uint64, nodes []NodeData) error
	// MatterAttributeReported publishes one attribute report. value is the raw
	// JSON the controller sent, so a value this service cannot interpret is
	// stored rather than coerced.
	MatterAttributeReported(ctx context.Context, nodeID int64, path string, value json.RawMessage) error
	// MatterNodeRemoved records that the node left the fabric.
	MatterNodeRemoved(ctx context.Context, nodeID int64) error
}

// Config describes the controller endpoint.
type Config struct {
	// URL is the controller's WebSocket endpoint, e.g. ws://matter:5580/ws.
	URL string
	// CallTimeout bounds one command. A command whose result never arrives is an
	// error; it is not retried silently, because a Matter invoke is not
	// necessarily idempotent.
	CallTimeout time.Duration
	// ReconnectInterval is how long to wait before redialling a dropped
	// controller connection.
	ReconnectInterval time.Duration
	// AllowTestNodes permits the controller's synthetic nodes (id >= 900000).
	// Off by default and intended only for a development fabric: the controller
	// acknowledges commands to those nodes without performing them.
	AllowTestNodes bool
	Logger         *logrus.Logger
}

// Controller is a client of a Matter controller.
type Controller struct {
	url               string
	callTimeout       time.Duration
	reconnectInterval time.Duration
	allowTestNodes    bool
	logger            *logrus.Logger
	platform          Platform

	connMu sync.Mutex
	conn   *websocket.Conn

	writeMu sync.Mutex

	pendingMu sync.Mutex
	pending   map[string]chan *frame
	counter   atomic.Uint64

	info  atomic.Pointer[serverInfo]
	nodes sync.Map // node id -> NodeData
}

// NewController validates the configuration. A missing URL is refused: there is
// no in-process Matter stack to fall back to, and a controller-less "success"
// would be indistinguishable from a real dispatch.
func NewController(cfg Config, platform Platform) (*Controller, error) {
	raw := strings.TrimSpace(cfg.URL)
	if raw == "" {
		return nil, errors.New("matter: url is required; this service has no built-in Matter stack")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("matter: url is not a URL: %w", err)
	}
	if parsed.Scheme != "ws" && parsed.Scheme != "wss" {
		return nil, fmt.Errorf("matter: url scheme must be ws or wss (got %q)", parsed.Scheme)
	}
	if platform == nil {
		return nil, errors.New("matter: a platform is required; device reports must be persisted")
	}
	callTimeout := cfg.CallTimeout
	if callTimeout <= 0 {
		callTimeout = 30 * time.Second
	}
	reconnect := cfg.ReconnectInterval
	if reconnect <= 0 {
		reconnect = 10 * time.Second
	}
	logger := cfg.Logger
	if logger == nil {
		logger = logrus.StandardLogger()
	}
	return &Controller{
		url:               raw,
		callTimeout:       callTimeout,
		reconnectInterval: reconnect,
		allowTestNodes:    cfg.AllowTestNodes,
		logger:            logger,
		platform:          platform,
		pending:           make(map[string]chan *frame),
	}, nil
}

// Run dials the controller and serves its events until ctx is cancelled,
// redialling with a fixed interval. Each attempt's failure is logged: a
// controller this service cannot reach must be visible, since every Matter load
// is uncontrollable until it returns.
func (c *Controller) Run(ctx context.Context) error {
	for {
		if err := c.session(ctx); err != nil && ctx.Err() == nil {
			c.logger.WithError(err).Warn("matter: controller session ended; every Matter load is uncommandable until it reconnects")
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(c.reconnectInterval):
		}
	}
}

// session runs one controller connection: handshake, node inventory, then the
// event loop.
func (c *Controller) session(ctx context.Context) error {
	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	conn, _, err := dialer.DialContext(ctx, c.url, nil)
	if err != nil {
		return fmt.Errorf("matter: dial controller: %w", err)
	}
	defer func() {
		c.setConn(nil)
		conn.Close()
		c.failPending(errors.New("matter: controller connection closed"))
		c.nodes.Range(func(key, _ any) bool {
			c.nodes.Delete(key)
			return true
		})
		c.info.Store(nil)
	}()

	// The controller sends its info first. It is read synchronously so an
	// incompatible schema is refused before any command is sent against
	// payloads this client may misinterpret.
	first, err := readFrame(conn)
	if err != nil {
		return fmt.Errorf("matter: read controller info: %w", err)
	}
	info, err := decodeServerInfo(first)
	if err != nil {
		return err
	}
	c.info.Store(info)
	c.setConn(conn)
	c.logger.WithFields(logrus.Fields{
		"fabric_id":      info.FabricID,
		"schema_version": info.SchemaVersion,
		"sdk_version":    info.SDKVersion,
	}).Info("matter: connected to controller")

	errCh := make(chan error, 1)
	go func() { errCh <- c.readLoop(ctx, conn) }()

	// start_listening returns the current node inventory and subscribes this
	// connection to attribute reports.
	nodes, err := c.startListening(ctx)
	if err != nil {
		conn.Close()
		<-errCh
		return err
	}
	for _, node := range nodes {
		c.nodes.Store(node.NodeID, node)
	}
	if err := c.platform.MatterNodesReported(ctx, info.FabricID, nodes); err != nil {
		// The platform is authoritative for which loads exist; if it did not
		// record the inventory, dispatch decisions would be made against a view
		// only this process holds.
		conn.Close()
		<-errCh
		return fmt.Errorf("matter: publish node inventory: %w", err)
	}

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		conn.Close()
		<-errCh
		return ctx.Err()
	}
}

func decodeServerInfo(f *frame) (*serverInfo, error) {
	if f.SchemaVersion == nil || f.MinSupportedSchemaVersion == nil || f.FabricID == nil {
		return nil, errors.New("matter: first controller frame is not a server info message")
	}
	var info serverInfo
	if err := json.Unmarshal(f.raw, &info); err != nil {
		return nil, fmt.Errorf("matter: decode server info: %w", err)
	}
	if info.MinSupportedSchemaVersion > SchemaVersion {
		return nil, fmt.Errorf(
			"matter: controller requires schema version >= %d but this client speaks %d; refusing rather than misreading device payloads",
			info.MinSupportedSchemaVersion, SchemaVersion,
		)
	}
	return &info, nil
}

func (c *Controller) setConn(conn *websocket.Conn) {
	c.connMu.Lock()
	c.conn = conn
	c.connMu.Unlock()
}

func (c *Controller) connection() *websocket.Conn {
	c.connMu.Lock()
	defer c.connMu.Unlock()
	return c.conn
}

// Connected reports whether a controller session is open. It is derived from the
// live connection, never from a previous successful dial.
func (c *Controller) Connected() bool {
	return c.connection() != nil && c.info.Load() != nil
}

// FabricID is the controller's fabric, or 0 when not connected.
func (c *Controller) FabricID() uint64 {
	if info := c.info.Load(); info != nil {
		return info.FabricID
	}
	return 0
}

func readFrame(conn *websocket.Conn) (*frame, error) {
	messageType, data, err := conn.ReadMessage()
	if err != nil {
		return nil, err
	}
	if messageType != websocket.TextMessage {
		return nil, fmt.Errorf("matter: controller sent a non-text frame (type %d)", messageType)
	}
	var f frame
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("matter: controller frame is not JSON: %w", err)
	}
	f.raw = data
	return &f, nil
}

func (c *Controller) readLoop(ctx context.Context, conn *websocket.Conn) error {
	for {
		f, err := readFrame(conn)
		if err != nil {
			return err
		}
		if f.MessageID != "" {
			c.deliver(f)
			continue
		}
		if f.Event != "" {
			c.handleEvent(ctx, f)
			continue
		}
		c.logger.WithField("frame", string(f.raw)).Warn("matter: ignoring a controller frame that is neither a result nor an event")
	}
}

func (c *Controller) deliver(f *frame) {
	c.pendingMu.Lock()
	waiter, ok := c.pending[f.MessageID]
	if ok {
		delete(c.pending, f.MessageID)
	}
	c.pendingMu.Unlock()
	if !ok {
		// Late or duplicate result. Dropped rather than applied to whatever
		// command is in flight now.
		c.logger.WithField("message_id", f.MessageID).Warn("matter: discarding a result with no waiting command")
		return
	}
	waiter <- f
}

func (c *Controller) failPending(err error) {
	c.pendingMu.Lock()
	pending := c.pending
	c.pending = make(map[string]chan *frame)
	c.pendingMu.Unlock()
	for id, waiter := range pending {
		waiter <- &frame{MessageID: id, ErrorCode: nil, Details: nil, transportErr: err}
	}
}

func (c *Controller) handleEvent(ctx context.Context, f *frame) {
	switch f.Event {
	case eventAttributeUpdated:
		report, err := parseAttributeReport(f.Data)
		if err != nil {
			c.logger.WithError(err).Warn("matter: unusable attribute report")
			return
		}
		if node, ok := c.nodes.Load(report.NodeID); ok {
			data := node.(NodeData)
			if data.Attributes == nil {
				data.Attributes = make(map[string]any)
			}
			var value any
			if err := json.Unmarshal(report.Value, &value); err == nil {
				data.Attributes[report.Path.String()] = value
			}
			c.nodes.Store(report.NodeID, data)
		}
		if err := c.platform.MatterAttributeReported(ctx, report.NodeID, report.Path.String(), report.Value); err != nil {
			c.logger.WithError(err).WithFields(logrus.Fields{
				"node_id": report.NodeID,
				"path":    report.Path.String(),
			}).Error("matter: attribute report not persisted; platform state is now behind the device")
		}

	case eventNodeAdded, eventNodeUpdated:
		var node NodeData
		if err := json.Unmarshal(f.Data, &node); err != nil {
			c.logger.WithError(err).Warn("matter: unusable node event")
			return
		}
		c.nodes.Store(node.NodeID, node)
		info := c.info.Load()
		var fabric uint64
		if info != nil {
			fabric = info.FabricID
		}
		if err := c.platform.MatterNodesReported(ctx, fabric, []NodeData{node}); err != nil {
			c.logger.WithError(err).WithField("node_id", node.NodeID).Error("matter: node event not persisted")
		}

	case eventNodeRemoved:
		var nodeID int64
		if err := json.Unmarshal(f.Data, &nodeID); err != nil {
			c.logger.WithError(err).Warn("matter: unusable node_removed event")
			return
		}
		c.nodes.Delete(nodeID)
		if err := c.platform.MatterNodeRemoved(ctx, nodeID); err != nil {
			c.logger.WithError(err).WithField("node_id", nodeID).Error("matter: node removal not persisted")
		}

	case eventServerShutdown:
		c.logger.Warn("matter: controller is shutting down; Matter loads are uncommandable until it returns")

	default:
		c.logger.WithField("event", f.Event).Debug("matter: ignoring an event this client does not interpret")
	}
}

// call sends a command and waits for its result. A timeout is an error, never a
// retry: repeating a Matter invoke can double-actuate a load.
func (c *Controller) call(ctx context.Context, name string, args map[string]any, out any) error {
	conn := c.connection()
	if conn == nil {
		return ErrNotConnected
	}
	messageID := strconv.FormatUint(c.counter.Add(1), 10)
	waiter := make(chan *frame, 1)
	c.pendingMu.Lock()
	c.pending[messageID] = waiter
	c.pendingMu.Unlock()

	payload, err := json.Marshal(command{MessageID: messageID, Command: name, Args: args})
	if err != nil {
		c.forget(messageID)
		return fmt.Errorf("matter: marshal %s: %w", name, err)
	}

	c.writeMu.Lock()
	err = conn.WriteMessage(websocket.TextMessage, payload)
	c.writeMu.Unlock()
	if err != nil {
		c.forget(messageID)
		return fmt.Errorf("matter: send %s: %w", name, err)
	}

	timer := time.NewTimer(c.callTimeout)
	defer timer.Stop()
	select {
	case f := <-waiter:
		if f.transportErr != nil {
			return f.transportErr
		}
		if f.ErrorCode != nil {
			details := ""
			if f.Details != nil {
				details = *f.Details
			}
			return &ControllerError{Code: *f.ErrorCode, Details: details, Command: name}
		}
		if out == nil {
			return nil
		}
		if len(f.Result) == 0 {
			return fmt.Errorf("matter: controller answered %s with no result", name)
		}
		if err := json.Unmarshal(f.Result, out); err != nil {
			return fmt.Errorf("matter: decode %s result: %w", name, err)
		}
		return nil
	case <-timer.C:
		c.forget(messageID)
		return fmt.Errorf("matter: %s timed out after %s; whether the node acted is unknown", name, c.callTimeout)
	case <-ctx.Done():
		c.forget(messageID)
		return ctx.Err()
	}
}

func (c *Controller) forget(messageID string) {
	c.pendingMu.Lock()
	delete(c.pending, messageID)
	c.pendingMu.Unlock()
}

func (c *Controller) startListening(ctx context.Context) ([]NodeData, error) {
	var nodes []NodeData
	if err := c.call(ctx, cmdStartListening, nil, &nodes); err != nil {
		return nil, err
	}
	return nodes, nil
}

// Nodes returns the controller's inventory as this session last saw it.
func (c *Controller) Nodes(ctx context.Context) ([]NodeData, error) {
	var nodes []NodeData
	if err := c.call(ctx, cmdGetNodes, nil, &nodes); err != nil {
		return nil, err
	}
	for _, node := range nodes {
		c.nodes.Store(node.NodeID, node)
	}
	return nodes, nil
}

// KnownNodes is the inventory this session has already been told about, without
// asking the controller again. It is what the node list endpoint serves, and it
// is only meaningful alongside Connected(): a stale inventory from a dropped
// controller must not be read as the current state of the fabric.
func (c *Controller) KnownNodes() []NodeData {
	var nodes []NodeData
	c.nodes.Range(func(_, value any) bool {
		nodes = append(nodes, value.(NodeData))
		return true
	})
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].NodeID < nodes[j].NodeID })
	return nodes
}

// requireCommandable checks a node can actually be commanded. Both refusals here
// exist to stop a dispatch being recorded against a node that cannot perform it.
func (c *Controller) requireCommandable(nodeID int64) error {
	if !c.Connected() {
		return ErrNotConnected
	}
	if nodeID >= TestNodeIDStart && !c.allowTestNodes {
		return fmt.Errorf("%w: node %d", ErrTestNode, nodeID)
	}
	value, ok := c.nodes.Load(nodeID)
	if !ok {
		return fmt.Errorf("matter: node %d is not commissioned on this fabric", nodeID)
	}
	if node := value.(NodeData); !node.Available {
		return fmt.Errorf("%w: node %d", ErrNodeUnavailable, nodeID)
	}
	return nil
}

// InvokeCommand sends a Matter cluster command. A nil error means the node
// acknowledged the interaction; the resulting load is only known from the
// attribute reports that follow, so callers must not record it as a measured
// outcome.
func (c *Controller) InvokeCommand(
	ctx context.Context,
	nodeID int64,
	endpoint uint16,
	clusterID uint32,
	commandName string,
	payload map[string]any,
) (json.RawMessage, error) {
	if err := c.requireCommandable(nodeID); err != nil {
		return nil, err
	}
	if strings.TrimSpace(commandName) == "" {
		return nil, errors.New("matter: command name is required")
	}
	if payload == nil {
		payload = map[string]any{}
	}
	var result json.RawMessage
	f := &rawResult{out: &result}
	if err := c.call(ctx, cmdDeviceCommand, map[string]any{
		"node_id":      nodeID,
		"endpoint_id":  endpoint,
		"cluster_id":   clusterID,
		"command_name": commandName,
		"payload":      payload,
	}, f); err != nil {
		return nil, err
	}
	return result, nil
}

// rawResult captures a result that may legitimately be JSON null: a Matter
// command with no response payload succeeds with a null result, which must be
// distinguishable from a missing result.
type rawResult struct {
	out *json.RawMessage
}

func (r *rawResult) UnmarshalJSON(data []byte) error {
	value := make(json.RawMessage, len(data))
	copy(value, data)
	*r.out = value
	return nil
}

// ReadAttribute reads one attribute from the node. The controller answers with a
// map keyed by attribute path; a response that does not contain the requested
// path is an error rather than a zero value.
func (c *Controller) ReadAttribute(ctx context.Context, nodeID int64, path AttributePath) (json.RawMessage, error) {
	if err := c.requireCommandable(nodeID); err != nil {
		return nil, err
	}
	var out map[string]json.RawMessage
	if err := c.call(ctx, cmdReadAttribute, map[string]any{
		"node_id":        nodeID,
		"attribute_path": path.String(),
	}, &out); err != nil {
		return nil, err
	}
	value, ok := out[path.String()]
	if !ok {
		return nil, fmt.Errorf("matter: node %d did not report %s", nodeID, path)
	}
	return value, nil
}

// WriteAttribute writes one attribute. As with InvokeCommand, success means the
// write was acknowledged, not that the load changed.
func (c *Controller) WriteAttribute(ctx context.Context, nodeID int64, path AttributePath, value any) error {
	if err := c.requireCommandable(nodeID); err != nil {
		return err
	}
	return c.call(ctx, cmdWriteAttribute, map[string]any{
		"node_id":        nodeID,
		"attribute_path": path.String(),
		"value":          value,
	}, nil)
}

// PingNode asks the controller to ping the node's addresses. The result is per
// address, and a node that answers on no address is reported as unreachable
// rather than assumed up.
func (c *Controller) PingNode(ctx context.Context, nodeID int64) (map[string]bool, error) {
	if nodeID >= TestNodeIDStart && !c.allowTestNodes {
		return nil, fmt.Errorf("%w: node %d", ErrTestNode, nodeID)
	}
	if !c.Connected() {
		return nil, ErrNotConnected
	}
	var result map[string]bool
	if err := c.call(ctx, cmdPingNode, map[string]any{"node_id": nodeID}, &result); err != nil {
		return nil, err
	}
	return result, nil
}
