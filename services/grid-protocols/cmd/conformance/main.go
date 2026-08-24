// Command conformance executes protocol test vectors against this service's
// adapters and, when pointed at the platform, records the result as evidence.
//
// It is the only way a protocol claim becomes "proven" in the platform: without
// a run, `der_capabilities.protocols` reads claimed_unproven, and no
// certification can be created.
//
// Runs against the in-process simulators by default. A device run is the same
// vector set pointed at real hardware, which the record distinguishes by target;
// a simulator pass is never evidence of device interoperability.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/vpp/grid-protocols/internal/conformance"
	"github.com/vpp/grid-protocols/internal/platform"
)

func main() {
	adapters := flag.String("adapters", "all", "comma-separated adapters to run, or \"all\"")
	operator := flag.String("operator", "", "who is accountable for this run (required)")
	adapterVersion := flag.String("adapter-version", "", "this service's build identifier (required)")
	deviceIdentifier := flag.String("device-identifier", "", "serial/LFDI of the unit under test, for a device run")
	platformURL := flag.String("platform-url", "", "platform base URL; runs are recorded when set")
	platformSecret := flag.String("platform-secret", os.Getenv("PLATFORM_SHARED_SECRET"), "platform shared secret (or PLATFORM_SHARED_SECRET)")
	caseTimeout := flag.Duration("case-timeout", 20*time.Second, "per-case timeout")
	output := flag.String("output", "", "write the runs as JSON to this path")
	flag.Parse()

	if err := run(*adapters, *operator, *adapterVersion, *deviceIdentifier,
		*platformURL, *platformSecret, *caseTimeout, *output); err != nil {
		fmt.Fprintf(os.Stderr, "conformance: %v\n", err)
		os.Exit(1)
	}
}

func run(
	adapterList, operator, adapterVersion, deviceIdentifier,
	platformURL, platformSecret string,
	caseTimeout time.Duration,
	outputPath string,
) error {
	if strings.TrimSpace(operator) == "" {
		return errors.New("-operator is required: an unattributed run is not evidence anybody can follow up on")
	}
	if strings.TrimSpace(adapterVersion) == "" {
		return errors.New("-adapter-version is required: a pass has to be tied to the code that earned it")
	}

	suites, err := selectSuites(adapterList)
	if err != nil {
		return err
	}

	var reporter conformance.Reporter
	if platformURL != "" {
		client, err := platform.NewClient(platform.Config{
			BaseURL:      platformURL,
			SharedSecret: platformSecret,
			Timeout:      30 * time.Second,
		})
		if err != nil {
			return err
		}
		reporter = client
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	runs := make([]conformance.Run, 0, len(suites))
	failures := 0

	for _, suite := range suites {
		result, err := conformance.Execute(ctx, suite, conformance.Options{
			Operator:         operator,
			AdapterVersion:   adapterVersion,
			DeviceIdentifier: deviceIdentifier,
			CaseTimeout:      caseTimeout,
		})
		if err != nil {
			return fmt.Errorf("executing %s: %w", suite.Adapter, err)
		}
		runs = append(runs, result)
		fmt.Println(result.Summary())
		for _, one := range result.Cases {
			if one.Outcome != conformance.Pass {
				fmt.Printf("  %s %s: %s — %s\n", one.Outcome, one.ID, one.Name, one.Detail)
			}
		}
		if !result.Passed() {
			failures++
		}

		if reporter != nil {
			receipt, err := reporter.ReportConformanceRun(ctx, result)
			if err != nil {
				// A run that was executed but not recorded must not look recorded:
				// the platform still reads the adapter as unproven, and saying
				// otherwise here is the failure mode this whole command exists to
				// remove.
				return fmt.Errorf("recording the %s run: %w", suite.Adapter, err)
			}
			fmt.Printf("  recorded as run %d (%s), checksum %s\n",
				receipt.RunID, receipt.Outcome, receipt.ArtifactChecksum)
		}
	}

	if outputPath != "" {
		body, err := json.MarshalIndent(runs, "", "  ")
		if err != nil {
			return err
		}
		if err := os.WriteFile(outputPath, body, 0o600); err != nil {
			return err
		}
	}

	if failures > 0 {
		return fmt.Errorf("%d of %d vector sets did not pass", failures, len(runs))
	}
	return nil
}

func selectSuites(list string) ([]conformance.Suite, error) {
	available := conformance.Suites()
	keys := make([]string, 0, len(available))
	for adapter := range available {
		keys = append(keys, string(adapter))
	}
	sort.Strings(keys)

	if strings.TrimSpace(list) == "" || list == "all" {
		suites := make([]conformance.Suite, 0, len(available))
		for _, key := range keys {
			suites = append(suites, available[conformance.Adapter(key)])
		}
		return suites, nil
	}

	suites := make([]conformance.Suite, 0)
	for _, raw := range strings.Split(list, ",") {
		name := strings.TrimSpace(raw)
		if name == "" {
			continue
		}
		suite, ok := available[conformance.Adapter(name)]
		if !ok {
			return nil, fmt.Errorf("no vector set for adapter %q; this build has %s",
				name, strings.Join(keys, ", "))
		}
		suites = append(suites, suite)
	}
	if len(suites) == 0 {
		return nil, errors.New("no adapters selected")
	}
	return suites, nil
}
