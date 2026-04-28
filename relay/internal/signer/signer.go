// Package signer abstracts the relay's transaction-signing key.
//
// Sub-phase A ships a single backend (env var). Sub-phase B will add KMS and
// PKCS#11 backends; the interface here is the seam that lets us add them
// without changing the dispatcher. Keep this interface narrow — it is
// security-critical surface.
package signer

import (
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
)

// Signer represents the relay's signing identity for ONE chain.
//
// We keep this per-chain rather than global because:
//   - Different chains use different chain IDs (EIP-155 replay protection).
//     Binding the chainID into the signer at construction time is safer
//     than passing it on every call.
//   - In sub-phase B, KMS keys are configurable per chain (different
//     aliases for different deployments).
type Signer interface {
	// Address returns the EOA the signer represents. This is the address
	// that must be whitelisted on-chain for `post()` to succeed.
	Address() common.Address

	// TransactOpts returns a fresh bind.TransactOpts pre-wired with the
	// signer. The caller is expected to set Context, Nonce, GasLimit,
	// and gas pricing (the dispatcher owns those concerns). The Signer
	// MUST set: From, Signer (the signing function), and ChainID.
	//
	// Returns a fresh struct on every call — TransactOpts is mutated by
	// go-ethereum's bind helpers, so sharing one across goroutines is a
	// footgun.
	TransactOpts() (*bind.TransactOpts, error)
}
