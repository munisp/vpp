package openadr

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type recordingHandler struct {
	instructions []Instruction
	optType      string
	err          error
}

func (h *recordingHandler) HandleEvent(ctx context.Context, instruction Instruction) (string, error) {
	h.instructions = append(h.instructions, instruction)
	if h.err != nil {
		return "", h.err
	}
	if h.optType == "" {
		return OptIn, nil
	}
	return h.optType, nil
}

const distributeEventXML = `<?xml version="1.0" encoding="UTF-8"?>
<oadrPayload xmlns="http://openadr.org/oadr-2.0b/2012/07"
  xmlns:ei="http://docs.oasis-open.org/ns/energyinterop/201110"
  xmlns:pyld="http://docs.oasis-open.org/ns/energyinterop/201110/payloads"
  xmlns:xcal="urn:ietf:params:xml:ns:icalendar-2.0"
  xmlns:strm="urn:ietf:params:xml:ns:icalendar-2.0:stream">
  <oadrSignedObject>
    <oadrDistributeEvent>
      <pyld:requestID>REQ-1</pyld:requestID>
      <vtnID>VTN-1</vtnID>
      <oadrEvent>
        <ei:eiEvent>
          <ei:eventDescriptor>
            <ei:eventID>EVT-1</ei:eventID>
            <ei:modificationNumber>0</ei:modificationNumber>
            <ei:priority>1</ei:priority>
            <ei:eiMarketContext><ei:marketContext>https://market.example/dr</ei:marketContext></ei:eiMarketContext>
            <ei:createdDateTime>2026-08-22T10:00:00Z</ei:createdDateTime>
            <ei:eventStatus>near</ei:eventStatus>
            <ei:testEvent>false</ei:testEvent>
          </ei:eventDescriptor>
          <ei:eiActivePeriod>
            <xcal:properties>
              <xcal:dtstart><xcal:date-time>2026-08-22T18:00:00Z</xcal:date-time></xcal:dtstart>
              <xcal:duration><xcal:duration>PT2H</xcal:duration></xcal:duration>
            </xcal:properties>
          </ei:eiActivePeriod>
          <ei:eiEventSignals>
            <ei:eiEventSignal>
              <strm:intervals>
                <ei:interval>
                  <xcal:duration><xcal:duration>PT1H</xcal:duration></xcal:duration>
                  <xcal:uid><xcal:text>0</xcal:text></xcal:uid>
                  <ei:signalPayload><ei:payloadFloat><ei:value>1</ei:value></ei:payloadFloat></ei:signalPayload>
                </ei:interval>
                <ei:interval>
                  <xcal:duration><xcal:duration>PT1H</xcal:duration></xcal:duration>
                  <xcal:uid><xcal:text>1</xcal:text></xcal:uid>
                  <ei:signalPayload><ei:payloadFloat><ei:value>2</ei:value></ei:payloadFloat></ei:signalPayload>
                </ei:interval>
              </strm:intervals>
              <ei:signalName>SIMPLE</ei:signalName>
              <ei:signalType>level</ei:signalType>
              <ei:signalID>SIG-1</ei:signalID>
            </ei:eiEventSignal>
          </ei:eiEventSignals>
          <ei:eiTarget><ei:venID>VEN-1</ei:venID></ei:eiTarget>
        </ei:eiEvent>
        <oadrResponseRequired>always</oadrResponseRequired>
      </oadrEvent>
    </oadrDistributeEvent>
  </oadrSignedObject>
</oadrPayload>`

const registrationXML = `<?xml version="1.0" encoding="UTF-8"?>
<oadrPayload xmlns="http://openadr.org/oadr-2.0b/2012/07"
  xmlns:ei="http://docs.oasis-open.org/ns/energyinterop/201110"
  xmlns:pyld="http://docs.oasis-open.org/ns/energyinterop/201110/payloads"
  xmlns:xcal="urn:ietf:params:xml:ns:icalendar-2.0">
  <oadrSignedObject>
    <oadrCreatedPartyRegistration>
      <ei:eiResponse>
        <ei:responseCode>200</ei:responseCode>
        <pyld:requestID>REQ-0</pyld:requestID>
      </ei:eiResponse>
      <registrationID>REG-9</registrationID>
      <venID>VEN-1</venID>
      <vtnID>VTN-1</vtnID>
      <oadrRequestedOadrPollFreq><xcal:duration>PT30S</xcal:duration></oadrRequestedOadrPollFreq>
    </oadrCreatedPartyRegistration>
  </oadrSignedObject>
</oadrPayload>`

