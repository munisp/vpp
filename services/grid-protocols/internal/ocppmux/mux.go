// Package ocppmux serves one /ocpp/<id> endpoint for both OCPP versions and
// gives the rest of the service one way to command a station regardless of which
// version it speaks.
//
// Version is decided by the WebSocket subprotocol the station offers, never by
// guessing at payloads: 1.6 and 2.0.1 share field names with different meanings,
// so a misrouted session would misread transactions and meter values.
//
// A station id may hold a session on one version at a time. The same id
// appearing on the other version is refused rather than tracked twice, because
// two live sessions for one physical station would let a command reach the
// wrong socket while the other reports the state.
package ocppmux

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/sirupsen/logrus"

	"github.com/vpp/grid-protocols/internal/ocpp16"
	"github.com/vpp/grid-protocols/internal/ocpp201"
	"github.com/vpp/grid-protocols/internal/ocppj"
)

// Version identifies which protocol a station is connected with.
type Version string

const (
	Version16  Version = "ocpp1.6"
	Version201 Version = "ocpp2.0.1"
)

// V16 is the subset of the 1.6 central system the mux needs.
type V16 interface {
	Serve(w http.ResponseWriter, r *http.Request, chargePointID string)
	ConnectedChargePoints() []string
	RemoteStartTransaction(ctx context.Context, chargePointID string, req ocpp16.RemoteStartTransactionRequest) (ocpp16.StatusResponse, error)
	RemoteStopTransaction(ctx context.Context, chargePointID string, req ocpp16.RemoteStopTransactionRequest) (ocpp16.StatusResponse, error)
	SetChargingProfile(ctx context.Context, chargePointID string, req ocpp16.SetChargingProfileRequest) (ocpp16.StatusResponse, error)
	ClearChargingProfile(ctx context.Context, chargePointID string, req ocpp16.ClearChargingProfileRequest) (ocpp16.StatusResponse, error)
}

// V201 is the subset of the 2.0.1 CSMS the mux needs.
type V201 interface {
	Serve(w http.ResponseWriter, r *http.Request, stationID string)
	ConnectedChargePoints() []string
	RequestStartTransaction(ctx context.Context, stationID string, req ocpp201.RequestStartTransactionRequest) (ocpp201.StatusResponse, error)
	RequestStopTransaction(ctx context.Context, stationID string, req ocpp201.RequestStopTransactionRequest) (ocpp201.StatusResponse, error)
	SetChargingProfile(ctx context.Context, stationID string, req ocpp201.SetChargingProfileRequest) (ocpp201.StatusResponse, error)
	ClearChargingProfile(ctx context.Context, stationID string, req ocpp201.ClearChargingProfileRequest) (ocpp201.StatusResponse, error)
}

// Mux routes station sessions and commands by protocol version.
type Mux struct {
	v16    V16
	v201   V201
	logger *logrus.Logger
}

func New(v16 V16, v201 V201, logger *logrus.Logger) (*Mux, error) {
	if v16 == nil && v201 == nil {
		return nil, fmt.Errorf("ocppmux: at least one protocol version must be enabled")
	}
	if logger == nil {
		logger = logrus.StandardLogger()
	}
	return &Mux{v16: v16, v201: v201, logger: logger}, nil
}

// ServeHTTP dispatches the upgrade request to the handler for the offered
// subprotocol. A station offering neither is rejected: there is no default.
func (m *Mux) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	stationID := strings.Trim(strings.TrimPrefix(r.URL.Path, "/ocpp"), "/")
	if stationID == "" || strings.Contains(stationID, "/") {
		http.Error(w, "path must be /ocpp/<stationId>", http.StatusNotFound)
		return
	}

	wants201 := ocpp201.HasSubprotocol(r)
	wants16 := hasSubprotocol(r, string(Version16))

	switch {
	case wants201 && m.v201 != nil:
		if m.connectedAs(stationID, Version16) {
			m.refuseDuplicate(w, stationID, Version16, Version201)
			return
		}
		m.v201.Serve(w, r, stationID)
	case wants16 && m.v16 != nil:
		if m.connectedAs(stationID, Version201) {
			m.refuseDuplicate(w, stationID, Version201, Version16)
			return
		}
		m.v16.Serve(w, r, stationID)
	case wants201 || wants16:
		http.Error(w, "that OCPP version is not enabled on this deployment", http.StatusBadRequest)
	default:
		http.Error(w, "an ocpp1.6 or ocpp2.0.1 subprotocol must be offered", http.StatusBadRequest)
	}
}

func (m *Mux) refuseDuplicate(w http.ResponseWriter, stationID string, holding, requested Version) {
	m.logger.WithFields(logrus.Fields{
		"station":   stationID,
		"connected": holding,
		"requested": requested,
	}).Warn("refused a second OCPP session for one station id")
	http.Error(w, fmt.Sprintf("station %s already holds a %s session", stationID, holding), http.StatusConflict)
}

