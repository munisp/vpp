// Package ocpp16 implements the OCPP 1.6J central system: the JSON-over-WebSocket
// wire format from the Open Charge Alliance specification, section 4 (RPC
// framework) and the core profile operations.
package ocpp16

import (
	"encoding/json"
	"fmt"
)

// Message type identifiers from OCPP-J 1.6 section 4.2.
const (
	MessageTypeCall       = 2
	MessageTypeCallResult = 3
	MessageTypeCallError  = 4
)

// Error codes from OCPP-J 1.6 section 4.2.3.
const (
	ErrNotImplemented              = "NotImplemented"
	ErrNotSupported                = "NotSupported"
	ErrInternalError               = "InternalError"
	ErrProtocolError               = "ProtocolError"
	ErrSecurityError               = "SecurityError"
	ErrFormationViolation          = "FormationViolation"
	ErrPropertyConstraintViolation = "PropertyConstraintViolation"
	ErrGenericError                = "GenericError"
)

// Call is a request frame: [2, uniqueId, action, payload].
type Call struct {
	UniqueID string
	Action   string
	Payload  json.RawMessage
}

// CallResult is a response frame: [3, uniqueId, payload].
type CallResult struct {
	UniqueID string
	Payload  json.RawMessage
}

// CallError is an error frame: [4, uniqueId, errorCode, errorDescription, errorDetails].
type CallError struct {
	UniqueID         string
	ErrorCode        string
	ErrorDescription string
	ErrorDetails     json.RawMessage
}

func (e *CallError) Error() string {
	return fmt.Sprintf("ocpp call error %s: %s", e.ErrorCode, e.ErrorDescription)
}

// Frame is exactly one of Call, CallResult or CallError.
type Frame struct {
	Call   *Call
	Result *CallResult
	Error  *CallError
}

// DecodeFrame parses an OCPP-J frame. Anything that is not a well-formed frame
// is an error: a central system that guesses at malformed input would ascribe
// meter values or transaction stops to the wrong charge point.
func DecodeFrame(data []byte) (*Frame, error) {
	var raw []json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("frame is not a JSON array: %w", err)
	}
	if len(raw) < 3 {
		return nil, fmt.Errorf("frame has %d elements, expected at least 3", len(raw))
	}

	var messageType int
	if err := json.Unmarshal(raw[0], &messageType); err != nil {
		return nil, fmt.Errorf("message type is not a number: %w", err)
	}
	var uniqueID string
	if err := json.Unmarshal(raw[1], &uniqueID); err != nil {
		return nil, fmt.Errorf("unique id is not a string: %w", err)
	}
	if uniqueID == "" {
		return nil, fmt.Errorf("unique id is empty")
	}

	switch messageType {
	case MessageTypeCall:
		if len(raw) != 4 {
			return nil, fmt.Errorf("CALL frame has %d elements, expected 4", len(raw))
		}
		var action string
		if err := json.Unmarshal(raw[2], &action); err != nil {
			return nil, fmt.Errorf("action is not a string: %w", err)
		}
		if action == "" {
			return nil, fmt.Errorf("action is empty")
		}
		return &Frame{Call: &Call{UniqueID: uniqueID, Action: action, Payload: raw[3]}}, nil

	case MessageTypeCallResult:
		if len(raw) != 3 {
			return nil, fmt.Errorf("CALLRESULT frame has %d elements, expected 3", len(raw))
		}
		return &Frame{Result: &CallResult{UniqueID: uniqueID, Payload: raw[2]}}, nil

	case MessageTypeCallError:
		if len(raw) != 5 {
			return nil, fmt.Errorf("CALLERROR frame has %d elements, expected 5", len(raw))
		}
		var code, description string
		if err := json.Unmarshal(raw[2], &code); err != nil {
			return nil, fmt.Errorf("error code is not a string: %w", err)
		}
		if err := json.Unmarshal(raw[3], &description); err != nil {
			return nil, fmt.Errorf("error description is not a string: %w", err)
		}
		return &Frame{Error: &CallError{
			UniqueID:         uniqueID,
			ErrorCode:        code,
			ErrorDescription: description,
			ErrorDetails:     raw[4],
		}}, nil

	default:
		return nil, fmt.Errorf("unknown message type %d", messageType)
	}
}

// EncodeCall renders [2, uniqueId, action, payload].
func EncodeCall(uniqueID, action string, payload any) ([]byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode %s payload: %w", action, err)
	}
	return json.Marshal([]any{MessageTypeCall, uniqueID, action, json.RawMessage(body)})
}

// EncodeCallResult renders [3, uniqueId, payload].
func EncodeCallResult(uniqueID string, payload any) ([]byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode result payload: %w", err)
	}
	return json.Marshal([]any{MessageTypeCallResult, uniqueID, json.RawMessage(body)})
}

// EncodeCallError renders [4, uniqueId, errorCode, errorDescription, errorDetails].
func EncodeCallError(uniqueID, code, description string) ([]byte, error) {
	return json.Marshal([]any{MessageTypeCallError, uniqueID, code, description, map[string]any{}})
}
