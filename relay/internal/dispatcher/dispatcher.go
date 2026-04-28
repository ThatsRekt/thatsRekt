// Package dispatcher submits validated post.create messages on-chain and
// returns the per-chain results.
//
// Sub-phase A:
//   - Single-chain only. The dispatcher holds exactly one (Client, Signer)
//     pair. If a message specifies a chain other than the one we have wired
//     up, that result entry is "skipped" with an error explaining it.
//   - Synchronous wait for receipt — we need the post id from the
//     PostCreated log to populate the ack.
//   - No nonce manager. We let the RPC + go-ethereum's bind pick the
//     pending nonce. With one writer, this is fine; sub-phase B introduces
//     an explicit nonce cursor.
//
// What's deliberately unbuilt here for sub-phase A:
//   - Per-chain worker pool / fan-out (B)
//   - Nonce resync on mismatch (B)
//   - Rate limiting (B)
//   - Retry-on-transient-error (intentionally NEVER: the relay is stateless;
//     the provider re-issues if it cares).
package dispatcher

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"

	"github.com/JeronimoHoulin/thatsRekt/relay/internal/chain"
	"github.com/JeronimoHoulin/thatsRekt/relay/internal/signer"
	"github.com/JeronimoHoulin/thatsRekt/relay/internal/ws"
)

// Dispatcher submits post.create messages and returns the per-chain
// SubmissionResult. Construct via New; the zero value is unusable.
type Dispatcher struct {
	// chains keyed by chain.Client.Name. Sub-phase A stores exactly one
	// entry; the lookup-by-name shape is intentional so sub-phase B can
	// add entries without changing this layer's call surface.
	chains map[string]*chainEntry

	// receiptTimeout caps how long we'll wait for a tx receipt before
	// returning failure. On Anvil this is ~instant; on real chains it's
	// finality-bounded. The default (60s) is generous for L2s.
	receiptTimeout time.Duration
}

type chainEntry struct {
	client *chain.Client
	signer signer.Signer
}

// Config bundles dispatcher construction params. Adding fields here is a
// non-breaking change.
type Config struct {
	// Pairs of chain client + signer. Sub-phase A passes exactly one;
	// sub-phase B accepts many.
	Chains []ChainPair
	// ReceiptTimeout caps receipt-wait. Zero defaults to 60s.
	ReceiptTimeout time.Duration
}

// ChainPair binds a chain client to the signer that should submit on that
// chain. Pairing them at construction time ensures we cannot accidentally
// submit a tx with a signer bound to a different chain id.
type ChainPair struct {
	Client *chain.Client
	Signer signer.Signer
}

// New validates the config and constructs a Dispatcher.
func New(cfg Config) (*Dispatcher, error) {
	if len(cfg.Chains) == 0 {
		return nil, errors.New("dispatcher: at least one chain pair required")
	}
	chains := make(map[string]*chainEntry, len(cfg.Chains))
	for i, p := range cfg.Chains {
		if p.Client == nil {
			return nil, fmt.Errorf("dispatcher: chain pair %d has nil Client", i)
		}
		if p.Signer == nil {
			return nil, fmt.Errorf("dispatcher: chain pair %d has nil Signer", i)
		}
		// Belt-and-braces: refuse a signer that doesn't match the
		// chain's id. EnvSigner already binds chainID; this guards
		// against a future signer that doesn't.
		if _, exists := chains[p.Client.Name]; exists {
			return nil, fmt.Errorf("dispatcher: duplicate chain name %q", p.Client.Name)
		}
		chains[p.Client.Name] = &chainEntry{client: p.Client, signer: p.Signer}
	}
	rt := cfg.ReceiptTimeout
	if rt <= 0 {
		rt = 60 * time.Second
	}
	return &Dispatcher{chains: chains, receiptTimeout: rt}, nil
}

// HasChain reports whether the dispatcher knows about a chain by name.
// Used by the ws layer to decide whether to mark a chain as "skipped".
func (d *Dispatcher) HasChain(name string) bool {
	_, ok := d.chains[name]
	return ok
}

