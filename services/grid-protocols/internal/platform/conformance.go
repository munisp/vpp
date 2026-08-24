package platform

import (
	"context"
	"errors"
	"time"

	"github.com/vpp/grid-protocols/internal/conformance"
)

// conformanceRunPayload is the wire form the platform's
// /api/grid/conformance/run endpoint accepts. The checksum is deliberately not
// sent: the platform computes it from the cases it stored, so the digest cannot
// be a value the runner asserted.
type conformanceRunPayload struct {
	Adapter          string                   `json:"adapter"`
	AdapterVersion   string                   `json:"adapter_version"`
	ProtocolVersion  string                   `json:"protocol_version"`
	DeviceModel      string                   `json:"device_model"`
	DeviceIdentifier string                   `json:"device_identifier,omitempty"`
	Target           string                   `json:"target"`
	VectorSetID      string                   `json:"vector_set_id"`
	VectorSetVersion string                   `json:"vector_set_version"`
	Operator         string                   `json:"operator"`
	StartedAt        string                   `json:"started_at"`
	CompletedAt      string                   `json:"completed_at"`
	Detail           string                   `json:"detail,omitempty"`
	RefusedReason    string                   `json:"refused_reason,omitempty"`
	Cases            []conformanceCasePayload `json:"cases"`
}

type conformanceCasePayload struct {
	CaseID      string `json:"case_id"`
	Name        string `json:"name"`
	Requirement string `json:"requirement"`
	Outcome     string `json:"outcome"`
	Detail      string `json:"detail,omitempty"`
	Evidence    any    `json:"evidence,omitempty"`
}

// ReportConformanceRun submits a run and returns what the platform stored. The
// receipt's outcome is the platform's verdict, not the runner's: a run this
// service considers a pass is only a pass once the platform's constraints
// accepted it as complete.
func (c *Client) ReportConformanceRun(
	ctx context.Context,
	run conformance.Run,
) (conformance.RunReceipt, error) {
	if run.Operator == "" {
		return conformance.RunReceipt{}, errors.New("platform: a conformance run needs an operator")
	}

	payload := conformanceRunPayload{
		Adapter:          string(run.Adapter),
		AdapterVersion:   run.AdapterVersion,
		ProtocolVersion:  run.ProtocolVersion,
		DeviceModel:      run.DeviceModel,
		DeviceIdentifier: run.DeviceIdentifier,
		Target:           string(run.Target),
		VectorSetID:      run.VectorSetID,
		VectorSetVersion: run.VectorSetVersion,
		Operator:         run.Operator,
		StartedAt:        run.StartedAt.UTC().Format(time.RFC3339),
		CompletedAt:      run.CompletedAt.UTC().Format(time.RFC3339),
		Detail:           run.Detail,
		RefusedReason:    run.RefusedReason,
		Cases:            make([]conformanceCasePayload, 0, len(run.Cases)),
	}
	for _, one := range run.Cases {
		payload.Cases = append(payload.Cases, conformanceCasePayload{
			CaseID:      one.ID,
			Name:        one.Name,
			Requirement: one.Requirement,
			Outcome:     string(one.Outcome),
			Detail:      one.Detail,
			Evidence:    one.Evidence,
		})
	}

	var receipt conformance.RunReceipt
	if err := c.post(ctx, "/api/grid/conformance/run", payload, &receipt); err != nil {
		return conformance.RunReceipt{}, err
	}
	if receipt.RunID == 0 {
		return conformance.RunReceipt{}, errors.New("platform: the conformance run was accepted without a run id, so nothing can cite it as evidence")
	}
	return receipt, nil
}
