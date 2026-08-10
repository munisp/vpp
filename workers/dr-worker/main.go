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
	EventID       int       `json:"eventId"`
	StartTime     time.Time `json:"startTime"`
	EndTime       time.Time `json:"endTime"`
	TargetKW      float64   `json:"targetKw"`
	CompensationRate int    `json:"compensationRate"` // cents per kWh
	AutoEnroll    bool      `json:"autoEnroll"`
}

// DR Event Workflow Result
type DREventWorkflowResult struct {
	Success          bool   `json:"success"`
	EventID          int    `json:"eventId"`
	ParticipantsEnrolled int `json:"participantsEnrolled"`
	NotificationsSent    int `json:"notificationsSent"`
	Error            string `json:"error,omitempty"`
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

	// Test connection
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

	result := DREventWorkflowResult{
		EventID: input.EventID,
	}

	// Step 1: Update event status to active
	err := workflow.ExecuteActivity(ctx, UpdateEventStatusActivity, input.EventID, "active").Get(ctx, nil)
	if err != nil {
		logger.Error("Failed to update event status", "error", err)
		result.Error = err.Error()
		return result, err
	}

	// Step 2: Enroll participants
	var enrollResult EnrollParticipantsResult
	err = workflow.ExecuteActivity(ctx, EnrollParticipantsActivity, EnrollParticipantsInput{
		EventID:    input.EventID,
		AutoEnroll: input.AutoEnroll,
	}).Get(ctx, &enrollResult)
	
	if err != nil {
		logger.Error("Failed to enroll participants", "error", err)
		result.Error = err.Error()
		return result, err
	}
	
	result.ParticipantsEnrolled = enrollResult.ParticipantCount

	// Step 3: Send notifications
	var notifResult SendNotificationsResult
	err = workflow.ExecuteActivity(ctx, SendNotificationsActivity, SendNotificationsInput{
		EventID: input.EventID,
		Type:    "event_start",
	}).Get(ctx, &notifResult)
	
	if err != nil {
		logger.Warn("Failed to send notifications", "error", err)
		// Don't fail workflow on notification errors
	} else {
		result.NotificationsSent = notifResult.SentCount
	}

	// Step 4: Wait for event start time
	if time.Now().Before(input.StartTime) {
		waitDuration := input.StartTime.Sub(time.Now())
		logger.Info("Waiting for event start", "duration", waitDuration)
		err = workflow.Sleep(ctx, waitDuration)
		if err != nil {
			logger.Error("Sleep interrupted", "error", err)
			return result, err
		}
	}

	// Step 5: Monitor event during execution
	eventDuration := input.EndTime.Sub(input.StartTime)
	monitorInterval := 5 * time.Minute
	
	for elapsed := time.Duration(0); elapsed < eventDuration; elapsed += monitorInterval {
		// Monitor participant compliance
		err = workflow.ExecuteActivity(ctx, MonitorComplianceActivity, input.EventID).Get(ctx, nil)
		if err != nil {
			logger.Warn("Compliance monitoring error", "error", err)
		}
		
		// Sleep until next check
		if elapsed+monitorInterval < eventDuration {
			workflow.Sleep(ctx, monitorInterval)
		}
	}

	// Step 6: Calculate compensation
	err = workflow.ExecuteActivity(ctx, CalculateCompensationActivity, CalculateCompensationInput{
		EventID:          input.EventID,
		CompensationRate: input.CompensationRate,
	}).Get(ctx, nil)
	
	if err != nil {
		logger.Error("Failed to calculate compensation", "error", err)
		result.Error = err.Error()
		return result, err
	}

	// Step 7: Update event status to completed
	err = workflow.ExecuteActivity(ctx, UpdateEventStatusActivity, input.EventID, "completed").Get(ctx, nil)
	if err != nil {
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

// Activity Input/Output Types
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

type CalculateCompensationInput struct {
	EventID          int `json:"eventId"`
	CompensationRate int `json:"compensationRate"`
}

// Activities
func UpdateEventStatusActivity(ctx context.Context, eventID int, status string) error {
	log.Printf("[Activity] Updating event %d status to %s", eventID, status)
	
	_, err := db.Exec(
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
	
	// Get eligible participants
	rows, err := db.Query(`
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
		
		// Enroll participant in event
		_, err = db.Exec(`
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

func SendNotificationsActivity(ctx context.Context, input SendNotificationsInput) (SendNotificationsResult, error) {
	log.Printf("[Activity] Sending %s notifications for event %d", input.Type, input.EventID)
	
	// TODO: Implement actual notification sending
	// For now, just log
	result := SendNotificationsResult{SentCount: 0}
	
	return result, nil
}

func MonitorComplianceActivity(ctx context.Context, eventID int) error {
	log.Printf("[Activity] Monitoring compliance for event %d", eventID)
	
	// TODO: Implement compliance monitoring
	// Query telemetry data and check participant reduction
	
	return nil
}

func CalculateCompensationActivity(ctx context.Context, input CalculateCompensationInput) error {
	log.Printf("[Activity] Calculating compensation for event %d", input.EventID)
	
	// TODO: Implement compensation calculation
	// Query actual reduction from telemetry and calculate payment
	
	return nil
}

func main() {
	// Initialize database
	if err := initDB(); err != nil {
		log.Fatal("Failed to initialize database:", err)
	}
	defer db.Close()

	// Create Temporal client
	temporalAddress := os.Getenv("TEMPORAL_ADDRESS")
	if temporalAddress == "" {
		temporalAddress = "localhost:7233"
	}

	c, err := client.Dial(client.Options{
		HostPort: temporalAddress,
	})
	if err != nil {
		log.Fatal("Unable to create Temporal client:", err)
	}
	defer c.Close()

	// Create worker
	w := worker.New(c, "dr-events", worker.Options{})

	// Register workflows and activities
	w.RegisterWorkflow(DREventWorkflow)
	w.RegisterActivity(UpdateEventStatusActivity)
	w.RegisterActivity(EnrollParticipantsActivity)
	w.RegisterActivity(SendNotificationsActivity)
	w.RegisterActivity(MonitorComplianceActivity)
	w.RegisterActivity(CalculateCompensationActivity)

	log.Println("[DR Worker] Starting worker on task queue: dr-events")

	// Start worker
	err = w.Run(worker.InterruptCh())
	if err != nil {
		log.Fatal("Unable to start worker:", err)
	}

	log.Println("[DR Worker] Worker stopped")
}
