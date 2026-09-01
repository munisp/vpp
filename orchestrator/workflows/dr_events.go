package workflows

import (
	"go.temporal.io/sdk/workflow"
	"time"
)

// DREventParticipationWorkflow handles user participation in DR events
func DREventParticipationWorkflow(ctx workflow.Context, userID string, eventID string) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting DR event participation workflow", "userID", userID, "eventID", eventID)

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Minute,
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	// Enroll user in DR event
	err := workflow.ExecuteActivity(ctx, "EnrollUserInDREventActivity", userID, eventID).Get(ctx, nil)
	if err != nil {
		return err
	}

	// Send enrollment confirmation
	err = workflow.ExecuteActivity(ctx, "SendPushNotificationActivity", userID, "DR Event Enrolled", "You are now participating in the DR event").Get(ctx, nil)
	if err != nil {
		logger.Warn("Failed to send notification", "error", err)
	}

	// Wait for event start time
	var eventStartTime time.Time
	err = workflow.ExecuteActivity(ctx, "GetDREventStartTimeActivity", eventID).Get(ctx, &eventStartTime)
	if err != nil {
		return err
	}

	err = workflow.Sleep(ctx, time.Until(eventStartTime))
	if err != nil {
		return err
	}

	// Send event start notification
	workflow.ExecuteActivity(ctx, "SendPushNotificationActivity", userID, "DR Event Starting", "Please reduce your energy consumption now").Get(ctx, nil)

	// Monitor user's energy consumption during event
	var eventDuration time.Duration
	err = workflow.ExecuteActivity(ctx, "GetDREventDurationActivity", eventID).Get(ctx, &eventDuration)
	if err != nil {
		return err
	}

	// Periodic consumption checks
	ticker := workflow.NewTimer(ctx, 5*time.Minute)
	for i := 0; i < int(eventDuration.Minutes()/5); i++ {
		ticker.Get(ctx, nil)

		var consumption float64
		err = workflow.ExecuteActivity(ctx, "GetCurrentConsumptionActivity", userID).Get(ctx, &consumption)
		if err != nil {
			// Do not publish a zero/fabricated consumption value.
			logger.Warn("Consumption unavailable; skipping telemetry publish for this interval", "error", err)
			ticker = workflow.NewTimer(ctx, 5*time.Minute)
			continue
		}

		// Publish telemetry to Fluvio
		err = workflow.ExecuteActivity(ctx, "PublishFluvioTelemetryActivity", userID, consumption).Get(ctx, nil)
		if err != nil {
			logger.Warn("Failed to publish telemetry", "error", err)
		}

		ticker = workflow.NewTimer(ctx, 5*time.Minute)
	}

	// Calculate performance and rewards
	var performance map[string]interface{}
	err = workflow.ExecuteActivity(ctx, "CalculateDRPerformanceActivity", userID, eventID).Get(ctx, &performance)
	if err != nil {
		return err
	}

	// Award points and credits
	err = workflow.ExecuteActivity(ctx, "AwardDRRewardsActivity", userID, performance).Get(ctx, nil)
	if err != nil {
		logger.Warn("Failed to award rewards", "error", err)
	}

	// Update leaderboard
	workflow.ExecuteActivity(ctx, "UpdateLeaderboardActivity", userID, "dr_participation").Get(ctx, nil)

	// Publish event completion
	workflow.ExecuteActivity(ctx, "PublishKafkaEventActivity", "dr.event.completed", eventID).Get(ctx, nil)

	return nil
}

// DRForecastingWorkflow predicts optimal DR event timing
func DRForecastingWorkflow(ctx workflow.Context, regionID string) error {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting DR forecasting workflow", "regionID", regionID)

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 20 * time.Minute,
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	// Query historical data from lakehouse
	var historicalData []byte
	err := workflow.ExecuteActivity(ctx, "QueryLakehouseDataActivity", regionID).Get(ctx, &historicalData)
	if err != nil {
		return err
	}

	// Run ML forecasting model
	var forecast map[string]interface{}
	err = workflow.ExecuteActivity(ctx, "RunForecastingModelActivity", historicalData).Get(ctx, &forecast)
	if err != nil {
		return err
	}

	// Identify peak demand periods
	var peakPeriods []time.Time
	err = workflow.ExecuteActivity(ctx, "IdentifyPeakPeriodsActivity", forecast).Get(ctx, &peakPeriods)
	if err != nil {
		return err
	}

	// Create DR events for peak periods
	for _, period := range peakPeriods {
		var eventID string
		err = workflow.ExecuteActivity(ctx, "CreateDREventActivity", regionID, period).Get(ctx, &eventID)
		if err != nil {
			logger.Warn("Failed to create DR event", "error", err)
			continue
		}

		// Notify eligible users
		workflow.ExecuteActivity(ctx, "NotifyEligibleUsersActivity", eventID).Get(ctx, nil)
	}

	// Store forecast results in lakehouse
	workflow.ExecuteActivity(ctx, "StoreForecastResultsActivity", forecast).Get(ctx, nil)

	return nil
}
