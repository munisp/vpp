// Package sep2 implements an IEEE 2030.5 (Smart Energy Profile 2.0) client for
// DER control: TLS client-certificate authentication, resource discovery from
// DeviceCapability, DERControl retrieval, and MirrorUsagePoint telemetry POSTs.
package sep2

import (
	"encoding/xml"
	"fmt"
	"math"
	"time"
)

// Namespace of IEEE 2030.5 resources.
const Namespace = "urn:ieee:std:2030.5:ns"

// Link is an href-only reference to another resource.
type Link struct {
	Href string `xml:"href,attr"`
}

// ListLink additionally carries the number of resources behind it.
type ListLink struct {
	Href string `xml:"href,attr"`
	All  int    `xml:"all,attr"`
}

type DeviceCapability struct {
	XMLName                  xml.Name  `xml:"urn:ieee:std:2030.5:ns DeviceCapability"`
	Href                     string    `xml:"href,attr"`
	TimeLink                 *Link     `xml:"TimeLink"`
	EndDeviceListLink        *ListLink `xml:"EndDeviceListLink"`
	MirrorUsagePointListLink *ListLink `xml:"MirrorUsagePointListLink"`
	DERProgramListLink       *ListLink `xml:"DERProgramListLink"`
}

type EndDeviceList struct {
	XMLName    xml.Name    `xml:"urn:ieee:std:2030.5:ns EndDeviceList"`
	All        int         `xml:"all,attr"`
	Results    int         `xml:"results,attr"`
	EndDevices []EndDevice `xml:"EndDevice"`
}

type EndDevice struct {
	Href                           string    `xml:"href,attr"`
	SFDI                           uint64    `xml:"sFDI"`
	LFDI                           string    `xml:"lFDI"`
	DERListLink                    *ListLink `xml:"DERListLink"`
	FunctionSetAssignmentsListLink *ListLink `xml:"FunctionSetAssignmentsListLink"`
	RegistrationLink               *Link     `xml:"RegistrationLink"`
}

type DERProgramList struct {
	XMLName  xml.Name     `xml:"urn:ieee:std:2030.5:ns DERProgramList"`
	All      int          `xml:"all,attr"`
	Results  int          `xml:"results,attr"`
	Programs []DERProgram `xml:"DERProgram"`
}

type DERProgram struct {
	Href                  string    `xml:"href,attr"`
	MRID                  string    `xml:"mRID"`
	Description           string    `xml:"description"`
	PrimacyValue          int       `xml:"primacy"`
	DERControlListLink    *ListLink `xml:"DERControlListLink"`
	DefaultDERControlLink *Link     `xml:"DefaultDERControlLink"`
}

type DERControlList struct {
	XMLName  xml.Name     `xml:"urn:ieee:std:2030.5:ns DERControlList"`
	All      int          `xml:"all,attr"`
	Results  int          `xml:"results,attr"`
	Controls []DERControl `xml:"DERControl"`
}

type DERControl struct {
	Href         string           `xml:"href,attr"`
	MRID         string           `xml:"mRID"`
	Description  string           `xml:"description"`
	CreationTime int64            `xml:"creationTime"`
	EventStatus  EventStatus      `xml:"EventStatus"`
	Interval     DateTimeInterval `xml:"interval"`
	Control      DERControlBase   `xml:"DERControlBase"`
}

type EventStatus struct {
	CurrentStatus         int   `xml:"currentStatus"`
	DateTime              int64 `xml:"dateTime"`
	PotentiallySuperseded bool  `xml:"potentiallySuperseded"`
}

type DateTimeInterval struct {
	Duration int64 `xml:"duration"`
	Start    int64 `xml:"start"`
}

// DERControlBase carries the control setpoints. Values are IEEE 2030.5
// "power of ten multiplier" pairs, never plain numbers.
type DERControlBase struct {
	OpModConnect  *bool          `xml:"opModConnect"`
	OpModEnergize *bool          `xml:"opModEnergize"`
	OpModFixedW   *int           `xml:"opModFixedW"` // percent of setMaxW, hundredths
	OpModFixedVar *ReactivePower `xml:"opModFixedVar"`
	OpModMaxLimW  *int           `xml:"opModMaxLimW"` // percent of setMaxW, hundredths
	OpModTargetW  *ActivePower   `xml:"opModTargetW"`
	RampTms       *int           `xml:"rampTms"`
}

type ActivePower struct {
	Multiplier int   `xml:"multiplier"`
	Value      int64 `xml:"value"`
}

type ReactivePower struct {
	Multiplier int   `xml:"multiplier"`
	Value      int64 `xml:"value"`
}

