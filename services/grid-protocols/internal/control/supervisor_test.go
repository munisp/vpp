package control

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/sirupsen/logrus"

	"github.com/vpp/grid-protocols/internal/ocpp16"
)

type recorder struct {
	mu        sync.Mutex
	calls     []ocpp16.SetChargingProfileRequest
	status    string
	err       error
	connected []string
}

func (r *recorder) SetChargingProfile(_ context.Context, _ string, req ocpp16.SetChargingProfileRequest) (ocpp16.StatusResponse, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, req)
	if r.err != nil {
		return ocpp16.StatusResponse{}, r.err
	}
	status := r.status
	if status == "" {
		status = "Accepted"
	}
	return ocpp16.StatusResponse{Status: status}, nil
}

func (r *recorder) ConnectedChargePoints() []string { return r.connected }

func (r *recorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.calls)
}

func quietLogger() *logrus.Logger {
	logger := logrus.New()
	logger.SetLevel(logrus.PanicLevel)
	return logger
}

func fallbackProfile(limit int) ocpp16.SetChargingProfileRequest {
	return ocpp16.SetChargingProfileRequest{
		ConnectorID: 1,
		CsChargingProfiles: ocpp16.ChargingProfile{
			ChargingProfileID:      1,
			StackLevel:             0,
			ChargingProfilePurpose: "TxDefaultProfile",
			ChargingProfileKind:    "Relative",
			ChargingSchedule: ocpp16.ChargingSchedule{
				ChargingRateUnit:       "W",
				ChargingSchedulePeriod: []ocpp16.ChargingSchedulePeriod{{StartPeriod: 0, Limit: float64(limit)}},
			},
		},
	}
}

func boundedProfile() ocpp16.SetChargingProfileRequest {
	req := fallbackProfile(7000)
	req.CsChargingProfiles.ChargingProfileID = 42
	req.CsChargingProfiles.StackLevel = 1
	return req
}

func newSupervisor(t *testing.T, commander Commander, now func() time.Time) *Supervisor {
	t.Helper()
	s, err := New(commander, Options{Logger: quietLogger(), Now: now})
	if err != nil {
		t.Fatalf("new supervisor: %v", err)
	}
	return s
}

func TestExpiredWindowAssertsTheFallback(t *testing.T) {
	commander := &recorder{}
	base := time.Now().UTC()
	clock := base
	s := newSupervisor(t, commander, func() time.Time { return clock })

	s.RegisterFallback("CP-1", fallbackProfile(3600))
	if err := s.RegisterBounded("CP-1", boundedProfile(), base, base.Add(10*time.Minute)); err != nil {
		t.Fatalf("register bounded: %v", err)
	}

	if result := s.Sweep(); result.Expired != 0 {
		t.Fatalf("an open window must not trigger a fallback: %+v", result)
	}

	clock = base.Add(11 * time.Minute)
	result := s.Sweep()
	if result.Expired != 1 || result.FallbackSent != 1 {
		t.Fatalf("expected one expiry with the fallback sent, got %+v", result)
	}
	if commander.count() != 1 {
		t.Fatalf("expected exactly one fallback command, got %d", commander.count())
	}

	// A second sweep must not re-issue the same fallback.
	if result := s.Sweep(); result.Expired != 0 || commander.count() != 1 {
		t.Fatalf("fallback was applied twice: %+v, %d calls", result, commander.count())
	}
}

// The dangerous case: a window closes and there is no registered safe state. The
// supervisor must report that, not pick a limit of its own.
func TestExpiryWithoutRegisteredFallbackIsReported(t *testing.T) {
	commander := &recorder{}
	base := time.Now().UTC()
	clock := base
	s := newSupervisor(t, commander, func() time.Time { return clock })

	if err := s.RegisterBounded("CP-2", boundedProfile(), base, base.Add(time.Minute)); err != nil {
		t.Fatalf("register bounded: %v", err)
	}
	clock = base.Add(2 * time.Minute)

	result := s.Sweep()
	if result.Expired != 1 || result.NoFallback != 1 || result.FallbackSent != 0 {
		t.Fatalf("expected the missing fallback to be reported, got %+v", result)
	}
	if commander.count() != 0 {
		t.Fatalf("supervisor invented a setpoint: %d commands sent", commander.count())
	}
}

