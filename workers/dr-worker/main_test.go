package main

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
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
	mock.ExpectExec(`UPDATE "demandResponseEvents" SET status = \$1`).
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
	mock.ExpectExec(`UPDATE "demandResponseEvents"`).
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

	// Idempotent insert per user: positional args are ($1 event, $2 user, $3 status)
	for _, uid := range []int{10, 11} {
		mock.ExpectExec(`INSERT INTO "drResponses"`).
			WithArgs(99, uid, "auto_enrolled").
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

func TestEnrollParticipantsActivity_InsertErrorFailsActivity(t *testing.T) {
	mock := setupMockDB(t)
	rows := sqlmock.NewRows([]string{"id"}).AddRow(10)
	mock.ExpectQuery(`SELECT id FROM users`).WillReturnRows(rows)
	mock.ExpectExec(`INSERT INTO "drResponses"`).
		WillReturnError(fmt.Errorf("deadlock detected"))

	if _, err := EnrollParticipantsActivity(context.Background(), EnrollParticipantsInput{EventID: 1}); err == nil {
		t.Error("expected enrollment to fail so Temporal retries, got nil")
	}
}

// ---------------------------------------------------------------------------
// SendNotificationsActivity
// ---------------------------------------------------------------------------

func TestSendNotificationsActivity_InsertsRows(t *testing.T) {
	mock := setupMockDB(t)

	eventRows := sqlmock.NewRows([]string{"eventName", "startTime", "endTime"}).
		AddRow("Peak Reduction", time.Now(), time.Now().Add(time.Hour))
	mock.ExpectQuery(`SELECT "eventName", "startTime", "endTime" FROM "demandResponseEvents" WHERE id = \$1`).
		WithArgs(7).
		WillReturnRows(eventRows)

	partRows := sqlmock.NewRows([]string{"userId"}).AddRow(3).AddRow(4)
	mock.ExpectQuery(`SELECT "userId" FROM "drResponses"`).
		WithArgs(7).
		WillReturnRows(partRows)

	for range []int{3, 4} {
		mock.ExpectExec(`INSERT INTO alerts`).
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
	mock.ExpectQuery(`SELECT "eventName", "startTime", "endTime" FROM "demandResponseEvents"`).
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

	partRows := sqlmock.NewRows([]string{"userId"}).AddRow(5)
	mock.ExpectQuery(`SELECT "userId" FROM "drResponses"`).
		WithArgs(10).
		WillReturnRows(partRows)

	// Telemetry AVG — returns 2000W (target is 5000W → reduction = 3000W → 3 kW, score 60)
	telRows := sqlmock.NewRows([]string{"avg_power"}).AddRow(2000.0)
	mock.ExpectQuery(`SELECT AVG\(t.power\)`).
		WillReturnRows(telRows)

	mock.ExpectExec(`UPDATE "drResponses"`).
		WithArgs(3, 60, 10, 5).
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

func TestMonitorComplianceActivity_NoTelemetrySkipsUpdate(t *testing.T) {
	mock := setupMockDB(t)

	partRows := sqlmock.NewRows([]string{"userId"}).AddRow(5)
	mock.ExpectQuery(`SELECT "userId" FROM "drResponses"`).
		WithArgs(10).
		WillReturnRows(partRows)

	telRows := sqlmock.NewRows([]string{"avg_power"}).AddRow(nil)
	mock.ExpectQuery(`SELECT AVG\(t.power\)`).WillReturnRows(telRows)

	// No UPDATE expected: nothing to score without telemetry.
	if err := MonitorComplianceActivity(context.Background(), MonitorComplianceInput{
		EventID:  10,
		TargetKW: 5.0,
	}); err != nil {
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

	// 3 kW reduction over a one-hour event at 1000 c/kWh → 3000 cents.
	partRows := sqlmock.NewRows([]string{"id", "userId", "actualReduction", "currency"}).
		AddRow(500, 6, 3, "TZS")
	mock.ExpectQuery(`FROM "drResponses" r`).
		WithArgs(20).
		WillReturnRows(partRows)

	mock.ExpectExec(`INSERT INTO "drCompensation"`).
		WillReturnResult(sqlmock.NewResult(1, 1))
	mock.ExpectExec(`UPDATE "drResponses"`).
		WillReturnResult(sqlmock.NewResult(0, 1))

	start := time.Now().Add(-time.Hour)
	err := CalculateCompensationActivity(context.Background(), CalculateCompensationInput{
		EventID:          20,
		CompensationRate: 1000, // 1000 cents/kWh
		StartTime:        start,
		EndTime:          start.Add(time.Hour),
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

	partRows := sqlmock.NewRows([]string{"id", "userId", "actualReduction", "currency"}).
		AddRow(501, 7, 0, "NGN")
	mock.ExpectQuery(`FROM "drResponses" r`).
		WithArgs(21).
		WillReturnRows(partRows)

	// No INSERT should be called
	start := time.Now().Add(-time.Hour)
	err := CalculateCompensationActivity(context.Background(), CalculateCompensationInput{
		EventID:          21,
		CompensationRate: 500,
		StartTime:        start,
		EndTime:          time.Now(),
	})
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Errorf("unfulfilled expectations: %v", err)
	}
}

func TestWithUTCSession_RefusesADSNForAnotherDatabase(t *testing.T) {
	// lib/pq takes any scheme and fails per query, so this worker would stay up
	// reporting query errors instead of naming the setting at fault.
	if _, err := withUTCSession("mysql://vpp:vpp@127.0.0.1:3306/vpp"); err == nil {
		t.Fatal("expected a MySQL DSN to be refused")
	} else if !strings.Contains(err.Error(), "only in PostgreSQL") {
		t.Errorf("unexpected error: %v", err)
	}

	dsn, err := withUTCSession("postgresql://vpp:vpp@127.0.0.1:5432/vpp")
	if err != nil {
		t.Fatalf("unexpected error for a PostgreSQL DSN: %v", err)
	}
	if !strings.Contains(dsn, "timezone%3DUTC") && !strings.Contains(dsn, "timezone=UTC") {
		t.Errorf("expected the UTC session option, got %q", dsn)
	}
}
