package openadr

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/sirupsen/logrus"
)

// Config describes the VTN connection and this VEN's identity.
type Config struct {
	// VTNBaseURL is the OpenADR 2.0b endpoint root, e.g. https://vtn.example.com/OpenADR2/Simple/2.0b
	VTNBaseURL string
	VenName    string
	// VenID and RegistrationID are assigned by the VTN. Empty values mean this
	// VEN must register before it may poll.
	VenID          string
	RegistrationID string
	// Basic auth and/or client certificates, whichever the VTN requires.
	Username       string
	Password       string
	ClientCertFile string
	ClientKeyFile  string
	CAFile         string
	PollInterval   time.Duration
	RequestTimeout time.Duration
	Logger         *logrus.Logger
}

// Instruction is a normalised demand-response event handed to the platform.
type Instruction struct {
	EventID            string        `json:"event_id"`
	ModificationNumber int           `json:"modification_number"`
	MarketContext      string        `json:"market_context"`
	Status             string        `json:"status"`
	Priority           int           `json:"priority"`
	TestEvent          bool          `json:"test_event"`
	Start              time.Time     `json:"start"`
	Duration           time.Duration `json:"duration"`
	Signals            []Signal      `json:"signals"`
	TargetVenIDs       []string      `json:"target_ven_ids,omitempty"`
	TargetResourceIDs  []string      `json:"target_resource_ids,omitempty"`
	ResponseRequired   bool          `json:"response_required"`
}

// Signal is one event signal, resolved into absolute interval boundaries.
type Signal struct {
	SignalID   string           `json:"signal_id"`
	SignalName string           `json:"signal_name"`
	SignalType string           `json:"signal_type"`
	Intervals  []SignalInterval `json:"intervals"`
}

type SignalInterval struct {
	UID      string        `json:"uid"`
	Start    time.Time     `json:"start"`
	Duration time.Duration `json:"duration"`
	Value    float64       `json:"value"`
}

// Handler decides how the platform responds to an event. Returning an error
// makes the VEN opt out and report the failure: pretending to opt in to a
// program the platform cannot serve produces settlement penalties.
type Handler interface {
	HandleEvent(ctx context.Context, instruction Instruction) (optType string, err error)
}

// VEN is an OpenADR 2.0b virtual end node using the HTTP pull model.
type VEN struct {
	cfg    Config
	client *http.Client
	logger *logrus.Logger

	venID          string
	registrationID string
	requestSeq     int
}

func NewVEN(cfg Config) (*VEN, error) {
	if strings.TrimSpace(cfg.VTNBaseURL) == "" {
		return nil, errors.New("openadr: vtn_base_url is required")
	}
	if !strings.HasPrefix(cfg.VTNBaseURL, "https://") && !strings.HasPrefix(cfg.VTNBaseURL, "http://") {
		return nil, fmt.Errorf("openadr: vtn_base_url %q is not an http(s) URL", cfg.VTNBaseURL)
	}
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = time.Minute
	}
	if cfg.RequestTimeout <= 0 {
		cfg.RequestTimeout = 30 * time.Second
	}
	if cfg.Logger == nil {
		cfg.Logger = logrus.StandardLogger()
	}

	transport := &http.Transport{}
	if cfg.ClientCertFile != "" || cfg.ClientKeyFile != "" || cfg.CAFile != "" {
		tlsConfig, err := buildTLS(cfg)
		if err != nil {
			return nil, err
		}
		transport.TLSClientConfig = tlsConfig
	}

	return &VEN{
		cfg:            cfg,
		client:         &http.Client{Timeout: cfg.RequestTimeout, Transport: transport},
		logger:         cfg.Logger,
		venID:          cfg.VenID,
		registrationID: cfg.RegistrationID,
	}, nil
}

