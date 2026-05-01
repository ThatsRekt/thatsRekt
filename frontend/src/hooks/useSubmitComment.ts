import { useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { useIsWhitelisted } from './useIsWhitelisted'
import {
  buildCreateMessage,
  submitComment,
  CommentMutationError,
  type CommentErrorCode,
} from '../lib/comments'

/**
 * Compose-flow hook for guardian comments. Encapsulates the four-step
 * sign-and-post pipeline:
 *
 *   1. Verify the wallet is connected — if not, signal the caller to
 *      open the connect/whitelist gate. (We don't open it ourselves;
 *      the parent owns the modal lifecycle.)
 *   2. Verify the address is whitelisted on at least one chain. The
 *      App-level `useDisconnectIfNotWhitelisted` will eventually kick
 *      the user, but we pre-empt with a synchronous error so the user
 *      gets feedback faster than the auto-disconnect's settling delay.
 *   3. Build the canonical message string + sign it via wagmi (which
 *      handles the EIP-191 prefix).
 *   4. POST the mutation. Discriminated-union response: success →
 *      invalidate the post's comment + count queries; error → store the
 *      typed code + message for the caller to render.
 */
export interface CommentFlowError {
  code: CommentErrorCode
  message: string
}

export type CommentFlowPhase = 'idle' | 'signing' | 'posting' | 'success' | 'error'

export function useSubmitComment(postId: string): {
  submit: (body: string) => Promise<void>
  phase: CommentFlowPhase
  error: CommentFlowError | null
  needsConnect: boolean
  dismissNeedsConnect: () => void
  reset: () => void
} {
  const { address, isConnected } = useAccount()
  const { isWhitelisted, isLoading: isCheckingWhitelist } = useIsWhitelisted(address)
  const { signMessageAsync } = useSignMessage()
  const queryClient = useQueryClient()

  const [phase, setPhase] = useState<CommentFlowPhase>('idle')
  const [error, setError] = useState<CommentFlowError | null>(null)
  const [needsConnect, setNeedsConnect] = useState(false)

  const reset = () => {
    setPhase('idle')
    setError(null)
    setNeedsConnect(false)
  }

  const submit = async (body: string) => {
    setError(null)
    setNeedsConnect(false)

    if (!isConnected || !address) {
      setNeedsConnect(true)
      return
    }
    // Whitelist read still in flight: silently no-op so the user can
    // click again once the read settles. Surfacing an error here would
    // be misleading.
    if (isCheckingWhitelist) return
    if (!isWhitelisted) {
      setPhase('error')
      setError({ code: 'NotWhitelisted', message: 'Only guardians can comment.' })
      return
    }

    setPhase('signing')
    const signedAt = new Date().toISOString()
    const message = buildCreateMessage(postId, body, signedAt)

    let signature: `0x${string}`
    try {
      signature = await signMessageAsync({ message })
    } catch {
      // wagmi throws on user-rejection or wallet-side failure. We don't
      // try to distinguish these — both surface as "you didn't sign".
      setPhase('error')
      setError({ code: 'UserRejected', message: 'Signature rejected.' })
      return
    }

    setPhase('posting')
    try {
      await submitComment({ postId, body, signer: address, signature, signedAt })
      setPhase('success')
      // Refresh both the list and the metadata-row chip.
      void queryClient.invalidateQueries({ queryKey: ['comments', postId] })
      void queryClient.invalidateQueries({ queryKey: ['commentCount', postId] })
    } catch (e) {
      setPhase('error')
      if (e instanceof CommentMutationError) {
        setError({ code: e.code, message: e.message })
      } else {
        const message =
          e instanceof Error ? e.message : 'Network error — try again in a moment.'
        setError({ code: 'NetworkError', message })
      }
    }
  }

  return {
    submit,
    phase,
    error,
    needsConnect,
    dismissNeedsConnect: () => setNeedsConnect(false),
    reset,
  }
}
