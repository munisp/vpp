// Package ocpp16 implements the OCPP 1.6J central system: the core profile
// operations from the Open Charge Alliance specification, on top of the OCPP-J
// RPC framing in internal/ocppj that 1.6J and 2.0.1 share.
package ocpp16

import (
	"encoding/json"

	"github.com/vpp/grid-protocols/internal/ocppj"
)

// Subprotocol is the WebSocket subprotocol a 1.6J charge point must offer.
const Subprotocol = "ocpp1.6"

// The RPC framework types are the shared ones; they are re-exported so callers
// and tests keep speaking version-specific packages.
type (
	Frame      = ocppj.Frame
	Call       = ocppj.Call
	CallResult = ocppj.CallResult
	CallError  = ocppj.CallError
)

const (
	MessageTypeCall       = ocppj.MessageTypeCall
	MessageTypeCallResult = ocppj.MessageTypeCallResult
	MessageTypeCallError  = ocppj.MessageTypeCallError
)

// Error codes from OCPP-J 1.6 section 4.2.3.
const (
	ErrNotImplemented              = ocppj.ErrNotImplemented
	ErrNotSupported                = ocppj.ErrNotSupported
	ErrInternalError               = ocppj.ErrInternalError
	ErrProtocolError               = ocppj.ErrProtocolError
	ErrSecurityError               = ocppj.ErrSecurityError
	ErrFormationViolation          = ocppj.ErrFormationViolation
	ErrPropertyConstraintViolation = ocppj.ErrPropertyConstraintViolation
	ErrGenericError                = ocppj.ErrGenericError
)

// ErrNotConnected is returned when a command targets a charge point with no open
// session; commands are never buffered and reported as sent.
var ErrNotConnected = ocppj.ErrNotConnected

func DecodeFrame(data []byte) (*Frame, error) { return ocppj.DecodeFrame(data) }

func EncodeCall(uniqueID, action string, payload any) ([]byte, error) {
	return ocppj.EncodeCall(uniqueID, action, payload)
}

func EncodeCallResult(uniqueID string, payload any) ([]byte, error) {
	return ocppj.EncodeCallResult(uniqueID, payload)
}

func EncodeCallError(uniqueID, code, description string) ([]byte, error) {
	return ocppj.EncodeCallError(uniqueID, code, description)
}

// decodeStrict rejects unknown fields so a charge point speaking a different
// profile is not silently half-understood.
func decodeStrict(payload json.RawMessage, target any) error {
	return ocppj.DecodeStrict(payload, target, ErrFormationViolation)
}
