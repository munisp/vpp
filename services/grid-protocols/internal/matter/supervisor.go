package matter

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

// Loads is the load-control surface the supervisor drives. It exists so the
// supervisor can be tested against a controller stub.
type Loads interface {
	ApplyLoad(ctx context.Context, cmd LoadCommand) (LoadResult, error)
}

// SupervisorOptions bounds every Matter load control.
type SupervisorOptions struct {
	// MaxValidity is the longest window a load control may hold.
	MaxValidity time.Duration
	// SweepInterval is how often expired windows are restored.
	SweepInterval time.Duration
	// CommandTimeout bounds one restore command.
	CommandTimeout time.Duration
	Logger         *logrus.Logger
}

// TargetState is what the supervisor believes about one endpoint. It is
// deliberately explicit about restoration: a window whose restore command failed
// is reported as still holding, because the load really is still trimmed.
type TargetState struct {
	NodeID      int64             `json:"node_id"`
	Endpoint    uint16            `json:"endpoint_id"`
	Action      string            `json:"action"`
	Enforcement WindowEnforcement `json:"window_enforcement"`
	ValidFrom   time.Time         `json:"valid_from"`
	ValidTo     time.Time         `json:"valid_to"`
	// Fallback is the control that will be issued when the window closes. It is
	// absent for device-enforced windows, which the node ends itself.
	Fallback *LoadCommand `json:"fallback,omitempty"`
	// Restored is set once the fallback was acknowledged by the controller.
	Restored *time.Time `json:"restored_at,omitempty"`
	// RestoreError is the last failure to restore, kept so an operator sees that
	// the load is holding a closed window rather than seeing nothing.
	RestoreError string `json:"restore_error,omitempty"`
}

// Supervisor holds Matter load controls to their windows. On/Off and Level
// Control carry no expiry, so without this a trimmed water heater would stay
// trimmed forever after the platform stopped talking; a Device Energy Management
// adjustment carries its own duration and is tracked but never restored here.
type Supervisor struct {
	loads   Loads
	options SupervisorOptions
	logger  *logrus.Logger

	mu      sync.Mutex
	targets map[string]*TargetState
}

func NewSupervisor(loads Loads, options SupervisorOptions) (*Supervisor, error) {
	if loads == nil {
		return nil, errors.New("matter: a load controller is required")
	}
	if options.MaxValidity <= 0 {
		return nil, errors.New("matter: max validity is required; an unbounded load control cannot be restored")
	}
	if options.SweepInterval <= 0 {
		return nil, errors.New("matter: sweep interval is required")
	}
	if options.SweepInterval >= options.MaxValidity {
		return nil, fmt.Errorf("matter: sweep interval %s must be shorter than max validity %s",
			options.SweepInterval, options.MaxValidity)
	}
	if options.CommandTimeout <= 0 {
		options.CommandTimeout = 30 * time.Second
	}
	if options.Logger == nil {
		options.Logger = logrus.New()
	}
	return &Supervisor{loads: loads, options: options, logger: options.Logger, targets: map[string]*TargetState{}}, nil
}

func (s *Supervisor) MaxValidity() time.Duration { return s.options.MaxValidity }

func targetKey(nodeID int64, endpoint uint16) string {
	return fmt.Sprintf("%d/%d", nodeID, endpoint)
}

