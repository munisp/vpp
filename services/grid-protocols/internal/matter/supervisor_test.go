package matter

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type stubLoads struct {
	mu       sync.Mutex
	applied  []LoadCommand
	fail     map[string]error
	failOnce map[string]error
	// enforcement decides what each action reports back.
	enforcement map[string]WindowEnforcement
}

func newStubLoads() *stubLoads {
	return &stubLoads{
		fail:        map[string]error{},
		failOnce:    map[string]error{},
		enforcement: map[string]WindowEnforcement{},
	}
}

func (s *stubLoads) ApplyLoad(_ context.Context, cmd LoadCommand) (LoadResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.applied = append(s.applied, cmd)
	if err, ok := s.failOnce[cmd.Action]; ok {
		delete(s.failOnce, cmd.Action)
		return LoadResult{}, err
	}
	if err, ok := s.fail[cmd.Action]; ok {
		return LoadResult{}, err
	}
	enforcement := s.enforcement[cmd.Action]
	if enforcement == "" {
		enforcement = EnforcementPlatform
	}
	return LoadResult{
		NodeID: cmd.NodeID, Endpoint: cmd.Endpoint, Action: cmd.Action,
		Enforcement: enforcement, Acknowledged: true, AcknowledgedAt: time.Now().UTC(),
	}, nil
}

func (s *stubLoads) commands() []LoadCommand {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]LoadCommand, len(s.applied))
	copy(out, s.applied)
	return out
}

func newTestSupervisor(t *testing.T, loads Loads) *Supervisor {
	t.Helper()
	supervisor, err := NewSupervisor(loads, SupervisorOptions{
		MaxValidity:    time.Hour,
		SweepInterval:  10 * time.Millisecond,
		CommandTimeout: time.Second,
		Logger:         quietLogger(),
	})
	if err != nil {
		t.Fatalf("NewSupervisor: %v", err)
	}
	return supervisor
}

func TestSupervisorRefusesUnboundedAndOverlongWindows(t *testing.T) {
	loads := newStubLoads()
	supervisor := newTestSupervisor(t, loads)
	fallback := &LoadCommand{NodeID: 4, Endpoint: 1, Action: ActionTurnOn}

	if _, err := supervisor.Apply(context.Background(), LoadCommand{
		NodeID: 4, Endpoint: 1, Action: ActionTurnOff,
	}, fallback); err == nil {
		t.Fatal("expected a load control with no window to be refused")
	}
	if _, err := supervisor.Apply(context.Background(), LoadCommand{
		NodeID: 4, Endpoint: 1, Action: ActionTurnOff, Window: 2 * time.Hour,
	}, fallback); err == nil {
		t.Fatal("expected a window beyond the configured maximum to be refused")
	}
	if len(loads.commands()) != 0 {
		t.Fatal("a refused control must never reach the device")
	}
}

func TestAPlatformEnforcedControlWithoutAFallbackIsRestoredAndRefused(t *testing.T) {
	loads := newStubLoads()
	supervisor := newTestSupervisor(t, loads)

	_, err := supervisor.Apply(context.Background(), LoadCommand{
		NodeID: 4, Endpoint: 1, Action: ActionTurnOff, Window: time.Minute,
	}, nil)
	if err == nil {
		t.Fatal("expected a control with no device expiry and no fallback to be refused")
	}
	commands := loads.commands()
	if len(commands) != 2 || commands[1].Action != ActionTurnOn {
		t.Fatalf("expected the load to be turned back on rather than left trimmed, got %+v", commands)
	}
	if len(supervisor.State()) != 0 {
		t.Fatal("a refused control must not be tracked as holding")
	}
}

func TestADeviceEnforcedControlNeedsNoFallback(t *testing.T) {
	loads := newStubLoads()
	loads.enforcement[ActionAdjustPower] = EnforcementDevice
	supervisor := newTestSupervisor(t, loads)

	watts := 1_200.0
	result, err := supervisor.Apply(context.Background(), LoadCommand{
		NodeID: 4, Endpoint: 1, Action: ActionAdjustPower, PowerAdjustW: &watts, Window: time.Millisecond,
	}, nil)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if result.Enforcement != EnforcementDevice {
		t.Fatalf("unexpected enforcement %q", result.Enforcement)
	}

	time.Sleep(20 * time.Millisecond)
	supervisor.Sweep(context.Background())
	if commands := loads.commands(); len(commands) != 1 {
		t.Fatalf("a device-enforced adjustment ends at the node; the platform must not command it again: %+v", commands)
	}
	state := supervisor.State()
	if len(state) != 1 || state[0].Fallback != nil {
		t.Fatalf("expected a tracked target with no platform fallback, got %+v", state)
	}
}