const okResponseXML = `<?xml version="1.0" encoding="UTF-8"?>
<oadrPayload xmlns="http://openadr.org/oadr-2.0b/2012/07"
  xmlns:ei="http://docs.oasis-open.org/ns/energyinterop/201110"
  xmlns:pyld="http://docs.oasis-open.org/ns/energyinterop/201110/payloads">
  <oadrSignedObject>
    <oadrResponse>
      <ei:eiResponse>
        <ei:responseCode>200</ei:responseCode>
        <pyld:requestID>REQ-1</pyld:requestID>
      </ei:eiResponse>
      <venID>VEN-1</venID>
    </oadrResponse>
  </oadrSignedObject>
</oadrPayload>`

type vtn struct {
	server   *httptest.Server
	requests []string
	bodies   []string
	pollBody string
}

func newVTN(t *testing.T) *vtn {
	t.Helper()
	v := &vtn{pollBody: distributeEventXML}
	mux := http.NewServeMux()
	mux.HandleFunc("/OpenADR2/Simple/2.0b/", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		v.requests = append(v.requests, strings.TrimPrefix(r.URL.Path, "/OpenADR2/Simple/2.0b/"))
		v.bodies = append(v.bodies, string(body))
		w.Header().Set("Content-Type", "application/xml")
		switch {
		case strings.HasSuffix(r.URL.Path, "EiRegisterParty"):
			fmt.Fprint(w, registrationXML)
		case strings.HasSuffix(r.URL.Path, "OadrPoll"):
			fmt.Fprint(w, v.pollBody)
		default:
			fmt.Fprint(w, okResponseXML)
		}
	})
	v.server = httptest.NewServer(mux)
	t.Cleanup(v.server.Close)
	return v
}

func newTestVEN(t *testing.T, v *vtn) *VEN {
	t.Helper()
	ven, err := NewVEN(Config{
		VTNBaseURL: v.server.URL + "/OpenADR2/Simple/2.0b",
		VenName:    "vpp-test",
		Username:   "user",
		Password:   "pass",
	})
	if err != nil {
		t.Fatalf("new ven: %v", err)
	}
	return ven
}

func TestRegisterStoresAssignedIdentifiers(t *testing.T) {
	v := newVTN(t)
	ven := newTestVEN(t, v)

	if err := ven.Register(context.Background()); err != nil {
		t.Fatalf("register: %v", err)
	}
	if ven.VenID() != "VEN-1" || ven.RegistrationID() != "REG-9" {
		t.Fatalf("unexpected identity %s/%s", ven.VenID(), ven.RegistrationID())
	}
	if ven.cfg.PollInterval != 30*time.Second {
		t.Fatalf("VTN poll frequency was ignored: %s", ven.cfg.PollInterval)
	}
}

func TestPollBeforeRegistrationFails(t *testing.T) {
	v := newVTN(t)
	ven := newTestVEN(t, v)
	if _, err := ven.Poll(context.Background(), &recordingHandler{}); err == nil {
		t.Fatal("expected polling without a venID to fail")
	}
}

func TestPollParsesEventAndReportsOptIn(t *testing.T) {
	v := newVTN(t)
	ven := newTestVEN(t, v)
	if err := ven.Register(context.Background()); err != nil {
		t.Fatalf("register: %v", err)
	}

	handler := &recordingHandler{}
	handled, err := ven.Poll(context.Background(), handler)
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	if handled != 1 || len(handler.instructions) != 1 {
		t.Fatalf("expected one handled event, got %d", handled)
	}

	instruction := handler.instructions[0]
	if instruction.EventID != "EVT-1" || instruction.MarketContext != "https://market.example/dr" {
		t.Fatalf("unexpected instruction %+v", instruction)
	}
	if instruction.Status != StatusNear || instruction.Duration != 2*time.Hour {
		t.Fatalf("unexpected schedule %+v", instruction)
	}
	if len(instruction.Signals) != 1 || len(instruction.Signals[0].Intervals) != 2 {
		t.Fatalf("signals were not parsed: %+v", instruction.Signals)
	}
	second := instruction.Signals[0].Intervals[1]
	if !second.Start.Equal(instruction.Start.Add(time.Hour)) || second.Value != 2 {
		t.Fatalf("interval boundaries are wrong: %+v", second)
	}
	if !instruction.ResponseRequired {
		t.Fatal("oadrResponseRequired=always was not honoured")
	}

	created := v.bodies[len(v.bodies)-1]
	if !strings.Contains(created, "oadrCreatedEvent") || !strings.Contains(created, "optIn") {
		t.Fatalf("expected an optIn oadrCreatedEvent, got %s", created)
	}
}

