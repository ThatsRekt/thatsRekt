import { useState } from 'react'
import { useAccount, useSignMessage } from 'wagmi'
import { useQueryClient } from '@tanstack/react-query'
import { useIsWhitelisted } from './useIsWhitelisted'
import {
  buildEditMessage,
  editComment,
  CommentMutationError,
  type Comment,
} from '../lib/comments'
import type { CommentFlowError, CommentFlowPhase } from './useSubmitComment'

/**
 * Edit-comment hook — same lifecycle as `useSubmitComment` but signs an
 * `op: edit` message and targets the existing comment id. The connected
 * wallet must match `comment.signer`; the contract path enforces this on
 * the server side too, but we short-circuit locally so a user who's
 * switched accounts mid-page gets immediate feedback.
 */
export function useEditComment(comment: Comment): {
  submit: (newBody: string) => Promise<void>
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

  const submit = async (newBody: string) => {
    setError(null)
    setNeedsConnect(false)

    if (!isConnected || !address) {
      setNeedsConnect(true)
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
    const message = buildEditMessage(comment.id, comment.postId, newBody, signedAt)

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
    needsConnect,
    dismissNeedsConnect: () => setNeedsConnect(false),
    reset,
  }
}
