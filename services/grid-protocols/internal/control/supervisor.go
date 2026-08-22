// Package control keeps charge points inside a maintained control window.
//
// The platform sends bounded profiles: each carries validFrom/validTo, which the
// charge point enforces on its own clock. That covers the case where the platform
// disappears. It does not cover two other cases, which this package does:
//
//   - a charge point that reboots or reconnects has dropped the profiles it held,
//     so the standing safe-limit profile is re-asserted on every session open;
//   - a window that closes without a refresh leaves the charge point back on
//     whatever it had before, so the safe-limit profile is asserted again at
//     expiry rather than assumed to still be installed.
//
// Nothing here invents a setpoint: if no fallback profile has been registered for
// a charge point, the supervisor records that it has no safe state to fall back
// to instead of picking a limit of its own.
package control

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/sirupsen/logrus"

	"github.com/vpp/grid-protocols/internal/ocpp16"
)

// Commander is the subset of the central system the supervisor drives.
type Commander interface {
	SetChargingProfile(ctx context.Context, chargePointID string, req ocpp16.SetChargingProfileRequest) (ocpp16.StatusResponse, error)
	ConnectedChargePoints() []string
}

// Options configures the supervisor.
type Options struct {
	// MaxValidity is the longest window a bounded profile may claim. Commands
	// exceeding it are rejected by internal/admin.
	MaxValidity time.Duration
	// SweepInterval is how often expired windows are checked.
	SweepInterval time.Duration
	// CommandTimeout bounds a single fallback command.
	CommandTimeout time.Duration
	Logger         *logrus.Logger
	// Now is injectable for tests.
	Now func() time.Time
}

func (o Options) withDefaults() Options {
	if o.MaxValidity <= 0 {
		o.MaxValidity = time.Hour
	}
	if o.SweepInterval <= 0 {
		o.SweepInterval = 30 * time.Second
	}
	if o.CommandTimeout <= 0 {
		o.CommandTimeout = 30 * time.Second
	}
	if o.Logger == nil {
		o.Logger = logrus.StandardLogger()
	}
	if o.Now == nil {
		o.Now = func() time.Time { return time.Now().UTC() }
	}
	return o
}

type target struct {
	chargePointID string
	connectorID   int
}

// bounded is a profile with a window we are watching.
type bounded struct {
	profileID int
	validFrom time.Time
	validTo   time.Time
	// expired records that the fallback for this window has already run, so a
	// slow sweep does not re-issue it every tick.
	closed bool
}

// FallbackState is the standing safe profile for a target.
type fallback struct {
	request ocpp16.SetChargingProfileRequest
	// lastAsserted is when the charge point last accepted it.
	lastAsserted time.Time
	lastError    string
}

// Supervisor tracks bounded profiles and re-asserts safe fallbacks.
type Supervisor struct {
	commander Commander
	opts      Options

	mu        sync.Mutex
	bounded   map[target]*bounded
	fallbacks map[target]*fallback
}

func New(commander Commander, opts Options) (*Supervisor, error) {
	if commander == nil {
		return nil, errors.New("control: a commander is required")
	}
	return &Supervisor{
		commander: commander,
		opts:      opts.withDefaults(),
		bounded:   make(map[target]*bounded),
		fallbacks: make(map[target]*fallback),
	}, nil
}

// MaxValidity is the configured ceiling, exposed for the admin API's validation.
func (s *Supervisor) MaxValidity() time.Duration { return s.opts.MaxValidity }

// RegisterFallback records the standing safe profile for a target after the
// charge point accepted it. It is re-sent on reconnect and after every expiry.
func (s *Supervisor) RegisterFallback(chargePointID string, req ocpp16.SetChargingProfileRequest) {
	key := target{chargePointID: chargePointID, connectorID: req.ConnectorID}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.fallbacks[key] = &fallback{request: req, lastAsserted: s.opts.Now()}
}

// RegisterBounded records an accepted bounded profile and the window it applies
// for. An unbounded profile is a programming error here: the admin API rejects
// those before they reach a charge point.
func (s *Supervisor) RegisterBounded(chargePointID string, req ocpp16.SetChargingProfileRequest, validFrom, validTo time.Time) error {
	if validTo.IsZero() {
		return errors.New("control: bounded profile has no validTo")
	}
	key := target{chargePointID: chargePointID, connectorID: req.ConnectorID}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bounded[key] = &bounded{
		profileID: req.CsChargingProfiles.ChargingProfileID,
		validFrom: validFrom,
		validTo:   validTo,
	}
	return nil
}

// OnSessionOpen re-asserts the fallback profile for a reconnected charge point.
// Wire it to ocpp16.Options.OnSessionOpen.
func (s *Supervisor) OnSessionOpen(chargePointID string) {
	s.mu.Lock()
	pending := make([]ocpp16.SetChargingProfileRequest, 0, 2)
	keys := make([]target, 0, 2)
	for key, fb := range s.fallbacks {
		if key.chargePointID == chargePointID {
			pending = append(pending, fb.request)
			keys = append(keys, key)
		}
	}
	s.mu.Unlock()

	if len(pending) == 0 {
		s.opts.Logger.WithField("charge_point", chargePointID).
			Warn("no safe fallback profile is registered for this charge point; it will hold whatever local default it has")
		return
	}
	for i, req := range pending {
		s.assert(keys[i], req, "session_open")
	}
}

// Run sweeps expired windows until the context is cancelled.
func (s *Supervisor) Run(ctx context.Context) {
	ticker := time.NewTicker(s.opts.SweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.Sweep()
		}
	}
}

