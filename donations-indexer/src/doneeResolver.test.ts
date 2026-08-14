/**
 * Unit tests for doneeResolver's pure ENS ABI helpers.
 *
 * The resolver uses native fetch for its two dependent RPC calls. These tests
 * intentionally exercise only deterministic calldata construction and ABI
 * decoding, without adding a mocked RPC client.
 */

import { describe, expect, test } from 'bun:test'
import {
  addressFromAbiAddressWord,
  encodeNamehashCallData,
  ENS_REGISTRY_ADDRESS,
  ENS_REGISTRY_RESOLVER_SELECTOR,
  ENS_RESOLVER_ADDR_SELECTOR,
  THATSREKT_ENS_NAMEHASH,
} from './doneeResolver.js'

const PUBLIC_RESOLVER = '0x231b0ee14048e9dccd1d247744d114a4eb5e8e63'
const GOV_SAFE = '0x59e4dbc95bd312a882bb36b7f3e8298682340679'

const PUBLIC_RESOLVER_WORD =
  '0x000000000000000000000000231b0ee14048e9dccd1d247744d114a4eb5e8e63'
const GOV_SAFE_WORD =
  '0x00000000000000000000000059e4dbc95bd312a882bb36b7f3e8298682340679'

describe('ENS call construction', () => {
  test('uses the canonical ENS Registry address', () => {
    expect(ENS_REGISTRY_ADDRESS).toBe(
      '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e',
    )
  })

  test('encodes the Registry resolver(bytes32) calldata exactly', () => {
    expect(
      encodeNamehashCallData(
        ENS_REGISTRY_RESOLVER_SELECTOR,
        THATSREKT_ENS_NAMEHASH,
      ),
    ).toBe(
      '0x0178b8bf6dfbf6357dc05b7c231e63a0fd428fd2138b381eb15bfbd6bc51705ca4117726',
    )
  })

  test('encodes the resolver addr(bytes32) calldata exactly', () => {
    expect(
      encodeNamehashCallData(ENS_RESOLVER_ADDR_SELECTOR, THATSREKT_ENS_NAMEHASH),
    ).toBe(
      '0x3b3b57de6dfbf6357dc05b7c231e63a0fd428fd2138b381eb15bfbd6bc51705ca4117726',
    )
  })
})

describe('addressFromAbiAddressWord', () => {
  test('decodes a captured resolver ABI word', () => {
    expect(addressFromAbiAddressWord(PUBLIC_RESOLVER_WORD)).toBe(PUBLIC_RESOLVER)
  })

  test('decodes a captured donee ABI word', () => {
    expect(addressFromAbiAddressWord(GOV_SAFE_WORD)).toBe(GOV_SAFE)
  })

  test('lowercases a valid ABI address word', () => {
    expect(addressFromAbiAddressWord(GOV_SAFE_WORD.toUpperCase().replace('0X', '0x'))).toBe(
      GOV_SAFE,
    )
  })

  test.each([
    ['a missing 0x prefix', GOV_SAFE_WORD.slice(2)],
    ['a short word', '0x' + GOV_SAFE_WORD.slice(2, -2)],
    ['a long word', GOV_SAFE_WORD + '00'],
    ['non-hexadecimal characters', GOV_SAFE_WORD.slice(0, -1) + 'g'],
    ['non-zero ABI padding', '0x1' + GOV_SAFE_WORD.slice(3)],
    [
      'the zero address',
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    ],
  ])('rejects %s', (_description, result) => {
    expect(addressFromAbiAddressWord(result)).toBeNull()
  })
})
