package conformance

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"

	"github.com/vpp/grid-protocols/internal/openadr"
)

// The OpenADR 2.0b vector set runs this service's real VEN against a simulated
// VTN over HTTP. What it proves is the part a wrong VEN gets wrong invisibly:
// registering before polling, resolving interval boundaries to absolute times
// from an ISO 8601 duration, opting out (rather than silently opting in) when the
// platform cannot serve an event, and refusing an event whose signal carries no
// intervals instead of treating it as a zero-value dispatch.

// vtnSimulator is a minimal OpenADR 2.0b VTN: it answers registration and
// serves whatever event the case queued. It is deliberately literal — it echoes
// back what it was told to send, so a VEN that misreads a payload fails rather
// than being helped.
type vtnSimulator struct {
	server *httptest.Server

	mu sync.Mutex
	// pending is the oadrDistributeEvent body to answer the next poll with.
	pending string
	// responses records every oadrCreatedEvent the VEN sent back, which is where
	// an opt-out is visible.
	responses []openadr.EventResponse
	requests  []string
}

func newVTNSimulator() *vtnSimulator {
	sim := &vtnSimulator{}
	mux := http.NewServeMux()
	mux.HandleFunc("/OpenADR2/Simple/2.0b/EiRegisterParty", sim.handleRegister)
	mux.HandleFunc("/OpenADR2/Simple/2.0b/OadrPoll", sim.handlePoll)
	mux.HandleFunc("/OpenADR2/Simple/2.0b/EiEvent", sim.handleEiEvent)
	sim.server = httptest.NewServer(mux)
	return sim
}

func (s *vtnSimulator) baseURL() string { return s.server.URL + "/OpenADR2/Simple/2.0b" }

func (s *vtnSimulator) record(service string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.requests = append(s.requests, service)
}

