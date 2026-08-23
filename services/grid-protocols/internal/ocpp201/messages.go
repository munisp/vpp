// Package ocpp201 implements an OCPP 2.0.1 CSMS (charging station management
// system) over the shared OCPP-J framing in internal/ocppj.
//
// 2.0.1 is not a renamed 1.6. Three differences matter to a platform that
// settles money on these messages, and they are why this is a separate package
// rather than a translation shim:
//
//   - the charging station, not the CSMS, owns transaction identity: it is an
//     opaque string the station generates, so the platform maps it instead of
//     handing one out;
//   - StartTransaction/StopTransaction are replaced by one TransactionEvent
//     message carrying a monotonic seqNo, so a station that queued events while
//     offline replays them and the receiver must be idempotent;
//   - a replayed event is flagged `offline`, which means the reading is real but
//     late — it is evidence of what happened, not evidence of the state now.
package ocpp201

import "time"

// Actions sent by the charging station to the CSMS.
const (
	ActionBootNotification   = "BootNotification"
	ActionHeartbeat          = "Heartbeat"
	ActionStatusNotification = "StatusNotification"
	ActionMeterValues        = "MeterValues"
	ActionAuthorize          = "Authorize"
	ActionTransactionEvent   = "TransactionEvent"
)

// Actions sent by the CSMS to the charging station.
const (
	ActionRequestStartTransaction = "RequestStartTransaction"
	ActionRequestStopTransaction  = "RequestStopTransaction"
	ActionSetChargingProfile      = "SetChargingProfile"
	ActionClearChargingProfile    = "ClearChargingProfile"
	ActionTriggerMessage          = "TriggerMessage"
	ActionReset                   = "Reset"
	ActionGetVariables            = "GetVariables"
	ActionSetVariables            = "SetVariables"
)

// Error codes from OCPP 2.0.1 part 4 section 4.2.3. `FormatViolation` replaces
// 1.6's `FormationViolation` and the occurrence/type constraint codes are new,
// so a 1.6 code sent to a 2.0.1 station is a protocol error, not a synonym.
const (
	ErrFormatViolation               = "FormatViolation"
	ErrGenericError                  = "GenericError"
	ErrInternalError                 = "InternalError"
	ErrMessageTypeNotSupported       = "MessageTypeNotSupported"
	ErrNotImplemented                = "NotImplemented"
	ErrNotSupported                  = "NotSupported"
	ErrOccurrenceConstraintViolation = "OccurrenceConstraintViolation"
	ErrPropertyConstraintViolation   = "PropertyConstraintViolation"
	ErrProtocolError                 = "ProtocolError"
	ErrRPCFrameworkError             = "RpcFrameworkError"
	ErrSecurityError                 = "SecurityError"
	ErrTypeConstraintViolation       = "TypeConstraintViolation"
)

// TransactionEvent event types (TransactionEventEnumType).
const (
	TransactionEventStarted = "Started"
	TransactionEventUpdated = "Updated"
	TransactionEventEnded   = "Ended"
)

// AuthorizationStatusEnumType values.
const (
	AuthAccepted           = "Accepted"
	AuthBlocked            = "Blocked"
	AuthExpired            = "Expired"
	AuthInvalid            = "Invalid"
	AuthConcurrentTx       = "ConcurrentTx"
	AuthNoCredit           = "NoCredit"
	AuthNotAllowedTypeEVSE = "NotAllowedTypeEVSE"
	AuthNotAtThisLocation  = "NotAtThisLocation"
	AuthNotAtThisTime      = "NotAtThisTime"
	AuthUnknown            = "Unknown"
)

// RegistrationStatusEnumType values.
const (
	RegistrationAccepted = "Accepted"
	RegistrationPending  = "Pending"
	RegistrationRejected = "Rejected"
)

// ChargingStation identifies the physical station (BootNotification).
type ChargingStation struct {
	Model           string  `json:"model"`
	VendorName      string  `json:"vendorName"`
	SerialNumber    string  `json:"serialNumber,omitempty"`
	FirmwareVersion string  `json:"firmwareVersion,omitempty"`
	Modem           *Modem  `json:"modem,omitempty"`
	CustomData      *Custom `json:"customData,omitempty"`
}

