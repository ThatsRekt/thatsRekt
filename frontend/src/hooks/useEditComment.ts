import { useState } from 'react'
import { useAccount, useSignTypedData } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { useIsWhitelisted } from './useIsWhitelisted'
import {
  buildEditTypedData,
  editComment,
  CommentMutationError,
  type Comment,
} from '../lib/comments'
import type { CommentFlowError, CommentFlowPhase } from './useSubmitComment'

/**
 * Edit-comment hook — same lifecycle as `useSubmitComment` but signs an
 * `EditComment` EIP-712 payload and targets the existing comment id. The
 * connected wallet must match `comment.signer`; the contract path
 * enforces this on the server side too, but we short-circuit locally so
 * a user who's switched accounts mid-page gets immediate feedback.
 *
 * Unlike `useSubmitComment`, this hook does NOT track a `needsConnect`
 * state — the [edit] button only renders when `isOwner` is true (see
 * `CommentRow` in `CommentThread.tsx`), which is itself gated on a
 * connected wallet whose address matches the comment's signer. By the
 * time `submit()` runs, we know the user is connected. We still keep
 * the `!address` guard as a defensive belt-and-braces check that fails
 * fast if the wallet disconnects mid-flight.
 */
export function useEditComment(comment: Comment): {
  submit: (newBody: string) => Promise<void>
  phase: CommentFlowPhase
  error: CommentFlowError | null
  reset: () => void
} {
  const { address } = useAccount()
  const { isWhitelisted, isLoading: isCheckingWhitelist } = useIsWhitelisted(address)
  const { signTypedDataAsync } = useSignTypedData()
  const queryClient = useQueryClient()

  const [phase, setPhase] = useState<CommentFlowPhase>('idle')
  const [error, setError] = useState<CommentFlowError | null>(null)

  const reset = () => {
    setPhase('idle')
    setError(null)
  }

  const submit = async (newBody: string) => {
    setError(null)

    // Defensive: edit UI is gated on `isOwner` (which requires a
    // connected wallet), so this branch is unreachable in normal flow.
    // Bail loudly rather than silently no-op'ing if the wallet
    // disconnected between render and submit.
    if (!address) {
      setPhase('error')
      setError({ code: 'NetworkError', message: 'Wallet disconnected — please reconnect.' })
      return
    }
    if (isCheckingWhitelist) return
    if (!isWhitelisted) {
      setPhase('error')
      setError({ code: 'NotWhitelisted', message: 'Only guardians can edit comments.' })
      return
    }
    // Local ownership pre-check — saves a wallet popup we know the
    // server would reject. Case-insensitive to tolerate the checksum/
    // lowercase mismatch between wagmi (`useAccount`) and the indexer.
    if (address.toLowerCase() !== comment.signer.toLowerCase()) {
      setPhase('error')
      setError({
        code: 'NotCommentOwner',
        message: 'Only the original author can edit this comment.',
      })
      return
    }

    setPhase('signing')
    const signedAt = new Date().toISOString()
    const typedData = buildEditTypedData(comment.id, comment.postId, newBody, signedAt)

    let signature: `0x${string}`
    try {
      signature = await signTypedDataAsync({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      })
    } catch {
      setPhase('error')
      setError({ code: 'UserRejected', message: 'Signature rejected.' })
      return
    }

    setPhase('posting')
    try {
      await editComment({
        commentId: comment.id,
        postId: comment.postId,
        newBody,
        signer: address,
        signature,
        signedAt,
      })
      setPhase('success')
      void queryClient.invalidateQueries({ queryKey: ['comments', comment.postId] })
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
    reset,
  }
}