func TestAClosedWindowRestoresTheLoad(t *testing.T) {
	loads := newStubLoads()
	supervisor := newTestSupervisor(t, loads)
	level := 30
	full := 100

	if _, err := supervisor.Apply(context.Background(), LoadCommand{
		NodeID: 4, Endpoint: 1, Action: ActionSetLevel, LevelPercent: &level, Window: 20 * time.Millisecond,
	}, &LoadCommand{NodeID: 4, Endpoint: 1, Action: ActionSetLevel, LevelPercent: &full}); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	// Before the window closes nothing is restored.
	supervisor.Sweep(context.Background())
	if len(loads.commands()) != 1 {
		t.Fatal("a control inside its window must not be restored")
	}

	time.Sleep(30 * time.Millisecond)
	supervisor.Sweep(context.Background())
	commands := loads.commands()
	if len(commands) != 2 || commands[1].LevelPercent == nil || *commands[1].LevelPercent != 100 {
		t.Fatalf("expected the declared fallback to be issued, got %+v", commands)
	}

	// A restored target is not restored twice.
	supervisor.Sweep(context.Background())
	if len(loads.commands()) != 2 {
		t.Fatal("a restored target must not be commanded again on every sweep")
	}
	state := supervisor.State()
	if len(state) != 1 || state[0].Restored == nil {
		t.Fatalf("expected the target to record its restoration, got %+v", state)
	}
}

func TestAFailedRestoreIsVisibleAndRetried(t *testing.T) {
	loads := newStubLoads()
	loads.failOnce[ActionTurnOn] = errors.New("node unreachable")
	supervisor := newTestSupervisor(t, loads)

	if _, err := supervisor.Apply(context.Background(), LoadCommand{
		NodeID: 4, Endpoint: 1, Action: ActionTurnOff, Window: 10 * time.Millisecond,
	}, &LoadCommand{NodeID: 4, Endpoint: 1, Action: ActionTurnOn}); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	time.Sleep(20 * time.Millisecond)
	supervisor.Sweep(context.Background())
	state := supervisor.State()
	if len(state) != 1 || state[0].Restored != nil || state[0].RestoreError == "" {
		t.Fatalf("a load still holding a closed window must say so, got %+v", state)
	}

	supervisor.Sweep(context.Background())
	state = supervisor.State()
	if state[0].Restored == nil || state[0].RestoreError != "" {
		t.Fatalf("expected the retry to restore the load, got %+v", state)
	}
}

func TestAControlTheDeviceRefusedIsNotTracked(t *testing.T) {
	loads := newStubLoads()
	loads.fail[ActionTurnOff] = errors.New("node refused")
	supervisor := newTestSupervisor(t, loads)

	if _, err := supervisor.Apply(context.Background(), LoadCommand{
		NodeID: 4, Endpoint: 1, Action: ActionTurnOff, Window: time.Minute,
	}, &LoadCommand{NodeID: 4, Endpoint: 1, Action: ActionTurnOn}); err == nil {
		t.Fatal("expected the device's refusal to surface")
	}
	if len(supervisor.State()) != 0 {
		t.Fatal("a control the device refused must not be tracked as in force")
	}
}

func TestNewSupervisorRefusesUnusableOptions(t *testing.T) {
	loads := newStubLoads()
	if _, err := NewSupervisor(nil, SupervisorOptions{MaxValidity: time.Hour, SweepInterval: time.Second}); err == nil {
		t.Fatal("expected a missing load controller to be refused")
	}
	if _, err := NewSupervisor(loads, SupervisorOptions{SweepInterval: time.Second}); err == nil {
		t.Fatal("expected a missing max validity to be refused")
	}
	if _, err := NewSupervisor(loads, SupervisorOptions{MaxValidity: time.Second, SweepInterval: time.Minute}); err == nil {
		t.Fatal("expected a sweep slower than the window to be refused: windows would close unnoticed")
	}
}
