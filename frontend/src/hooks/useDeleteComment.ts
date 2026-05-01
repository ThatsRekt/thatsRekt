import { useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { useIsWhitelisted } from './useIsWhitelisted'
import {
  buildDeleteMessage,
  deleteComment,
  CommentMutationError,
  type Comment,
} from '../lib/comments'
import type { CommentFlowError, CommentFlowPhase } from './useSubmitComment'

/**
 * Delete-comment hook — signs `op: delete` with the comment id and
 * posts the mutation. Hard delete: no version history, no soft-delete
 * marker on the row. The list query is invalidated on success so the
 * row drops out of the UI.
 *
 * Caller is responsible for confirming with the user before calling
 * `submit()` — a button click without a confirm step is a footgun.
 */
export function useDeleteComment(comment: Comment): {
  submit: () => Promise<void>
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

  const submit = async () => {
    setError(null)
    setNeedsConnect(false)

    if (!isConnected || !address) {
      setNeedsConnect(true)
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
    const message = buildDeleteMessage(comment.id, comment.postId, signedAt)

    let signature: `0x${string}`
    try {
      signature = await signMessageAsync({ message })
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
    needsConnect,
    dismissNeedsConnect: () => setNeedsConnect(false),
    reset,
  }
}
