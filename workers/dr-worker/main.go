package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"

	_ "github.com/go-sql-driver/mysql"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

// DR Event Workflow Input
type DREventWorkflowInput struct {
	EventID          int       `json:"eventId"`
	StartTime        time.Time `json:"startTime"`
	EndTime          time.Time `json:"endTime"`
	TargetKW         float64   `json:"targetKw"`
	CompensationRate int       `json:"compensationRate"` // cents per kWh
	AutoEnroll       bool      `json:"autoEnroll"`
}

// DR Event Workflow Result
type DREventWorkflowResult struct {
	Success              bool   `json:"success"`
	EventID              int    `json:"eventId"`
	ParticipantsEnrolled int    `json:"participantsEnrolled"`
	NotificationsSent    int    `json:"notificationsSent"`
	Error                string `json:"error,omitempty"`
}

// Database connection
var db *sql.DB

// Initialize database connection
func initDB() error {
	var err error
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		return fmt.Errorf("DATABASE_URL environment variable not set")
	}

	db, err = sql.Open("mysql", databaseURL)
	if err != nil {
		return fmt.Errorf("failed to connect to database: %w", err)
	}

	if err = db.Ping(); err != nil {
		return fmt.Errorf("failed to ping database: %w", err)
	}

	log.Println("[DB] Connected to database")
	return nil
}

// DR Event Workflow
func DREventWorkflow(ctx workflow.Context, input DREventWorkflowInput) (DREventWorkflowResult, error) {
	logger := workflow.GetLogger(ctx)
	logger.Info("Starting DR Event Workflow", "eventId", input.EventID)

	result := DREventWorkflowResult{EventID: input.EventID}

	// Step 1: Update event status to active
	if err := workflow.ExecuteActivity(ctx, UpdateEventStatusActivity, input.EventID, "active").Get(ctx, nil); err != nil {
		logger.Error("Failed to update event status", "error", err)
		result.Error = err.Error()
		return result, err
	}

	// Step 2: Enroll participants
	var enrollResult EnrollParticipantsResult
	if err := workflow.ExecuteActivity(ctx, EnrollParticipantsActivity, EnrollParticipantsInput{
		EventID:    input.EventID,
		AutoEnroll: input.AutoEnroll,
	}).Get(ctx, &enrollResult); err != nil {
		logger.Error("Failed to enroll participants", "error", err)
		result.Error = err.Error()
		return result, err
	}
	result.ParticipantsEnrolled = enrollResult.ParticipantCount

	// Step 3: Send start notifications
	var notifResult SendNotificationsResult
	if err := workflow.ExecuteActivity(ctx, SendNotificationsActivity, SendNotificationsInput{
		EventID: input.EventID,
		Type:    "event_start",
	}).Get(ctx, &notifResult); err != nil {
		logger.Warn("Failed to send start notifications", "error", err)
	} else {
		result.NotificationsSent = notifResult.SentCount
	}

	// Step 4: Wait for event start time
	if time.Now().Before(input.StartTime) {
		waitDuration := input.StartTime.Sub(time.Now())
		logger.Info("Waiting for event start", "duration", waitDuration)
		if err := workflow.Sleep(ctx, waitDuration); err != nil {
			logger.Error("Sleep interrupted", "error", err)
			return result, err
		}
	}

	// Step 5: Monitor compliance during event execution
	eventDuration := input.EndTime.Sub(input.StartTime)
	monitorInterval := 5 * time.Minute

	for elapsed := time.Duration(0); elapsed < eventDuration; elapsed += monitorInterval {
		if err := workflow.ExecuteActivity(ctx, MonitorComplianceActivity, MonitorComplianceInput{
			EventID:      input.EventID,
			TargetKW:     input.TargetKW,
			StartTime:    input.StartTime,
		}).Get(ctx, nil); err != nil {
			logger.Warn("Compliance monitoring error", "error", err)
		}
		if elapsed+monitorInterval < eventDuration {
			workflow.Sleep(ctx, monitorInterval)
		}
	}

	// Step 6: Calculate compensation
	if err := workflow.ExecuteActivity(ctx, CalculateCompensationActivity, CalculateCompensationInput{
		EventID:          input.EventID,
		CompensationRate: input.CompensationRate,
		StartTime:        input.StartTime,
		EndTime:          input.EndTime,
	}).Get(ctx, nil); err != nil {
		logger.Error("Failed to calculate compensation", "error", err)
		result.Error = err.Error()
		return result, err
	}

	// Step 7: Update event status to completed
	if err := workflow.ExecuteActivity(ctx, UpdateEventStatusActivity, input.EventID, "completed").Get(ctx, nil); err != nil {
		logger.Error("Failed to update event status to completed", "error", err)
	}

	// Step 8: Send completion notifications
	workflow.ExecuteActivity(ctx, SendNotificationsActivity, SendNotificationsInput{
		EventID: input.EventID,
		Type:    "event_complete",
	}).Get(ctx, nil)

	result.Success = true
	logger.Info("DR Event Workflow completed successfully", "eventId", input.EventID)
	return result, nil
}

