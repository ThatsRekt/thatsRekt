package graphql

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"
)

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func graphqlResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(bytes.NewBufferString(body)),
	}
}

// Deleting the shared pace gate (or creating one per call) makes every request
// immediately eligible and leaves this test with no recorded 100ms slots.
func TestClient_PacesOverlappingLatestPostsAndPostByIDRequests(t *testing.T) {
	t.Parallel()

	var waits []time.Duration
	var waitsMu sync.Mutex
	wait := func(_ context.Context, delay time.Duration) error {
		waitsMu.Lock()
		defer waitsMu.Unlock()
		waits = append(waits, delay)
		return nil
	}

	client := newClient(
		"http://mesh.invalid/graphql",
		&http.Client{Transport: roundTripperFunc(func(req *http.Request) (*http.Response, error) {
			payload, err := io.ReadAll(req.Body)
			if err != nil {
				t.Fatalf("read GraphQL request: %v", err)
			}
			if bytes.Contains(payload, []byte("NotifierPostById")) {
				return graphqlResponse(http.StatusOK, `{"data":{"Base_postById":{"removed":true,"title":"retracted"}}}`), nil
			}
			if !bytes.Contains(payload, []byte("query Notifier")) {
				t.Fatalf("unexpected GraphQL query: %s", payload)
			}
			return graphqlResponse(http.StatusOK, `{"data":{"posts":{"items":[{"id":"base-42","chain":{"chainId":8453,"slug":"base","name":"Base"},"title":"latest"}]}}}`), nil
		})},
		10,
		func() time.Time { return time.Unix(0, 0) },
		wait,
	)

	start := make(chan struct{})
	errs := make(chan error, 4)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			posts, err := client.LatestPosts(context.Background(), 1)
			if err == nil && (len(posts) != 1 || posts[0].ID != "base-42") {
				err = errors.New("LatestPosts returned the wrong post")
			}
			errs <- err
		}()
		go func() {
			defer wg.Done()
			<-start
			post, err := client.PostById(context.Background(), "base", "42")
			if err == nil && (post == nil || !post.Removed || post.Title != "retracted") {
				err = errors.New("PostById returned the wrong post")
			}
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}

	waitsMu.Lock()
	defer waitsMu.Unlock()
	want := []time.Duration{100 * time.Millisecond, 100 * time.Millisecond, 100 * time.Millisecond}
	if len(waits) != len(want) {
		t.Fatalf("pace waits = %v, want %v", waits, want)
	}
	for i := range want {
		if waits[i] != want[i] {
			t.Fatalf("pace waits = %v, want %v", waits, want)
		}
	}
}

// Removing the retry delay or its pace-gate pass leaves this test without both
// 100ms waits; allowing unbounded retries makes the transport see extra calls.
func TestClient_Retries429OnceThroughThePaceGate(t *testing.T) {
	t.Parallel()

	var calls int
	var waits []time.Duration
	client := newClient(
		"http://mesh.invalid/graphql",
		&http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
			calls++
			if calls == 1 {
				return graphqlResponse(http.StatusTooManyRequests, `rate limited`), nil
			}
			return graphqlResponse(http.StatusOK, `{"data":{"posts":{"items":[]}}}`), nil
		})},
		10,
		func() time.Time { return time.Unix(0, 0) },
		func(_ context.Context, delay time.Duration) error {
			waits = append(waits, delay)
			return nil
		},
	)

	posts, err := client.LatestPosts(context.Background(), 1)
	if err != nil {
		t.Fatalf("LatestPosts after one 429: %v", err)
	}
	if len(posts) != 0 {
		t.Fatalf("LatestPosts returned %d posts, want 0", len(posts))
	}
	if calls != 2 {
		t.Fatalf("HTTP requests = %d, want 2", calls)
	}
	if len(waits) != 2 || waits[0] != 100*time.Millisecond || waits[1] != 100*time.Millisecond {
		t.Fatalf("retry waits = %v, want [100ms 100ms]", waits)
	}
}

// Ignoring Retry-After can immediately re-hit an overloaded gateway; trusting
// it without a cap can stall the notifier for an attacker-controlled duration.
func TestClient_CapsRetryAfterBeforePacingTheRetry(t *testing.T) {
	t.Parallel()

	var calls int
	var waits []time.Duration
	client := newClient(
		"http://mesh.invalid/graphql",
		&http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
			calls++
			if calls == 1 {
				response := graphqlResponse(http.StatusTooManyRequests, `rate limited`)
				response.Header.Set("Retry-After", "2")
				return response, nil
			}
			return graphqlResponse(http.StatusOK, `{"data":{"posts":{"items":[]}}}`), nil
		})},
		10,
		func() time.Time { return time.Unix(0, 0) },
		func(_ context.Context, delay time.Duration) error {
			waits = append(waits, delay)
			return nil
		},
	)

	if _, err := client.LatestPosts(context.Background(), 1); err != nil {
		t.Fatalf("LatestPosts after Retry-After: %v", err)
	}
	if calls != 2 {
		t.Fatalf("HTTP requests = %d, want 2", calls)
	}
	if len(waits) != 2 || waits[0] != time.Second || waits[1] != 100*time.Millisecond {
		t.Fatalf("retry waits = %v, want [1s 100ms]", waits)
	}
}