func hasSubprotocol(r *http.Request, want string) bool {
	return ocppj.HasSubprotocol(r, want)
}

// ProtocolVersion reports the version a station is connected with as a plain
// string, or "" when it is not connected. The platform needs it because the two
// versions do not accept the same commands: stopping a 2.0.1 transaction takes
// the station's own transaction id, which only exists once it has reported one.
func (m *Mux) ProtocolVersion(stationID string) string {
	return string(m.Version(stationID))
}

// Version reports how a station is connected, or "" when it is not connected.
func (m *Mux) Version(stationID string) Version {
	if m.connectedAs(stationID, Version201) {
		return Version201
	}
	if m.connectedAs(stationID, Version16) {
		return Version16
	}
	return ""
}

func (m *Mux) connectedAs(stationID string, version Version) bool {
	var ids []string
	switch version {
	case Version16:
		if m.v16 == nil {
			return false
		}
		ids = m.v16.ConnectedChargePoints()
	case Version201:
		if m.v201 == nil {
			return false
		}
		ids = m.v201.ConnectedChargePoints()
	}
	for _, id := range ids {
		if id == stationID {
			return true
		}
	}
	return false
}

// ConnectedChargePoints lists every connected station across both versions.
func (m *Mux) ConnectedChargePoints() []string {
	ids := make([]string, 0, 8)
	if m.v16 != nil {
		ids = append(ids, m.v16.ConnectedChargePoints()...)
	}
	if m.v201 != nil {
		ids = append(ids, m.v201.ConnectedChargePoints()...)
	}
	return ids
}

// SetChargingProfile applies a bounded profile to whichever version the station
// speaks. Callers keep using the 1.6 shape (it is what the platform sends and
// what the control supervisor stores); for a 2.0.1 station it is translated,
// and a field that has no faithful 2.0.1 equivalent is an error rather than a
// guess.
func (m *Mux) SetChargingProfile(ctx context.Context, stationID string, req ocpp16.SetChargingProfileRequest) (ocpp16.StatusResponse, error) {
	switch m.Version(stationID) {
	case Version201:
		translated, err := ToProfile201(req)
		if err != nil {
			return ocpp16.StatusResponse{}, err
		}
		status, err := m.v201.SetChargingProfile(ctx, stationID, translated)
		return ocpp16.StatusResponse{Status: status.Status}, err
	case Version16:
		return m.v16.SetChargingProfile(ctx, stationID, req)
	default:
		return ocpp16.StatusResponse{}, fmt.Errorf("%w: %s", ocpp16.ErrNotConnected, stationID)
	}
}

// ClearChargingProfile revokes profiles on whichever version the station speaks.
func (m *Mux) ClearChargingProfile(ctx context.Context, stationID string, req ocpp16.ClearChargingProfileRequest) (ocpp16.StatusResponse, error) {
	switch m.Version(stationID) {
	case Version201:
		status, err := m.v201.ClearChargingProfile(ctx, stationID, ocpp201.ClearChargingProfileRequest{
			ChargingProfileID: req.ID,
			ChargingProfileCriteria: &ocpp201.ClearChargingProfileScope{
				EvseID:                 req.ConnectorID,
				ChargingProfilePurpose: purpose201(req.ChargingProfilePurpose),
				StackLevel:             req.StackLevel,
			},
		})
		return ocpp16.StatusResponse{Status: status.Status}, err
	case Version16:
		return m.v16.ClearChargingProfile(ctx, stationID, req)
	default:
		return ocpp16.StatusResponse{}, fmt.Errorf("%w: %s", ocpp16.ErrNotConnected, stationID)
	}
}

// RemoteStart starts a transaction on whichever version the station speaks.
// remoteStartID lets a 2.0.1 station tie its own transaction back to this
// request, since it — not the CSMS — issues the transaction id.
func (m *Mux) RemoteStart(ctx context.Context, stationID string, req ocpp16.RemoteStartTransactionRequest, remoteStartID int, idTokenType string) (ocpp16.StatusResponse, error) {
	switch m.Version(stationID) {
	case Version201:
		if req.ChargingProfile != nil {
			// Sending the profile separately would leave the station charging
			// unbounded in between, so this is refused rather than split.
			return ocpp16.StatusResponse{}, fmt.Errorf("a charging profile cannot be attached to a 2.0.1 remote start by this adapter; set the profile as a separate bounded command")
		}
		if idTokenType == "" {
			// 2.0.1 id tokens are typed (ISO14443, eMAID, Central...). Picking a
			// type on the station's behalf could authorize the wrong credential.
			return ocpp16.StatusResponse{}, fmt.Errorf("an idToken type is required to start a transaction on a 2.0.1 station")
		}
		status, err := m.v201.RequestStartTransaction(ctx, stationID, ocpp201.RequestStartTransactionRequest{
			EvseID:        req.ConnectorID,
			RemoteStartID: remoteStartID,
			IDToken:       ocpp201.IDToken{IDToken: req.IdTag, Type: idTokenType},
		})
		return ocpp16.StatusResponse{Status: status.Status}, err
	case Version16:
		return m.v16.RemoteStartTransaction(ctx, stationID, req)
	default:
		return ocpp16.StatusResponse{}, fmt.Errorf("%w: %s", ocpp16.ErrNotConnected, stationID)
	}
}