// Watts resolves a 2030.5 ActivePower (value × 10^multiplier).
func (p ActivePower) Watts() float64 {
	return float64(p.Value) * math.Pow10(p.Multiplier)
}

// DERControl status values (2030.5 EventStatus currentStatus).
const (
	StatusScheduled                  = 0
	StatusActive                     = 1
	StatusCancelled                  = 2
	StatusCancelledWithRandomization = 3
	StatusSuperseded                 = 4
)

// Instruction is a normalised DER control handed to the platform.
type Instruction struct {
	MRID        string        `json:"mrid"`
	ProgramMRID string        `json:"program_mrid"`
	Description string        `json:"description"`
	Status      int           `json:"status"`
	Primacy     int           `json:"primacy"`
	Start       time.Time     `json:"start"`
	Duration    time.Duration `json:"duration"`
	// TargetWatts is set when the control specifies opModTargetW.
	TargetWatts *float64 `json:"target_watts,omitempty"`
	// MaxLimitPercent is set when the control specifies opModMaxLimW.
	MaxLimitPercent *float64 `json:"max_limit_percent,omitempty"`
	// FixedPercent is set when the control specifies opModFixedW.
	FixedPercent *float64 `json:"fixed_percent,omitempty"`
	Connect      *bool    `json:"connect,omitempty"`
	Energize     *bool    `json:"energize,omitempty"`
	RampSeconds  *int     `json:"ramp_seconds,omitempty"`
}

// toInstruction converts a DERControl. A control with no recognised setpoint is
// an error: applying "nothing" while reporting success would silently ignore a
// utility instruction.
func toInstruction(program DERProgram, control DERControl) (Instruction, error) {
	if control.MRID == "" {
		return Instruction{}, fmt.Errorf("DERControl at %s has no mRID", control.Href)
	}
	if control.Interval.Start <= 0 {
		return Instruction{}, fmt.Errorf("DERControl %s has no interval start", control.MRID)
	}
	if control.Interval.Duration <= 0 {
		return Instruction{}, fmt.Errorf("DERControl %s has a non-positive duration", control.MRID)
	}

	instruction := Instruction{
		MRID:        control.MRID,
		ProgramMRID: program.MRID,
		Description: control.Description,
		Status:      control.EventStatus.CurrentStatus,
		Primacy:     program.PrimacyValue,
		Start:       time.Unix(control.Interval.Start, 0).UTC(),
		Duration:    time.Duration(control.Interval.Duration) * time.Second,
		Connect:     control.Control.OpModConnect,
		Energize:    control.Control.OpModEnergize,
		RampSeconds: control.Control.RampTms,
	}
	if control.Control.RampTms != nil {
		// rampTms is in hundredths of a second.
		seconds := *control.Control.RampTms / 100
		instruction.RampSeconds = &seconds
	}
	if control.Control.OpModTargetW != nil {
		watts := control.Control.OpModTargetW.Watts()
		instruction.TargetWatts = &watts
	}
	if control.Control.OpModMaxLimW != nil {
		percent := float64(*control.Control.OpModMaxLimW) / 100.0
		instruction.MaxLimitPercent = &percent
	}
	if control.Control.OpModFixedW != nil {
		percent := float64(*control.Control.OpModFixedW) / 100.0
		instruction.FixedPercent = &percent
	}

	if instruction.TargetWatts == nil && instruction.MaxLimitPercent == nil &&
		instruction.FixedPercent == nil && instruction.Connect == nil && instruction.Energize == nil {
		return Instruction{}, fmt.Errorf("DERControl %s carries no supported setpoint", control.MRID)
	}
	return instruction, nil
}

// MirrorMeterReading is the telemetry a client mirrors back to the server.
type MirrorMeterReading struct {
	XMLName        xml.Name     `xml:"urn:ieee:std:2030.5:ns MirrorMeterReading"`
	MRID           string       `xml:"mRID"`
	Description    string       `xml:"description,omitempty"`
	LastUpdateTime int64        `xml:"lastUpdateTime"`
	Reading        *Reading     `xml:"Reading,omitempty"`
	ReadingType    *ReadingType `xml:"ReadingType,omitempty"`
}

type Reading struct {
	TimePeriod *DateTimeInterval `xml:"timePeriod,omitempty"`
	Value      int64             `xml:"value"`
}

type ReadingType struct {
	PowerOfTenMultiplier int `xml:"powerOfTenMultiplier"`
	UOM                  int `xml:"uom"`
	DataQualifier        int `xml:"dataQualifier,omitempty"`
	FlowDirection        int `xml:"flowDirection,omitempty"`
	IntervalLength       int `xml:"intervalLength,omitempty"`
}

// Units of measure used by this client (IEC 61968 UomType).
const (
	UomWatts     = 38
	UomWattHours = 72
)