// SweepResult reports one pass, so tests and logs describe the same thing.
type SweepResult struct {
	Expired       int
	FallbackSent  int
	NoFallback    int
	FallbackError int
}

// Sweep asserts the fallback profile for every window that has closed.
func (s *Supervisor) Sweep() SweepResult {
	now := s.opts.Now()
	var result SweepResult

	s.mu.Lock()
	type work struct {
		key      target
		request  ocpp16.SetChargingProfileRequest
		hasFallb bool
		profile  int
	}
	jobs := make([]work, 0, len(s.bounded))
	for key, b := range s.bounded {
		if b.closed || now.Before(b.validTo) {
			continue
		}
		b.closed = true
		job := work{key: key, profile: b.profileID}
		if fb, ok := s.fallbacks[key]; ok {
			job.request = fb.request
			job.hasFallb = true
		}
		jobs = append(jobs, job)
	}
	s.mu.Unlock()

	for _, job := range jobs {
		result.Expired++
		if !job.hasFallb {
			result.NoFallback++
			s.opts.Logger.WithFields(logrus.Fields{
				"charge_point": job.key.chargePointID,
				"connector":    job.key.connectorID,
				"profile_id":   job.profile,
			}).Error("control window closed but no safe fallback profile is registered; the charge point is outside a maintained window")
			continue
		}
		if err := s.assert(job.key, job.request, "window_expired"); err != nil {
			result.FallbackError++
			continue
		}
		result.FallbackSent++
	}
	return result
}

func (s *Supervisor) assert(key target, req ocpp16.SetChargingProfileRequest, reason string) error {
	ctx, cancel := context.WithTimeout(context.Background(), s.opts.CommandTimeout)
	defer cancel()

	status, err := s.commander.SetChargingProfile(ctx, key.chargePointID, req)
	logger := s.opts.Logger.WithFields(logrus.Fields{
		"charge_point": key.chargePointID,
		"connector":    key.connectorID,
		"reason":       reason,
	})
	if err != nil {
		s.recordFallbackError(key, err.Error())
		if errors.Is(err, ocpp16.ErrNotConnected) {
			// Not an error state to hide: the charge point will get the fallback
			// when it reconnects, and until then it is on its own local default.
			logger.Warn("charge point is offline; safe fallback profile will be asserted on reconnect")
		} else {
			logger.WithError(err).Error("failed to assert safe fallback profile")
		}
		return err
	}
	if status.Status != "Accepted" {
		s.recordFallbackError(key, "charge point answered "+status.Status)
		logger.WithField("status", status.Status).Error("charge point refused the safe fallback profile")
		return fmt.Errorf("charge point %s refused the fallback profile: %s", key.chargePointID, status.Status)
	}

	s.mu.Lock()
	if fb, ok := s.fallbacks[key]; ok {
		fb.lastAsserted = s.opts.Now()
		fb.lastError = ""
	}
	s.mu.Unlock()
	logger.Info("safe fallback profile asserted")
	return nil
}

func (s *Supervisor) recordFallbackError(key target, message string) {
	s.mu.Lock()
	if fb, ok := s.fallbacks[key]; ok {
		fb.lastError = message
	}
	s.mu.Unlock()
}

// TargetState is the reportable state of one target.
type TargetState struct {
	ChargePointID      string `json:"charge_point_id"`
	ConnectorID        int    `json:"connector_id"`
	Connected          bool   `json:"connected"`
	HasFallback        bool   `json:"has_fallback"`
	FallbackAssertedAt string `json:"fallback_asserted_at,omitempty"`
	FallbackError      string `json:"fallback_error,omitempty"`
	BoundedProfileID   int    `json:"bounded_profile_id,omitempty"`
	ValidTo            string `json:"valid_to,omitempty"`
	SecondsRemaining   int64  `json:"seconds_remaining,omitempty"`
	// WindowClosed means the bounded window has expired: the charge point is on
	// its fallback, not on an optimizer setpoint.
	WindowClosed bool `json:"window_closed"`
}

// State reports every target the supervisor knows about, for GET
// /admin/control-state. It reports what was actually asserted and what failed;
// it never claims a fallback is in place because one was configured.
func (s *Supervisor) State() []TargetState {
	now := s.opts.Now()
	connected := make(map[string]bool)
	for _, id := range s.commander.ConnectedChargePoints() {
		connected[id] = true
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	keys := make(map[target]struct{})
	for key := range s.bounded {
		keys[key] = struct{}{}
	}
	for key := range s.fallbacks {
		keys[key] = struct{}{}
	}

	states := make([]TargetState, 0, len(keys))
	for key := range keys {
		state := TargetState{
			ChargePointID: key.chargePointID,
			ConnectorID:   key.connectorID,
			Connected:     connected[key.chargePointID],
		}
		if fb, ok := s.fallbacks[key]; ok {
			state.HasFallback = true
			if !fb.lastAsserted.IsZero() {
				state.FallbackAssertedAt = fb.lastAsserted.UTC().Format(time.RFC3339)
			}
			state.FallbackError = fb.lastError
		}
		if b, ok := s.bounded[key]; ok {
			state.BoundedProfileID = b.profileID
			state.ValidTo = b.validTo.UTC().Format(time.RFC3339)
			state.WindowClosed = !now.Before(b.validTo)
			if !state.WindowClosed {
				state.SecondsRemaining = int64(b.validTo.Sub(now).Seconds())
			}
		}
		states = append(states, state)
	}
	return states
}
