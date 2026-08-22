package mqtt

import "strings"

// TopicMatches reports whether an MQTT topic name matches a subscription
// filter, applying the MQTT 3.1.1 wildcard rules: `+` matches exactly one
// level, `#` matches the remaining levels and is only valid as the last level.
func TopicMatches(filter, topic string) bool {
	filterLevels := strings.Split(filter, "/")
	topicLevels := strings.Split(topic, "/")

	for i, level := range filterLevels {
		if level == "#" {
			return i == len(filterLevels)-1
		}
		if i >= len(topicLevels) {
			return false
		}
		if level != "+" && level != topicLevels[i] {
			return false
		}
	}
	return len(filterLevels) == len(topicLevels)
}
