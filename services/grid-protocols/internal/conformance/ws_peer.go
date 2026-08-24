package conformance

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/vpp/grid-protocols/internal/ocppj"
)

// wsPeer is a simulated OCPP-J station: it speaks the same framing 1.6J and
// 2.0.1 share, over a real WebSocket, against the central system or CSMS under
// test. Both suites use it, so a framing defect is caught once rather than
// tested twice with two harnesses that could disagree.
type wsPeer struct {
	server      *httptest.Server
	subprotocol string
	stationID   string

	mu     sync.Mutex
	conn   *websocket.Conn
	nextID int

	answerMu sync.Mutex
	answer   func(call *ocppj.Call) (result any, callError *ocppj.CallError)
	received []string
}

func newWSPeer(server *httptest.Server, subprotocol, stationID string) *wsPeer {
	return &wsPeer{server: server, subprotocol: subprotocol, stationID: stationID}
}

func (p *wsPeer) close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.conn != nil {
		_ = p.conn.Close()
		p.conn = nil
	}
}

// dial opens a raw connection with whatever subprotocols and identity the case
// wants, so handshake cases can offer the wrong ones on purpose.
func (p *wsPeer) dial(subprotocols []string, stationID string) (*websocket.Conn, *http.Response, error) {
	target := "ws" + strings.TrimPrefix(p.server.URL, "http") + "/ocpp/" + stationID
	dialer := websocket.Dialer{Subprotocols: subprotocols, HandshakeTimeout: 5 * time.Second}
	return dialer.Dial(target, nil)
}

// session returns the peer's long-lived connection, opening it on first use.
func (p *wsPeer) session() (*websocket.Conn, error) {
	p.mu.Lock()
	if p.conn != nil {
		conn := p.conn
		p.mu.Unlock()
		return conn, nil
	}
	p.mu.Unlock()

	conn, _, err := p.dial([]string{p.subprotocol}, p.stationID)
	if err != nil {
		return nil, fmt.Errorf("dial: %w", err)
	}
	p.mu.Lock()
	p.conn = conn
	p.mu.Unlock()
	return conn, nil
}

// call sends a station-initiated request and returns the server's frame.
func (p *wsPeer) call(action string, payload any) (*ocppj.Frame, error) {
	conn, err := p.session()
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	p.nextID++
	uniqueID := fmt.Sprintf("conf-%d", p.nextID)
	p.mu.Unlock()

	data, err := ocppj.EncodeCall(uniqueID, action, payload)
	if err != nil {
		return nil, fmt.Errorf("encode %s: %w", action, err)
	}
	return p.exchange(conn, data, uniqueID)
}

// raw sends bytes verbatim, so a case can send a frame no encoder would produce.
func (p *wsPeer) raw(data []byte, uniqueID string) (*ocppj.Frame, error) {
	conn, err := p.session()
	if err != nil {
		return nil, err
	}
	return p.exchange(conn, data, uniqueID)
}

func (p *wsPeer) exchange(conn *websocket.Conn, data []byte, uniqueID string) (*ocppj.Frame, error) {
	if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
		return nil, fmt.Errorf("write: %w", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for {
		if err := conn.SetReadDeadline(deadline); err != nil {
			return nil, err
		}
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return nil, fmt.Errorf("read: %w", err)
		}
		frame, err := ocppj.DecodeFrame(raw)
		if err != nil {
			return nil, fmt.Errorf("server sent a frame this station cannot decode (%s): %w", raw, err)
		}
		// An inbound CALL is a command from the server, not the answer to this
		// request: answer it and keep waiting for our own response.
		if frame.Call != nil {
			if err := p.answerCall(conn, frame.Call); err != nil {
				return nil, err
			}
			continue
		}
		id := ""
		switch {
		case frame.Result != nil:
			id = frame.Result.UniqueID
		case frame.Error != nil:
			id = frame.Error.UniqueID
		}
		if uniqueID != "" && id != uniqueID {
			return nil, fmt.Errorf("server answered id %q for request %q", id, uniqueID)
		}
		return frame, nil
	}
}

func (p *wsPeer) answerCall(conn *websocket.Conn, call *ocppj.Call) error {
	p.answerMu.Lock()
	p.received = append(p.received, call.Action)
	answer := p.answer
	p.answerMu.Unlock()

	var (
		result    any = map[string]string{"status": "Accepted"}
		callError *ocppj.CallError
	)
	if answer != nil {
		result, callError = answer(call)
	}

	var (
		data []byte
		err  error
	)
	if callError != nil {
		data, err = ocppj.EncodeCallError(call.UniqueID, callError.ErrorCode, callError.ErrorDescription)
	} else {
		data, err = ocppj.EncodeCallResult(call.UniqueID, result)
	}
	if err != nil {
		return fmt.Errorf("encode answer to %s: %w", call.Action, err)
	}
	return conn.WriteMessage(websocket.TextMessage, data)
}

// serve answers server-initiated commands in the background, for cases that send
// a command from the server and then wait on its result.
func (p *wsPeer) serve(ctx context.Context, conn *websocket.Conn) {
	go func() {
		for ctx.Err() == nil {
			_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			frame, err := ocppj.DecodeFrame(raw)
			if err != nil || frame.Call == nil {
				continue
			}
			if err := p.answerCall(conn, frame.Call); err != nil {
				return
			}
		}
	}()
}

func (p *wsPeer) setAnswer(fn func(call *ocppj.Call) (any, *ocppj.CallError)) {
	p.answerMu.Lock()
	p.answer = fn
	p.answerMu.Unlock()
}
