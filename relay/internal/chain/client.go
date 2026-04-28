// Package chain wires together an RPC client + the typed thatsRekt binding
// for a single chain. Sub-phase A only registers one client at a time; sub-
// phase B will add a registry indexed by chain name so the dispatcher can
// fan out.
package chain

import (
	"context"
	"errors"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"

	"github.com/JeronimoHoulin/thatsRekt/relay/internal/thatsrekt"
)

// Client is the relay's per-chain handle: an ethclient + a typed binding
// against the proxy. The contract field is the thatsRekt proxy ADDRESS,
// not the implementation — UUPS routes calls through the proxy.
type Client struct {
	Name     string          // human-readable chain id ("base", "anvil-eth")
	ChainID  *big.Int        // EIP-155 chain id; must match signer's
	Contract common.Address  // thatsRekt proxy address
	Eth      *ethclient.Client
	Binding  *thatsrekt.ThatsRekt
}

// Config carries everything Dial needs to construct a Client. We keep this
// as a flat struct (not options-pattern) because the field set is small
// and stable; the design doc's chain block maps directly to these fields.
type Config struct {
	Name     string
	RPCURL   string
	ChainID  uint64 // expected; dialer verifies against the RPC's reported chainID
	Contract common.Address
}

// Dial connects to the RPC, verifies the chain id matches what the operator
// configured (mismatch = wrong RPC, refuse to start), and constructs the
// typed binding. Defensive: a wrong RPC pointing at a different chain would
// silently succeed without this check, then signing replay-protect against
// a chain id we never saw.
func Dial(ctx context.Context, cfg Config) (*Client, error) {
	if cfg.Name == "" {
		return nil, errors.New("chain.Dial: Name is empty")
	}
	if cfg.RPCURL == "" {
		return nil, fmt.Errorf("chain.Dial[%s]: RPCURL is empty", cfg.Name)
	}
	if cfg.ChainID == 0 {
		return nil, fmt.Errorf("chain.Dial[%s]: ChainID is 0", cfg.Name)
	}
	if cfg.Contract == (common.Address{}) {
		return nil, fmt.Errorf("chain.Dial[%s]: Contract address is zero", cfg.Name)
	}

	eth, err := ethclient.DialContext(ctx, cfg.RPCURL)
	if err != nil {
		return nil, fmt.Errorf("chain.Dial[%s]: rpc dial: %w", cfg.Name, err)
	}

	gotID, err := eth.ChainID(ctx)
	if err != nil {
		eth.Close()
		return nil, fmt.Errorf("chain.Dial[%s]: query chain id: %w", cfg.Name, err)
	}
	want := new(big.Int).SetUint64(cfg.ChainID)
	if gotID.Cmp(want) != 0 {
		eth.Close()
		return nil, fmt.Errorf(
			"chain.Dial[%s]: chain id mismatch: rpc reports %s, configured %s",
			cfg.Name, gotID, want,
		)
	}

	binding, err := thatsrekt.NewThatsRekt(cfg.Contract, eth)
	if err != nil {
		eth.Close()
		return nil, fmt.Errorf("chain.Dial[%s]: bind contract: %w", cfg.Name, err)
	}

	return &Client{
		Name:     cfg.Name,
		ChainID:  want,
		Contract: cfg.Contract,
		Eth:      eth,
		Binding:  binding,
	}, nil
}

// Close releases the RPC connection. Idempotent; safe to call multiple times.
func (c *Client) Close() {
	if c == nil || c.Eth == nil {
		return
	}
	c.Eth.Close()
}
