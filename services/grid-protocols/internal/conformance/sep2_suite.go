package conformance

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/vpp/grid-protocols/internal/sep2"
)

// The IEEE 2030.5 vector set runs this service's real client against a simulated
// utility server over genuine mutual TLS, because 2030.5 has no other
// authentication and a client that would accept a plain connection cannot
// receive DER controls at all.
//
// The cases target the arithmetic and precedence rules that a wrong client gets
// wrong silently: a power value is a multiplier-scaled integer (not watts), a
// percentage field is in hundredths of a percent, controls are ordered by
// primacy and then start time, and a control carrying no recognised setpoint
// must be refused rather than applied as "nothing".

type sep2Peer struct {
	client *sep2.Client
	server *sep2Simulator
}

// sep2Simulator serves a small 2030.5 resource tree. The bodies are literal XML
// so the cases test the client's decoding, not a shared Go struct that would
// hide a field-name mistake on both sides.
type sep2Simulator struct {
	server *httptest.Server

	mu sync.Mutex
	// controls is the DERControlList body served for the active program.
	controls string
	// mirrored records what the client posted, so a telemetry case can assert
	// what actually went on the wire.
	mirrored []string
}

func newSEP2Simulator() *sep2Simulator {
	sim := &sep2Simulator{}
	mux := http.NewServeMux()

	mux.HandleFunc("/dcap", func(w http.ResponseWriter, _ *http.Request) {
		writeXML(w, `<DeviceCapability xmlns="urn:ieee:std:2030.5:ns" href="/dcap">
  <EndDeviceListLink href="/edev" all="1"/>
  <DERProgramListLink href="/derp" all="1"/>
  <TimeLink href="/tm"/>
</DeviceCapability>`)
	})

	mux.HandleFunc("/edev", func(w http.ResponseWriter, _ *http.Request) {
		writeXML(w, `<EndDeviceList xmlns="urn:ieee:std:2030.5:ns" href="/edev" all="1" results="1">
  <EndDevice href="/edev/1">
    <lFDI>3E4F45AB31EDFE5B67E343E5E4562E31984E23E5</lFDI>
    <sFDI>167261211391</sFDI>
    <DERListLink href="/edev/1/der" all="1"/>
  </EndDevice>
</EndDeviceList>`)
	})

	mux.HandleFunc("/derp", func(w http.ResponseWriter, _ *http.Request) {
		writeXML(w, `<DERProgramList xmlns="urn:ieee:std:2030.5:ns" href="/derp" all="1" results="1">
  <DERProgram href="/derp/1">
    <mRID>4E1F2A3B4C5D6E7F</mRID>
    <description>Conformance program</description>
    <primacy>1</primacy>
    <DERControlListLink href="/derp/1/derc" all="2"/>
  </DERProgram>
</DERProgramList>`)
	})

	mux.HandleFunc("/derp/1/derc", func(w http.ResponseWriter, _ *http.Request) {
		sim.mu.Lock()
		body := sim.controls
		sim.mu.Unlock()
		if body == "" {
			writeXML(w, `<DERControlList xmlns="urn:ieee:std:2030.5:ns" href="/derp/1/derc" all="0" results="0"/>`)
			return
		}
		writeXML(w, body)
	})

	mux.HandleFunc("/mup/1", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		sim.mu.Lock()
		sim.mirrored = append(sim.mirrored, string(body))
		sim.mu.Unlock()
		w.WriteHeader(http.StatusCreated)
	})

	sim.server = httptest.NewUnstartedServer(mux)
	return sim
}

func writeXML(w http.ResponseWriter, body string) {
	w.Header().Set("Content-Type", "application/sep+xml")
	fmt.Fprint(w, `<?xml version="1.0" encoding="UTF-8"?>`+"\n"+body)
}

func (s *sep2Simulator) setControls(body string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.controls = body
}

func (s *sep2Simulator) posted() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.mirrored))
	copy(out, s.mirrored)
	return out
}