func buildTLS(cfg Config) (*tls.Config, error) {
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if (cfg.ClientCertFile == "") != (cfg.ClientKeyFile == "") {
		return nil, errors.New("openadr: client_cert_file and client_key_file must be set together")
	}
	if cfg.ClientCertFile != "" {
		cert, err := tls.LoadX509KeyPair(cfg.ClientCertFile, cfg.ClientKeyFile)
		if err != nil {
			return nil, fmt.Errorf("openadr: load client certificate: %w", err)
		}
		tlsConfig.Certificates = []tls.Certificate{cert}
	}
	if cfg.CAFile != "" {
		pem, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, fmt.Errorf("openadr: read ca file: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("openadr: ca file %s contains no certificates", cfg.CAFile)
		}
		tlsConfig.RootCAs = pool
	}
	return tlsConfig, nil
}

// VenID is the identifier the VTN assigned during registration.
func (v *VEN) VenID() string { return v.venID }

// RegistrationID is the registration handle assigned by the VTN.
func (v *VEN) RegistrationID() string { return v.registrationID }

func (v *VEN) nextRequestID(prefix string) string {
	v.requestSeq++
	return fmt.Sprintf("%s-%d-%d", prefix, time.Now().UTC().Unix(), v.requestSeq)
}

// Register performs oadrCreatePartyRegistration and stores the assigned IDs.
func (v *VEN) Register(ctx context.Context) error {
	req := &CreatePartyRegistration{
		RequestID:     v.nextRequestID("reg"),
		VenID:         v.venID,
		ProfileName:   "2.0b",
		TransportName: "simpleHttp",
		ReportOnly:    false,
		XmlSignature:  false,
		VenName:       v.cfg.VenName,
		HTTPPullModel: true,
	}

	resp, err := v.exchange(ctx, "EiRegisterParty", &SignedObject{CreatePartyRegistration: req})
	if err != nil {
		return err
	}
	created := resp.SignedObj.CreatedPartyRegistration
	if created == nil {
		return fmt.Errorf("openadr: VTN did not return oadrCreatedPartyRegistration")
	}
	if created.EiResponse.ResponseCode != ResponseCodeOK {
		return fmt.Errorf("openadr: registration rejected with %s: %s",
			created.EiResponse.ResponseCode, created.EiResponse.ResponseDescription)
	}
	if created.VenID == "" || created.RegistrationID == "" {
		return fmt.Errorf("openadr: registration response is missing venID or registrationID")
	}

	v.venID = created.VenID
	v.registrationID = created.RegistrationID
	if created.PollFreq != nil {
		if d, err := ParseDuration(created.PollFreq.Duration); err == nil && d > 0 {
			v.cfg.PollInterval = d
		}
	}
	v.logger.WithFields(logrus.Fields{
		"ven_id":          v.venID,
		"registration_id": v.registrationID,
		"poll_interval":   v.cfg.PollInterval.String(),
	}).Info("registered with VTN")
	return nil
}

// Poll performs one oadrPoll and dispatches any events it returns. It reports
// how many events were handled; a transport or protocol failure is returned
// rather than treated as "no events", which would look identical to a quiet
// grid while DR obligations went unanswered.
func (v *VEN) Poll(ctx context.Context, handler Handler) (int, error) {
	if v.venID == "" {
		return 0, errors.New("openadr: cannot poll before registration assigned a venID")
	}

	resp, err := v.exchange(ctx, "OadrPoll", &SignedObject{Poll: &Poll{VenID: v.venID}})
	if err != nil {
		return 0, err
	}

	obj := resp.SignedObj
	switch {
	case obj.DistributeEvent != nil:
		return v.handleDistributeEvent(ctx, handler, obj.DistributeEvent)
	case obj.Response != nil:
		if obj.Response.EiResponse.ResponseCode != ResponseCodeOK {
			return 0, fmt.Errorf("openadr: poll returned %s: %s",
				obj.Response.EiResponse.ResponseCode, obj.Response.EiResponse.ResponseDescription)
		}
		return 0, nil
	default:
		return 0, errors.New("openadr: poll response contained no recognised payload")
	}
}