func TestRefusedFallbackIsNotCountedAsApplied(t *testing.T) {
	commander := &recorder{status: "Rejected"}
	base := time.Now().UTC()
	clock := base.Add(2 * time.Hour)
	s := newSupervisor(t, commander, func() time.Time { return clock })

	s.RegisterFallback("CP-3", fallbackProfile(3600))
	if err := s.RegisterBounded("CP-3", boundedProfile(), base, base.Add(time.Minute)); err != nil {
		t.Fatalf("register bounded: %v", err)
	}

	result := s.Sweep()
	if result.FallbackSent != 0 || result.FallbackError != 1 {
		t.Fatalf("a refused fallback must be an error, got %+v", result)
	}
	states := s.State()
	if len(states) != 1 || states[0].FallbackError == "" {
		t.Fatalf("refusal must be visible in the reported state: %+v", states)
	}
}

func TestOfflineFallbackIsRecordedAndRetriedOnReconnect(t *testing.T) {
	commander := &recorder{err: ocpp16.ErrNotConnected}
	base := time.Now().UTC()
	s := newSupervisor(t, commander, func() time.Time { return base })

	s.RegisterFallback("CP-4", fallbackProfile(3600))
	if err := s.RegisterBounded("CP-4", boundedProfile(), base.Add(-2*time.Hour), base.Add(-time.Hour)); err != nil {
		t.Fatalf("register bounded: %v", err)
	}

	if result := s.Sweep(); result.FallbackError != 1 {
		t.Fatalf("an offline charge point must not count as fallback applied: %+v", result)
	}
	states := s.State()
	if len(states) != 1 || states[0].FallbackError == "" || states[0].Connected {
		t.Fatalf("offline state must be reported: %+v", states)
	}

	// On reconnect the fallback is asserted again, and now it lands.
	commander.err = nil
	s.OnSessionOpen("CP-4")
	if commander.count() != 2 {
		t.Fatalf("expected the fallback to be re-asserted on reconnect, got %d calls", commander.count())
	}
	if states := s.State(); states[0].FallbackError != "" {
		t.Fatalf("a successful re-assertion must clear the error: %+v", states)
	}
}

func TestUnboundedRegistrationIsRejected(t *testing.T) {
	s := newSupervisor(t, &recorder{}, nil)
	if err := s.RegisterBounded("CP-5", boundedProfile(), time.Now(), time.Time{}); err == nil {
		t.Fatal("a profile with no validTo must not be tracked as bounded")
	}
}

func TestStateReportsRemainingWindow(t *testing.T) {
	base := time.Now().UTC()
	commander := &recorder{connected: []string{"CP-6"}}
	s := newSupervisor(t, commander, func() time.Time { return base })

	s.RegisterFallback("CP-6", fallbackProfile(3600))
	if err := s.RegisterBounded("CP-6", boundedProfile(), base, base.Add(15*time.Minute)); err != nil {
		t.Fatalf("register bounded: %v", err)
	}
	states := s.State()
	if len(states) != 1 {
		t.Fatalf("expected one target, got %d", len(states))
	}
	state := states[0]
	if !state.Connected || state.WindowClosed || state.SecondsRemaining < 890 || state.SecondsRemaining > 900 {
		t.Fatalf("unexpected state: %+v", state)
	}
	if state.BoundedProfileID != 42 || !state.HasFallback {
		t.Fatalf("state must identify the bounded profile and the fallback: %+v", state)
	}
}

func TestRunStopsWithContext(t *testing.T) {
	s, err := New(&recorder{}, Options{Logger: quietLogger(), SweepInterval: 10 * time.Millisecond})
	if err != nil {
		t.Fatalf("new: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		s.Run(ctx)
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not stop when its context was cancelled")
	}
}
