// Package conformance executes protocol test vectors against this service's own
// adapters and reports the result to the platform as evidence.
//
// The problem it solves: `der_capabilities.protocols` is a list of strings
// somebody typed, and the platform used to treat "this asset speaks OCPP" as if
// it meant the wire had been shown to work. A conformance run replaces the claim
// with a record — which vector set ran, against what peer, which cases passed,
// who ran it, and a digest of the whole thing.
//
// Two deliberate limits on what a run here can prove:
//
//   - The default peer is a simulator inside this process, which exercises the
//     real adapter (framing, message validation, scaling, status mapping) against
//     a peer that behaves as the specification says. It cannot prove a *device*
//     interoperates; a run records Target so nobody can confuse the two, and a
//     device run is the same vector set pointed at real hardware.
//   - A case that cannot be executed is `Skipped`, and a run containing a skip is
//     not a pass. Half a suite proves half of nothing, and the platform's schema
//     refuses to store it as passing.
package conformance

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"
)

// Adapter identifies the protocol implementation under test. These strings are
// the platform's `conformance_adapter` enum; a value it does not know is
// rejected there rather than stored.
type Adapter string

const (
	AdapterOCPP16        Adapter = "ocpp16"
	AdapterOCPP201       Adapter = "ocpp201"
	AdapterOpenADR2b     Adapter = "openadr2b"
	AdapterIEEE2030_5    Adapter = "ieee2030_5"
	AdapterModbusSunSpec Adapter = "modbus_sunspec"
	AdapterMatter        Adapter = "matter"
)

// Target says what the vector set ran against. There is no third option: a run
// either exercised a simulated peer or a real device.
type Target string

const (
	TargetSimulator Target = "simulator"
	TargetDevice    Target = "device"
)

// Outcome of a single case.
type Outcome string

const (
	Pass Outcome = "pass"
	Fail Outcome = "fail"
	// Skip is for a case that could not be executed at all — an optional feature
	// the peer does not expose, a case needing hardware. It is not a pass, and a
	// run containing one cannot be recorded as passing.
	Skip Outcome = "skipped"
)

// Case is one requirement, executed. `Requirement` cites the clause being
// tested so a failure can be read by somebody who did not write the case.
type Case struct {
	ID          string
	Name        string
	Requirement string
	// Run executes the case. Returning an error fails it; returning
	// ErrCaseNotApplicable skips it.
	Run func(ctx context.Context, env *Env) (evidence any, err error)
}

// ErrCaseNotApplicable marks a case as skipped rather than failed.
var ErrCaseNotApplicable = errors.New("conformance: case is not applicable to this peer")

// CaseResult is a case's outcome plus whatever the case observed. Evidence is
// stored verbatim by the platform, so a later reader can see what the peer
// actually said rather than the runner's summary of it.
type CaseResult struct {
	ID          string  `json:"case_id"`
	Name        string  `json:"name"`
	Requirement string  `json:"requirement"`
	Outcome     Outcome `json:"outcome"`
	Detail      string  `json:"detail,omitempty"`
	Evidence    any     `json:"evidence,omitempty"`
}

// Env is what a suite gives its cases: the peer it set up, plus a place to
// record anything the whole suite established.
type Env struct {
	// Peer is the suite's own handle on the simulated or real peer. Each suite
	// defines its own type; cases in that suite know what to expect.
	Peer any
	// Target the suite actually ran against.
	Target Target
}

// Suite is one adapter's vector set. `Setup` builds the peer; anything it
// returns as an error means the run is refused rather than failed, because a
// suite that could not start has tested nothing.
type Suite struct {
	Adapter Adapter
	// VectorSetID and Version identify the vector set itself, so a later run
	// with more cases is distinguishable from a re-run of the same set.
	VectorSetID      string
	VectorSetVersion string
	// ProtocolVersion is the version of the protocol on the wire ("1.6", "2.0.1").
	ProtocolVersion string
	// DeviceModel describes the peer. For a simulator this names the simulator,
	// because "unknown" in that column would be indistinguishable from a run
	// against unspecified hardware.
	DeviceModel string
	Setup       func(ctx context.Context) (env *Env, teardown func(), err error)
	Cases       []Case
}

// Run is the record of one execution, in the shape the platform ingests. The
// checksum is deliberately absent: the platform computes it from this payload,
// so the digest cannot be a number the runner made up.
type Run struct {
	Adapter          Adapter      `json:"adapter"`
	AdapterVersion   string       `json:"adapter_version"`
	ProtocolVersion  string       `json:"protocol_version"`
	DeviceModel      string       `json:"device_model"`
	DeviceIdentifier string       `json:"device_identifier,omitempty"`
	Target           Target       `json:"target"`
	VectorSetID      string       `json:"vector_set_id"`
	VectorSetVersion string       `json:"vector_set_version"`
	Operator         string       `json:"operator"`
	StartedAt        time.Time    `json:"started_at"`
	CompletedAt      time.Time    `json:"completed_at"`
	Detail           string       `json:"detail,omitempty"`
	RefusedReason    string       `json:"refused_reason,omitempty"`
	Cases            []CaseResult `json:"cases"`
}

// Passed reports whether this run proves the adapter: every case ran and passed.
func (r Run) Passed() bool {
	if r.RefusedReason != "" || len(r.Cases) == 0 {
		return false
	}
	for _, one := range r.Cases {
		if one.Outcome != Pass {
			return false
		}
	}
	return true
}

