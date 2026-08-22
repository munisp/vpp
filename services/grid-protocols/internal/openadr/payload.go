// Package openadr implements an OpenADR 2.0b VEN (Virtual End Node): the
// simple HTTP PUSH/PULL profile with real oadrPayload XML over HTTP, per the
// OpenADR 2.0b Profile Specification.
package openadr

import "encoding/xml"

// XML namespaces used by OpenADR 2.0b payloads.
const (
	NSOADR     = "http://openadr.org/oadr-2.0b/2012/07"
	NSEI       = "http://docs.oasis-open.org/ns/energyinterop/201110"
	NSPayloads = "http://docs.oasis-open.org/ns/energyinterop/201110/payloads"
	NSStrm     = "urn:ietf:params:xml:ns:icalendar-2.0:stream"
	NSXcal     = "urn:ietf:params:xml:ns:icalendar-2.0"
	NSPower    = "http://docs.oasis-open.org/ns/emix/2011/06/power"
	NSEmix     = "http://docs.oasis-open.org/ns/emix/2011/06"
)

// Response codes from EI (energy interoperation) payloads.
const (
	ResponseCodeOK = "200"
)

// Payload is the oadrPayload envelope. Only the message types this VEN uses are
// modelled; an unexpected message is reported rather than ignored.
type Payload struct {
	XMLName   xml.Name      `xml:"oadrPayload"`
	SignedObj *SignedObject `xml:"oadrSignedObject"`
}

type SignedObject struct {
	XMLName xml.Name `xml:"oadrSignedObject"`

	QueryRegistration        *QueryRegistration        `xml:"oadrQueryRegistration,omitempty"`
	CreatePartyRegistration  *CreatePartyRegistration  `xml:"oadrCreatePartyRegistration,omitempty"`
	CreatedPartyRegistration *CreatedPartyRegistration `xml:"oadrCreatedPartyRegistration,omitempty"`
	Poll                     *Poll                     `xml:"oadrPoll,omitempty"`
	Response                 *Response                 `xml:"oadrResponse,omitempty"`
	DistributeEvent          *DistributeEvent          `xml:"oadrDistributeEvent,omitempty"`
	CreatedEvent             *CreatedEvent             `xml:"oadrCreatedEvent,omitempty"`
}

type QueryRegistration struct {
	RequestID string `xml:"http://docs.oasis-open.org/ns/energyinterop/201110/payloads requestID"`
}

type CreatePartyRegistration struct {
	RequestID        string `xml:"http://docs.oasis-open.org/ns/energyinterop/201110/payloads requestID"`
	RegistrationID   string `xml:"registrationID,omitempty"`
	VenID            string `xml:"venID,omitempty"`
	ProfileName      string `xml:"oadrProfileName"`
	TransportName    string `xml:"oadrTransportName"`
	TransportAddress string `xml:"oadrTransportAddress,omitempty"`
	ReportOnly       bool   `xml:"oadrReportOnly"`
	XmlSignature     bool   `xml:"oadrXmlSignature"`
	VenName          string `xml:"oadrVenName,omitempty"`
	HTTPPullModel    bool   `xml:"oadrHttpPullModel"`
}

type CreatedPartyRegistration struct {
	EiResponse     EiResponse `xml:"eiResponse"`
	RegistrationID string     `xml:"registrationID"`
	VenID          string     `xml:"venID"`
	VtnID          string     `xml:"vtnID"`
	PollFreq       *Duration  `xml:"oadrRequestedOadrPollFreq"`
}

type Duration struct {
	Duration string `xml:"duration"`
}

type Poll struct {
	VenID string `xml:"venID"`
}

type Response struct {
	EiResponse EiResponse `xml:"eiResponse"`
	VenID      string     `xml:"venID"`
}

type EiResponse struct {
	ResponseCode        string `xml:"http://docs.oasis-open.org/ns/energyinterop/201110 responseCode"`
	ResponseDescription string `xml:"http://docs.oasis-open.org/ns/energyinterop/201110 responseDescription,omitempty"`
	RequestID           string `xml:"http://docs.oasis-open.org/ns/energyinterop/201110/payloads requestID"`
}

type DistributeEvent struct {
	EiResponse *EiResponse `xml:"eiResponse"`
	RequestID  string      `xml:"http://docs.oasis-open.org/ns/energyinterop/201110/payloads requestID"`
	VtnID      string      `xml:"vtnID"`
	Events     []Event     `xml:"oadrEvent"`
}