func (s *vtnSimulator) handleRegister(w http.ResponseWriter, r *http.Request) {
	s.record("EiRegisterParty")
	body, _ := io.ReadAll(r.Body)
	requestID := extractTag(string(body), "requestID")
	w.Header().Set("Content-Type", "application/xml")
	fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?>
<oadrPayload xmlns="http://openadr.org/oadr-2.0b/2012/07">
  <oadrSignedObject>
    <oadrCreatedPartyRegistration>
      <ei:eiResponse xmlns:ei="http://docs.oasis-open.org/ns/energyinterop/201110">
        <ei:responseCode>200</ei:responseCode>
        <ei:responseDescription>OK</ei:responseDescription>
        <pyld:requestID xmlns:pyld="http://docs.oasis-open.org/ns/energyinterop/201110/payloads">%s</pyld:requestID>
      </ei:eiResponse>
      <ei:registrationID xmlns:ei="http://docs.oasis-open.org/ns/energyinterop/201110">REG-CONFORMANCE-1</ei:registrationID>
      <ei:venID xmlns:ei="http://docs.oasis-open.org/ns/energyinterop/201110">VEN-CONFORMANCE-1</ei:venID>
      <oadrRequestedOadrPollFreq>
        <xcal:duration xmlns:xcal="urn:ietf:params:xml:ns:icalendar-2.0">PT30S</xcal:duration>
      </oadrRequestedOadrPollFreq>
    </oadrCreatedPartyRegistration>
  </oadrSignedObject>
</oadrPayload>`, requestID)
}

func (s *vtnSimulator) handlePoll(w http.ResponseWriter, _ *http.Request) {
	s.record("OadrPoll")
	s.mu.Lock()
	body := s.pending
	s.pending = ""
	s.mu.Unlock()

	w.Header().Set("Content-Type", "application/xml")
	if body == "" {
		fmt.Fprint(w, `<?xml version="1.0" encoding="UTF-8"?>
<oadrPayload xmlns="http://openadr.org/oadr-2.0b/2012/07">
  <oadrSignedObject>
    <oadrResponse>
      <ei:eiResponse xmlns:ei="http://docs.oasis-open.org/ns/energyinterop/201110">
        <ei:responseCode>200</ei:responseCode>
      </ei:eiResponse>
    </oadrResponse>
  </oadrSignedObject>
</oadrPayload>`)
		return
	}
	fmt.Fprint(w, body)
}

// handleEiEvent receives the VEN's oadrCreatedEvent, which carries the opt
// decision. The simulator stores it: a VEN that claims to have opted out has to
// have actually said so on the wire.
func (s *vtnSimulator) handleEiEvent(w http.ResponseWriter, r *http.Request) {
	s.record("EiEvent")
	body, _ := io.ReadAll(r.Body)

	var payload struct {
		Responses []struct {
			OptType      string `xml:"optType"`
			ResponseCode string `xml:"eiResponse>responseCode"`
			EventID      string `xml:"qualifiedEventID>eventID"`
		} `xml:"oadrSignedObject>oadrCreatedEvent>eiCreatedEvent>eventResponses>eventResponse"`
	}
	if err := xml.Unmarshal(body, &payload); err == nil {
		s.mu.Lock()
		for _, one := range payload.Responses {
			s.responses = append(s.responses, openadr.EventResponse{
				OptType: one.OptType,
				QualifiedEventID: openadr.QualifiedEventID{
					EventID: one.EventID,
				},
			})
		}
		s.mu.Unlock()
	}

	w.Header().Set("Content-Type", "application/xml")
	fmt.Fprint(w, `<?xml version="1.0" encoding="UTF-8"?>
<oadrPayload xmlns="http://openadr.org/oadr-2.0b/2012/07">
  <oadrSignedObject>
    <oadrResponse>
      <ei:eiResponse xmlns:ei="http://docs.oasis-open.org/ns/energyinterop/201110">
        <ei:responseCode>200</ei:responseCode>
      </ei:eiResponse>
    </oadrResponse>
  </oadrSignedObject>
</oadrPayload>`)
}

func (s *vtnSimulator) queue(body string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pending = body
}

func (s *vtnSimulator) optDecisions() []openadr.EventResponse {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]openadr.EventResponse, len(s.responses))
	copy(out, s.responses)
	return out
}

func extractTag(body, tag string) string {
	open := "<" + tag + ">"
	start := strings.Index(body, open)
	if start < 0 {
		// Namespaced element: find any prefixed spelling.
		for _, prefix := range []string{"pyld:", "ei:", "oadr:"} {
			open = "<" + prefix + tag + ">"
			start = strings.Index(body, open)
			if start >= 0 {
				break
			}
		}
		if start < 0 {
			return ""
		}
	}
	rest := body[start+len(open):]
	end := strings.Index(rest, "<")
	if end < 0 {
		return ""
	}
	return rest[:end]
}

// distributeEvent renders an oadrDistributeEvent carrying one simple level
// signal. `signalPayload` is injected verbatim so a case can send an interval
// list that is empty or malformed.
func distributeEvent(eventID, dtstart, duration, intervals string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<oadrPayload xmlns="http://openadr.org/oadr-2.0b/2012/07">
  <oadrSignedObject>
    <oadrDistributeEvent xmlns:ei="http://docs.oasis-open.org/ns/energyinterop/201110"
                         xmlns:pyld="http://docs.oasis-open.org/ns/energyinterop/201110/payloads"
                         xmlns:xcal="urn:ietf:params:xml:ns:icalendar-2.0"
                         xmlns:strm="urn:ietf:params:xml:ns:icalendar-2.0:stream">
      <ei:eiResponse><ei:responseCode>200</ei:responseCode></ei:eiResponse>
      <pyld:requestID>VTN-REQ-1</pyld:requestID>
      <ei:vtnID>VTN-CONFORMANCE</ei:vtnID>
      <oadrEvent>
        <ei:eiEvent>
          <ei:eventDescriptor>
            <ei:eventID>%s</ei:eventID>
            <ei:modificationNumber>0</ei:modificationNumber>
            <ei:eiMarketContext><marketContext xmlns="http://docs.oasis-open.org/ns/emix/2011/06">https://vtn.example/market</marketContext></ei:eiMarketContext>
            <ei:createdDateTime>2026-01-01T00:00:00Z</ei:createdDateTime>
            <ei:eventStatus>active</ei:eventStatus>
            <ei:testEvent>false</ei:testEvent>
            <ei:priority>1</ei:priority>
          </ei:eventDescriptor>
          <ei:eiActivePeriod>
            <xcal:properties>
              <xcal:dtstart><xcal:date-time>%s</xcal:date-time></xcal:dtstart>
              <xcal:duration><xcal:duration>%s</xcal:duration></xcal:duration>
            </xcal:properties>
          </ei:eiActivePeriod>
          <ei:eiEventSignals>
            <ei:eiEventSignal>
              <strm:intervals>%s</strm:intervals>
              <ei:signalName>SIMPLE</ei:signalName>
              <ei:signalType>level</ei:signalType>
              <ei:signalID>SIG-1</ei:signalID>
            </ei:eiEventSignal>
          </ei:eiEventSignals>
          <ei:eiTarget><ei:venID>VEN-CONFORMANCE-1</ei:venID></ei:eiTarget>
        </ei:eiEvent>
        <oadrResponseRequired>always</oadrResponseRequired>
      </oadrEvent>
    </oadrDistributeEvent>
  </oadrSignedObject>
</oadrPayload>`, eventID, dtstart, duration, intervals)
}

