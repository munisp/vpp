package signed

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

var secret = []byte("0123456789abcdef0123456789abcdef")

func request(t *testing.T, body []byte, at time.Time, sign func(timestamp string, body []byte) string) *http.Request {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/matter/load", nil)
	timestamp := strconv.FormatInt(at.Unix(), 10)
	r.Header.Set("x-grid-timestamp", timestamp)
	if signature := sign(timestamp, body); signature != "" {
		r.Header.Set("x-grid-signature", signature)
	}
	return r
}

func validSignature(timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func TestVerifyAcceptsASignatureOverTheExactBody(t *testing.T) {
	body := []byte(`{"node_id":"4"}`)
	if err := Verify(secret, request(t, body, time.Now(), validSignature), body); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	// A GET carries no body and is signed over an empty one.
	if err := Verify(secret, request(t, nil, time.Now(), validSignature), nil); err != nil {
		t.Fatalf("Verify with no body: %v", err)
	}
}

// The signature covers the body, so a command whose body was swapped after
// signing must not authenticate — this is the difference between authenticating
// the caller and authenticating the instruction.
func TestVerifyRejectsABodyThatWasNotSigned(t *testing.T) {
	signed := []byte(`{"action":"turn_off"}`)
	tampered := []byte(`{"action":"turn_on"}`)
	err := Verify(secret, request(t, signed, time.Now(), validSignature), tampered)
	if !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("expected ErrInvalidSignature, got %v", err)
	}
}

func TestVerifyRejectsMissingStaleAndMalformedRequests(t *testing.T) {
	body := []byte(`{}`)

	unsigned := request(t, body, time.Now(), func(string, []byte) string { return "" })
	if err := Verify(secret, unsigned, body); !errors.Is(err, ErrMissingSignature) {
		t.Fatalf("expected ErrMissingSignature, got %v", err)
	}

	noTimestamp := request(t, body, time.Now(), validSignature)
	noTimestamp.Header.Del("x-grid-timestamp")
	if err := Verify(secret, noTimestamp, body); !errors.Is(err, ErrMissingSignature) {
		t.Fatalf("expected ErrMissingSignature, got %v", err)
	}

	badTimestamp := request(t, body, time.Now(), validSignature)
	badTimestamp.Header.Set("x-grid-timestamp", "not-a-time")
	if err := Verify(secret, badTimestamp, body); !errors.Is(err, ErrInvalidTimestamp) {
		t.Fatalf("expected ErrInvalidTimestamp, got %v", err)
	}

	// A captured command must not stay replayable, in either direction of skew.
	for _, at := range []time.Time{
		time.Now().Add(-MaxClockSkew - time.Minute),
		time.Now().Add(MaxClockSkew + time.Minute),
	} {
		if err := Verify(secret, request(t, body, at, validSignature), body); !errors.Is(err, ErrStaleSignature) {
			t.Fatalf("expected ErrStaleSignature at %s, got %v", at, err)
		}
	}

	other := []byte("ffffffffffffffffffffffffffffffff")
	wrongSecret := request(t, body, time.Now(), func(timestamp string, body []byte) string {
		mac := hmac.New(sha256.New, other)
		mac.Write([]byte(timestamp))
		mac.Write([]byte("."))
		mac.Write(body)
		return hex.EncodeToString(mac.Sum(nil))
	})
	if err := Verify(secret, wrongSecret, body); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("expected ErrInvalidSignature, got %v", err)
	}
}

func TestStatusMapsFailuresToUnauthorized(t *testing.T) {
	if Status(nil) != http.StatusOK {
		t.Fatal("a verified request is not an error")
	}
	for _, err := range []error{ErrMissingSignature, ErrInvalidTimestamp, ErrStaleSignature, ErrInvalidSignature} {
		if got := Status(err); got != http.StatusUnauthorized {
			t.Fatalf("%v mapped to %d", err, got)
		}
	}
}
