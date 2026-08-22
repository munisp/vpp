package ocpp16

import "time"

// Core profile actions this central system implements.
const (
	ActionBootNotification       = "BootNotification"
	ActionHeartbeat              = "Heartbeat"
	ActionStatusNotification     = "StatusNotification"
	ActionMeterValues            = "MeterValues"
	ActionAuthorize              = "Authorize"
	ActionStartTransaction       = "StartTransaction"
	ActionStopTransaction        = "StopTransaction"
	ActionRemoteStartTransaction = "RemoteStartTransaction"
	ActionRemoteStopTransaction  = "RemoteStopTransaction"
	ActionSetChargingProfile     = "SetChargingProfile"
	ActionTriggerMessage         = "TriggerMessage"
	ActionReset                  = "Reset"
)

// Authorization status values (OCPP 1.6 section 7.1 AuthorizationStatus).
const (
	AuthAccepted     = "Accepted"
	AuthBlocked      = "Blocked"
	AuthExpired      = "Expired"
	AuthInvalid      = "Invalid"
	AuthConcurrentTx = "ConcurrentTx"
)

// Registration status values (RegistrationStatus).
const (
	RegistrationAccepted = "Accepted"
	RegistrationPending  = "Pending"
	RegistrationRejected = "Rejected"
)

type BootNotificationRequest struct {
	ChargePointVendor       string `json:"chargePointVendor"`
	ChargePointModel        string `json:"chargePointModel"`
	ChargePointSerialNumber string `json:"chargePointSerialNumber,omitempty"`
	ChargeBoxSerialNumber   string `json:"chargeBoxSerialNumber,omitempty"`
	FirmwareVersion         string `json:"firmwareVersion,omitempty"`
	Iccid                   string `json:"iccid,omitempty"`
	Imsi                    string `json:"imsi,omitempty"`
	MeterType               string `json:"meterType,omitempty"`
	MeterSerialNumber       string `json:"meterSerialNumber,omitempty"`
}

type BootNotificationResponse struct {
	Status      string `json:"status"`
	CurrentTime string `json:"currentTime"`
	Interval    int    `json:"interval"`
}

type HeartbeatResponse struct {
	CurrentTime string `json:"currentTime"`
}

type StatusNotificationRequest struct {
	ConnectorID     int    `json:"connectorId"`
	ErrorCode       string `json:"errorCode"`
	Status          string `json:"status"`
	Info            string `json:"info,omitempty"`
	Timestamp       string `json:"timestamp,omitempty"`
	VendorID        string `json:"vendorId,omitempty"`
	VendorErrorCode string `json:"vendorErrorCode,omitempty"`
}

type SampledValue struct {
	Value     string `json:"value"`
	Context   string `json:"context,omitempty"`
	Format    string `json:"format,omitempty"`
	Measurand string `json:"measurand,omitempty"`
	Phase     string `json:"phase,omitempty"`
	Location  string `json:"location,omitempty"`
	Unit      string `json:"unit,omitempty"`
}

type MeterValue struct {
	Timestamp    string         `json:"timestamp"`
	SampledValue []SampledValue `json:"sampledValue"`
}

type MeterValuesRequest struct {
	ConnectorID   int          `json:"connectorId"`
	TransactionID *int         `json:"transactionId,omitempty"`
	MeterValue    []MeterValue `json:"meterValue"`
}

type IdTagInfo struct {
	Status      string `json:"status"`
	ExpiryDate  string `json:"expiryDate,omitempty"`
	ParentIdTag string `json:"parentIdTag,omitempty"`
}

type AuthorizeRequest struct {
	IdTag string `json:"idTag"`
}

type AuthorizeResponse struct {
	IdTagInfo IdTagInfo `json:"idTagInfo"`
}

type StartTransactionRequest struct {
	ConnectorID   int    `json:"connectorId"`
	IdTag         string `json:"idTag"`
	MeterStart    int    `json:"meterStart"`
	ReservationID *int   `json:"reservationId,omitempty"`
	Timestamp     string `json:"timestamp"`
}

type StartTransactionResponse struct {
	TransactionID int       `json:"transactionId"`
	IdTagInfo     IdTagInfo `json:"idTagInfo"`
}

type StopTransactionRequest struct {
	IdTag           string       `json:"idTag,omitempty"`
	MeterStop       int          `json:"meterStop"`
	Timestamp       string       `json:"timestamp"`
	TransactionID   int          `json:"transactionId"`
	Reason          string       `json:"reason,omitempty"`
	TransactionData []MeterValue `json:"transactionData,omitempty"`
}

type StopTransactionResponse struct {
	IdTagInfo *IdTagInfo `json:"idTagInfo,omitempty"`
}

type RemoteStartTransactionRequest struct {
	ConnectorID     *int             `json:"connectorId,omitempty"`
	IdTag           string           `json:"idTag"`
	ChargingProfile *ChargingProfile `json:"chargingProfile,omitempty"`
}

type RemoteStopTransactionRequest struct {
	TransactionID int `json:"transactionId"`
}

// ChargingSchedulePeriod limits are amps or watts depending on chargingRateUnit.
// Negative limits express discharge for V2G-capable equipment.
type ChargingSchedulePeriod struct {
	StartPeriod  int     `json:"startPeriod"`
	Limit        float64 `json:"limit"`
	NumberPhases *int    `json:"numberPhases,omitempty"`
}

type ChargingSchedule struct {
	Duration               *int                     `json:"duration,omitempty"`
	StartSchedule          string                   `json:"startSchedule,omitempty"`
	ChargingRateUnit       string                   `json:"chargingRateUnit"`
	ChargingSchedulePeriod []ChargingSchedulePeriod `json:"chargingSchedulePeriod"`
	MinChargingRate        *float64                 `json:"minChargingRate,omitempty"`
}

type ChargingProfile struct {
	ChargingProfileID      int              `json:"chargingProfileId"`
	TransactionID          *int             `json:"transactionId,omitempty"`
	StackLevel             int              `json:"stackLevel"`
	ChargingProfilePurpose string           `json:"chargingProfilePurpose"`
	ChargingProfileKind    string           `json:"chargingProfileKind"`
	RecurrencyKind         string           `json:"recurrencyKind,omitempty"`
	ValidFrom              string           `json:"validFrom,omitempty"`
	ValidTo                string           `json:"validTo,omitempty"`
	ChargingSchedule       ChargingSchedule `json:"chargingSchedule"`
}

type SetChargingProfileRequest struct {
	ConnectorID        int             `json:"connectorId"`
	CsChargingProfiles ChargingProfile `json:"csChargingProfiles"`
}

type StatusResponse struct {
	Status string `json:"status"`
}

type TriggerMessageRequest struct {
	RequestedMessage string `json:"requestedMessage"`
	ConnectorID      *int   `json:"connectorId,omitempty"`
}

type ResetRequest struct {
	Type string `json:"type"`
}

func utcNow() string {
	return time.Now().UTC().Format(time.RFC3339)
}