// selfSignedPair writes a certificate and key to dir and returns their paths.
// The suite generates its own material because 2030.5 requires client
// certificates: a run using no certificate would be testing a different
// protocol.
func selfSignedPair(dir, name string, isServer bool) (certPath, keyPath string, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return "", "", err
	}
	template := x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: name},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	if isServer {
		template.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
		template.DNSNames = []string{"localhost"}
		template.IPAddresses = append(template.IPAddresses, parseIPv4Loopback())
	} else {
		template.ExtKeyUsage = []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}
	}

	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		return "", "", err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return "", "", err
	}

	certPath = filepath.Join(dir, name+".crt")
	keyPath = filepath.Join(dir, name+".key")
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		return "", "", err
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		return "", "", err
	}
	return certPath, keyPath, nil
}

func parseIPv4Loopback() []byte {
	return []byte{127, 0, 0, 1}
}

func newSEP2Peer() (*sep2Peer, func(), error) {
	dir, err := os.MkdirTemp("", "sep2-conformance-")
	if err != nil {
		return nil, nil, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }

	serverCert, serverKey, err := selfSignedPair(dir, "server", true)
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	clientCert, clientKey, err := selfSignedPair(dir, "client", false)
	if err != nil {
		cleanup()
		return nil, nil, err
	}

	pair, err := tls.LoadX509KeyPair(serverCert, serverKey)
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	clientPEM, err := os.ReadFile(clientCert)
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	clientPool := x509.NewCertPool()
	if !clientPool.AppendCertsFromPEM(clientPEM) {
		cleanup()
		return nil, nil, errors.New("generated client certificate did not parse")
	}

	sim := newSEP2Simulator()
	sim.server.TLS = &tls.Config{
		Certificates: []tls.Certificate{pair},
		MinVersion:   tls.VersionTLS12,
		// The simulated utility requires a client certificate, as a 2030.5
		// server must: a run that passed without one would prove nothing about
		// how this client authenticates.
		ClientAuth: tls.RequireAndVerifyClientCert,
		ClientCAs:  clientPool,
	}
	sim.server.StartTLS()

	client, err := sep2.NewClient(sep2.Config{
		BaseURL:        sim.server.URL + "/dcap",
		ClientCertFile: clientCert,
		ClientKeyFile:  clientKey,
		CAFile:         serverCert,
		RequestTimeout: 5 * time.Second,
	})
	if err != nil {
		sim.server.Close()
		cleanup()
		return nil, nil, fmt.Errorf("client: %w", err)
	}

	return &sep2Peer{client: client, server: sim}, func() {
		sim.server.Close()
		cleanup()
	}, nil
}

// derControl renders one DERControl. The setpoint block is injected verbatim so
// a case can send an empty one.
func derControl(mrid string, start int64, duration int, primacyControl string) string {
	return fmt.Sprintf(`<DERControl href="/derp/1/derc/%s">
    <mRID>%s</mRID>
    <description>control %s</description>
    <EventStatus><currentStatus>1</currentStatus></EventStatus>
    <interval><start>%d</start><duration>%d</duration></interval>
    <DERControlBase>%s</DERControlBase>
  </DERControl>`, mrid, mrid, mrid, start, duration, primacyControl)
}

func controlList(controls ...string) string {
	body := `<DERControlList xmlns="urn:ieee:std:2030.5:ns" href="/derp/1/derc" all="` +
		fmt.Sprint(len(controls)) + `" results="` + fmt.Sprint(len(controls)) + `">`
	for _, one := range controls {
		body += "\n  " + one
	}
	return body + "\n</DERControlList>"
}

