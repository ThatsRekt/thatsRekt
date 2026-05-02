import { useState } from 'react'
import { useAccount, useSignTypedData } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { useIsWhitelisted } from './useIsWhitelisted'
import {
  buildDeleteTypedData,
  deleteComment,
  CommentMutationError,
  type Comment,
} from '../lib/comments'
import type { CommentFlowError, CommentFlowPhase } from './useSubmitComment'

/**
 * Delete-comment hook — signs an `DeleteComment` EIP-712 payload with
 * the comment id and posts the mutation. Hard delete: no version
 * history, no soft-delete marker on the row. The list query is
 * invalidated on success so the row drops out of the UI.
 *
 * Caller is responsible for confirming with the user before calling
 * `submit()` — a button click without a confirm step is a footgun.
 *
 * Like `useEditComment`, this hook does NOT track a `needsConnect`
 * state — the [delete] button only renders when `isOwner` is true,
 * which is gated on a connected wallet matching the comment's signer.
 * The `!address` guard remains as a defensive fail-fast for the
 * mid-flight disconnect case.
 */
export function useDeleteComment(comment: Comment): {
  submit: () => Promise<void>
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

  const submit = async () => {
    setError(null)

    if (!address) {
      setPhase('error')
      setError({ code: 'NetworkError', message: 'Wallet disconnected — please reconnect.' })
      return
    }
    if (isCheckingWhitelist) return
    if (!isWhitelisted) {
      setPhase('error')
      setError({
        code: 'NotWhitelisted',
        message: 'Only guardians can delete comments.',
      })
      return
    }
    if (address.toLowerCase() !== comment.signer.toLowerCase()) {
      setPhase('error')
      setError({
        code: 'NotCommentOwner',
        message: 'Only the original author can delete this comment.',
      })
      return
    }

    setPhase('signing')
    const signedAt = new Date().toISOString()
    const typedData = buildDeleteTypedData(comment.id, comment.postId, signedAt)

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
      await deleteComment({
        commentId: comment.id,
        postId: comment.postId,
        signer: address,
        signature,
        signedAt,
      })
      setPhase('success')
      void queryClient.invalidateQueries({ queryKey: ['comments', comment.postId] })
      void queryClient.invalidateQueries({ queryKey: ['commentCount', comment.postId] })
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
