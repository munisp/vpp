package workflows

import (
	"go.temporal.io/sdk/worker"

	"github.com/vpp-platform/orchestrator/activities"
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

// RegisterActivities registers every implemented, honest activity with the
// worker. Nothing that fabricates data is registered: every activity below
// either performs real work (Dapr state, Redis, Kafka, PostgreSQL per
// drizzle/schema.ts, or a configured payment gateway) or fails loudly with an
// explicit error.
//
// Deliberately NOT registered — these activity names are referenced by
// workflows but were never implemented in this module. Their workflows will
// fail fast with an explicit "activity type is not registered" error rather
// than silently producing fabricated results:
//
//   - Onboarding: CreateUserActivity, SendWelcomeEmailActivity,
//     InitializeWalletActivity, ValidatePaymentCredentialsActivity,
//     StorePaymentCredentialsActivity, TestPaymentTransactionActivity,
//     GenerateContractActivity, VerifyBiometricSignatureActivity,
//     ActivateContractActivity
//   - P2P trading: VerifyEnergyAvailableActivity, CreateP2PTradeActivity,
//     CancelP2PTradeActivity, TransferEnergyCreditsActivity,
//     UpdateAchievementsActivity
//   - QR payments / refunds: ParseQRCodeActivity, VerifyMerchantActivity,
//     ProcessQRPaymentActivity, InitiateRefundActivity
//   - DR forecasting: QueryLakehouseDataActivity, RunForecastingModelActivity,
//     IdentifyPeakPeriodsActivity, CreateDREventActivity,
//     NotifyEligibleUsersActivity, StoreForecastResultsActivity
//   - Alerts: GetAlertDetailsActivity, GetAffectedUsersActivity,
//     LogAlertToLakehouseActivity
func RegisterActivities(w worker.Worker, svc *services.Services) {
	act := activities.NewActivities(svc.Kafka, svc.Redis, svc.Dapr, svc.DB)

	// Onboarding activities
	w.RegisterActivity(act.CreateUserProfileActivity)
	w.RegisterActivity(act.RegisterAssetActivity)
	w.RegisterActivity(act.SetupPaymentMethodActivity)

	// Trading activities (real data only: Dapr state, Redis cache, PostgreSQL
	// order book / marketPrices / telemetry)
	w.RegisterActivity(act.GetAutoTradingRulesActivity)
	w.RegisterActivity(act.GetActiveStrategiesActivity)
	w.RegisterActivity(act.EvaluateStrategyConditionsActivity)
	w.RegisterActivity(act.UpdateStrategyPerformanceActivity)
	w.RegisterActivity(act.GetEnergySurplusActivity)
	w.RegisterActivity(act.GetMarketPriceActivity)
	w.RegisterActivity(act.GetBatteryStateOfChargeActivity)
	w.RegisterActivity(act.CreateSellOrderActivity)
	w.RegisterActivity(act.CreateBuyOrderActivity)
	w.RegisterActivity(act.CancelOrderActivity)
	w.RegisterActivity(act.FindBestOfferActivity)

	// Ledger-backed activities: registered so callers fail loudly with an
	// explicit "ledger integration not configured" error instead of
	// fabricating money movement (see services/services.go).
	w.RegisterActivity(act.GetWalletBalanceActivity)
	w.RegisterActivity(act.ProcessTigerBeetleTransferActivity)
	w.RegisterActivity(act.RecordTigerBeetleTransactionActivity)
	w.RegisterActivity(act.UpdateWalletBalanceActivity)

	// Demand response activities
	w.RegisterActivity(act.EnrollUserInDREventActivity)
	w.RegisterActivity(act.GetDREventStartTimeActivity)
	w.RegisterActivity(act.GetDREventDurationActivity)
	w.RegisterActivity(act.GetCurrentConsumptionActivity)
	w.RegisterActivity(act.CalculateDRPerformanceActivity)
	w.RegisterActivity(act.AwardDRRewardsActivity)

	// Payment activities (gateway charge only happens when a real gateway is
	// configured via PAYMENT_GATEWAY_URL/PAYMENT_GATEWAY_API_KEY)
	w.RegisterActivity(act.ValidatePaymentMethodActivity)
	w.RegisterActivity(act.ProcessPaymentGatewayActivity)
	w.RegisterActivity(act.SendPaymentReceiptActivity)

	// Monitoring activities
	w.RegisterActivity(act.GetDeviceTelemetryActivity)
	w.RegisterActivity(act.DetectAnomaliesActivity)
	w.RegisterActivity(act.CreateAlertActivity)

	// Gamification activities (scores aggregated from real executed trades;
	// achievements evaluated against real recorded metrics)
	w.RegisterActivity(act.UpdateLeaderboardActivity)
	w.RegisterActivity(act.CalculateLeaderboardScoresActivity)
	w.RegisterActivity(act.UpdateRedisLeaderboardActivity)
	w.RegisterActivity(act.GetTopPerformersActivity)
	w.RegisterActivity(act.AwardBonusPointsActivity)
	w.RegisterActivity(act.CheckAchievementsActivity)
	w.RegisterActivity(act.AwardAchievementActivity)

	// Notification, event streaming, and cache activities
	w.RegisterActivity(act.SendPushNotificationActivity)
	w.RegisterActivity(act.TriggerHapticFeedbackActivity)
	w.RegisterActivity(act.PublishKafkaEventActivity)
	w.RegisterActivity(act.PublishFluvioTelemetryActivity) // fails loudly: no Fluvio client available
	w.RegisterActivity(act.CacheTelemetryActivity)
}