// SEP2Suite is the IEEE 2030.5 vector set.
func SEP2Suite() Suite {
	return Suite{
		Adapter:          AdapterIEEE2030_5,
		VectorSetID:      "vpp-ieee2030-5-der-client",
		VectorSetVersion: "1",
		ProtocolVersion:  "2030.5-2018",
		DeviceModel:      "vpp-ieee2030-5-utility-simulator",
		Setup: func(_ context.Context) (*Env, func(), error) {
			peer, teardown, err := newSEP2Peer()
			if err != nil {
				return nil, nil, err
			}
			return &Env{Peer: peer, Target: TargetSimulator}, teardown, nil
		},
		Cases: []Case{
			{
				ID:          "sep2-001-mutual-tls-required",
				Name:        "The client refuses to be built without a certificate",
				Requirement: "IEEE 2030.5-2018 §6.3: TLS with client certificates is the only authentication; an unauthenticated session cannot receive DER controls",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*sep2Peer)
					_, err := sep2.NewClient(sep2.Config{BaseURL: peer.server.server.URL + "/dcap"})
					if err == nil {
						return nil, errors.New("a client with no certificate was created")
					}
					_, httpErr := sep2.NewClient(sep2.Config{
						BaseURL:        "http://utility.example/dcap",
						ClientCertFile: "x",
						ClientKeyFile:  "y",
					})
					if httpErr == nil {
						return nil, errors.New("a plain-HTTP 2030.5 base URL was accepted")
					}
					return map[string]string{
						"no_certificate": err.Error(),
						"plain_http":     httpErr.Error(),
					}, nil
				},
			},
			{
				ID:          "sep2-002-lfdi-derivation",
				Name:        "The LFDI is the first 160 bits of the certificate's SHA-256",
				Requirement: "IEEE 2030.5-2018 §8.3.2: the LFDI is derived from the certificate; a wrong LFDI is a different device to the utility",
				Run: func(_ context.Context, env *Env) (any, error) {
					peer := env.Peer.(*sep2Peer)
					lfdi := peer.client.LFDI()
					if len(lfdi) != 40 {
						return lfdi, fmt.Errorf("LFDI is %d hex characters, expected 40 (160 bits)", len(lfdi))
					}
					for _, ch := range lfdi {
						if !((ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'F')) {
							return lfdi, fmt.Errorf("LFDI contains %q; it must be uppercase hex", string(ch))
						}
					}
					return map[string]string{"lfdi": lfdi}, nil
				},
			},
			{
				ID:          "sep2-003-device-capability-walk",
				Name:        "The client walks dcap to its end devices over mutual TLS",
				Requirement: "IEEE 2030.5-2018 §10.2: DeviceCapability is the entry point; every other resource is reached by following its links",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*sep2Peer)
					dcap, err := peer.client.DeviceCapability(ctx)
					if err != nil {
						return nil, err
					}
					devices, err := peer.client.EndDevices(ctx, dcap)
					if err != nil {
						return nil, err
					}
					if len(devices) != 1 {
						return devices, fmt.Errorf("server listed 1 end device, client found %d", len(devices))
					}
					if devices[0].LFDI == "" {
						return devices[0], errors.New("end device arrived with no LFDI")
					}
					return devices[0], nil
				},
			},
			{
				ID:          "sep2-004-active-power-scaling",
				Name:        "opModTargetW is scaled by its multiplier into watts",
				Requirement: "IEEE 2030.5-2018 §B.2.3.6: ActivePower is value × 10^multiplier; reading the raw value would dispatch 5 W as 5000 W or the reverse",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*sep2Peer)
					start := time.Now().Add(time.Minute).Unix()
					peer.server.setControls(controlList(derControl("CTRL-SCALE", start, 900,
						`<opModTargetW><multiplier>3</multiplier><value>5</value></opModTargetW>`)))

					dcap, err := peer.client.DeviceCapability(ctx)
					if err != nil {
						return nil, err
					}
					instructions, errs, err := peer.client.ActiveControls(ctx, dcap)
					if err != nil {
						return nil, err
					}
					if len(errs) > 0 {
						return errs, fmt.Errorf("client reported %d control errors: %v", len(errs), errs[0])
					}
					if len(instructions) != 1 {
						return instructions, fmt.Errorf("expected 1 instruction, got %d", len(instructions))
					}
					got := instructions[0]
					if got.TargetWatts == nil {
						return got, errors.New("instruction carries no target watts")
					}
					if *got.TargetWatts != 5000 {
						return got, fmt.Errorf("5 × 10^3 W was read as %v W", *got.TargetWatts)
					}
					return map[string]any{"target_watts": *got.TargetWatts}, nil
				},
			},
			{
				ID:          "sep2-005-percentage-hundredths",
				Name:        "opModMaxLimW is read as hundredths of a percent",
				Requirement: "IEEE 2030.5-2018 §B.2.3.10: Percent is expressed in hundredths of a percent; 8000 is 80%, not 8000%",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*sep2Peer)
					start := time.Now().Add(time.Minute).Unix()
					peer.server.setControls(controlList(derControl("CTRL-PERCENT", start, 900,
						`<opModMaxLimW>8000</opModMaxLimW>`)))

					dcap, err := peer.client.DeviceCapability(ctx)
					if err != nil {
						return nil, err
					}
					instructions, _, err := peer.client.ActiveControls(ctx, dcap)
					if err != nil {
						return nil, err
					}
					if len(instructions) != 1 {
						return instructions, fmt.Errorf("expected 1 instruction, got %d", len(instructions))
					}
					got := instructions[0]
					if got.MaxLimitPercent == nil {
						return got, errors.New("instruction carries no max limit percentage")
					}
					if *got.MaxLimitPercent != 80 {
						return got, fmt.Errorf("8000 hundredths of a percent was read as %v%%", *got.MaxLimitPercent)
					}
					return map[string]any{"max_limit_percent": *got.MaxLimitPercent}, nil
				},
			},
			{
				ID:          "sep2-006-empty-control-base-refused",
				Name:        "A control with no recognised setpoint is refused, not applied as nothing",
				Requirement: "IEEE 2030.5-2018 §10.10: a DERControl carries a DERControlBase; applying an empty one while reporting success would silently ignore a utility instruction",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*sep2Peer)
					start := time.Now().Add(time.Minute).Unix()
					peer.server.setControls(controlList(derControl("CTRL-EMPTY", start, 900, "")))

					dcap, err := peer.client.DeviceCapability(ctx)
					if err != nil {
						return nil, err
					}
					instructions, errs, err := peer.client.ActiveControls(ctx, dcap)
					if err != nil {
						return nil, err
					}
					if len(instructions) != 0 {
						return instructions, errors.New("a control with no setpoint was returned as an instruction")
					}
					if len(errs) == 0 {
						return nil, errors.New("a control with no setpoint was dropped without an error the operator can see")
					}
					return map[string]string{"error": errs[0].Error()}, nil
				},
			},
			{
				ID:          "sep2-007-primacy-then-start-order",
				Name:        "Controls are ordered by primacy, then by start time",
				Requirement: "IEEE 2030.5-2018 §10.10: lower primacy wins; equal primacy is resolved by start time. Wrong order applies the wrong limit",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*sep2Peer)
					base := time.Now().Add(time.Minute).Unix()
					peer.server.setControls(controlList(
						derControl("CTRL-LATER", base+600, 900, `<opModTargetW><multiplier>0</multiplier><value>2000</value></opModTargetW>`),
						derControl("CTRL-EARLIER", base, 900, `<opModTargetW><multiplier>0</multiplier><value>1000</value></opModTargetW>`),
					))

					dcap, err := peer.client.DeviceCapability(ctx)
					if err != nil {
						return nil, err
					}
					instructions, _, err := peer.client.ActiveControls(ctx, dcap)
					if err != nil {
						return nil, err
					}
					if len(instructions) != 2 {
						return instructions, fmt.Errorf("expected 2 instructions, got %d", len(instructions))
					}
					if instructions[0].MRID != "CTRL-EARLIER" {
						return instructions, fmt.Errorf("first instruction is %s; equal primacy should order by start time", instructions[0].MRID)
					}
					return []string{instructions[0].MRID, instructions[1].MRID}, nil
				},
			},
			{
				ID:          "sep2-008-mirror-reading-posted",
				Name:        "A mirrored meter reading reaches the server as 2030.5 XML",
				Requirement: "IEEE 2030.5-2018 §10.13: telemetry is mirrored to a MirrorUsagePoint; a reading the utility never received is not reported telemetry",
				Run: func(ctx context.Context, env *Env) (any, error) {
					peer := env.Peer.(*sep2Peer)
					err := peer.client.PostMirrorReading(ctx, "/mup/1", sep2.MirrorMeterReading{
						MRID: "READING-1",
						Reading: &sep2.Reading{
							Value:      4200,
							TimePeriod: &sep2.DateTimeInterval{Start: time.Now().Unix(), Duration: 300},
						},
					})
					if err != nil {
						return nil, err
					}
					posted := peer.server.posted()
					if len(posted) == 0 {
						return nil, errors.New("the client reported success but the server received nothing")
					}
					body := posted[len(posted)-1]
					if !containsAll(body, "MirrorMeterReading", "4200") {
						return body, errors.New("the posted body does not carry the reading")
					}
					return map[string]any{"body_bytes": len(body)}, nil
				},
			},
		},
	}
}

func containsAll(body string, needles ...string) bool {
	for _, needle := range needles {
		if !strings.Contains(body, needle) {
			return false
		}
	}
	return true
}