func interval(uid, duration string, value float64) string {
	return fmt.Sprintf(`<ei:interval>
      <xcal:duration><xcal:duration>%s</xcal:duration></xcal:duration>
      <xcal:uid><xcal:text>%s</xcal:text></xcal:uid>
      <ei:signalPayload><ei:payloadFloat><ei:value>%v</ei:value></ei:payloadFloat></ei:signalPayload>
    </ei:interval>`, duration, uid, value)
}

// openadrPeer is the simulated VTN plus the VEN under test, with a handler whose
// decision the cases control.
type openadrPeer struct {
	sim *vtnSimulator
	ven *openadr.VEN

	mu           sync.Mutex
	decision     string
	decisionErr  error
	instructions []openadr.Instruction
}

func (p *openadrPeer) HandleEvent(_ context.Context, instruction openadr.Instruction) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.instructions = append(p.instructions, instruction)
	if p.decisionErr != nil {
		return "", p.decisionErr
	}
	if p.decision == "" {
		return "optIn", nil
	}
	return p.decision, nil
}

func (p *openadrPeer) lastInstruction() (openadr.Instruction, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.instructions) == 0 {
		return openadr.Instruction{}, false
	}
	return p.instructions[len(p.instructions)-1], true
}

func (p *openadrPeer) setDecision(optType string, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.decision = optType
	p.decisionErr = err
}