// ---------------------------------------------------------------------------
// Activity Input / Output Types
// ---------------------------------------------------------------------------

type EnrollParticipantsInput struct {
	EventID    int  `json:"eventId"`
	AutoEnroll bool `json:"autoEnroll"`
}

type EnrollParticipantsResult struct {
	ParticipantCount int `json:"participantCount"`
}

type SendNotificationsInput struct {
	EventID int    `json:"eventId"`
	Type    string `json:"type"`
}

type SendNotificationsResult struct {
	SentCount int `json:"sentCount"`
}

type MonitorComplianceInput struct {
	EventID   int       `json:"eventId"`
	TargetKW  float64   `json:"targetKw"`
	StartTime time.Time `json:"startTime"`
}

type CalculateCompensationInput struct {
	EventID          int       `json:"eventId"`
	CompensationRate int       `json:"compensationRate"` // cents per kWh
	StartTime        time.Time `json:"startTime"`
	EndTime          time.Time `json:"endTime"`
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

func UpdateEventStatusActivity(ctx context.Context, eventID int, status string) error {
	log.Printf("[Activity] Updating event %d status to %s", eventID, status)
	_, err := db.ExecContext(ctx,
		"UPDATE demand_response_events SET status = ?, updatedAt = NOW() WHERE id = ?",
		status, eventID,
	)
	if err != nil {
		return fmt.Errorf("failed to update event status: %w", err)
	}
	return nil
}

func EnrollParticipantsActivity(ctx context.Context, input EnrollParticipantsInput) (EnrollParticipantsResult, error) {
	log.Printf("[Activity] Enrolling participants for event %d", input.EventID)
	result := EnrollParticipantsResult{}

	rows, err := db.QueryContext(ctx, `
		SELECT id FROM users
		WHERE id IN (SELECT userId FROM drParticipants WHERE status = 'active')
	`)
	if err != nil {
		return result, fmt.Errorf("failed to query participants: %w", err)
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		var userID int
		if err := rows.Scan(&userID); err != nil {
			continue
		}
		_, err = db.ExecContext(ctx, `
			INSERT INTO dr_event_participants (eventId, userId, status, enrolledAt)
			VALUES (?, ?, 'enrolled', NOW())
			ON DUPLICATE KEY UPDATE status = 'enrolled'
		`, input.EventID, userID)
		if err == nil {
			count++
		}
	}

	result.ParticipantCount = count
	log.Printf("[Activity] Enrolled %d participants", count)
	return result, nil
}

// SendNotificationsActivity inserts notification rows into the database.
// The Node.js notification service polls the notifications table and delivers
// messages via FCM / APNS / email — this worker does not call those APIs directly.
func SendNotificationsActivity(ctx context.Context, input SendNotificationsInput) (SendNotificationsResult, error) {
	log.Printf("[Activity] Sending %s notifications for event %d", input.Type, input.EventID)
	result := SendNotificationsResult{}

	// Fetch event details for the notification body
	var eventTitle string
	var startTime, endTime time.Time
	err := db.QueryRowContext(ctx,
		"SELECT title, startTime, endTime FROM demand_response_events WHERE id = ?",
		input.EventID,
	).Scan(&eventTitle, &startTime, &endTime)
	if err != nil {
		return result, fmt.Errorf("failed to fetch event details: %w", err)
	}

	// Determine notification content based on event type
	var title, body string
	switch input.Type {
	case "event_start":
		title = "Demand Response Event Started"
		body = fmt.Sprintf("Event '%s' has started. Please reduce your energy usage until %s.",
			eventTitle, endTime.Format("15:04"))
	case "event_complete":
		title = "Demand Response Event Completed"
		body = fmt.Sprintf("Event '%s' has ended. Thank you for your participation. Compensation will be credited shortly.",
			eventTitle)
	default:
		title = "Demand Response Update"
		body = fmt.Sprintf("Update for event '%s': %s", eventTitle, input.Type)
	}

	// Fetch all enrolled participants
	rows, err := db.QueryContext(ctx,
		"SELECT userId FROM dr_event_participants WHERE eventId = ? AND status = 'enrolled'",
		input.EventID,
	)
	if err != nil {
		return result, fmt.Errorf("failed to fetch participants: %w", err)
	}
	defer rows.Close()

	data, _ := json.Marshal(map[string]interface{}{
		"eventId": input.EventID,
		"type":    input.Type,
	})

	count := 0
	for rows.Next() {
		var userID int
		if err := rows.Scan(&userID); err != nil {
			continue
		}
		_, err = db.ExecContext(ctx,
			`INSERT INTO notifications (userId, title, body, type, data, createdAt)
			 VALUES (?, ?, ?, 'dr_event', ?, NOW())`,
			userID, title, body, string(data),
		)
		if err == nil {
			count++
		} else {
			log.Printf("[Activity] Failed to insert notification for user %d: %v", userID, err)
		}
	}

	result.SentCount = count
	log.Printf("[Activity] Queued %d notifications for event %d (%s)", count, input.EventID, input.Type)
	return result, nil
}

// MonitorComplianceActivity queries real telemetry data and records each
// participant's power reduction against the event target.
func MonitorComplianceActivity(ctx context.Context, input MonitorComplianceInput) error {
	log.Printf("[Activity] Monitoring compliance for event %d (target %.1f kW)", input.EventID, input.TargetKW)

	// Fetch enrolled participants
	rows, err := db.QueryContext(ctx,
		"SELECT userId FROM dr_event_participants WHERE eventId = ? AND status = 'enrolled'",
		input.EventID,
	)
	if err != nil {
		return fmt.Errorf("failed to fetch participants: %w", err)
	}
	defer rows.Close()

	now := time.Now()
	windowStart := now.Add(-5 * time.Minute) // look back over the last monitoring interval

	for rows.Next() {
		var userID int
		if err := rows.Scan(&userID); err != nil {
			continue
		}

		// Average power (W) for this user's assets over the monitoring window
		var avgPower sql.NullFloat64
		err = db.QueryRowContext(ctx, `
			SELECT AVG(t.power)
			FROM telemetry t
			JOIN assets a ON t.assetId = a.id
			WHERE a.userId = ?
			  AND t.timestamp BETWEEN ? AND ?
		`, userID, windowStart, now).Scan(&avgPower)
		if err != nil || !avgPower.Valid {
			continue
		}

		// Reduction = target minus actual (floor at 0)
		targetW := input.TargetKW * 1000
		reductionW := targetW - avgPower.Float64
		if reductionW < 0 {
			reductionW = 0
		}

		// Update the participant's compliance record
		_, err = db.ExecContext(ctx, `
			UPDATE dr_event_participants
			SET actualReduction = ?, complianceScore = LEAST(100, ROUND(? / ? * 100)),
			    updatedAt = NOW()
			WHERE eventId = ? AND userId = ?
		`, reductionW, reductionW, targetW, input.EventID, userID)
		if err != nil {
			log.Printf("[Activity] Failed to update compliance for user %d: %v", userID, err)
		}
	}

	return nil
}

// CalculateCompensationActivity computes each participant's earned compensation
// based on their actual energy reduction and inserts payment records.
func CalculateCompensationActivity(ctx context.Context, input CalculateCompensationInput) error {
	log.Printf("[Activity] Calculating compensation for event %d (rate %d c/kWh)", input.EventID, input.CompensationRate)

	eventDurationHours := input.EndTime.Sub(input.StartTime).Hours()

	rows, err := db.QueryContext(ctx,
		`SELECT userId, actualReduction FROM dr_event_participants
		 WHERE eventId = ? AND status = 'enrolled'`,
		input.EventID,
	)
	if err != nil {
		return fmt.Errorf("failed to fetch participant reductions: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var userID int
		var actualReductionW sql.NullFloat64
		if err := rows.Scan(&userID, &actualReductionW); err != nil {
			continue
		}
		if !actualReductionW.Valid || actualReductionW.Float64 <= 0 {
			continue
		}

		// Energy reduced in kWh = (W / 1000) * hours
		energyKWh := (actualReductionW.Float64 / 1000.0) * eventDurationHours
		// Compensation in cents
		compensationCents := int(energyKWh * float64(input.CompensationRate))
		if compensationCents <= 0 {
			continue
		}

		// Insert a compensation payment record
		_, err = db.ExecContext(ctx, `
			INSERT INTO dr_compensation (eventId, userId, energyKwh, compensationCents, status, createdAt)
			VALUES (?, ?, ?, ?, 'pending', NOW())
			ON DUPLICATE KEY UPDATE
			  energyKwh = VALUES(energyKwh),
			  compensationCents = VALUES(compensationCents),
			  updatedAt = NOW()
		`, input.EventID, userID, energyKWh, compensationCents)
		if err != nil {
			log.Printf("[Activity] Failed to insert compensation for user %d: %v", userID, err)
			continue
		}

		log.Printf("[Activity] Compensation for user %d: %.3f kWh → %d cents", userID, energyKWh, compensationCents)
	}

	return nil
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

func main() {
	if err := initDB(); err != nil {
		log.Fatal("Failed to initialize database:", err)
	}
	defer db.Close()

	temporalAddress := os.Getenv("TEMPORAL_ADDRESS")
	if temporalAddress == "" {
		temporalAddress = "localhost:7233"
	}

	c, err := client.Dial(client.Options{HostPort: temporalAddress})
	if err != nil {
		log.Fatal("Unable to create Temporal client:", err)
	}
	defer c.Close()

	w := worker.New(c, "dr-events", worker.Options{})
	w.RegisterWorkflow(DREventWorkflow)
	w.RegisterActivity(UpdateEventStatusActivity)
	w.RegisterActivity(EnrollParticipantsActivity)
	w.RegisterActivity(SendNotificationsActivity)
	w.RegisterActivity(MonitorComplianceActivity)
	w.RegisterActivity(CalculateCompensationActivity)

	log.Println("[DR Worker] Starting worker on task queue: dr-events")
	if err = w.Run(worker.InterruptCh()); err != nil {
		log.Fatal("Unable to start worker:", err)
	}
	log.Println("[DR Worker] Worker stopped")
}
