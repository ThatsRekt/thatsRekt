package signer

import (
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// EnvSigner holds a private key in process memory. Local-dev / testnet only.
//
// SECURITY:
//   - The private key is held in plain memory for the process lifetime. On
//     any production deployment, switch to KMS (sub-phase B). The relay
//     does not log the key or its address derivation; only the public
//     address is exposed via Address().
//   - The chainID is captured at construction time so we cannot accidentally
//     sign a tx for a different chain than the one the operator authorized.
type EnvSigner struct {
	addr    common.Address
	chainID *big.Int

	// transactor is the bind helper; we don't store the key directly
	// because bind.NewKeyedTransactorWithChainID closes over it.
	transactor func() (*bind.TransactOpts, error)
}

// NewEnvSigner parses a hex-encoded private key (with or without `0x`
// prefix) and binds it to chainID. The chainID MUST match the chain the
// dispatcher will submit to — replay protection depends on it.
func NewEnvSigner(hexKey string, chainID *big.Int) (*EnvSigner, error) {
	if chainID == nil || chainID.Sign() <= 0 {
		return nil, errors.New("env signer: chainID must be > 0")
	}
	hexKey = strings.TrimSpace(hexKey)
	hexKey = strings.TrimPrefix(hexKey, "0x")
	if hexKey == "" {
		return nil, errors.New("env signer: private key is empty")
	}
	priv, err := crypto.HexToECDSA(hexKey)
	if err != nil {
		return nil, fmt.Errorf("env signer: invalid hex key: %w", err)
	}
	addr := crypto.PubkeyToAddress(priv.PublicKey)

	// Wrap in a closure so callers always get a fresh TransactOpts.
	// bind.NewKeyedTransactorWithChainID returns a struct that callers
	// mutate (Nonce, GasLimit, etc.); sharing it across goroutines would
	// be a data race.
	transactor := func() (*bind.TransactOpts, error) {
		return bind.NewKeyedTransactorWithChainID(priv, chainID)
	}

	return &EnvSigner{
		addr:       addr,
		chainID:    new(big.Int).Set(chainID),
		transactor: transactor,
	}, nil
}

func (s *EnvSigner) Address() common.Address { return s.addr }

func (s *EnvSigner) TransactOpts() (*bind.TransactOpts, error) {
	if s.transactor == nil {
		return nil, errors.New("env signer: not initialized")
	}
	return s.transactor()
}
