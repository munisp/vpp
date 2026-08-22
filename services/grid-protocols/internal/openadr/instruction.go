package openadr

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ParseDuration parses the iCalendar/ISO-8601 durations OpenADR uses
// (PT1H, PT15M, PT30S, P1D and combinations). Unparsable durations are an
// error: a silently zero-length DR event would look like compliance with no
// load reduction at all.
func ParseDuration(value string) (time.Duration, error) {
	text := strings.TrimSpace(value)
	if text == "" {
		return 0, fmt.Errorf("empty duration")
	}
	negative := false
	if strings.HasPrefix(text, "-") {
		negative = true
		text = text[1:]
	}
	if !strings.HasPrefix(text, "P") {
		return 0, fmt.Errorf("duration %q does not start with P", value)
	}
	text = text[1:]

	var total time.Duration
	inTime := false
	components := 0
	number := strings.Builder{}

	for _, ch := range text {
		switch {
		case ch == 'T':
			inTime = true
			continue
		case ch >= '0' && ch <= '9':
			number.WriteRune(ch)
			continue
		}

		if number.Len() == 0 {
			return 0, fmt.Errorf("duration %q has unit %q without a value", value, string(ch))
		}
		amount, err := strconv.Atoi(number.String())
		if err != nil {
			return 0, fmt.Errorf("duration %q: %w", value, err)
		}
		number.Reset()
		components++

		switch ch {
		case 'W':
			total += time.Duration(amount) * 7 * 24 * time.Hour
		case 'D':
			total += time.Duration(amount) * 24 * time.Hour
		case 'H':
			if !inTime {
				return 0, fmt.Errorf("duration %q has H outside the time part", value)
			}
			total += time.Duration(amount) * time.Hour
		case 'M':
			if !inTime {
				// Calendar months have no fixed length; OpenADR event durations
				// must not be guessed at 30 days.
				return 0, fmt.Errorf("duration %q uses months, which have no fixed length", value)
			}
			total += time.Duration(amount) * time.Minute
		case 'S':
			if !inTime {
				return 0, fmt.Errorf("duration %q has S outside the time part", value)
			}
			total += time.Duration(amount) * time.Second
		case 'Y':
			return 0, fmt.Errorf("duration %q uses years, which have no fixed length", value)
		default:
			return 0, fmt.Errorf("duration %q has unknown unit %q", value, string(ch))
		}
	}

	if number.Len() != 0 {
		return 0, fmt.Errorf("duration %q ends with a value that has no unit", value)
	}
	if components == 0 {
		return 0, fmt.Errorf("duration %q contains no components", value)
	}
	if negative {
		total = -total
	}
	return total, nil
}

// toInstruction converts an oadrEvent into the platform's normalised form,
// resolving every interval to an absolute start time.
func toInstruction(event Event) (Instruction, error) {
	descriptor := event.EiEvent.EventDescriptor
	if descriptor.EventID == "" {
		return Instruction{}, fmt.Errorf("event has no eventID")
	}
	if descriptor.EventStatus == "" {
		return Instruction{}, fmt.Errorf("event %s has no eventStatus", descriptor.EventID)
	}

	properties := event.EiEvent.EiActivePeriod.Properties
	start, err := time.Parse(time.RFC3339, strings.TrimSpace(properties.DTStart.DateTime))
	if err != nil {
		return Instruction{}, fmt.Errorf("event %s has an unparsable dtstart %q: %w",
			descriptor.EventID, properties.DTStart.DateTime, err)
	}
	duration, err := ParseDuration(properties.Duration.Duration)
	if err != nil {
		return Instruction{}, fmt.Errorf("event %s: %w", descriptor.EventID, err)
	}

	signals := make([]Signal, 0, len(event.EiEvent.EiEventSignals.Signals))
	for _, raw := range event.EiEvent.EiEventSignals.Signals {
		if len(raw.Intervals.Intervals) == 0 {
			return Instruction{}, fmt.Errorf("event %s signal %s has no intervals",
				descriptor.EventID, raw.SignalID)
		}
		cursor := start
		intervals := make([]SignalInterval, 0, len(raw.Intervals.Intervals))
		for i, interval := range raw.Intervals.Intervals {
			intervalDuration, err := ParseDuration(interval.Duration.Duration)
			if err != nil {
				return Instruction{}, fmt.Errorf("event %s signal %s interval %d: %w",
					descriptor.EventID, raw.SignalID, i, err)
			}
			intervals = append(intervals, SignalInterval{
				UID:      interval.UID.Text,
				Start:    cursor,
				Duration: intervalDuration,
				Value:    interval.SignalPayload.PayloadFloat.Value,
			})
			cursor = cursor.Add(intervalDuration)
		}
		signals = append(signals, Signal{
			SignalID:   raw.SignalID,
			SignalName: raw.SignalName,
			SignalType: raw.SignalType,
			Intervals:  intervals,
		})
	}
	if len(signals) == 0 {
		return Instruction{}, fmt.Errorf("event %s carries no signals", descriptor.EventID)
	}

	instruction := Instruction{
		EventID:            descriptor.EventID,
		ModificationNumber: descriptor.ModificationNumber,
		MarketContext:      descriptor.MarketContext,
		Status:             descriptor.EventStatus,
		Priority:           descriptor.Priority,
		TestEvent:          strings.EqualFold(descriptor.TestEvent, "true"),
		Start:              start,
		Duration:           duration,
		Signals:            signals,
		ResponseRequired:   strings.EqualFold(event.ResponseRequired, "always"),
	}
	if target := event.EiEvent.EiTarget; target != nil {
		instruction.TargetVenIDs = target.VenIDs
		instruction.TargetResourceIDs = target.ResourceIDs
	}
	return instruction, nil
}
