// Command wsclient is a minimal websocket client used by the smoke-test
// harness. It connects to the relay, sends one JSON message read from
// stdin, prints the response to stdout, and exits.
//
// Not part of the relay binary; lives under scripts/ so it doesn't ship
// to production. Pure stdlib + gorilla/websocket (already a dependency).
package main

import (
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"

	"github.com/gorilla/websocket"
)

func main() {
	var (
		url     = flag.String("url", "ws://127.0.0.1:8080/ws", "relay websocket URL")
		token   = flag.String("token", "", "bearer token for Authorization header")
		timeout = flag.Duration("timeout", 30*time.Second, "read timeout")
	)
	flag.Parse()

	body, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read stdin: %v\n", err)
		os.Exit(1)
	}
	if len(body) == 0 {
		fmt.Fprintln(os.Stderr, "stdin: empty (expected one JSON envelope)")
		os.Exit(1)
	}

	header := http.Header{}
	if *token != "" {
		header.Set("Authorization", "Bearer "+*token)
	}
	dialer := websocket.DefaultDialer
	dialer.HandshakeTimeout = 10 * time.Second

	conn, resp, err := dialer.Dial(*url, header)
	if err != nil {
		if resp != nil {
			fmt.Fprintf(os.Stderr, "dial: %v (status %d)\n", err, resp.StatusCode)
		} else {
			fmt.Fprintf(os.Stderr, "dial: %v\n", err)
		}
		os.Exit(1)
	}
	defer conn.Close()

	if err := conn.WriteMessage(websocket.TextMessage, body); err != nil {
		fmt.Fprintf(os.Stderr, "write: %v\n", err)
		os.Exit(1)
	}

	_ = conn.SetReadDeadline(time.Now().Add(*timeout))
	_, raw, err := conn.ReadMessage()
	if err != nil {
		fmt.Fprintf(os.Stderr, "read: %v\n", err)
		os.Exit(1)
	}
	if _, err := os.Stdout.Write(raw); err != nil {
		fmt.Fprintf(os.Stderr, "stdout: %v\n", err)
		os.Exit(1)
	}
	fmt.Println()
}
