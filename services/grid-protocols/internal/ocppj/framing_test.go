package ocpp16

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDecodeCall(t *testing.T) {
	frame, err := DecodeFrame([]byte(`[2,"19223201","BootNotification",{"chargePointVendor":"v","chargePointModel":"m"}]`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if frame.Call == nil {
		t.Fatal("expected a CALL frame")
	}
	if frame.Call.UniqueID != "19223201" || frame.Call.Action != "BootNotification" {
		t.Fatalf("unexpected call %+v", frame.Call)
	}
}

func TestDecodeCallResultAndError(t *testing.T) {
	frame, err := DecodeFrame([]byte(`[3,"19223201",{"status":"Accepted"}]`))
	if err != nil || frame.Result == nil {
		t.Fatalf("expected CALLRESULT, got %v %v", frame, err)
	}

	frame, err = DecodeFrame([]byte(`[4,"19223201","NotSupported","nope",{}]`))
	if err != nil || frame.Error == nil {
		t.Fatalf("expected CALLERROR, got %v %v", frame, err)
	}
	if frame.Error.ErrorCode != ErrNotSupported {
		t.Fatalf("unexpected error code %q", frame.Error.ErrorCode)
	}
}

func TestDecodeRejectsMalformedFrames(t *testing.T) {
	cases := map[string]string{
		"not an array":               `{"messageTypeId":2}`,
		"too few elements":           `[2,"id"]`,
		"call missing payload":       `[2,"id","Heartbeat"]`,
		"result with extra":          `[3,"id",{},{}]`,
		"unknown type":               `[9,"id","Heartbeat",{}]`,
		"empty unique id":            `[2,"","Heartbeat",{}]`,
		"empty action":               `[2,"id","",{}]`,
		"call error missing details": `[4,"id","NotSupported","nope"]`,
	}
	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := DecodeFrame([]byte(payload)); err == nil {
				t.Fatalf("expected %s to be rejected", name)
			}
		})
	}
}

func TestEncodeRoundTrip(t *testing.T) {
	data, err := EncodeCall("abc", ActionHeartbeat, struct{}{})
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	var decoded []json.RawMessage
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(decoded) != 4 || string(decoded[0]) != "2" {
		t.Fatalf("unexpected frame %s", data)
	}

	result, err := EncodeCallResult("abc", HeartbeatResponse{CurrentTime: "2026-01-01T00:00:00Z"})
	if err != nil {
		t.Fatalf("encode result: %v", err)
	}
	if !strings.HasPrefix(string(result), `[3,"abc"`) {
		t.Fatalf("unexpected result frame %s", result)
	}
}
