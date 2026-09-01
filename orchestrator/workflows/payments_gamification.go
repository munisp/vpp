package workflows

import (
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
	"time"
)

// PaymentProcessingWorkflow handles mobile money payments
func PaymentProcessingWorkflow(ctx workflow.Context, userID string, amount float64, method string) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting payment processing workflow")

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 3,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	// Validate payment method
	err := workflow.ExecuteActivity(ctx, "ValidatePaymentMethodActivity", userID, method).Get(ctx, nil)
	if err != nil {
		return err
	}

	// Process payment via gateway
	var transactionID string
	err = workflow.ExecuteActivity(ctx, "ProcessPaymentGatewayActivity", userID, amount, method).Get(ctx, &transactionID)
	if err != nil {
		return err
	}

	// Record in TigerBeetle ledger
	err = workflow.ExecuteActivity(ctx, "RecordTigerBeetleTransactionActivity", userID, amount, transactionID).Get(ctx, nil)
	if err != nil {
		// Initiate refund
		workflow.ExecuteActivity(ctx, "InitiateRefundActivity", transactionID).Get(ctx, nil)
		return err
	}

	// Update user wallet
	err = workflow.ExecuteActivity(ctx, "UpdateWalletBalanceActivity", userID, amount).Get(ctx, nil)
	if err != nil {
		return err
	}

	// Publish event
	workflow.ExecuteActivity(ctx, "PublishKafkaEventActivity", "payment.completed", transactionID).Get(ctx, nil)

	// Send receipt
	workflow.ExecuteActivity(ctx, "SendPaymentReceiptActivity", userID, transactionID).Get(ctx, nil)

	return nil
}

// QRPaymentWorkflow handles QR code-based payments
func QRPaymentWorkflow(ctx workflow.Context, userID string, qrData string) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting QR payment workflow")

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	// Parse QR code data
	var paymentInfo map[string]interface{}
	err := workflow.ExecuteActivity(ctx, "ParseQRCodeActivity", qrData).Get(ctx, &paymentInfo)
	if err != nil {
		return err
	}

	// Verify merchant
	err = workflow.ExecuteActivity(ctx, "VerifyMerchantActivity", paymentInfo["merchantID"]).Get(ctx, nil)
	if err != nil {
		return err
	}

	// Process payment
	var transactionID string
	err = workflow.ExecuteActivity(ctx, "ProcessQRPaymentActivity", userID, paymentInfo).Get(ctx, &transactionID)
	if err != nil {
		return err
	}

	// Trigger haptic feedback
	workflow.ExecuteActivity(ctx, "TriggerHapticFeedbackActivity", userID, "success").Get(ctx, nil)

	return nil
}

// TelemetryMonitoringWorkflow monitors IoT device telemetry
func TelemetryMonitoringWorkflow(ctx workflow.Context, deviceID string) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting telemetry monitoring workflow")

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 1 * time.Hour,
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	// Continuous monitoring loop
	for {
		// Get latest telemetry
		var telemetry map[string]interface{}
		err := workflow.ExecuteActivity(ctx, "GetDeviceTelemetryActivity", deviceID).Get(ctx, &telemetry)
		if err != nil {
			logger.Warn("Failed to get telemetry", "error", err)
			continue
		}

		// Check for anomalies
		var hasAnomaly bool
		err = workflow.ExecuteActivity(ctx, "DetectAnomaliesActivity", telemetry).Get(ctx, &hasAnomaly)
		if err == nil && hasAnomaly {
			// Create alert
			workflow.ExecuteActivity(ctx, "CreateAlertActivity", deviceID, telemetry).Get(ctx, nil)
		}

		// Publish to Fluvio
		workflow.ExecuteActivity(ctx, "PublishFluvioTelemetryActivity", deviceID, telemetry).Get(ctx, nil)

		// Cache in Redis
		workflow.ExecuteActivity(ctx, "CacheTelemetryActivity", deviceID, telemetry).Get(ctx, nil)

		// Sleep before next check
		workflow.Sleep(ctx, 1*time.Minute)
	}
}

// AlertManagementWorkflow handles system alerts
func AlertManagementWorkflow(ctx workflow.Context, alertID string) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting alert management workflow")

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Minute,
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	// Get alert details
	var alert map[string]interface{}
	err := workflow.ExecuteActivity(ctx, "GetAlertDetailsActivity", alertID).Get(ctx, &alert)
	if err != nil {
		return err
	}

	// Determine severity and affected users
	var affectedUsers []string
	err = workflow.ExecuteActivity(ctx, "GetAffectedUsersActivity", alert).Get(ctx, &affectedUsers)
	if err != nil {
		return err
	}

	// Send notifications
	for _, userID := range affectedUsers {
		workflow.ExecuteActivity(ctx, "SendPushNotificationActivity", userID, "System Alert", alert["message"]).Get(ctx, nil)
	}

	// Log to lakehouse
	workflow.ExecuteActivity(ctx, "LogAlertToLakehouseActivity", alert).Get(ctx, nil)

	return nil
}

// LeaderboardUpdateWorkflow updates gamification leaderboard
func LeaderboardUpdateWorkflow(ctx workflow.Context, period string) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting leaderboard update workflow")

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 15 * time.Minute,
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	// Calculate scores for all users
	var scores map[string]float64
	err := workflow.ExecuteActivity(ctx, "CalculateLeaderboardScoresActivity", period).Get(ctx, &scores)
	if err != nil {
		return err
	}

	// Update leaderboard in Redis
	err = workflow.ExecuteActivity(ctx, "UpdateRedisLeaderboardActivity", scores).Get(ctx, nil)
	if err != nil {
		return err
	}

	// Identify top performers
	var topUsers []string
	err = workflow.ExecuteActivity(ctx, "GetTopPerformersActivity", scores, 10).Get(ctx, &topUsers)
	if err != nil {
		return err
	}

	// Award bonus points
	for _, userID := range topUsers {
		workflow.ExecuteActivity(ctx, "AwardBonusPointsActivity", userID).Get(ctx, nil)
	}

	// Publish leaderboard update event
	workflow.ExecuteActivity(ctx, "PublishKafkaEventActivity", "leaderboard.updated", period).Get(ctx, nil)

	return nil
}

// AchievementTrackingWorkflow tracks and awards achievements
func AchievementTrackingWorkflow(ctx workflow.Context, userID string, action string) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting achievement tracking workflow")

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 5 * time.Minute,
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	// Check if action triggers achievement
	var achievements []string
	err := workflow.ExecuteActivity(ctx, "CheckAchievementsActivity", userID, action).Get(ctx, &achievements)
	if err != nil {
		return err
	}

	// Award achievements
	for _, achievementID := range achievements {
		err = workflow.ExecuteActivity(ctx, "AwardAchievementActivity", userID, achievementID).Get(ctx, nil)
		if err != nil {
			logger.Warn("Failed to award achievement", "error", err)
			continue
		}

		// Send notification
		workflow.ExecuteActivity(ctx, "SendPushNotificationActivity", userID, "Achievement Unlocked!", achievementID).Get(ctx, nil)

		// Trigger haptic feedback
		workflow.ExecuteActivity(ctx, "TriggerHapticFeedbackActivity", userID, "success").Get(ctx, nil)
	}

	// Publish event
	if len(achievements) > 0 {
		workflow.ExecuteActivity(ctx, "PublishKafkaEventActivity", "achievement.unlocked", userID).Get(ctx, nil)
	}

	return nil
}