func (v *VEN) handleDistributeEvent(ctx context.Context, handler Handler, dist *DistributeEvent) (int, error) {
	responses := make([]EventResponse, 0, len(dist.Events))
	handled := 0

	for _, event := range dist.Events {
		instruction, err := toInstruction(event)
		if err != nil {
			// An event we cannot parse is not an event we can be measured
			// against; opt out explicitly instead of ignoring it.
			v.logger.WithError(err).WithField("event_id", event.EiEvent.EventDescriptor.EventID).
				Warn("rejecting unparsable OpenADR event")
			responses = append(responses, eventResponse(event, dist.RequestID, OptOut, "452", err.Error()))
			continue
		}

		optType, err := handler.HandleEvent(ctx, instruction)
		if err != nil {
			v.logger.WithError(err).WithField("event_id", instruction.EventID).
				Warn("platform could not accept OpenADR event; opting out")
			responses = append(responses, eventResponse(event, dist.RequestID, OptOut, "459", err.Error()))
			continue
		}
		if optType != OptIn && optType != OptOut {
			return handled, fmt.Errorf("openadr: handler returned invalid optType %q", optType)
		}
		handled++
		if instruction.ResponseRequired {
			responses = append(responses, eventResponse(event, dist.RequestID, optType, ResponseCodeOK, ""))
		}
	}

	if len(responses) == 0 {
		return handled, nil
	}
	created := &CreatedEvent{EiCreatedEvent: EiCreatedEvent{
		EiResponse:     EiResponse{ResponseCode: ResponseCodeOK, RequestID: dist.RequestID},
		VenID:          v.venID,
		EventResponses: EventResponses{Responses: responses},
	}}
	ack, err := v.exchange(ctx, "EiEvent", &SignedObject{CreatedEvent: created})
	if err != nil {
		return handled, fmt.Errorf("openadr: sending oadrCreatedEvent failed: %w", err)
	}
	if ack.SignedObj.Response != nil && ack.SignedObj.Response.EiResponse.ResponseCode != ResponseCodeOK {
		return handled, fmt.Errorf("openadr: VTN rejected oadrCreatedEvent with %s: %s",
			ack.SignedObj.Response.EiResponse.ResponseCode,
			ack.SignedObj.Response.EiResponse.ResponseDescription)
	}
	return handled, nil
}

func eventResponse(event Event, requestID, optType, code, description string) EventResponse {
	return EventResponse{
		ResponseCode:        code,
		ResponseDescription: description,
		RequestID:           requestID,
		QualifiedEventID: QualifiedEventID{
			EventID:            event.EiEvent.EventDescriptor.EventID,
			ModificationNumber: event.EiEvent.EventDescriptor.ModificationNumber,
		},
		OptType: optType,
	}
}

// Run polls the VTN until the context is cancelled, registering first if needed.
func (v *VEN) Run(ctx context.Context, handler Handler) error {
	if v.venID == "" {
		if err := v.Register(ctx); err != nil {
			return err
		}
	}
	ticker := time.NewTicker(v.cfg.PollInterval)
	defer ticker.Stop()

	for {
		if _, err := v.Poll(ctx, handler); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			v.logger.WithError(err).Warn("OpenADR poll failed")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (v *VEN) exchange(ctx context.Context, service string, body *SignedObject) (*Payload, error) {
	payload := &Payload{SignedObj: body}
	encoded, err := xml.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("openadr: marshal %s request: %w", service, err)
	}
	document := append([]byte(xml.Header), encoded...)

	url := strings.TrimSuffix(v.cfg.VTNBaseURL, "/") + "/" + service
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(document))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/xml")
	req.Header.Set("Accept", "application/xml")
	if v.cfg.Username != "" {
		req.SetBasicAuth(v.cfg.Username, v.cfg.Password)
	}

	resp, err := v.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("openadr: %s request to %s failed: %w", service, url, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, fmt.Errorf("openadr: reading %s response: %w", service, err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("openadr: %s returned HTTP %d: %s", service, resp.StatusCode, truncate(string(raw), 512))
	}

	var decoded Payload
	if err := xml.Unmarshal(raw, &decoded); err != nil {
		return nil, fmt.Errorf("openadr: %s response is not an oadrPayload: %w", service, err)
	}
	if decoded.SignedObj == nil {
		return nil, fmt.Errorf("openadr: %s response has no oadrSignedObject", service)
	}
	return &decoded, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
