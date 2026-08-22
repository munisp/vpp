package sep2

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writeCertificate creates a self-signed certificate/key pair on disk and
// returns their paths plus the PEM bytes.
func writeCertificate(t *testing.T, dir, name string) (certPath, keyPath string, certPEM []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(time.Now().UnixNano()),
		Subject:               pkix.Name{CommonName: name},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		DNSNames:              []string{"localhost"},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
		IsCA:                  true,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}

	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	certPath = filepath.Join(dir, name+".crt")
	keyPath = filepath.Join(dir, name+".key")
	if err := os.WriteFile(certPath, certPEM, 0o600); err != nil {
		t.Fatalf("write cert: %v", err)
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}
	return certPath, keyPath, certPEM
}

type sep2Server struct {
	server         *httptest.Server
	clientCertSeen bool
	posted         []string
	dcap           string
	programs       string
	controls       string
}

func newSEP2Server(t *testing.T, serverCert tls.Certificate) *sep2Server {
	t.Helper()
	s := &sep2Server{}
	mux := http.NewServeMux()

	mux.HandleFunc("/dcap", func(w http.ResponseWriter, r *http.Request) {
		s.clientCertSeen = len(r.TLS.PeerCertificates) > 0
		w.Header().Set("Content-Type", "application/sep+xml")
		fmt.Fprint(w, s.dcap)
	})
	mux.HandleFunc("/derp", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, s.programs)
	})
	mux.HandleFunc("/derp/1/derc", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, s.controls)
	})
	mux.HandleFunc("/mup/1", func(w http.ResponseWriter, r *http.Request) {
		s.posted = append(s.posted, r.URL.Path)
		w.WriteHeader(http.StatusCreated)
	})
	mux.HandleFunc("/mup/broken", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "quota exceeded", http.StatusForbidden)
	})

	server := httptest.NewUnstartedServer(mux)
	server.TLS = &tls.Config{
		Certificates: []tls.Certificate{serverCert},
		ClientAuth:   tls.RequireAnyClientCert,
	}
	server.StartTLS()
	t.Cleanup(server.Close)
	s.server = server
	return s
}

const dcapXML = `<DeviceCapability xmlns="urn:ieee:std:2030.5:ns" href="/dcap">
  <EndDeviceListLink href="/edev" all="1"/>
  <DERProgramListLink href="/derp" all="1"/>
  <MirrorUsagePointListLink href="/mup" all="1"/>
</DeviceCapability>`

const programsXML = `<DERProgramList xmlns="urn:ieee:std:2030.5:ns" all="1" results="1">
  <DERProgram href="/derp/1">
    <mRID>PRG-1</mRID>
    <description>Peak management</description>
    <primacy>1</primacy>
    <DERControlListLink href="/derp/1/derc" all="2"/>
  </DERProgram>
</DERProgramList>`

// One usable control (opModTargetW = 5 × 10^3 W) and one with no setpoint.
const controlsXML = `<DERControlList xmlns="urn:ieee:std:2030.5:ns" all="2" results="2">
  <DERControl href="/derp/1/derc/1">
    <mRID>CTL-1</mRID>
    <description>curtail</description>
    <creationTime>1780000000</creationTime>
    <EventStatus><currentStatus>1</currentStatus><dateTime>1780000000</dateTime><potentiallySuperseded>false</potentiallySuperseded></EventStatus>
    <interval><duration>3600</duration><start>1780000000</start></interval>
    <DERControlBase>
      <opModTargetW><multiplier>3</multiplier><value>5</value></opModTargetW>
      <rampTms>1000</rampTms>
    </DERControlBase>
  </DERControl>
  <DERControl href="/derp/1/derc/2">
    <mRID>CTL-2</mRID>
    <creationTime>1780000000</creationTime>
    <EventStatus><currentStatus>0</currentStatus><dateTime>1780000000</dateTime><potentiallySuperseded>false</potentiallySuperseded></EventStatus>
    <interval><duration>3600</duration><start>1780003600</start></interval>
    <DERControlBase></DERControlBase>
  </DERControl>
</DERControlList>`