type Modem struct {
	Iccid string `json:"iccid,omitempty"`
	Imsi  string `json:"imsi,omitempty"`
}

// Custom carries vendor extensions. It is kept opaque: this service does not
// interpret vendor data, and dropping it would hide it from the platform.
type Custom struct {
	VendorID string `json:"vendorId"`
}

type BootNotificationRequest struct {
	Reason          string          `json:"reason"`
	ChargingStation ChargingStation `json:"chargingStation"`
	CustomData      *Custom         `json:"customData,omitempty"`
}

type BootNotificationResponse struct {
	CurrentTime string `json:"currentTime"`
	Interval    int    `json:"interval"`
	Status      string `json:"status"`
	StatusInfo  *Info  `json:"statusInfo,omitempty"`
}

type Info struct {
	ReasonCode     string `json:"reasonCode"`
	AdditionalInfo string `json:"additionalInfo,omitempty"`
}

type HeartbeatResponse struct {
	CurrentTime string `json:"currentTime"`
}

// StatusNotificationRequest is per EVSE and connector in 2.0.1; 1.6's flat
// connectorId cannot express which EVSE of a multi-EVSE station reported.
type StatusNotificationRequest struct {
	Timestamp       string  `json:"timestamp"`
	ConnectorStatus string  `json:"connectorStatus"`
	EvseID          int     `json:"evseId"`
	ConnectorID     int     `json:"connectorId"`
	CustomData      *Custom `json:"customData,omitempty"`
}

// connectorStatuses is ConnectorStatusEnumType. 2.0.1 has five statuses, not
// 1.6's nine: a station sending "Charging" or "Preparing" here is not speaking
// 2.0.1, and forwarding it would leave the platform mapping a value the standard
// does not define.
var connectorStatuses = [5]string{"Available", "Occupied", "Reserved", "Unavailable", "Faulted"}

func validConnectorStatus(status string) bool {
	for _, candidate := range connectorStatuses {
		if candidate == status {
			return true
		}
	}
	return false
}

type IDToken struct {
	IDToken string  `json:"idToken"`
	Type    string  `json:"type"`
	Custom  *Custom `json:"customData,omitempty"`
}

type IDTokenInfo struct {
	Status              string   `json:"status"`
	CacheExpiryDateTime string   `json:"cacheExpiryDateTime,omitempty"`
	ChargingPriority    *int     `json:"chargingPriority,omitempty"`
	GroupIDToken        *IDToken `json:"groupIdToken,omitempty"`
	Language1           string   `json:"language1,omitempty"`
	Evses               []int    `json:"evseId,omitempty"`
}

type AuthorizeRequest struct {
	IDToken    IDToken `json:"idToken"`
	CustomData *Custom `json:"customData,omitempty"`
}

type AuthorizeResponse struct {
	IDTokenInfo IDTokenInfo `json:"idTokenInfo"`
}

type SampledValue struct {
	Value            float64        `json:"value"`
	Context          string         `json:"context,omitempty"`
	Measurand        string         `json:"measurand,omitempty"`
	Phase            string         `json:"phase,omitempty"`
	Location         string         `json:"location,omitempty"`
	UnitOfMeasure    *UnitOfMeasure `json:"unitOfMeasure,omitempty"`
	SignedMeterValue *SignedMeter   `json:"signedMeterValue,omitempty"`
}

// UnitOfMeasure carries the unit and a power-of-ten multiplier. Ignoring the
// multiplier would misread a station that reports kWh as Wh×10³.
type UnitOfMeasure struct {
	Unit       string `json:"unit,omitempty"`
	Multiplier *int   `json:"multiplier,omitempty"`
}

// SignedMeter is the station's cryptographically signed register reading. It is
// forwarded verbatim; this service does not verify it and must not imply it did.
type SignedMeter struct {
	SignedMeterData string `json:"signedMeterData"`
	SigningMethod   string `json:"signingMethod"`
	EncodingMethod  string `json:"encodingMethod"`
	PublicKey       string `json:"publicKey,omitempty"`
}

