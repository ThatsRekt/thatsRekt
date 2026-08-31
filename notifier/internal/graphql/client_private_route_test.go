package graphql

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

type privateRouteRequest struct {
	host          string
	authorization string
}

func TestClient_PrivateRoutePreservesURLHostAndSendsBearerForBothOperations(t *testing.T) {
	const originalHostname = "graphql.private-route.test"

	var requestsMu sync.Mutex
	var requests []privateRouteRequest
	server, roots := newPrivateRouteTLSServer(t, originalHostname, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		payload, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "read request", http.StatusInternalServerError)
			return
		}

		requestsMu.Lock()
		requests = append(requests, privateRouteRequest{
			host:          r.Host,
			authorization: r.Header.Get("Authorization"),
		})
		requestsMu.Unlock()

		switch {
		case bytes.Contains(payload, []byte("NotifierPostById")):
			_, _ = w.Write([]byte(`{"data":{"Base_postById":{"removed":true,"title":"retracted"}}}`))
		case bytes.Contains(payload, []byte("query Notifier")):
			_, _ = w.Write([]byte(`{"data":{"posts":{"items":[{"id":"base-42","chain":{"chainId":8453,"slug":"base","name":"Base"},"title":"latest"}]}}}`))
		default:
			http.Error(w, "unexpected GraphQL operation", http.StatusBadRequest)
		}
	}))
	installTrustedDefaultTransport(t, roots)

	client := NewClient(
		"https://"+originalHostname+"/graphql",
		10,
		ClientOptions{
			DialAddress: server.Listener.Addr().String(),
			BearerToken: "test-token",
		},
	)

	posts, err := client.LatestPosts(context.Background(), 1)
	if err != nil {
		t.Fatalf("LatestPosts: %v", err)
	}
	if len(posts) != 1 || posts[0].ID != "base-42" {
		t.Fatalf("LatestPosts = %#v, want base-42", posts)
	}

	post, err := client.PostById(context.Background(), "base", "42")
	if err != nil {
		t.Fatalf("PostById: %v", err)
	}
	if post == nil || !post.Removed || post.Title != "retracted" {
		t.Fatalf("PostById = %#v, want removed retracted post", post)
	}

	requestsMu.Lock()
	defer requestsMu.Unlock()
	if len(requests) != 2 {
		t.Fatalf("received %d requests, want 2", len(requests))
	}
	for _, request := range requests {
		if request.host != originalHostname {
			t.Errorf("Request.Host = %q, want original URL hostname %q", request.host, originalHostname)
		}
		if request.authorization != "Bearer test-token" {
			t.Errorf("Authorization = %q, want %q", request.authorization, "Bearer test-token")
		}
	}
}

func TestClient_PublicRouteOmitsAuthorization(t *testing.T) {
	var authorization string
	var authorizationMu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorizationMu.Lock()
		authorization = r.Header.Get("Authorization")
		authorizationMu.Unlock()
		_, _ = w.Write([]byte(`{"data":{"posts":{"items":[{"id":"base-42","chain":{"chainId":8453,"slug":"base","name":"Base"},"title":"latest"}]}}}`))
	}))
	t.Cleanup(server.Close)

	client := NewClient(server.URL, 10, ClientOptions{})
	posts, err := client.LatestPosts(context.Background(), 1)
	if err != nil {
		t.Fatalf("LatestPosts: %v", err)
	}
	if len(posts) != 1 || posts[0].ID != "base-42" {
		t.Fatalf("LatestPosts = %#v, want base-42", posts)
	}

	authorizationMu.Lock()
	defer authorizationMu.Unlock()
	if authorization != "" {
		t.Fatalf("Authorization = %q, want no Authorization header", authorization)
	}
}

func newPrivateRouteTLSServer(t *testing.T, hostname string, handler http.Handler) (*httptest.Server, *x509.CertPool) {
	t.Helper()

	certificate, roots := certificateForHostname(t, hostname)
	server := httptest.NewUnstartedServer(handler)
	server.TLS = &tls.Config{Certificates: []tls.Certificate{certificate}}
	server.StartTLS()
	t.Cleanup(server.Close)
	return server, roots
}

func installTrustedDefaultTransport(t *testing.T, roots *x509.CertPool) {
	t.Helper()

	original, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		t.Fatalf("http.DefaultTransport has type %T, want *http.Transport", http.DefaultTransport)
	}
	transport := original.Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: roots}
	previous := http.DefaultTransport
	http.DefaultTransport = transport
	t.Cleanup(func() {
		http.DefaultTransport = previous
		transport.CloseIdleConnections()
	})
}

func certificateForHostname(t *testing.T, hostname string) (tls.Certificate, *x509.CertPool) {
	t.Helper()

	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate private key: %v", err)
	}
	certificateTemplate := x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: hostname},
		NotBefore:             time.Now().Add(-time.Minute),
		NotAfter:              time.Now().Add(time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
		DNSNames:              []string{hostname},
	}
	certificateDER, err := x509.CreateCertificate(rand.Reader, &certificateTemplate, &certificateTemplate, &privateKey.PublicKey, privateKey)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	privateKeyDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatalf("marshal private key: %v", err)
	}
	certificate, err := tls.X509KeyPair(
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificateDER}),
		pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateKeyDER}),
	)
	if err != nil {
		t.Fatalf("load TLS certificate: %v", err)
	}
	parsedCertificate, err := x509.ParseCertificate(certificateDER)
	if err != nil {
		t.Fatalf("parse certificate: %v", err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(parsedCertificate)
	return certificate, roots
}
