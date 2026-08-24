package conformance

import (
	"context"
	"errors"
	"testing"
	"time"
)

// Every vector set in this build must pass against its simulator. A failure here
// is either a defect in the adapter or a case that no longer matches the
// adapter's behaviour; both are worth failing CI over, because these runs are
// what the platform stores as proof.
func TestSuitesPassAgainstTheirSimulators(t *testing.T) {
	for adapter, suite := range Suites() {
		adapter, suite := adapter, suite
		t.Run(string(adapter), func(t *testing.T) {
			t.Parallel()
			ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()

			run, err := Execute(ctx, suite, Options{
				Operator:       "go-test",
				AdapterVersion: "test",
				CaseTimeout:    20 * time.Second,
			})
			if err != nil {
				t.Fatalf("executing the %s vector set: %v", adapter, err)
			}
			if run.RefusedReason != "" {
				t.Fatalf("%s refused: %s", adapter, run.RefusedReason)
			}
			if run.Target != TargetSimulator {
				t.Fatalf("%s ran against target %q, expected simulator", adapter, run.Target)
			}
			if len(run.Cases) != len(suite.Cases) {
				t.Fatalf("%s executed %d of %d cases", adapter, len(run.Cases), len(suite.Cases))
			}
			for _, one := range run.Cases {
				if one.Outcome != Pass {
					t.Errorf("%s/%s %s: %s", adapter, one.ID, one.Outcome, one.Detail)
				}
				if one.Requirement == "" {
					t.Errorf("%s/%s cites no requirement, so a failure could not be read by anybody else", adapter, one.ID)
				}
			}
			if !run.Passed() {
				t.Errorf("%s did not pass: %s", adapter, run.Summary())
			}
		})
	}
}

// A suite whose setup fails has tested nothing. It must produce a refusal record
// rather than an error the caller can drop, and a refusal must never read as a
// pass.
func TestSetupFailureIsRefusedNotPassed(t *testing.T) {
	suite := Suite{
		Adapter:          AdapterOCPP16,
		VectorSetID:      "unreachable",
		VectorSetVersion: "1",
		ProtocolVersion:  "1.6",
		DeviceModel:      "peer that is not there",
		Setup: func(context.Context) (*Env, func(), error) {
			return nil, nil, errors.New("dial tcp 127.0.0.1:1: connection refused")
		},
		Cases: []Case{{
			ID:          "x-001",
			Name:        "never runs",
			Requirement: "clause",
			Run: func(context.Context, *Env) (any, error) {
				t.Fatal("a case ran after setup failed")
				return nil, nil
			},
		}},
	}

	run, err := Execute(context.Background(), suite, Options{Operator: "go-test", AdapterVersion: "test"})
	if err != nil {
		t.Fatalf("a refused run should be returned as a record, not an error: %v", err)
	}
	if run.RefusedReason == "" {
		t.Fatal("a suite that could not start was not recorded as refused")
	}
	if run.Passed() {
		t.Fatal("a refused run reported as passed")
	}
	if len(run.Cases) != 0 {
		t.Fatalf("a refused run carries %d case results", len(run.Cases))
	}
}

// A run containing a skip is not a pass: half a vector set proves half of
// nothing, and the platform's schema refuses to store it as passing.
func TestSkippedCaseIsNotAPass(t *testing.T) {
	suite := Suite{
		Adapter:          AdapterMatter,
		VectorSetID:      "partial",
		VectorSetVersion: "1",
		ProtocolVersion:  "1",
		DeviceModel:      "simulator",
		Setup: func(context.Context) (*Env, func(), error) {
			return &Env{Target: TargetSimulator}, nil, nil
		},
		Cases: []Case{
			{ID: "y-001", Name: "ok", Requirement: "clause", Run: func(context.Context, *Env) (any, error) { return nil, nil }},
			{ID: "y-002", Name: "needs hardware", Requirement: "clause", Run: func(context.Context, *Env) (any, error) {
				return nil, ErrCaseNotApplicable
			}},
		},
	}

	run, err := Execute(context.Background(), suite, Options{Operator: "go-test", AdapterVersion: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if run.Cases[1].Outcome != Skip {
		t.Fatalf("case outcome is %q, expected skipped", run.Cases[1].Outcome)
	}
	if run.Passed() {
		t.Fatal("a run with a skipped case reported as passed")
	}
}

// Cases run in ID order regardless of how the suite listed them, so two runs of
// the same vector set produce the same record for the same behaviour.
func TestCasesRunInStableOrder(t *testing.T) {
	suite := Suite{
		Adapter:          AdapterOCPP201,
		VectorSetID:      "ordering",
		VectorSetVersion: "1",
		ProtocolVersion:  "2.0.1",
		DeviceModel:      "simulator",
		Setup: func(context.Context) (*Env, func(), error) {
			return &Env{Target: TargetSimulator}, nil, nil
		},
		Cases: []Case{
			{ID: "z-003", Name: "third", Requirement: "clause", Run: func(context.Context, *Env) (any, error) { return nil, nil }},
			{ID: "z-001", Name: "first", Requirement: "clause", Run: func(context.Context, *Env) (any, error) { return nil, nil }},
			{ID: "z-002", Name: "second", Requirement: "clause", Run: func(context.Context, *Env) (any, error) { return nil, nil }},
		},
	}

	run, err := Execute(context.Background(), suite, Options{Operator: "go-test", AdapterVersion: "test"})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"z-001", "z-002", "z-003"}
	for i, id := range want {
		if run.Cases[i].ID != id {
			t.Fatalf("case %d is %s, expected %s", i, run.Cases[i].ID, id)
		}
	}
}

// An unattributed or unversioned run is not evidence, so Execute refuses it
// rather than storing a record nobody can follow up on.
func TestRunRequiresOperatorAndAdapterVersion(t *testing.T) {
	suite := Suites()[AdapterOCPP16]
	if _, err := Execute(context.Background(), suite, Options{AdapterVersion: "test"}); err == nil {
		t.Fatal("a run with no operator was accepted")
	}
	if _, err := Execute(context.Background(), suite, Options{Operator: "go-test"}); err == nil {
		t.Fatal("a run with no adapter version was accepted")
	}
}

// A case that hangs must fail that case rather than hang the run: a peer that
// stops answering is a failure, and a run that never completes records nothing.
func TestHangingCaseFailsOnTimeout(t *testing.T) {
	suite := Suite{
		Adapter:          AdapterOpenADR2b,
		VectorSetID:      "hanging",
		VectorSetVersion: "1",
		ProtocolVersion:  "2.0b",
		DeviceModel:      "simulator",
		Setup: func(context.Context) (*Env, func(), error) {
			return &Env{Target: TargetSimulator}, nil, nil
		},
		Cases: []Case{{
			ID: "h-001", Name: "peer stops answering", Requirement: "clause",
			Run: func(ctx context.Context, _ *Env) (any, error) {
				<-ctx.Done()
				return nil, ctx.Err()
			},
		}},
	}

	run, err := Execute(context.Background(), suite, Options{
		Operator: "go-test", AdapterVersion: "test", CaseTimeout: 50 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	if run.Cases[0].Outcome != Fail {
		t.Fatalf("a timed-out case is %q, expected fail", run.Cases[0].Outcome)
	}
}