type MeterValue struct {
	Timestamp    string         `json:"timestamp"`
	SampledValue []SampledValue `json:"sampledValue"`
}

type EVSE struct {
	ID          int  `json:"id"`
	ConnectorID *int `json:"connectorId,omitempty"`
}

// TransactionInfo carries the station-generated transaction id. `ChargingState`
// is the station's own view (Charging, EVConnected, SuspendedEV, Idle...).
type TransactionInfo struct {
	TransactionID     string  `json:"transactionId"`
	ChargingState     string  `json:"chargingState,omitempty"`
	TimeSpentCharging *int    `json:"timeSpentCharging,omitempty"`
	StoppedReason     string  `json:"stoppedReason,omitempty"`
	RemoteStartID     *int    `json:"remoteStartId,omitempty"`
	CustomData        *Custom `json:"customData,omitempty"`
}

// TransactionEventRequest replaces StartTransaction/StopTransaction/MeterValues
// for anything inside a transaction. SeqNo is monotonic per transaction and
// Offline marks an event the station buffered while disconnected.
type TransactionEventRequest struct {
	EventType          string          `json:"eventType"`
	Timestamp          string          `json:"timestamp"`
	TriggerReason      string          `json:"triggerReason"`
	SeqNo              int             `json:"seqNo"`
	Offline            bool            `json:"offline,omitempty"`
	NumberOfPhasesUsed *int            `json:"numberOfPhasesUsed,omitempty"`
	CableMaxCurrent    *int            `json:"cableMaxCurrent,omitempty"`
	ReservationID      *int            `json:"reservationId,omitempty"`
	TransactionInfo    TransactionInfo `json:"transactionInfo"`
	Evse               *EVSE           `json:"evse,omitempty"`
	IDToken            *IDToken        `json:"idToken,omitempty"`
	MeterValue         []MeterValue    `json:"meterValue,omitempty"`
	CustomData         *Custom         `json:"customData,omitempty"`
}

// TransactionEventResponse may carry authorization and cost. `TotalCost` is
// omitted unless the platform actually priced the session.
type TransactionEventResponse struct {
	TotalCost        *float64     `json:"totalCost,omitempty"`
	ChargingPriority *int         `json:"chargingPriority,omitempty"`
	IDTokenInfo      *IDTokenInfo `json:"idTokenInfo,omitempty"`
	UpdatedMessage   *Message     `json:"updatedPersonalMessage,omitempty"`
}

type Message struct {
	Format   string `json:"format"`
	Language string `json:"language,omitempty"`
	Content  string `json:"content"`
}

type MeterValuesRequest struct {
	EvseID     int          `json:"evseId"`
	MeterValue []MeterValue `json:"meterValue"`
	CustomData *Custom      `json:"customData,omitempty"`
}

// ChargingSchedulePeriod limits are in the schedule's chargingRateUnit.
// Negative limits express discharge for V2G-capable equipment.
type ChargingSchedulePeriod struct {
	StartPeriod    int      `json:"startPeriod"`
	Limit          float64  `json:"limit"`
	NumberPhases   *int     `json:"numberPhases,omitempty"`
	PhaseToUse     *int     `json:"phaseToUse,omitempty"`
	DischargeLimit *float64 `json:"dischargeLimit,omitempty"`
}

type ChargingSchedule struct {
	ID                     int                      `json:"id"`
	StartSchedule          string                   `json:"startSchedule,omitempty"`
	Duration               *int                     `json:"duration,omitempty"`
	ChargingRateUnit       string                   `json:"chargingRateUnit"`
	MinChargingRate        *float64                 `json:"minChargingRate,omitempty"`
	ChargingSchedulePeriod []ChargingSchedulePeriod `json:"chargingSchedulePeriod"`
}