// Summary is a one-line description for an operator watching a run.
func (r Run) Summary() string {
	passed, failed, skipped := 0, 0, 0
	for _, one := range r.Cases {
		switch one.Outcome {
		case Pass:
			passed++
		case Fail:
			failed++
		case Skip:
			skipped++
		}
	}
	if r.RefusedReason != "" {
		return fmt.Sprintf("%s: refused (%s) after %d/%d cases",
			r.Adapter, r.RefusedReason, passed, len(r.Cases))
	}
	return fmt.Sprintf("%s %s vs %s: %d passed, %d failed, %d skipped",
		r.Adapter, r.ProtocolVersion, r.DeviceModel, passed, failed, skipped)
}

// Options for executing a suite.
type Options struct {
	// Operator is who is accountable for the run. Required: an unattributed
	// conformance record is not evidence anybody can follow up on.
	Operator string
	// AdapterVersion is this service's build identifier, so a pass can be tied
	// to the code that earned it.
	AdapterVersion string
	// DeviceIdentifier names the specific unit for a device run (serial, LFDI).
	DeviceIdentifier string
	// CaseTimeout bounds one case, so a peer that stops answering fails that
	// case instead of hanging the run.
	CaseTimeout time.Duration
}

const defaultCaseTimeout = 20 * time.Second

// Execute runs a suite. It returns a Run for every outcome including refusal:
// "the suite could not start" is a fact worth storing, and a missing row would
// leave the adapter looking untested for a reason nobody recorded.
func Execute(ctx context.Context, suite Suite, opts Options) (Run, error) {
	if opts.Operator == "" {
		return Run{}, errors.New("conformance: an operator is required; an unattributed run is not evidence")
	}
	if opts.AdapterVersion == "" {
		return Run{}, errors.New("conformance: an adapter version is required to tie a pass to the code that earned it")
	}
	if len(suite.Cases) == 0 {
		return Run{}, fmt.Errorf("conformance: suite %s has no cases; an empty vector set cannot prove anything", suite.VectorSetID)
	}

	timeout := opts.CaseTimeout
	if timeout <= 0 {
		timeout = defaultCaseTimeout
	}

	run := Run{
		Adapter:          suite.Adapter,
		AdapterVersion:   opts.AdapterVersion,
		ProtocolVersion:  suite.ProtocolVersion,
		DeviceModel:      suite.DeviceModel,
		DeviceIdentifier: opts.DeviceIdentifier,
		VectorSetID:      suite.VectorSetID,
		VectorSetVersion: suite.VectorSetVersion,
		Operator:         opts.Operator,
		StartedAt:        time.Now().UTC(),
	}

	env, teardown, err := suite.Setup(ctx)
	if err != nil {
		run.Target = TargetSimulator
		run.CompletedAt = time.Now().UTC()
		run.RefusedReason = fmt.Sprintf("suite setup failed: %v", err)
		return run, nil
	}
	if teardown != nil {
		defer teardown()
	}
	run.Target = env.Target

	// Cases run in a stable order so two runs of the same vector set produce the
	// same record for the same behaviour.
	cases := make([]Case, len(suite.Cases))
	copy(cases, suite.Cases)
	sort.SliceStable(cases, func(i, j int) bool { return cases[i].ID < cases[j].ID })

	for _, one := range cases {
		result := CaseResult{
			ID:          one.ID,
			Name:        one.Name,
			Requirement: one.Requirement,
		}

		caseCtx, cancel := context.WithTimeout(ctx, timeout)
		evidence, err := one.Run(caseCtx, env)
		cancel()

		switch {
		case errors.Is(err, ErrCaseNotApplicable):
			result.Outcome = Skip
			result.Detail = err.Error()
		case err != nil:
			result.Outcome = Fail
			result.Detail = err.Error()
			result.Evidence = evidence
		default:
			result.Outcome = Pass
			result.Evidence = evidence
		}
		run.Cases = append(run.Cases, result)
	}

	run.CompletedAt = time.Now().UTC()
	return run, nil
}

// Reporter submits a run to the platform.
type Reporter interface {
	ReportConformanceRun(ctx context.Context, run Run) (RunReceipt, error)
}

// RunReceipt is what the platform stored, including the digest it computed. The
// runner does not choose the checksum: a digest the producer picks proves
// nothing about the thing it digests.
type RunReceipt struct {
	RunID            int    `json:"runId"`
	Outcome          string `json:"outcome"`
	TotalCases       int    `json:"totalCases"`
	PassedCases      int    `json:"passedCases"`
	FailedCases      int    `json:"failedCases"`
	SkippedCases     int    `json:"skippedCases"`
	ArtifactChecksum string `json:"artifactChecksum"`
}

// Suites returns every vector set this build can execute, keyed by adapter.
// Modbus/SunSpec is absent on purpose: that adapter is the Rust poller in
// services/modbus-poller, and it reports its own runs. Claiming to test it from
// here would be testing nothing.
func Suites() map[Adapter]Suite {
	return map[Adapter]Suite{
		AdapterOCPP16:     OCPP16Suite(),
		AdapterOCPP201:    OCPP201Suite(),
		AdapterOpenADR2b:  OpenADRSuite(),
		AdapterIEEE2030_5: SEP2Suite(),
		AdapterMatter:     MatterSuite(),
	}
}