// RemoteStop stops a transaction. On 2.0.1 the transaction id is the station's
// own opaque string, so the caller has to supply it; the platform's integer
// session id means nothing to the station.
func (m *Mux) RemoteStop(ctx context.Context, stationID string, req ocpp16.RemoteStopTransactionRequest, transactionID201 string) (ocpp16.StatusResponse, error) {
	switch m.Version(stationID) {
	case Version201:
		if strings.TrimSpace(transactionID201) == "" {
			return ocpp16.StatusResponse{}, fmt.Errorf("station %s is on OCPP 2.0.1: its own transactionId is required to stop a transaction", stationID)
		}
		status, err := m.v201.RequestStopTransaction(ctx, stationID, ocpp201.RequestStopTransactionRequest{TransactionID: transactionID201})
		return ocpp16.StatusResponse{Status: status.Status}, err
	case Version16:
		return m.v16.RemoteStopTransaction(ctx, stationID, req)
	default:
		return ocpp16.StatusResponse{}, fmt.Errorf("%w: %s", ocpp16.ErrNotConnected, stationID)
	}
}

// ToProfile201 translates a 1.6 SetChargingProfile into its 2.0.1 equivalent.
//
// The limit values, the window and the stack level carry over unchanged. What
// does not carry over is refused: a 1.6 transactionId is a platform integer,
// whereas a 2.0.1 profile refers to the station's own transaction id string, so
// a transaction-scoped profile cannot be translated without inventing identity.
func ToProfile201(req ocpp16.SetChargingProfileRequest) (ocpp201.SetChargingProfileRequest, error) {
	profile := req.CsChargingProfiles
	if profile.TransactionID != nil {
		return ocpp201.SetChargingProfileRequest{}, fmt.Errorf(
			"transaction-scoped profile %d cannot be translated to OCPP 2.0.1: the station owns transaction ids, so the platform id %d would name nothing",
			profile.ChargingProfileID, *profile.TransactionID)
	}
	if len(profile.ChargingSchedule.ChargingSchedulePeriod) == 0 {
		return ocpp201.SetChargingProfileRequest{}, fmt.Errorf("profile %d has no schedule periods", profile.ChargingProfileID)
	}

	periods := make([]ocpp201.ChargingSchedulePeriod, 0, len(profile.ChargingSchedule.ChargingSchedulePeriod))
	for _, period := range profile.ChargingSchedule.ChargingSchedulePeriod {
		periods = append(periods, ocpp201.ChargingSchedulePeriod{
			StartPeriod:  period.StartPeriod,
			Limit:        period.Limit,
			NumberPhases: period.NumberPhases,
		})
	}

	return ocpp201.SetChargingProfileRequest{
		EvseID: req.ConnectorID,
		ChargingProfile: ocpp201.ChargingProfile{
			ID:                     profile.ChargingProfileID,
			StackLevel:             profile.StackLevel,
			ChargingProfilePurpose: purpose201(profile.ChargingProfilePurpose),
			ChargingProfileKind:    profile.ChargingProfileKind,
			RecurrencyKind:         profile.RecurrencyKind,
			ValidFrom:              profile.ValidFrom,
			ValidTo:                profile.ValidTo,
			ChargingSchedule: []ocpp201.ChargingSchedule{{
				// 2.0.1 schedules are identified; reusing the profile id keeps the
				// pair traceable in station logs.
				ID:                     profile.ChargingProfileID,
				StartSchedule:          profile.ChargingSchedule.StartSchedule,
				Duration:               profile.ChargingSchedule.Duration,
				ChargingRateUnit:       profile.ChargingSchedule.ChargingRateUnit,
				MinChargingRate:        profile.ChargingSchedule.MinChargingRate,
				ChargingSchedulePeriod: periods,
			}},
		},
	}, nil
}

// purpose201 renames the one purpose OCPP 2.0.1 spells differently. An unknown
// purpose is passed through so the station rejects it, rather than being
// silently rewritten into a purpose the caller did not ask for.
func purpose201(purpose string) string {
	if purpose == "ChargePointMaxProfile" {
		return "ChargingStationMaxProfile"
	}
	return purpose
}