type Event struct {
	EiEvent          EiEvent `xml:"eiEvent"`
	ResponseRequired string  `xml:"oadrResponseRequired"`
}

type EiEvent struct {
	EventDescriptor EventDescriptor `xml:"eventDescriptor"`
	EiActivePeriod  ActivePeriod    `xml:"eiActivePeriod"`
	EiEventSignals  EventSignals    `xml:"eiEventSignals"`
	EiTarget        *EiTarget       `xml:"eiTarget"`
}

type EventDescriptor struct {
	EventID            string `xml:"eventID"`
	ModificationNumber int    `xml:"modificationNumber"`
	Priority           int    `xml:"priority"`
	MarketContext      string `xml:"eiMarketContext>marketContext"`
	CreatedDateTime    string `xml:"createdDateTime"`
	EventStatus        string `xml:"eventStatus"`
	TestEvent          string `xml:"testEvent,omitempty"`
	VtnComment         string `xml:"vtnComment,omitempty"`
}

type ActivePeriod struct {
	Properties Properties `xml:"properties"`
}

type Properties struct {
	DTStart   DTStart      `xml:"dtstart"`
	Duration  DurationProp `xml:"duration"`
	Tolerance *Tolerance   `xml:"tolerance"`
}

type DTStart struct {
	DateTime string `xml:"date-time"`
}

type DurationProp struct {
	Duration string `xml:"duration"`
}

type Tolerance struct {
	Tolerate Tolerate `xml:"tolerate"`
}

type Tolerate struct {
	StartAfter string `xml:"startafter"`
}

type EventSignals struct {
	Signals []EventSignal `xml:"eiEventSignal"`
}

type EventSignal struct {
	Intervals    Intervals     `xml:"intervals"`
	SignalName   string        `xml:"signalName"`
	SignalType   string        `xml:"signalType"`
	SignalID     string        `xml:"signalID"`
	CurrentValue *CurrentValue `xml:"currentValue"`
}

type CurrentValue struct {
	PayloadFloat PayloadFloat `xml:"payloadFloat"`
}

type Intervals struct {
	Intervals []Interval `xml:"interval"`
}

type Interval struct {
	Duration      DurationProp  `xml:"duration"`
	UID           UID           `xml:"uid"`
	SignalPayload SignalPayload `xml:"signalPayload"`
}

type UID struct {
	Text string `xml:"text"`
}

type SignalPayload struct {
	PayloadFloat PayloadFloat `xml:"payloadFloat"`
}

type PayloadFloat struct {
	Value float64 `xml:"value"`
}

type EiTarget struct {
	VenIDs      []string `xml:"venID"`
	GroupIDs    []string `xml:"groupID"`
	ResourceIDs []string `xml:"resourceID"`
}

type CreatedEvent struct {
	EiCreatedEvent EiCreatedEvent `xml:"http://docs.oasis-open.org/ns/energyinterop/201110 eiCreatedEvent"`
}

type EiCreatedEvent struct {
	EiResponse     EiResponse     `xml:"eiResponse"`
	VenID          string         `xml:"venID"`
	EventResponses EventResponses `xml:"eventResponses"`
}

type EventResponses struct {
	Responses []EventResponse `xml:"eventResponse"`
}

type EventResponse struct {
	ResponseCode        string           `xml:"responseCode"`
	ResponseDescription string           `xml:"responseDescription,omitempty"`
	RequestID           string           `xml:"http://docs.oasis-open.org/ns/energyinterop/201110/payloads requestID"`
	QualifiedEventID    QualifiedEventID `xml:"qualifiedEventID"`
	OptType             string           `xml:"optType"`
}

type QualifiedEventID struct {
	EventID            string `xml:"eventID"`
	ModificationNumber int    `xml:"modificationNumber"`
}

// Opt types a VEN can return for an event (EI OptType).
const (
	OptIn  = "optIn"
	OptOut = "optOut"
)

// Event status values (EventStatusEnumeratedType).
const (
	StatusNone      = "none"
	StatusFar       = "far"
	StatusNear      = "near"
	StatusActive    = "active"
	StatusCompleted = "completed"
	StatusCancelled = "cancelled"
)