type ChargingProfile struct {
	ID                     int                `json:"id"`
	StackLevel             int                `json:"stackLevel"`
	ChargingProfilePurpose string             `json:"chargingProfilePurpose"`
	ChargingProfileKind    string             `json:"chargingProfileKind"`
	RecurrencyKind         string             `json:"recurrencyKind,omitempty"`
	ValidFrom              string             `json:"validFrom,omitempty"`
	ValidTo                string             `json:"validTo,omitempty"`
	TransactionID          string             `json:"transactionId,omitempty"`
	ChargingSchedule       []ChargingSchedule `json:"chargingSchedule"`
}

type SetChargingProfileRequest struct {
	EvseID          int             `json:"evseId"`
	ChargingProfile ChargingProfile `json:"chargingProfile"`
}

// ClearChargingProfileRequest fields are filters; internal/admin requires at
// least one so a revocation cannot wipe every profile on the station.
type ClearChargingProfileRequest struct {
	ChargingProfileID       *int                       `json:"chargingProfileId,omitempty"`
	ChargingProfileCriteria *ClearChargingProfileScope `json:"chargingProfileCriteria,omitempty"`
}

type ClearChargingProfileScope struct {
	EvseID                 *int   `json:"evseId,omitempty"`
	ChargingProfilePurpose string `json:"chargingProfilePurpose,omitempty"`
	StackLevel             *int   `json:"stackLevel,omitempty"`
}

type RequestStartTransactionRequest struct {
	EvseID          *int             `json:"evseId,omitempty"`
	RemoteStartID   int              `json:"remoteStartId"`
	IDToken         IDToken          `json:"idToken"`
	ChargingProfile *ChargingProfile `json:"chargingProfile,omitempty"`
}

type RequestStopTransactionRequest struct {
	TransactionID string `json:"transactionId"`
}

type TriggerMessageRequest struct {
	RequestedMessage string `json:"requestedMessage"`
	Evse             *EVSE  `json:"evse,omitempty"`
}

type ResetRequest struct {
	Type   string `json:"type"`
	EvseID *int   `json:"evseId,omitempty"`
}

// StatusResponse is the common `{status, statusInfo}` shape of CSMS-initiated
// command responses.
type StatusResponse struct {
	Status     string `json:"status"`
	StatusInfo *Info  `json:"statusInfo,omitempty"`
}

// GetVariables/SetVariables replace 1.6's key-value configuration.
type Component struct {
	Name     string `json:"name"`
	Instance string `json:"instance,omitempty"`
	Evse     *EVSE  `json:"evse,omitempty"`
}

type Variable struct {
	Name     string `json:"name"`
	Instance string `json:"instance,omitempty"`
}

type GetVariableData struct {
	Component     Component `json:"component"`
	Variable      Variable  `json:"variable"`
	AttributeType string    `json:"attributeType,omitempty"`
}

type GetVariablesRequest struct {
	GetVariableData []GetVariableData `json:"getVariableData"`
}

type GetVariableResult struct {
	AttributeStatus string    `json:"attributeStatus"`
	AttributeType   string    `json:"attributeType,omitempty"`
	AttributeValue  string    `json:"attributeValue,omitempty"`
	Component       Component `json:"component"`
	Variable        Variable  `json:"variable"`
	StatusInfo      *Info     `json:"statusInfo,omitempty"`
}

type GetVariablesResponse struct {
	GetVariableResult []GetVariableResult `json:"getVariableResult"`
}

type SetVariableData struct {
	AttributeType  string    `json:"attributeType,omitempty"`
	AttributeValue string    `json:"attributeValue"`
	Component      Component `json:"component"`
	Variable       Variable  `json:"variable"`
}

type SetVariablesRequest struct {
	SetVariableData []SetVariableData `json:"setVariableData"`
}

type SetVariableResult struct {
	AttributeStatus string    `json:"attributeStatus"`
	AttributeType   string    `json:"attributeType,omitempty"`
	Component       Component `json:"component"`
	Variable        Variable  `json:"variable"`
	StatusInfo      *Info     `json:"statusInfo,omitempty"`
}

type SetVariablesResponse struct {
	SetVariableResult []SetVariableResult `json:"setVariableResult"`
}

func utcNow() string {
	return time.Now().UTC().Format(time.RFC3339)
}
