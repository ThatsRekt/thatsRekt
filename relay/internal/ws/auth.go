package ws

import "crypto/subtle"

// constantTimeEqual compares two strings in constant time relative to the
// shorter input. We split out the length check so that a length-mismatch
// returns immediately — that's a known timing leak (the LENGTH of the
// configured token), but it's not a leak of the TOKEN bytes. The relay's
// auth token is operator-set, not user-set, so length-leak is acceptable.
func constantTimeEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
