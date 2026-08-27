import { describe, expect, it } from 'bun:test'
import {
  PUBLIC_RPC_ENVIRONMENT_VARIABLES,
  PublicRpcConfigurationError,
  resolvePublicRpcUrls,
} from './publicRpc'

const validEnvironment = Object.freeze({
  VITE_PUBLIC_RPC_ETHEREUM_URL: 'https://ethereum.rpc.example.test',
  VITE_PUBLIC_RPC_BASE_URL: 'https://base.rpc.example.test',
  VITE_PUBLIC_RPC_ARBITRUM_URL: 'https://arbitrum.rpc.example.test',
  VITE_PUBLIC_RPC_OPTIMISM_URL: 'https://optimism.rpc.example.test',
  VITE_PUBLIC_RPC_BSC_URL: 'https://bsc.rpc.example.test',
  VITE_PUBLIC_RPC_POLYGON_URL: 'https://polygon.rpc.example.test',
})

describe('resolvePublicRpcUrls', () => {
  it('requires one HTTPS endpoint for every Production Chain', () => {
    expect(resolvePublicRpcUrls(validEnvironment)).toEqual({
      ethereum: 'https://ethereum.rpc.example.test/',
      base: 'https://base.rpc.example.test/',
      arbitrum: 'https://arbitrum.rpc.example.test/',
      optimism: 'https://optimism.rpc.example.test/',
      bsc: 'https://bsc.rpc.example.test/',
      polygon: 'https://polygon.rpc.example.test/',
    })
  })

  it.each(PUBLIC_RPC_ENVIRONMENT_VARIABLES)(
    'rejects a missing %s without exposing configuration',
    (variableName) => {
      const environment = { ...validEnvironment, [variableName]: undefined }

      expect(() => resolvePublicRpcUrls(environment)).toThrow(
        new PublicRpcConfigurationError(variableName),
      )
      expect(() => resolvePublicRpcUrls(environment)).toThrow(variableName)
      expect(() => resolvePublicRpcUrls(environment)).not.toThrow(
        validEnvironment.VITE_PUBLIC_RPC_BASE_URL,
      )
    },
  )

  it('rejects blank and non-HTTPS values by environment variable name only', () => {
    expect(() =>
      resolvePublicRpcUrls({
        ...validEnvironment,
        VITE_PUBLIC_RPC_BASE_URL: '  ',
      }),
    ).toThrow('VITE_PUBLIC_RPC_BASE_URL')
    expect(() =>
      resolvePublicRpcUrls({
        ...validEnvironment,
        VITE_PUBLIC_RPC_BASE_URL: 'http://base.rpc.example.test',
      }),
    ).toThrow('VITE_PUBLIC_RPC_BASE_URL')
  })
})
