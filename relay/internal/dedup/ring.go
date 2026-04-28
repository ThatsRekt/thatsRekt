// Package dedup implements idempotency for inbound provider messages.
//
// The relay caches the response for each `msg_id` for a configurable window
// (default 15min, per the design doc). On replay within the window, the
// cached response is returned and NO on-chain submission is repeated.
//
// Properties:
//   - In-memory only; a relay restart resets the cache. The provider is
//     expected to handle "I sent this and don't know if it landed" by
//     polling Mesh, which is the source of confirmation truth.
//   - Eviction is lazy: on every Get/Put, expired entries from the head of
//     the ring are dropped. This keeps memory proportional to actual
//     traffic without a background goroutine.
//   - Thread-safe. Multiple ws connections in sub-phase B+ will share one
//     cache.
package dedup

import (
	"sync"
	"time"
)

// Cache is a fixed-window deduplication cache keyed by message id.
//
// We model it as a map for O(1) lookup PLUS a queue of (id, expiresAt)
// for ordered eviction. Eviction visits expired entries in insertion
// order; insertion is monotonic in expiresAt (entries are added with
// `now + window`), so the queue stays sorted as long as the window
// is fixed. A change in window after construction would break that
// invariant, so we make Window immutable post-construction.
type Cache[V any] struct {
	mu     sync.Mutex
	window time.Duration
	now    func() time.Time // injected for tests
	store  map[string]entry[V]
	order  []string // insertion-ordered, used for FIFO eviction
}

type entry[V any] struct {
	value     V
	expiresAt time.Time
}

// New constructs a Cache with the given window. If window <= 0, the cache
// behaves as a no-op (every Get returns "not found"); useful for tests
// that want to disable dedup without code paths branching on a flag.
func New[V any](window time.Duration) *Cache[V] {
	return newWithClock[V](window, time.Now)
}

func newWithClock[V any](window time.Duration, now func() time.Time) *Cache[V] {
	return &Cache[V]{
		window: window,
		now:    now,
		store:  make(map[string]entry[V]),
		order:  make([]string, 0, 64),
	}
}

// Get returns the cached value for id, or zero + false if absent or expired.
// Lazy-evicts expired head entries while traversing.
func (c *Cache[V]) Get(id string) (V, bool) {
	var zero V
	if c.window <= 0 || id == "" {
		return zero, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.evictExpiredLocked()
	e, ok := c.store[id]
	if !ok {
		return zero, false
	}
	// Defensive: even if somehow not yet evicted, treat expired as absent.
	if !c.now().Before(e.expiresAt) {
		c.removeLocked(id)
		return zero, false
	}
	return e.value, true
}

// Put inserts or refreshes id -> value. Re-inserting an existing id moves
// it to the tail of the eviction queue (it gets a fresh window). This is
// the desired behavior for our use case: the relay only Puts after a
// successful submission, and a duplicate id would have hit Get first.
func (c *Cache[V]) Put(id string, value V) {
	if c.window <= 0 || id == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.evictExpiredLocked()
	if _, exists := c.store[id]; exists {
		// Refresh: drop from order, re-append. O(n) but n is small in
		// the steady state and this branch is uncommon (the contract
		// of Put is "first time we've seen id"; this is defense-in-depth).
		c.removeFromOrderLocked(id)
	}
	c.store[id] = entry[V]{value: value, expiresAt: c.now().Add(c.window)}
	c.order = append(c.order, id)
}

// Len returns the count of live entries (after lazy eviction).
func (c *Cache[V]) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.evictExpiredLocked()
	return len(c.store)
}

func (c *Cache[V]) evictExpiredLocked() {
	now := c.now()
	for len(c.order) > 0 {
		head := c.order[0]
		e, ok := c.store[head]
		if !ok {
			// Stale order entry — drop and continue.
			c.order = c.order[1:]
			continue
		}
		if now.Before(e.expiresAt) {
			return
		}
		delete(c.store, head)
		c.order = c.order[1:]
	}
}

func (c *Cache[V]) removeLocked(id string) {
	delete(c.store, id)
	c.removeFromOrderLocked(id)
}

func (c *Cache[V]) removeFromOrderLocked(id string) {
	for i, x := range c.order {
		if x == id {
			c.order = append(c.order[:i], c.order[i+1:]...)
			return
		}
	}
}
