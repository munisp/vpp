// Package signed verifies the HMAC the VPP server attaches to every command it
// sends this service. It exists so every command surface — charge points, Matter
// loads — authenticates identically rather than each one growing its own check.
package signed

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net/http"
	"strconv"
	"time"
)

// MaxClockSkew bounds how old a signed command may be, so a captured request
// cannot be replayed indefinitely.
const MaxClockSkew = 5 * time.Minute

// Errors a caller may want to distinguish.
var (
	ErrMissingSignature = errors.New("missing signature")
	ErrInvalidTimestamp = errors.New("invalid timestamp")
	ErrStaleSignature   = errors.New("stale signature")
	ErrInvalidSignature = errors.New("invalid signature")
)

// Verify checks the signature over the request body. body may be nil for GET
// requests, which are signed over an empty body.
func Verify(secret []byte, r *http.Request, body []byte) error {
	timestamp := r.Header.Get("x-grid-timestamp")
	signature := r.Header.Get("x-grid-signature")
	if timestamp == "" || signature == "" {
		return ErrMissingSignature
	}
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return ErrInvalidTimestamp
	}
	age := time.Since(time.Unix(seconds, 0))
	if age > MaxClockSkew || age < -MaxClockSkew {
		return ErrStaleSignature
	}

	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))

	if subtle.ConstantTimeCompare([]byte(expected), []byte(signature)) != 1 {
		return ErrInvalidSignature
	}
	return nil
}

// Status maps a verification failure to the HTTP status it should produce.
func Status(err error) int {
	if err == nil {
		return http.StatusOK
	}
	return http.StatusUnauthorized
}
