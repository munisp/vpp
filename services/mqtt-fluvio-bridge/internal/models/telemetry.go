package models

import (
	"encoding/json"
	"fmt"
	"time"
)

// TelemetryData represents IoT device telemetry
type TelemetryData struct {
	DeviceID     string    `json:"device_id"`
	AssetID      int       `json:"asset_id"`
	Timestamp    time.Time `json:"timestamp"`
	Power        float64   `json:"power"`         // W
	Energy       float64   `json:"energy"`        // Wh
	Voltage      float64   `json:"voltage"`       // V
	Current      float64   `json:"current"`       // A
	Frequency    float64   `json:"frequency"`     // Hz
	PowerFactor  float64   `json:"power_factor"`  // 0-1
	BatteryLevel *float64  `json:"battery_level,omitempty"` // % (optional)
}

// Validate checks if telemetry data is valid
func (t *TelemetryData) Validate() error {
	if t.DeviceID == "" {
		return fmt.Errorf("device_id is required")
	}
	if t.AssetID <= 0 {
		return fmt.Errorf("asset_id must be positive")
	}
	if t.Timestamp.IsZero() {
		return fmt.Errorf("timestamp is required")
	}
	if t.Power < 0 {
		return fmt.Errorf("power cannot be negative")
	}
	if t.Energy < 0 {
		return fmt.Errorf("energy cannot be negative")
	}
	if t.Voltage < 0 || t.Voltage > 1000 {
		return fmt.Errorf("voltage out of range (0-1000V)")
	}
	if t.Current < 0 || t.Current > 1000 {
		return fmt.Errorf("current out of range (0-1000A)")
	}
	if t.Frequency < 45 || t.Frequency > 65 {
		return fmt.Errorf("frequency out of range (45-65Hz)")
	}
	if t.PowerFactor < 0 || t.PowerFactor > 1 {
		return fmt.Errorf("power_factor out of range (0-1)")
	}
	if t.BatteryLevel != nil && (*t.BatteryLevel < 0 || *t.BatteryLevel > 100) {
		return fmt.Errorf("battery_level out of range (0-100%%)")
	}
	return nil
}

// ToJSON converts telemetry data to JSON bytes
func (t *TelemetryData) ToJSON() ([]byte, error) {
	return json.Marshal(t)
}

// FromJSON parses JSON bytes into telemetry data
func FromJSON(data []byte) (*TelemetryData, error) {
	var t TelemetryData
	if err := json.Unmarshal(data, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// DeviceCommand represents a command sent to an IoT device
type DeviceCommand struct {
	DeviceID   string                 `json:"device_id"`
	Command    string                 `json:"command"`
	Parameters map[string]interface{} `json:"parameters"`
	Timestamp  time.Time              `json:"timestamp"`
}

// SystemEvent represents a system-level event
type SystemEvent struct {
	EventType string                 `json:"event_type"`
	UserID    *int                   `json:"user_id,omitempty"`
	DeviceID  *string                `json:"device_id,omitempty"`
	Data      map[string]interface{} `json:"data"`
	Timestamp time.Time              `json:"timestamp"`
}