func newTestClient(t *testing.T) (*Client, *sep2Server) {
	t.Helper()
	dir := t.TempDir()
	serverCertPath, serverKeyPath, serverPEM := writeCertificate(t, dir, "server")
	clientCertPath, clientKeyPath, _ := writeCertificate(t, dir, "client")

	serverCert, err := tls.LoadX509KeyPair(serverCertPath, serverKeyPath)
	if err != nil {
		t.Fatalf("load server keypair: %v", err)
	}
	server := newSEP2Server(t, serverCert)
	server.dcap = dcapXML
	server.programs = programsXML
	server.controls = controlsXML

	caPath := filepath.Join(dir, "ca.pem")
	if err := os.WriteFile(caPath, serverPEM, 0o600); err != nil {
		t.Fatalf("write ca: %v", err)
	}

	client, err := NewClient(Config{
		BaseURL:        server.server.URL + "/dcap",
		ClientCertFile: clientCertPath,
		ClientKeyFile:  clientKeyPath,
		CAFile:         caPath,
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	return client, server
}

func TestClientRequiresCertificateAndHTTPS(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath, _ := writeCertificate(t, dir, "client")

	if _, err := NewClient(Config{BaseURL: "https://x/dcap"}); err == nil {
		t.Fatal("expected a missing client certificate to be rejected")
	}
	if _, err := NewClient(Config{BaseURL: "http://x/dcap", ClientCertFile: certPath, ClientKeyFile: keyPath}); err == nil {
		t.Fatal("expected plain http to be rejected")
	}
}

func TestLFDIIsDerivedFromCertificate(t *testing.T) {
	client, _ := newTestClient(t)
	if len(client.LFDI()) != 40 {
		t.Fatalf("LFDI must be 40 hex characters (160 bits), got %q", client.LFDI())
	}
	if strings.ToUpper(client.LFDI()) != client.LFDI() {
		t.Fatalf("LFDI must be upper case, got %q", client.LFDI())
	}
}

func TestDiscoveryUsesMutualTLS(t *testing.T) {
	client, server := newTestClient(t)
	dcap, err := client.DeviceCapability(context.Background())
	if err != nil {
		t.Fatalf("device capability: %v", err)
	}
	if !server.clientCertSeen {
		t.Fatal("server did not receive the client certificate")
	}
	if dcap.DERProgramListLink == nil || dcap.DERProgramListLink.Href != "/derp" {
		t.Fatalf("unexpected dcap %+v", dcap)
	}
}

func TestActiveControlsNormalisesSetpoints(t *testing.T) {
	client, _ := newTestClient(t)
	dcap, err := client.DeviceCapability(context.Background())
	if err != nil {
		t.Fatalf("device capability: %v", err)
	}

	instructions, problems, err := client.ActiveControls(context.Background(), dcap)
	if err != nil {
		t.Fatalf("active controls: %v", err)
	}
	if len(instructions) != 1 {
		t.Fatalf("expected one usable control, got %d", len(instructions))
	}
	if len(problems) != 1 {
		t.Fatalf("the setpoint-less control should be reported, got %d problems", len(problems))
	}

	instruction := instructions[0]
	if instruction.MRID != "CTL-1" || instruction.ProgramMRID != "PRG-1" {
		t.Fatalf("unexpected identity %+v", instruction)
	}
	if instruction.TargetWatts == nil || *instruction.TargetWatts != 5000 {
		t.Fatalf("opModTargetW multiplier was not applied: %+v", instruction.TargetWatts)
	}
	if instruction.RampSeconds == nil || *instruction.RampSeconds != 10 {
		t.Fatalf("rampTms is in hundredths of a second: %+v", instruction.RampSeconds)
	}
	if instruction.Duration != time.Hour {
		t.Fatalf("unexpected duration %s", instruction.Duration)
	}
}

func TestServerErrorsAreReported(t *testing.T) {
	client, server := newTestClient(t)
	server.dcap = "not xml at all"
	if _, err := client.DeviceCapability(context.Background()); err == nil {
		t.Fatal("expected an unparsable dcap to be an error")
	}

	server.server.Close()
	if _, err := client.DeviceCapability(context.Background()); err == nil {
		t.Fatal("expected an unreachable server to be an error")
	}
}

func TestPostMirrorReading(t *testing.T) {
	client, server := newTestClient(t)
	reading := MirrorMeterReading{
		MRID:           "MMR-1",
		LastUpdateTime: time.Now().Unix(),
		Reading:        &Reading{Value: 4200},
		ReadingType:    &ReadingType{PowerOfTenMultiplier: 0, UOM: UomWatts},
	}
	if err := client.PostMirrorReading(context.Background(), "/mup/1", reading); err != nil {
		t.Fatalf("post reading: %v", err)
	}
	if len(server.posted) != 1 {
		t.Fatalf("server did not record the reading: %+v", server.posted)
	}

	// A rejected reading must surface: telemetry silently dropped at the
	// utility would make settlement figures unverifiable.
	if err := client.PostMirrorReading(context.Background(), "/mup/broken", reading); err == nil {
		t.Fatal("expected an HTTP 403 to be reported")
	}
}

func TestRefusesCrossHostHref(t *testing.T) {
	client, _ := newTestClient(t)
	err := client.PostMirrorReading(context.Background(), "https://evil.example/mup/1", MirrorMeterReading{MRID: "x"})
	if err == nil || !strings.Contains(err.Error(), "refusing to follow") {
		t.Fatalf("expected cross-host hrefs to be refused, got %v", err)
	}
}
