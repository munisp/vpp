package stream

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"sync"

	"github.com/sirupsen/logrus"
	"github.com/vpp/mqtt-fluvio-bridge/config"
)

// keySeparator splits key from value on `fluvio produce` stdin. ASCII unit
// separator never appears in compact JSON or in a device id, both of which are
// rejected below if they contain it.
const keySeparator = "\x1f"

// FluvioProducer publishes telemetry through the `fluvio` CLI.
//
// InfinyOn ships no Go SDK, so the CLI is the supported integration path for a
// Go service. Each publish is a `fluvio produce` invocation whose exit status is
// the delivery acknowledgement.
type FluvioProducer struct {
	cfg    *config.FluvioConfig
	logger *logrus.Logger
	// mu serialises CLI invocations: the CLI mutates ~/.fluvio state and
	// concurrent produces from one process gain nothing over batching.
	mu sync.Mutex
}

// NewFluvioProducer resolves the CLI and the cluster it is pointed at.
func NewFluvioProducer(cfg *config.FluvioConfig, logger *logrus.Logger) (*FluvioProducer, error) {
	cliPath := cfg.CLIPath
	if cliPath == "" {
		cliPath = "fluvio"
	}
	resolved, err := exec.LookPath(cliPath)
	if err != nil {
		return nil, fmt.Errorf("fluvio CLI %q not found: install it (https://www.fluvio.io/docs/fluvio/cli/overview) or set fluvio.cli_path: %w", cliPath, err)
	}

	producer := &FluvioProducer{cfg: cfg, logger: logger}
	producer.cfg.CLIPath = resolved

	if cfg.Profile != "" {
		current, err := producer.run(context.Background(), nil, "profile", "current")
		if err != nil {
			return nil, fmt.Errorf("fluvio profile current: %w", err)
		}
		if got := strings.TrimSpace(current); got != cfg.Profile {
			// There is no per-command profile flag, so a mismatch means records
			// would go to a different cluster than the one configured.
			return nil, fmt.Errorf("fluvio active profile is %q but fluvio.profile is %q: run `fluvio profile switch %s`", got, cfg.Profile, cfg.Profile)
		}
	}

	logger.Infof("Fluvio: using CLI %s (endpoint %s)", resolved, cfg.Endpoint)
	return producer, nil
}

func (p *FluvioProducer) Transport() config.Transport { return config.TransportFluvio }

func (p *FluvioProducer) Send(ctx context.Context, topic string, key string, value []byte) error {
	return p.SendBatch(ctx, topic, []Record{{Key: key, Value: value}})
}

// SendBatch produces every record in one CLI invocation, one line per record.
func (p *FluvioProducer) SendBatch(ctx context.Context, topic string, records []Record) error {
	if topic == "" {
		return errors.New("fluvio topic is empty")
	}
	if len(records) == 0 {
		return nil
	}

	var stdin bytes.Buffer
	for _, record := range records {
		if err := validateRecord(record); err != nil {
			return err
		}
		stdin.WriteString(record.Key)
		stdin.WriteString(keySeparator)
		stdin.Write(record.Value)
		stdin.WriteByte('\n')
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	out, err := p.run(ctx, stdin.Bytes(), "produce", topic, "--key-separator", keySeparator)
	if err != nil {
		return fmt.Errorf("fluvio produce to %s: %w", topic, err)
	}
	// The CLI prints one "Ok!" per accepted record; fewer means some records
	// were not acknowledged, which must not be reported as a success.
	if acked := strings.Count(out, "Ok!"); acked > 0 && acked < len(records) {
		return fmt.Errorf("fluvio produce to %s: %d of %d records acknowledged", topic, acked, len(records))
	}
	return nil
}

// EnsureTopics fails unless every topic exists, creating them only when
// fluvio.create_missing_topics is enabled.
func (p *FluvioProducer) EnsureTopics(ctx context.Context, topics []string) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	out, err := p.run(ctx, nil, "topic", "list")
	if err != nil {
		return fmt.Errorf("fluvio topic list: %w", err)
	}
	existing := parseTopicList(out)

	for _, topic := range topics {
		if existing[topic] {
			continue
		}
		if !p.cfg.CreateMissingTopics {
			return fmt.Errorf("fluvio topic %q does not exist and fluvio.create_missing_topics is false", topic)
		}
		if _, err := p.run(ctx, nil, "topic", "create", topic,
			"--partitions", fmt.Sprint(p.cfg.Partitions)); err != nil {
			return fmt.Errorf("fluvio topic create %s: %w", topic, err)
		}
		p.logger.Infof("Fluvio: created topic %s (%d partitions)", topic, p.cfg.Partitions)
	}
	return nil
}

// Close has nothing to release: each publish is its own short-lived process.
func (p *FluvioProducer) Close() error { return nil }

func (p *FluvioProducer) run(ctx context.Context, stdin []byte, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, p.cfg.CLIPath, args...)
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = strings.TrimSpace(stdout.String())
		}
		if message != "" {
			return stdout.String(), fmt.Errorf("%w: %s", err, message)
		}
		return stdout.String(), err
	}
	return stdout.String(), nil
}

func validateRecord(record Record) error {
	if strings.ContainsAny(record.Key, keySeparator+"\n") {
		return fmt.Errorf("record key %q contains a reserved delimiter", record.Key)
	}
	if bytes.ContainsAny(record.Value, keySeparator+"\n") {
		return errors.New("record value contains a newline or unit separator: it cannot be produced as a single CLI record")
	}
	return nil
}

// parseTopicList reads topic names from the first column of `fluvio topic list`.
func parseTopicList(out string) map[string]bool {
	topics := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if fields[0] == "NAME" {
			continue
		}
		topics[fields[0]] = true
	}
	return topics
}
