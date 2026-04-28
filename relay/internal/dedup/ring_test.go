package dedup

import (
	"testing"
	"time"
)

func TestCache_GetMissReturnsZero(t *testing.T) {
	c := New[string](time.Minute)
	v, ok := c.Get("nope")
	if ok || v != "" {
		t.Fatalf("expected miss, got %q ok=%v", v, ok)
	}
}

func TestCache_PutGet(t *testing.T) {
	c := New[string](time.Minute)
	c.Put("k", "v")
	v, ok := c.Get("k")
	if !ok || v != "v" {
		t.Fatalf("expected hit v, got %q ok=%v", v, ok)
	}
}

func TestCache_ZeroWindowIsNoOp(t *testing.T) {
	c := New[string](0)
	c.Put("k", "v")
	if _, ok := c.Get("k"); ok {
		t.Fatal("zero window should never hit")
	}
}

func TestCache_EmptyIDIsNoOp(t *testing.T) {
	c := New[string](time.Minute)
	c.Put("", "v")
	if c.Len() != 0 {
		t.Fatalf("empty id should not be stored, len=%d", c.Len())
	}
}

// fakeClock returns the time it's told to return; mutate Now between calls
// to simulate elapsed wall time without time.Sleep in tests.
type fakeClock struct{ t time.Time }

func (f *fakeClock) advance(d time.Duration) { f.t = f.t.Add(d) }
func (f *fakeClock) now() time.Time          { return f.t }

func TestCache_ExpiryEvictsOnGet(t *testing.T) {
	clk := &fakeClock{t: time.Unix(1_000_000, 0)}
	c := newWithClock[string](time.Minute, clk.now)
	c.Put("a", "alpha")
	clk.advance(30 * time.Second)
	if v, ok := c.Get("a"); !ok || v != "alpha" {
		t.Fatalf("should still be live: %q ok=%v", v, ok)
	}
	clk.advance(31 * time.Second)
	if v, ok := c.Get("a"); ok {
		t.Fatalf("should be expired: %q ok=%v", v, ok)
	}
}

func TestCache_ExpiryEvictsOnPut(t *testing.T) {
	clk := &fakeClock{t: time.Unix(1_000_000, 0)}
	c := newWithClock[string](time.Minute, clk.now)
	c.Put("a", "alpha")
	c.Put("b", "beta")
	if c.Len() != 2 {
		t.Fatalf("expected 2, got %d", c.Len())
	}
	clk.advance(2 * time.Minute)
	c.Put("c", "gamma")
	// "a" and "b" should have been evicted before "c" was inserted.
	// Len() also lazy-evicts.
	if got := c.Len(); got != 1 {
		t.Fatalf("expected 1 live entry, got %d", got)
	}
	if _, ok := c.Get("a"); ok {
		t.Fatal("a should be evicted")
	}
	if _, ok := c.Get("b"); ok {
		t.Fatal("b should be evicted")
	}
	if v, ok := c.Get("c"); !ok || v != "gamma" {
		t.Fatalf("c should be live: %q ok=%v", v, ok)
	}
}

func TestCache_FifoOrderingOnRefresh(t *testing.T) {
	// Re-Put on an existing key must move it to the tail of the eviction
	// queue — otherwise an early Put could carry an expired window into
	// the future and mis-evict a fresh-but-newer key.
	clk := &fakeClock{t: time.Unix(1_000_000, 0)}
	c := newWithClock[string](time.Minute, clk.now)
	c.Put("a", "v1")
	clk.advance(30 * time.Second)
	c.Put("a", "v2") // refresh
	clk.advance(35 * time.Second)
	// 65s elapsed since first Put, but only 35s since refresh. Should still hit.
	if v, ok := c.Get("a"); !ok || v != "v2" {
		t.Fatalf("expected refresh to keep entry alive: v=%q ok=%v", v, ok)
	}
}

func TestCache_ConcurrentPutGet(t *testing.T) {
	// Smoke test for the mutex; not a thorough race test (use -race).
	c := New[int](time.Minute)
	done := make(chan struct{}, 4)
	for i := 0; i < 4; i++ {
		go func(i int) {
			for j := 0; j < 100; j++ {
				c.Put("k", i*100+j)
				_, _ = c.Get("k")
			}
			done <- struct{}{}
		}(i)
	}
	for i := 0; i < 4; i++ {
		<-done
	}
	if _, ok := c.Get("k"); !ok {
		t.Fatal("key should still be present")
	}
}
