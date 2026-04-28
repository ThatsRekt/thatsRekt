package dispatcher

import (
	"context"
	"errors"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/core/types"

	"github.com/JeronimoHoulin/thatsRekt/relay/internal/chain"
)

// waitMined waits for tx to be mined. Thin wrapper over bind.WaitMined so
// we have one place to add poll-rate / backoff configuration later. The
// underlying call honors ctx cancellation (returns an error on timeout).
func waitMined(ctx context.Context, c *chain.Client, tx *types.Transaction) (*types.Receipt, error) {
	if c == nil || c.Eth == nil {
		return nil, errors.New("waitMined: chain client is not initialized")
	}
	// bind.WaitMined polls every 250ms internally on most go-ethereum
	// versions. That's adequate for both Anvil (instant blocks) and L2s.
	return bind.WaitMined(ctx, c.Eth, tx)
}

// decodePostID scans the receipt's logs for a PostCreated event emitted by
// our contract and returns the post id. Returns (id, true) on success;
// (nil, false) if no matching log is present.
//
// Why iterate manually instead of using the binding's filterer Watch path:
// the watcher takes a sink + subscription; for one-shot decode of a known
// receipt log, ParsePostCreated on each Log is the simplest and fastest
// path. No RPC calls, no goroutines.
func decodePostID(receipt *types.Receipt, c *chain.Client) (*big.Int, bool) {
	if receipt == nil || c == nil || c.Binding == nil {
		return nil, false
	}
	for _, lg := range receipt.Logs {
		if lg == nil {
			continue
		}
		// Only consider logs from our contract — a receipt can include
		// logs from inner calls if the contract ever emits via another
		// address (it doesn't today, but defense in depth).
		if lg.Address != c.Contract {
			continue
		}
		ev, err := c.Binding.ParsePostCreated(*lg)
		if err != nil {
			continue
		}
		if ev == nil || ev.Id == nil {
			continue
		}
		return new(big.Int).Set(ev.Id), true
	}
	return nil, false
}

// pollInterval is exported as a package-private const so tests can reason
// about expected timing without wiring into bind internals.
const pollInterval = 250 * time.Millisecond