// A platform that cannot serve an event must opt out; claiming participation
// would expose the operator to non-performance penalties.
func TestHandlerFailureOptsOut(t *testing.T) {
	v := newVTN(t)
	ven := newTestVEN(t, v)
	if err := ven.Register(context.Background()); err != nil {
		t.Fatalf("register: %v", err)
	}

	handler := &recordingHandler{err: errors.New("no flexible capacity")}
	handled, err := ven.Poll(context.Background(), handler)
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	if handled != 0 {
		t.Fatalf("expected zero handled events, got %d", handled)
	}
	created := v.bodies[len(v.bodies)-1]
	if !strings.Contains(created, "optOut") || !strings.Contains(created, "no flexible capacity") {
		t.Fatalf("expected an optOut carrying the reason, got %s", created)
	}
}

func TestUnparsableEventOptsOutInsteadOfBeingIgnored(t *testing.T) {
	v := newVTN(t)
	v.pollBody = strings.Replace(distributeEventXML,
		"<xcal:duration><xcal:duration>PT2H</xcal:duration></xcal:duration>",
		"<xcal:duration><xcal:duration>2 hours</xcal:duration></xcal:duration>", 1)
	ven := newTestVEN(t, v)
	if err := ven.Register(context.Background()); err != nil {
		t.Fatalf("register: %v", err)
	}

	handler := &recordingHandler{}
	handled, err := ven.Poll(context.Background(), handler)
	if err != nil {
		t.Fatalf("poll: %v", err)
	}
	if handled != 0 || len(handler.instructions) != 0 {
		t.Fatal("a malformed event must not reach the platform")
	}
	if created := v.bodies[len(v.bodies)-1]; !strings.Contains(created, "optOut") {
		t.Fatalf("expected an optOut, got %s", created)
	}
}

func TestPollTransportFailureIsReported(t *testing.T) {
	v := newVTN(t)
	ven := newTestVEN(t, v)
	if err := ven.Register(context.Background()); err != nil {
		t.Fatalf("register: %v", err)
	}
	v.server.Close()

	if _, err := ven.Poll(context.Background(), &recordingHandler{}); err == nil {
		t.Fatal("an unreachable VTN must be an error, not an empty event list")
	}
}

func TestHTTPErrorIsReported(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "forbidden", http.StatusForbidden)
	}))
	defer server.Close()

	ven, err := NewVEN(Config{VTNBaseURL: server.URL, VenName: "vpp"})
	if err != nil {
		t.Fatalf("new ven: %v", err)
	}
	if err := ven.Register(context.Background()); err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("expected an HTTP 403 error, got %v", err)
	}
}

func TestNewVENValidatesURL(t *testing.T) {
	if _, err := NewVEN(Config{VenName: "vpp"}); err == nil {
		t.Fatal("expected a missing VTN URL to be rejected")
	}
	if _, err := NewVEN(Config{VTNBaseURL: "vtn.example.com", VenName: "vpp"}); err == nil {
		t.Fatal("expected a non-http URL to be rejected")
	}
}

func TestParseDuration(t *testing.T) {
	cases := map[string]time.Duration{
		"PT1H":    time.Hour,
		"PT15M":   15 * time.Minute,
		"PT30S":   30 * time.Second,
		"P1D":     24 * time.Hour,
		"PT1H30M": 90 * time.Minute,
		"P1DT2H":  26 * time.Hour,
		"-PT15M":  -15 * time.Minute,
	}
	for input, expected := range cases {
		got, err := ParseDuration(input)
		if err != nil {
			t.Fatalf("%s: %v", input, err)
		}
		if got != expected {
			t.Fatalf("%s: expected %s, got %s", input, expected, got)
		}
	}

	for _, invalid := range []string{"", "1H", "PT1X", "P1M", "P1Y", "PT", "PT1", "P1H"} {
		if _, err := ParseDuration(invalid); err == nil {
			t.Fatalf("expected %q to be rejected", invalid)
		}
	}
}
