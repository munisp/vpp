package mqtt

import "testing"

func TestTopicMatches(t *testing.T) {
	cases := []struct {
		filter string
		topic  string
		want   bool
	}{
		{"vpp/telemetry/+", "vpp/telemetry/meter-1", true},
		{"vpp/telemetry/+", "vpp/telemetry/meter-1/extra", false},
		{"vpp/telemetry/+", "vpp/telemetry", false},
		{"vpp/devices/+/status", "vpp/devices/meter-1/status", true},
		{"vpp/devices/+/status", "vpp/devices/meter-1/health", false},
		{"vpp/#", "vpp/telemetry/meter-1/raw", true},
		{"vpp/#", "grid/telemetry", false},
		{"vpp/telemetry/meter-1", "vpp/telemetry/meter-1", true},
	}

	for _, tc := range cases {
		if got := TopicMatches(tc.filter, tc.topic); got != tc.want {
			t.Errorf("TopicMatches(%q, %q) = %v, want %v", tc.filter, tc.topic, got, tc.want)
		}
	}
}
