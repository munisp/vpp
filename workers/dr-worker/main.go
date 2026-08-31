package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/url"
	"os"
	"time"

	_ "github.com/lib/pq"
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

	dsn, err := withUTCSession(databaseURL)
	if err != nil {
		return err
	}

	db, err = sql.Open("postgres", dsn)
	if err != nil {
		return fmt.Errorf("failed to connect to database: %w", err)
	}

	if err = db.Ping(); err != nil {
		return fmt.Errorf("failed to ping database: %w", err)
	}

	log.Println("[DB] Connected to database")
	return nil
}

// withUTCSession forces the PostgreSQL session time zone to UTC. Timestamp
// columns are `timestamp without time zone` holding UTC, and NOW() is
// converted using the session time zone, so a non-UTC session would silently
// shift every timestamp this worker writes (DR windows, compensation).
func withUTCSession(databaseURL string) (string, error) {
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		return "", fmt.Errorf("DATABASE_URL is not a valid URL: %w", err)
	}
	query := parsed.Query()
	if query.Get("options") == "" {
		query.Set("options", "-c timezone=UTC")
		parsed.RawQuery = query.Encode()
	}
	return parsed.String(), nil
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
		logger.Error("Failed to send start notifications", "error", err)
		result.Error = err.Error()
		return result, err
	}
	result.NotificationsSent = notifResult.SentCount

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
			logger.Error("Compliance monitoring error", "error", err)
			result.Error = err.Error()
			return result, err
		}
		if elapsed+monitorInterval < eventDuration {
			if err := workflow.Sleep(ctx, monitorInterval); err != nil {
				return result, err
			}
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
		result.Error = err.Error()
		return result, err
	}

	// Step 8: Send completion notifications
	if err := workflow.ExecuteActivity(ctx, SendNotificationsActivity, SendNotificationsInput{
		EventID: input.EventID,
		Type:    "event_complete",
	}).Get(ctx, nil); err != nil {
		logger.Error("Failed to send completion notifications", "error", err)
		result.Error = err.Error()
		return result, err
	}

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
	// Real table per drizzle/schema.ts: demandResponseEvents
	// (status enum: scheduled/active/completed/cancelled)
	_, err := db.ExecContext(ctx,
		`UPDATE "demandResponseEvents" SET status = $1, "updatedAt" = NOW() WHERE id = $2`,
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
		WHERE id IN (SELECT "userId" FROM "drParticipants" WHERE status = 'active')
	`)
	if err != nil {
		return result, fmt.Errorf("failed to query participants: %w", err)
	}
	defer rows.Close()

	// drResponses.participationStatus enum: opted_in/opted_out/auto_enrolled
	participationStatus := "opted_in"
	if input.AutoEnroll {
		participationStatus = "auto_enrolled"
	}

	count := 0
	for rows.Next() {
		var userID int
		if err := rows.Scan(&userID); err != nil {
			return result, fmt.Errorf("failed to scan participant row: %w", err)
		}
		// Real table per drizzle/schema.ts: drResponses. No unique key exists on
		// (eventId, userId), so idempotency under Temporal activity retries is
		// enforced with WHERE NOT EXISTS instead of ON DUPLICATE KEY UPDATE.
		_, err = db.ExecContext(ctx, `
			INSERT INTO "drResponses" ("eventId", "userId", "participationStatus", "responseTime")
			SELECT $1, $2, $3::"drResponses_participation_status", NOW()
			WHERE NOT EXISTS (
				SELECT 1 FROM "drResponses" WHERE "eventId" = $1 AND "userId" = $2
			)
		`, input.EventID, userID, participationStatus)
		if err != nil {
			// A DB error must fail the activity so Temporal retries — an event
			// that enrolls 0 due to DB errors is a failure, not count=0 success.
			return result, fmt.Errorf("failed to enroll user %d in event %d: %w", userID, input.EventID, err)
		}
		count++
	}
	if err := rows.Err(); err != nil {
		return result, fmt.Errorf("error iterating participants: %w", err)
	}

	result.ParticipantCount = count
	log.Printf("[Activity] Enrolled %d participants", count)
	return result, nil
}

// SendNotificationsActivity inserts user-facing rows into the real `alerts`
// table. The Node.js notification service polls `alerts` and delivers
// messages via FCM / APNS / email — this worker does not call those APIs directly.
func SendNotificationsActivity(ctx context.Context, input SendNotificationsInput) (SendNotificationsResult, error) {
	log.Printf("[Activity] Sending %s notifications for event %d", input.Type, input.EventID)
	result := SendNotificationsResult{}

	// Fetch event details for the notification body.
	// Real table: demandResponseEvents (column is eventName, not title).
	var eventTitle string
	var startTime, endTime time.Time
	err := db.QueryRowContext(ctx,
		`SELECT "eventName", "startTime", "endTime" FROM "demandResponseEvents" WHERE id = $1`,
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

	// Fetch all enrolled participants from the real drResponses table.
	rows, err := db.QueryContext(ctx,
		`SELECT "userId" FROM "drResponses"
		 WHERE "eventId" = $1 AND "participationStatus" IN ('opted_in', 'auto_enrolled')`,
		input.EventID,
	)
	if err != nil {
		return result, fmt.Errorf("failed to fetch participants: %w", err)
	}
	defer rows.Close()

	data, err := json.Marshal(map[string]interface{}{
		"eventId": input.EventID,
		"type":    input.Type,
	})
	if err != nil {
		return result, fmt.Errorf("failed to marshal notification metadata: %w", err)
	}

	count := 0
	for rows.Next() {
		var userID int
		if err := rows.Scan(&userID); err != nil {
			return result, fmt.Errorf("failed to scan participant row: %w", err)
		}
		// Real table per drizzle/schema.ts: alerts
		// (alertType enum: system/trading/billing/maintenance)
		_, err = db.ExecContext(ctx,
			`INSERT INTO alerts ("userId", "alertType", severity, title, message, "isRead", metadata, "createdAt")
			 VALUES ($1, 'system', 'info', $2, $3, false, $4, NOW())`,
			userID, title, body, string(data),
		)
		if err != nil {
			// Fail loudly so Temporal retries instead of silently dropping
			// participant notifications.
			return result, fmt.Errorf("failed to insert notification for user %d: %w", userID, err)
		}
		count++
	}
	if err := rows.Err(); err != nil {
		return result, fmt.Errorf("error iterating participants: %w", err)
	}

	result.SentCount = count
	log.Printf("[Activity] Queued %d notifications for event %d (%s)", count, input.EventID, input.Type)
	return result, nil
}

// MonitorComplianceActivity queries real telemetry data and records each
// participant's power reduction against the event target.
func MonitorComplianceActivity(ctx context.Context, input MonitorComplianceInput) error {
	log.Printf("[Activity] Monitoring compliance for event %d (target %.1f kW)", input.EventID, input.TargetKW)

	// Fetch enrolled participants from the real drResponses table
	rows, err := db.QueryContext(ctx,
		`SELECT "userId" FROM "drResponses"
		 WHERE "eventId" = $1 AND "participationStatus" IN ('opted_in', 'auto_enrolled')`,
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
			return fmt.Errorf("failed to scan participant row: %w", err)
		}

		// Average power (W) for this user's assets over the monitoring window
		var avgPower sql.NullFloat64
		err = db.QueryRowContext(ctx, `
			SELECT AVG(t.power)
			FROM telemetry t
			JOIN assets a ON t."assetId" = a.id
			WHERE a."userId" = $1
			  AND t.timestamp BETWEEN $2 AND $3
		`, userID, windowStart, now).Scan(&avgPower)
		if err != nil {
			return fmt.Errorf("failed to query telemetry for user %d: %w", userID, err)
		}
		if !avgPower.Valid {
			// No telemetry in the window for this user — nothing to score yet.
			continue
		}

		// Reduction = target minus actual (floor at 0).
		targetW := input.TargetKW * 1000
		reductionW := targetW - avgPower.Float64
		if reductionW < 0 {
			reductionW = 0
		}
		// drResponses.actualReduction is stored in kW per drizzle/schema.ts.
		reductionKW := int(math.Round(reductionW / 1000.0))
		complianceScore := 0
		if targetW > 0 {
			complianceScore = int(math.Round(reductionW / targetW * 100))
			if complianceScore > 100 {
				complianceScore = 100
			}
		}

		// Update the participant's compliance record. drResponses has no
		// complianceScore column, so the score is kept in the metadata JSON.
		_, err = db.ExecContext(ctx, `
			UPDATE "drResponses"
			SET "actualReduction" = $1,
			    metadata = (jsonb_set(COALESCE(metadata, '{}')::jsonb, '{complianceScore}', to_jsonb($2::numeric), true))::text,
			    "updatedAt" = NOW()
			WHERE "eventId" = $3 AND "userId" = $4
		`, reductionKW, complianceScore, input.EventID, userID)
		if err != nil {
			return fmt.Errorf("failed to update compliance for user %d: %w", userID, err)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("error iterating participants: %w", err)
	}

	return nil
}

// CalculateCompensationActivity computes each participant's earned compensation
// based on their actual energy reduction and inserts payment records.
func CalculateCompensationActivity(ctx context.Context, input CalculateCompensationInput) error {
	log.Printf("[Activity] Calculating compensation for event %d (rate %d c/kWh)", input.EventID, input.CompensationRate)

	eventDurationHours := input.EndTime.Sub(input.StartTime).Hours()

	// drResponses.actualReduction is kW (int); join users for the payout
	// currency (drCompensation.currency enum: NGN/TZS/USD, NOT NULL).
	rows, err := db.QueryContext(ctx,
		`SELECT r.id, r."userId", r."actualReduction", u.currency
		 FROM "drResponses" r
		 JOIN users u ON u.id = r."userId"
		 WHERE r."eventId" = $1 AND r."participationStatus" IN ('opted_in', 'auto_enrolled')`,
		input.EventID,
	)
	if err != nil {
		return fmt.Errorf("failed to fetch participant reductions: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var responseID, userID int
		var actualReductionKW sql.NullInt64
		var currency string
		if err := rows.Scan(&responseID, &userID, &actualReductionKW, &currency); err != nil {
			return fmt.Errorf("failed to scan participant reduction row: %w", err)
		}
		if !actualReductionKW.Valid || actualReductionKW.Int64 <= 0 {
			continue
		}

		// Energy reduced in kWh = kW * hours; compensation in cents.
		energyKWh := float64(actualReductionKW.Int64) * eventDurationHours
		compensationCents := int(energyKWh * float64(input.CompensationRate))
		if compensationCents <= 0 {
			continue
		}

		// drCompensation has no energyKwh/compensationCents columns; the energy
		// figure is kept in the metadata JSON, the money goes in `amount`.
		metadata, err := json.Marshal(map[string]interface{}{
			"energyKwh":         energyKWh,
			"compensationRate":  input.CompensationRate,
			"actualReductionKw": actualReductionKW.Int64,
		})
		if err != nil {
			return fmt.Errorf("failed to marshal compensation metadata for user %d: %w", userID, err)
		}

		// Idempotent under Temporal retries: responseId is unique per
		// user/event response, so guard on it (no unique key exists, hence
		// WHERE NOT EXISTS rather than ON DUPLICATE KEY UPDATE).
		_, err = db.ExecContext(ctx, `
			INSERT INTO "drCompensation" ("userId", "eventId", "responseId", amount, currency, status, metadata)
			SELECT $1, $2, $3, $4, $5::"drCompensation_currency", 'pending', $6
			WHERE NOT EXISTS (
				SELECT 1 FROM "drCompensation" WHERE "responseId" = $3
			)
		`, userID, input.EventID, responseID, compensationCents, currency, string(metadata))
		if err != nil {
			return fmt.Errorf("failed to insert compensation for user %d: %w", userID, err)
		}

		// Record the earned compensation on the response row itself.
		_, err = db.ExecContext(ctx, `
			UPDATE "drResponses"
			SET compensation = $1, "completedAt" = COALESCE("completedAt", NOW()), "updatedAt" = NOW()
			WHERE id = $2
		`, compensationCents, responseID)
		if err != nil {
			return fmt.Errorf("failed to update compensation on response %d: %w", responseID, err)
		}

		log.Printf("[Activity] Compensation for user %d: %.3f kWh → %d %s cents", userID, energyKWh, compensationCents, currency)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("error iterating participant reductions: %w", err)
	}

	return nil
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

func main() {
	// RETIRED: the TypeScript workers own DR orchestration. The server
	// dispatches `orchestrateDREvent` on the `dr-orchestration` task queue
	// (server/integration/temporal-client.ts), served by
	// server/workflows/dr-worker.ts (deployed as `dr-worker` in
	// docker-compose.prod.yml). This worker polls `dr-events`, a queue
	// nothing publishes to, and registers `DREventWorkflow`, a type nothing
	// dispatches. It is no longer launched by any compose file and is kept
	// for reference only. Do not run it in production.
	log.Println("[DR Worker] RETIRED: TS workers own DR orchestration (queue dr-orchestration, workflow orchestrateDREvent); this worker polls dr-events, which nothing publishes to. Do not run in production.")

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