// Apply issues a bounded load control and tracks its window. fallback is the
// control to issue when the window closes and is required for anything the
// device will not end on its own; a caller that cannot say how the load should
// be left is refused rather than allowed to strand it.
func (s *Supervisor) Apply(ctx context.Context, cmd LoadCommand, fallback *LoadCommand) (LoadResult, error) {
	if cmd.Window <= 0 {
		return LoadResult{}, errors.New("matter: a load control requires a window")
	}
	if cmd.Window > s.options.MaxValidity {
		return LoadResult{}, fmt.Errorf("matter: window %s exceeds the configured maximum %s", cmd.Window, s.options.MaxValidity)
	}

	result, err := s.loads.ApplyLoad(ctx, cmd)
	if err != nil {
		return LoadResult{}, err
	}
	if result.Enforcement == EnforcementPlatform && fallback == nil {
		// The load is already trimmed at this point, so it is restored
		// immediately rather than left holding a window nothing will close.
		restore := restoreOf(cmd)
		if _, restoreErr := s.loads.ApplyLoad(ctx, restore); restoreErr != nil {
			return LoadResult{}, fmt.Errorf(
				"matter: a %s control needs a fallback and restoring the load failed: %w", cmd.Action, restoreErr)
		}
		return LoadResult{}, fmt.Errorf(
			"matter: a %s control has no device-side expiry, so a fallback control is required; the load was restored",
			cmd.Action)
	}

	now := time.Now().UTC()
	state := &TargetState{
		NodeID:      cmd.NodeID,
		Endpoint:    result.Endpoint,
		Action:      cmd.Action,
		Enforcement: result.Enforcement,
		ValidFrom:   now,
		ValidTo:     now.Add(cmd.Window),
	}
	if result.Enforcement == EnforcementPlatform {
		state.Fallback = fallback
	}
	s.mu.Lock()
	s.targets[targetKey(cmd.NodeID, result.Endpoint)] = state
	s.mu.Unlock()
	return result, nil
}

// restoreOf is the safest reversal of a control whose caller gave no fallback:
// a trimmed load is turned back on and a dimmed load returned to full.
func restoreOf(cmd LoadCommand) LoadCommand {
	switch cmd.Action {
	case ActionSetLevel:
		full := 100
		return LoadCommand{NodeID: cmd.NodeID, Endpoint: cmd.Endpoint, Action: ActionSetLevel, LevelPercent: &full}
	default:
		return LoadCommand{NodeID: cmd.NodeID, Endpoint: cmd.Endpoint, Action: ActionTurnOn}
	}
}

// State reports every tracked target.
func (s *Supervisor) State() []TargetState {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]TargetState, 0, len(s.targets))
	for _, state := range s.targets {
		out = append(out, *state)
	}
	return out
}

// Run sweeps closed windows until the context ends.
func (s *Supervisor) Run(ctx context.Context) {
	ticker := time.NewTicker(s.options.SweepInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.Sweep(ctx)
		}
	}
}

// Sweep restores every platform-enforced control whose window has closed. A
// restore that fails is retried on the next sweep and recorded on the target, so
// an operator can see a load still holding a closed window.
func (s *Supervisor) Sweep(ctx context.Context) {
	now := time.Now().UTC()

	type due struct {
		key      string
		fallback LoadCommand
	}
	var pending []due

	s.mu.Lock()
	for key, state := range s.targets {
		if state.Enforcement != EnforcementPlatform || state.Fallback == nil {
			continue
		}
		if state.Restored != nil || now.Before(state.ValidTo) {
			continue
		}
		pending = append(pending, due{key: key, fallback: *state.Fallback})
	}
	s.mu.Unlock()

	for _, item := range pending {
		commandCtx, cancel := context.WithTimeout(ctx, s.options.CommandTimeout)
		_, err := s.loads.ApplyLoad(commandCtx, item.fallback)
		cancel()

		s.mu.Lock()
		state, ok := s.targets[item.key]
		if ok {
			if err != nil {
				state.RestoreError = err.Error()
			} else {
				restoredAt := time.Now().UTC()
				state.Restored = &restoredAt
				state.RestoreError = ""
			}
		}
		s.mu.Unlock()

		if err != nil {
			s.logger.WithError(err).WithFields(logrus.Fields{
				"node_id":     item.fallback.NodeID,
				"endpoint_id": item.fallback.Endpoint,
			}).Error("restoring a Matter load after its control window closed failed; the load is still holding the control")
		}
	}
}