// Retrying after cancellation can turn notifier shutdown into an extra request.
func TestClient_CancelsDuring429RetryDelay(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var calls int
	delayStarted := make(chan time.Duration, 1)
	client := newClient(
		"http://mesh.invalid/graphql",
		&http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
			calls++
			response := graphqlResponse(http.StatusTooManyRequests, `rate limited`)
			response.Header.Set("Retry-After", "1")
			return response, nil
		})},
		10,
		func() time.Time { return time.Unix(0, 0) },
		func(ctx context.Context, delay time.Duration) error {
			delayStarted <- delay
			<-ctx.Done()
			return ctx.Err()
		},
	)

	errs := make(chan error, 1)
	go func() {
		_, err := client.LatestPosts(ctx, 1)
		errs <- err
	}()
	if delay := <-delayStarted; delay != time.Second {
		t.Fatalf("retry delay = %s, want 1s", delay)
	}
	cancel()

	if err := <-errs; !errors.Is(err, context.Canceled) {
		t.Fatalf("LatestPosts error = %v, want context cancellation", err)
	}
	if calls != 1 {
		t.Fatalf("HTTP requests after cancelled retry delay = %d, want 1", calls)
	}
}

// Changing the retry loop to allow another attempt turns persistent gateway
// overload into an unbounded request stream.
func TestClient_StopsAfterOne429Retry(t *testing.T) {
	t.Parallel()

	var calls int
	client := newClient(
		"http://mesh.invalid/graphql",
		&http.Client{Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) {
			calls++
			return graphqlResponse(http.StatusTooManyRequests, `rate limited`), nil
		})},
		10,
		func() time.Time { return time.Unix(0, 0) },
		func(_ context.Context, _ time.Duration) error { return nil },
	)

	_, err := client.LatestPosts(context.Background(), 1)
	if err == nil {
		t.Fatal("LatestPosts succeeded after persistent 429 responses")
	}
	if calls != 2 {
		t.Fatalf("HTTP requests = %d, want 2", calls)
	}
}

// Releasing the scheduling mutex before dispatch lets a later caller overtake
// an earlier, descheduled caller and emit two requests closer than the limit.
func TestRequestPacer_SerializesOverlappingRequestDispatch(t *testing.T) {
	t.Parallel()

	slowDelayReached := make(chan struct{})
	var slowDelayOnce sync.Once
	releaseSlowDelay := make(chan struct{})
	pacer := newRequestPacer(
		100*time.Millisecond,
		func() time.Time { return time.Unix(0, 0) },
		func(_ context.Context, delay time.Duration) error {
			if delay == 100*time.Millisecond {
				waitForSlow := false
				slowDelayOnce.Do(func() {
					waitForSlow = true
					close(slowDelayReached)
				})
				if waitForSlow {
					<-releaseSlowDelay
				}
			}
			return nil
		},
	)

	var dispatched []string
	var dispatchedMu sync.Mutex
	send := func(name string) func() (*http.Response, error) {
		return func() (*http.Response, error) {
			dispatchedMu.Lock()
			dispatched = append(dispatched, name)
			dispatchedMu.Unlock()
			return nil, nil
		}
	}

	if _, err := pacer.Do(context.Background(), send("warm")); err != nil {
		t.Fatalf("warm request: %v", err)
	}

	errs := make(chan error, 2)
	go func() {
		_, err := pacer.Do(context.Background(), send("slow"))
		errs <- err
	}()
	<-slowDelayReached
	go func() {
		_, err := pacer.Do(context.Background(), send("fast"))
		errs <- err
	}()
	close(releaseSlowDelay)

	for range 2 {
		if err := <-errs; err != nil {
			t.Fatalf("paced request: %v", err)
		}
	}
	dispatchedMu.Lock()
	defer dispatchedMu.Unlock()
	want := []string{"warm", "slow", "fast"}
	if len(dispatched) != len(want) {
		t.Fatalf("dispatch order = %v, want %v", dispatched, want)
	}
	for i := range want {
		if dispatched[i] != want[i] {
			t.Fatalf("dispatch order = %v, want %v", dispatched, want)
		}
	}
}

// Advancing time while a request dispatches must move the next slot forward;
// otherwise the next queued caller can fire immediately after a slow dispatch.
func TestRequestPacer_PacesFromPreviousDispatchCompletion(t *testing.T) {
	t.Parallel()

	now := time.Unix(0, 0)
	var waits []time.Duration
	pacer := newRequestPacer(
		100*time.Millisecond,
		func() time.Time { return now },
		func(_ context.Context, delay time.Duration) error {
			waits = append(waits, delay)
			return nil
		},
	)

	if _, err := pacer.Do(context.Background(), func() (*http.Response, error) {
		now = now.Add(200 * time.Millisecond)
		return nil, nil
	}); err != nil {
		t.Fatalf("slow request: %v", err)
	}
	if _, err := pacer.Do(context.Background(), func() (*http.Response, error) {
		return nil, nil
	}); err != nil {
		t.Fatalf("next request: %v", err)
	}

	if len(waits) != 1 || waits[0] != 100*time.Millisecond {
		t.Fatalf("pace waits = %v, want [100ms]", waits)
	}
}
