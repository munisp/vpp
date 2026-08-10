package workflows

import (
"go.temporal.io/sdk/worker"
"github.com/vpp-platform/orchestrator/services"
)

// RegisterWorkflows registers all workflows with the worker
func RegisterWorkflows(w worker.Worker) {
// Onboarding workflows
w.RegisterWorkflow(UserOnboardingWorkflow)
w.RegisterWorkflow(PaymentSetupWorkflow)
w.RegisterWorkflow(ContractSigningWorkflow)

// Trading workflows
w.RegisterWorkflow(AutoTradingWorkflow)
w.RegisterWorkflow(ManualTradingWorkflow)
w.RegisterWorkflow(P2PTradingWorkflow)

// DR workflows
w.RegisterWorkflow(DREventParticipationWorkflow)
w.RegisterWorkflow(DRForecastingWorkflow)

// Payment workflows
w.RegisterWorkflow(PaymentProcessingWorkflow)
w.RegisterWorkflow(QRPaymentWorkflow)

// Monitoring workflows
w.RegisterWorkflow(TelemetryMonitoringWorkflow)
w.RegisterWorkflow(AlertManagementWorkflow)

// Gamification workflows
w.RegisterWorkflow(LeaderboardUpdateWorkflow)
w.RegisterWorkflow(AchievementTrackingWorkflow)
}

// RegisterActivities registers all activities with the worker
func RegisterActivities(w worker.Worker, svc *services.Services) {
// Activities will be registered here
}
