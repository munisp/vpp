package main

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// setupMockDB replaces the global db with a sqlmock instance and returns
// the mock controller so tests can set expectations.
func setupMockDB(t *testing.T) sqlmock.Sqlmock {
	t.Helper()
	mockDB, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("failed to create sqlmock: %v", err)
	}
	db = mockDB
	t.Cleanup(func() { mockDB.Close() })
	return mock
}

// ---------------------------------------------------------------------------
// UpdateEventStatusActivity
// ---------------------------------------------------------------------------

func TestUpdateEventStatusActivity_Success(t *testing.T) {
	mock := setupMockDB(t)
	mock.ExpectExec(regexp.QuoteMeta("UPDATE demand_response_events SET status = ?, updatedAt = NOW() WHERE id = ?")).
		WithArgs("active", 42).
		WillReturnResult(sqlmock.NewResult(1, 1))

	err := UpdateEventStatusActivity(context.Background(), 42, "active")
	if err != nil {
		t.Errorf("expected no error, got: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}

func TestUpdateEventStatusActivity_DBError(t *testing.T) {
	mock := setupMockDB(t)
	mock.ExpectExec(regexp.QuoteMeta("UPDATE demand_response_events SET status = ?, updatedAt = NOW() WHERE id = ?")).
		WithArgs("active", 1).
		WillReturnError(fmt.Errorf("connection refused"))

	err := UpdateEventStatusActivity(context.Background(), 1, "active")
	if err == nil {
		t.Error("expected an error but got nil")
	}
}

// ---------------------------------------------------------------------------
// EnrollParticipantsActivity
// ---------------------------------------------------------------------------

func TestEnrollParticipantsActivity_EnrollsUsers(t *testing.T) {
	mock := setupMockDB(t)

	// Return two eligible users
	rows := sqlmock.NewRows([]string{"id"}).AddRow(10).AddRow(11)
	mock.ExpectQuery(`SELECT id FROM users`).WillReturnRows(rows)

	// Expect two INSERT statements
	for _, uid := range []int{10, 11} {
		mock.ExpectExec(regexp.QuoteMeta("INSERT INTO dr_event_participants")).
			WithArgs(99, uid).
			WillReturnResult(sqlmock.NewResult(1, 1))
	}

	result, err := EnrollParticipantsActivity(context.Background(), EnrollParticipantsInput{
		EventID:    99,
		AutoEnroll: true,
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ParticipantCount != 2 {
		t.Errorf("expected 2 participants, got %d", result.ParticipantCount)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}

func TestEnrollParticipantsActivity_NoEligibleUsers(t *testing.T) {
	mock := setupMockDB(t)
	rows := sqlmock.NewRows([]string{"id"}) // empty
	mock.ExpectQuery(`SELECT id FROM users`).WillReturnRows(rows)

	result, err := EnrollParticipantsActivity(context.Background(), EnrollParticipantsInput{EventID: 5})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ParticipantCount != 0 {
		t.Errorf("expected 0 participants, got %d", result.ParticipantCount)
	}
}

// ---------------------------------------------------------------------------
// SendNotificationsActivity
// ---------------------------------------------------------------------------

func TestSendNotificationsActivity_InsertsRows(t *testing.T) {
	mock := setupMockDB(t)

	// Event details query
	eventRows := sqlmock.NewRows([]string{"title", "startTime", "endTime"}).
		AddRow("Peak Reduction", time.Now(), time.Now().Add(time.Hour))
	mock.ExpectQuery(regexp.QuoteMeta("SELECT title, startTime, endTime FROM demand_response_events WHERE id = ?")).
		WithArgs(7).
		WillReturnRows(eventRows)

	// Participants query
	partRows := sqlmock.NewRows([]string{"userId"}).AddRow(3).AddRow(4)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT userId FROM dr_event_participants WHERE eventId = ? AND status = 'enrolled'")).
		WithArgs(7).
		WillReturnRows(partRows)

	// Two INSERT notifications
	for range []int{3, 4} {
		mock.ExpectExec(regexp.QuoteMeta("INSERT INTO notifications")).
			WillReturnResult(sqlmock.NewResult(1, 1))
	}

	result, err := SendNotificationsActivity(context.Background(), SendNotificationsInput{
		EventID: 7,
		Type:    "event_start",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.SentCount != 2 {
		t.Errorf("expected SentCount=2, got %d", result.SentCount)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}

func TestSendNotificationsActivity_EventNotFound(t *testing.T) {
	mock := setupMockDB(t)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT title, startTime, endTime FROM demand_response_events WHERE id = ?")).
		WithArgs(999).
		WillReturnError(sql.ErrNoRows)

	_, err := SendNotificationsActivity(context.Background(), SendNotificationsInput{EventID: 999, Type: "event_start"})
	if err == nil {
		t.Error("expected error for missing event, got nil")
	}
}

// ---------------------------------------------------------------------------
// MonitorComplianceActivity
// ---------------------------------------------------------------------------

func TestMonitorComplianceActivity_UpdatesCompliance(t *testing.T) {
	mock := setupMockDB(t)

	// Participants
	partRows := sqlmock.NewRows([]string{"userId"}).AddRow(5)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT userId FROM dr_event_participants WHERE eventId = ? AND status = 'enrolled'")).
		WithArgs(10).
		WillReturnRows(partRows)

	// Asset lookup
	assetRows := sqlmock.NewRows([]string{"id"}).AddRow(101)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT id FROM assets WHERE userId = ?")).
		WithArgs(5).
		WillReturnRows(assetRows)

	// Telemetry AVG — returns 2000W (target is 5000W → reduction = 3000W)
	telRows := sqlmock.NewRows([]string{"avg_power"}).AddRow(2000.0)
	mock.ExpectQuery(regexp.QuoteMeta("SELECT AVG(t.power)")).
		WillReturnRows(telRows)

	// Compliance UPDATE
	mock.ExpectExec(regexp.QuoteMeta("UPDATE dr_event_participants")).
		WillReturnResult(sqlmock.NewResult(0, 1))

	err := MonitorComplianceActivity(context.Background(), MonitorComplianceInput{
		EventID:   10,
		TargetKW:  5.0,
		StartTime: time.Now().Add(-10 * time.Minute),
	})
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}

// ---------------------------------------------------------------------------
// CalculateCompensationActivity
// ---------------------------------------------------------------------------

func TestCalculateCompensationActivity_InsertsCompensation(t *testing.T) {
	mock := setupMockDB(t)

	// Participants with actual reduction
	partRows := sqlmock.NewRows([]string{"userId", "actualReduction"}).
		AddRow(6, 3000.0) // 3000W reduction
	mock.ExpectQuery(regexp.QuoteMeta("SELECT userId, actualReduction FROM dr_event_participants")).
		WithArgs(20).
		WillReturnRows(partRows)

	// INSERT compensation
	mock.ExpectExec(regexp.QuoteMeta("INSERT INTO dr_compensation")).
		WillReturnResult(sqlmock.NewResult(1, 1))

	start := time.Now().Add(-time.Hour)
	end := time.Now()
	err := CalculateCompensationActivity(context.Background(), CalculateCompensationInput{
		EventID:          20,
		CompensationRate: 1000, // 1000 cents/kWh
		StartTime:        start,
		EndTime:          end,
	})
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}

func TestCalculateCompensationActivity_SkipsZeroReduction(t *testing.T) {
	mock := setupMockDB(t)

	partRows := sqlmock.NewRows([]string{"userId", "actualReduction"}).
		AddRow(7, 0.0) // zero reduction → no compensation
	mock.ExpectQuery(regexp.QuoteMeta("SELECT userId, actualReduction FROM dr_event_participants")).
		WithArgs(21).
		WillReturnRows(partRows)

	// No INSERT should be called
	start := time.Now().Add(-time.Hour)
	end := time.Now()
	err := CalculateCompensationActivity(context.Background(), CalculateCompensationInput{
		EventID:          21,
		CompensationRate: 500,
		StartTime:        start,
		EndTime:          end,
	})
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}
