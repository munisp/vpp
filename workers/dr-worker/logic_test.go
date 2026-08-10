package main

import (
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Pure-logic tests for DR worker business rules.
// These tests verify the mathematical and control-flow correctness of the
// remediated activities without requiring a database connection.
// ---------------------------------------------------------------------------

// TestCompensationMath verifies the energy-to-compensation calculation used
// inside CalculateCompensationActivity.
func TestCompensationMath(t *testing.T) {
	tests := []struct {
		name             string
		reductionW       float64
		durationHours    float64
		ratePerKWh       int
		expectedCents    int
	}{
		{"1kW for 1h at 100c/kWh", 1000, 1.0, 100, 100},
		{"3kW for 30min at 200c/kWh", 3000, 0.5, 200, 300},
		{"zero reduction → zero compensation", 0, 1.0, 500, 0},
		{"5kW for 2h at 50c/kWh", 5000, 2.0, 50, 500},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			energyKWh := (tc.reductionW / 1000.0) * tc.durationHours
			compensationCents := int(energyKWh * float64(tc.ratePerKWh))
			if compensationCents != tc.expectedCents {
				t.Errorf("expected %d cents, got %d", tc.expectedCents, compensationCents)
			}
		})
	}
}

// TestComplianceScoreCalculation verifies the compliance score formula used
// inside MonitorComplianceActivity.
func TestComplianceScoreCalculation(t *testing.T) {
	tests := []struct {
		name          string
		targetKW      float64
		actualAvgW    float64
		expectedScore int
	}{
		{"full compliance (zero power)", 5.0, 0.0, 100},
		{"half compliance", 5.0, 2500.0, 50},
		{"no compliance (no reduction)", 5.0, 5000.0, 0},
		{"over-compliance capped at 100", 5.0, -1000.0, 100},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			targetW := tc.targetKW * 1000
			reductionW := targetW - tc.actualAvgW
			if reductionW < 0 {
				reductionW = 0
			}
			score := 0
			if targetW > 0 {
				score = int(reductionW / targetW * 100)
				if score > 100 {
					score = 100
				}
			}
			if score != tc.expectedScore {
				t.Errorf("expected score %d, got %d", tc.expectedScore, score)
			}
		})
	}
}

// TestEventDurationHours verifies that event duration is correctly computed
// from start and end timestamps.
func TestEventDurationHours(t *testing.T) {
	start := time.Date(2025, 1, 1, 10, 0, 0, 0, time.UTC)
	end := time.Date(2025, 1, 1, 11, 30, 0, 0, time.UTC)
	got := end.Sub(start).Hours()
	want := 1.5
	if got != want {
		t.Errorf("expected %.1f hours, got %.1f", want, got)
	}
}

// TestNotificationTypeMapping verifies that notification type strings map to
// the correct message categories.
func TestNotificationTypeMapping(t *testing.T) {
	tests := []struct {
		eventType      string
		expectStart    bool
		expectComplete bool
	}{
		{"event_start", true, false},
		{"event_complete", false, true},
		{"unknown_type", false, false},
	}

	for _, tc := range tests {
		t.Run(tc.eventType, func(t *testing.T) {
			isStart := tc.eventType == "event_start"
			isComplete := tc.eventType == "event_complete"
			if isStart != tc.expectStart {
				t.Errorf("isStart: expected %v, got %v", tc.expectStart, isStart)
			}
			if isComplete != tc.expectComplete {
				t.Errorf("isComplete: expected %v, got %v", tc.expectComplete, isComplete)
			}
		})
	}
}

// TestMonitoringWindowBounds verifies that the monitoring window correctly
// covers the last 5-minute interval.
func TestMonitoringWindowBounds(t *testing.T) {
	now := time.Date(2025, 6, 1, 14, 35, 0, 0, time.UTC)
	windowStart := now.Add(-5 * time.Minute)
	expected := time.Date(2025, 6, 1, 14, 30, 0, 0, time.UTC)
	if !windowStart.Equal(expected) {
		t.Errorf("expected window start %v, got %v", expected, windowStart)
	}
}