// OpenADRSuite is the OpenADR 2.0b vector set.
func OpenADRSuite() Suite {
	return Suite{
		Adapter:          AdapterOpenADR2b,
		VectorSetID:      "vpp-openadr2b-ven",
		VectorSetVersion: "1",
		ProtocolVersion:  "2.0b",
		DeviceModel:      "vpp-openadr2b-vtn-simulator",
		Setup: func(ctx context.Context) (*Env, func(), error) {
			sim := newVTNSimulator()
			ven, err := openadr.NewVEN(openadr.Config{
				VTNBaseURL:     sim.baseURL(),
				VenName:        "vpp-conformance",
				RequestTimeout: 5 * time.Second,
			})
			if err != nil {
				sim.server.Close()
				return nil, nil, fmt.Errorf("ven: %w", err)
			}
			peer := &openadrPeer{sim: sim, ven: ven}
			// Registration is part of the suite's precondition and its own case
			// asserts it happened; a VEN that cannot register has tested nothing.
			if err := ven.Register(ctx); err != nil {
				sim.server.Close()
				return nil, nil, fmt.Errorf("register with the simulated VTN: %w", err)
			}
			return &Env{Peer: peer, Target: TargetSimulator}, sim.server.Close, nil
		},
		Cases: []Case{
			{
				ID:          "openadr-001-registration-identity",
				Name:        "Registration adopts the VTN-assigned venID and registrationID",
				Requirement: "OpenADR 2.0b §8.2: the VTN assigns venID and registrationID; a VEN that keeps its own would poll as an unknown party",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*openadrPeer)
					if peer.ven.VenID() != "VEN-CONFORMANCE-1" {
						return nil, fmt.Errorf("venID is %q, not the VTN-assigned VEN-CONFORMANCE-1", peer.ven.VenID())
					}
					if peer.ven.RegistrationID() != "REG-CONFORMANCE-1" {
						return nil, fmt.Errorf("registrationID is %q", peer.ven.RegistrationID())
					}
					return map[string]string{
						"ven_id":          peer.ven.VenID(),
						"registration_id": peer.ven.RegistrationID(),
					}, nil
				},
			},
			{
				ID:          "openadr-002-empty-poll",
				Name:        "A poll with no events yields no events",
				Requirement: "OpenADR 2.0b §8.4: oadrResponse to a poll carries no event; inventing one would dispatch a fleet on nothing",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*openadrPeer)
					count, err := peer.ven.Poll(ctx, peer)
					if err != nil {
						return nil, err
					}
					if count != 0 {
						return nil, fmt.Errorf("an empty poll produced %d events", count)
					}
					return map[string]int{"events": count}, nil
				},
			},
			{
				ID:          "openadr-003-interval-boundaries-absolute",
				Name:        "Interval boundaries resolve to absolute times from ISO 8601 durations",
				Requirement: "OpenADR 2.0b §8.5/xcal: each interval starts where the previous ended; a mis-parsed PT15M shifts a whole event",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*openadrPeer)
					peer.setDecision("optIn", nil)
					peer.sim.queue(distributeEvent(
						"EV-INTERVALS", "2026-06-01T10:00:00Z", "PT1H",
						interval("0", "PT15M", 1)+interval("1", "PT45M", 2),
					))
					count, err := peer.ven.Poll(ctx, peer)
					if err != nil {
						return nil, err
					}
					if count != 1 {
						return nil, fmt.Errorf("poll produced %d events, expected 1", count)
					}
					instruction, ok := peer.lastInstruction()
					if !ok {
						return nil, errors.New("no instruction reached the handler")
					}
					if instruction.Duration != time.Hour {
						return instruction, fmt.Errorf("event duration parsed as %s", instruction.Duration)
					}
					if len(instruction.Signals) != 1 || len(instruction.Signals[0].Intervals) != 2 {
						return instruction, errors.New("signal intervals were not preserved")
					}
					first := instruction.Signals[0].Intervals[0]
					second := instruction.Signals[0].Intervals[1]
					wantStart := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
					if !first.Start.Equal(wantStart) {
						return instruction, fmt.Errorf("first interval starts at %s, expected %s", first.Start, wantStart)
					}
					if !second.Start.Equal(wantStart.Add(15 * time.Minute)) {
						return instruction, fmt.Errorf("second interval starts at %s, expected 10:15Z", second.Start)
					}
					if second.Duration != 45*time.Minute {
						return instruction, fmt.Errorf("second interval duration is %s", second.Duration)
					}
					return map[string]any{
						"first_start":  first.Start,
						"second_start": second.Start,
						"values":       []float64{first.Value, second.Value},
					}, nil
				},
			},
			{
				ID:          "openadr-004-opt-out-is-sent",
				Name:        "A platform that cannot serve an event opts out on the wire",
				Requirement: "OpenADR 2.0b §8.6: oadrCreatedEvent carries optType; a silent opt-in to an unservable event earns settlement penalties",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*openadrPeer)
					peer.setDecision("", errors.New("no flexible capacity available for this window"))
					defer peer.setDecision("optIn", nil)
					peer.sim.queue(distributeEvent(
						"EV-OPTOUT", "2026-06-01T12:00:00Z", "PT30M",
						interval("0", "PT30M", 3),
					))
					if _, err := peer.ven.Poll(ctx, peer); err != nil {
						return nil, err
					}
					decisions := peer.sim.optDecisions()
					for _, one := range decisions {
						if one.QualifiedEventID.EventID == "EV-OPTOUT" {
							if one.OptType != "optOut" {
								return decisions, fmt.Errorf("the VTN was told %q for an event the platform refused", one.OptType)
							}
							return one, nil
						}
					}
					return decisions, errors.New("the VEN sent the VTN no decision for the refused event")
				},
			},
			{
				ID:          "openadr-005-signal-without-intervals-refused",
				Name:        "A signal carrying no intervals is refused, not read as zero",
				Requirement: "OpenADR 2.0b §8.5: a signal must carry at least one interval; an empty stream is not a zero-value dispatch",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*openadrPeer)
					peer.setDecision("optIn", nil)
					before, _ := peer.lastInstruction()
					peer.sim.queue(distributeEvent(
						"EV-EMPTY", "2026-06-01T13:00:00Z", "PT30M", "",
					))
					count, err := peer.ven.Poll(ctx, peer)
					if err == nil && count > 0 {
						after, _ := peer.lastInstruction()
						if after.EventID == "EV-EMPTY" {
							return after, errors.New("an event with no intervals was handed to the platform as a dispatch")
						}
					}
					current, ok := peer.lastInstruction()
					if ok && current.EventID == "EV-EMPTY" && current.EventID != before.EventID {
						return current, errors.New("an event with no intervals reached the handler")
					}
					return map[string]any{"events_handled": count}, nil
				},
			},
			{
				ID:          "openadr-006-unparsable-duration-refused",
				Name:        "An unparsable duration is refused rather than defaulted",
				Requirement: "OpenADR 2.0b/xcal: a duration this VEN cannot parse has no safe default; a zero-length or hour-long guess both dispatch wrongly",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*openadrPeer)
					peer.setDecision("optIn", nil)
					peer.sim.queue(distributeEvent(
						"EV-BAD-DURATION", "2026-06-01T14:00:00Z", "1 hour",
						interval("0", "PT30M", 1),
					))
					count, err := peer.ven.Poll(ctx, peer)
					if err == nil && count > 0 {
						if instruction, ok := peer.lastInstruction(); ok && instruction.EventID == "EV-BAD-DURATION" {
							return instruction, errors.New("an event with an unparsable duration was dispatched")
						}
					}
					return map[string]any{"events_handled": count}, nil
				},
			},
			{
				ID:          "openadr-007-duration-parser",
				Name:        "ISO 8601 durations parse to exact values, and nonsense is rejected",
				Requirement: "OpenADR 2.0b uses xcal durations; PT15M, PT1H30M and P1D must be exact and an unrecognised string must error",
				Run: func(_ context.Context, _ *Env) (any, error) {
					cases := map[string]time.Duration{
						"PT15M":   15 * time.Minute,
						"PT1H30M": 90 * time.Minute,
						"P1D":     24 * time.Hour,
						"PT0S":    0,
					}
					for input, want := range cases {
						got, err := openadr.ParseDuration(input)
						if err != nil {
							return nil, fmt.Errorf("%s: %w", input, err)
						}
						if got != want {
							return nil, fmt.Errorf("%s parsed as %s, expected %s", input, got, want)
						}
					}
					for _, bad := range []string{"", "1 hour", "PT", "15M"} {
						if _, err := openadr.ParseDuration(bad); err == nil {
							return nil, fmt.Errorf("%q was accepted as a duration", bad)
						}
					}
					return map[string]any{"accepted": len(cases), "rejected": 4}, nil
				},
			},
		},
	}
}