// SubmitPostCreate iterates the requested chains and submits one tx per
// chain that we know about. Returns one SubmissionResult per requested
// chain (preserving order) so the ack mirrors the request. Unknown chains
// produce a "failed" result with an explanatory error — sub-phase B will
// treat them as "skipped" once multi-chain is wired.
//
// Per-chain failures DO NOT fail the whole call: each chain's outcome is
// reported independently. The caller decides whether the envelope-level
// response is "ack" or "nack" based on whether ALL results succeeded.
func (d *Dispatcher) SubmitPostCreate(
	ctx context.Context,
	payload ws.PostCreatePayload,
) []ws.SubmissionResult {
	results := make([]ws.SubmissionResult, 0, len(payload.Chains))
	for _, chainName := range payload.Chains {
		results = append(results, d.submitOne(ctx, chainName, payload))
	}
	return results
}

func (d *Dispatcher) submitOne(
	ctx context.Context,
	chainName string,
	payload ws.PostCreatePayload,
) ws.SubmissionResult {
	res := ws.SubmissionResult{Chain: chainName}

	entry, ok := d.chains[chainName]
	if !ok {
		// Sub-phase A: a chain not wired up is a hard failure for THIS
		// chain. The provider should not be asking for chains we don't
		// support, so surfacing as failed (not silently skipped) is the
		// correct loud-fail behavior.
		res.Status = "failed"
		res.Error = fmt.Sprintf("chain %q is not configured on this relay", chainName)
		return res
	}

	// Convert string addresses → common.Address. We do this here, not in
	// the codec, because go-ethereum's HexToAddress is forgiving (pads /
	// truncates) — we want the contract's strict checks to be the policy
	// layer, but we also don't want to silently misalign bytes on input.
	// Validate hex-ness and 20-byte length explicitly.
	attackers, err := parseAddresses(payload.Attackers, "attackers")
	if err != nil {
		res.Status = "failed"
		res.Error = err.Error()
		return res
	}
	victims, err := parseAddresses(payload.Victims, "victims")
	if err != nil {
		res.Status = "failed"
		res.Error = err.Error()
		return res
	}

	opts, err := entry.signer.TransactOpts()
	if err != nil {
		res.Status = "failed"
		res.Error = fmt.Sprintf("signer: %v", err)
		return res
	}
	opts.Context = ctx
	// Leave Nonce/GasLimit unset — bind will auto-suggest. Sub-phase B
	// will install an explicit nonce manager.

	tx, err := entry.client.Binding.Post(opts, payload.Title, attackers, victims, payload.Note, payload.AttackedAt)
	if err != nil {
		res.Status = "failed"
		res.Error = fmt.Sprintf("submit: %v", err)
		return res
	}
	res.TxHash = tx.Hash().Hex()

	// Wait for receipt to grab the post id from PostCreated.
	rctx, cancel := context.WithTimeout(ctx, d.receiptTimeout)
	defer cancel()

	receipt, err := waitMined(rctx, entry.client, tx)
	if err != nil {
		res.Status = "failed"
		res.Error = fmt.Sprintf("receipt wait: %v", err)
		return res
	}
	if receipt.Status != types.ReceiptStatusSuccessful {
		res.Status = "failed"
		res.Error = fmt.Sprintf("tx reverted on chain (status=%d, gas_used=%d)", receipt.Status, receipt.GasUsed)
		return res
	}

	postID, ok := decodePostID(receipt, entry.client)
	if !ok {
		// Tx succeeded but no PostCreated log we could parse. This
		// shouldn't happen on a successful post() call — surface loudly
		// rather than fabricate an id.
		res.Status = "failed"
		res.Error = "tx succeeded but PostCreated log not found in receipt"
		res.TxHash = receipt.TxHash.Hex()
		return res
	}

	res.Status = "submitted"
	res.PostID = postID.String()
	return res
}

// parseAddresses converts ["0x..."] to []common.Address with strict format
// checks. We accept lower/upper/checksummed; the contract treats addresses
// as raw bytes regardless. We REJECT short or non-hex strings here because
// HexToAddress would silently pad zeros and we don't want to submit a
// malformed-but-valid-looking address.
func parseAddresses(in []string, field string) ([]common.Address, error) {
	out := make([]common.Address, 0, len(in))
	for i, s := range in {
		s = strings.TrimSpace(s)
		if !common.IsHexAddress(s) {
			return nil, fmt.Errorf("%s[%d]: %q is not a valid 20-byte hex address", field, i, s)
		}
		out = append(out, common.HexToAddress(s))
	}
	return out, nil
}
