import { useEffect, useState } from 'react'
import { useAccount } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { useIsWhitelisted } from '../hooks/useIsWhitelisted'
import { useSubmitComment } from '../hooks/useSubmitComment'
import { useEditComment } from '../hooks/useEditComment'
import { useDeleteComment } from '../hooks/useDeleteComment'
import { fetchComments, type Comment } from '../lib/comments'
import { AddressLabel } from './AddressLabel'
import { WhitelistGateModal } from './WhitelistGateModal'
import { formatTimestamp, relativeTime } from '../lib/format'

const MAX_BODY_LENGTH = 1000

/**
 * Comment thread for a single post. Brutalist-styled list + compose
 * form. Read-only for non-guardians (which means most viewers); the
 * compose box always renders, but submitting falls back through the
 * connect/whitelist gate.
 *
 * Mounted from `PostDetail` after the rest of the post body so it lives
 * at the bottom of the page — comments are the discussion layer, not
 * the headline data.
 */
export function CommentThread({
  postId,
  chainSlug,
}: {
  postId: string
  chainSlug?: string
}) {
  const { data: comments, isLoading } = useQuery({
    queryKey: ['comments', postId],
    queryFn: () => fetchComments(postId),
    enabled: postId.length > 0,
  })

  return (
    <section className="space-y-4">
      <h2 className="font-black uppercase tracking-widest text-sm">
        comments{' '}
        {comments && (
          <span className="text-neutral-700">[{comments.length}]</span>
        )}
      </h2>

      {isLoading ? (
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          loading comments…
        </p>
      ) : (
        <CommentList comments={comments ?? []} chainSlug={chainSlug} />
      )}

      <ComposeBox postId={postId} />
    </section>
  )
}

// =============================================================================
// List
// =============================================================================

function CommentList({
  comments,
  chainSlug,
}: {
  comments: readonly Comment[]
  chainSlug?: string
}) {
  if (comments.length === 0) {
    return (
      <p className="text-xs uppercase tracking-widest text-neutral-700">
        no comments yet — be the first guardian to weigh in.
      </p>
    )
  }
  return (
    <ul className="space-y-3">
      {comments.map((c) => (
        <li key={c.id}>
          <CommentRow comment={c} chainSlug={chainSlug} />
        </li>
      ))}
    </ul>
  )
}

function CommentRow({
  comment,
  chainSlug,
}: {
  comment: Comment
  chainSlug?: string
}) {
  const { address } = useAccount()
  const isOwner =
    !!address && address.toLowerCase() === comment.signer.toLowerCase()

  const [mode, setMode] = useState<'view' | 'edit'>('view')

  if (mode === 'edit') {
    return (
      <CommentEditRow
        comment={comment}
        onCancel={() => setMode('view')}
        onSaved={() => setMode('view')}
      />
    )
  }

  return (
    <article className="border-l-2 border-black pl-3">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {/* AddressLabel self-styles its hex/ENS text — no wrapper needed.
            Matches sizing of address labels elsewhere on the post page. */}
        <AddressLabel addr={comment.signer} chainSlug={chainSlug} />
        <span
          className="text-[10px] uppercase tracking-widest text-neutral-600"
          title={formatTimestamp(comment.createdAt)}
        >
          {relativeTime(comment.createdAt)}
        </span>
        {comment.lastEditedAt && (
          <span
            className="text-[10px] uppercase tracking-widest text-neutral-500"
            title={`edited ${formatTimestamp(comment.lastEditedAt)}`}
          >
            (edited)
          </span>
        )}
      </header>

      <p className="mt-1 text-sm leading-relaxed text-neutral-800 whitespace-pre-wrap break-words">
        {comment.body}
      </p>

      {isOwner && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMode('edit')}
            className="text-[10px] uppercase tracking-widest border border-black/30 hover:border-black px-1"
          >
            [edit]
          </button>
          <CommentDeleteButton comment={comment} />
        </div>
      )}
    </article>
  )
}

// =============================================================================
// Edit row
// =============================================================================

function CommentEditRow({
  comment,
  onCancel,
  onSaved,
}: {
  comment: Comment
  onCancel: () => void
  onSaved: () => void
}) {
  const [body, setBody] = useState(comment.body)
  const { submit, phase, error, reset } = useEditComment(comment)

  // Once the server confirms the edit, swap back to view mode. The
  // query invalidation already kicked off by the hook will refresh the
  // displayed body the next render.
  useEffect(() => {
    if (phase === 'success') onSaved()
  }, [phase, onSaved])

  const trimmed = body.trim()
  const unchanged = trimmed === comment.body.trim()
  const tooLong = body.length > MAX_BODY_LENGTH
  const isBusy = phase === 'signing' || phase === 'posting'
  const canSave = trimmed.length > 0 && !tooLong && !unchanged && !isBusy

  const handleCancel = () => {
    reset()
    onCancel()
  }

  return (
    <div className="border-l-2 border-black pl-3 space-y-2">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        maxLength={MAX_BODY_LENGTH + 100 /* soft cap; hard validate below */}
        className="w-full border-2 border-black bg-white px-3 py-2 text-sm font-mono"
      />
      <div className="flex items-center justify-between gap-3">
        <span
          className={
            'text-[10px] uppercase tracking-widest ' +
            (tooLong ? 'text-red-700 font-black' : 'text-neutral-600')
          }
        >
          {body.length} / {MAX_BODY_LENGTH}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCancel}
            disabled={isBusy}
            className="text-[10px] uppercase tracking-widest border border-black/30 hover:border-black px-2 py-1 disabled:opacity-50"
          >
            cancel
          </button>
          <button
            type="button"
            onClick={() => void submit(trimmed)}
            disabled={!canSave}
            className="text-[10px] uppercase tracking-widest border-2 border-black bg-white px-2 py-1 font-black disabled:opacity-50 hover:bg-yellow-100 active:bg-yellow-200"
          >
            {phase === 'signing'
              ? 'sign…'
              : phase === 'posting'
                ? 'saving…'
                : '[ save ]'}
          </button>
        </div>
      </div>
      {error && <CommentErrorBlock code={error.code} message={error.message} />}
    </div>
  )
}

// =============================================================================
// Delete button (with confirm step)
// =============================================================================

function CommentDeleteButton({ comment }: { comment: Comment }) {
  const [confirming, setConfirming] = useState(false)
  const { submit, phase, error } = useDeleteComment(comment)

  const isBusy = phase === 'signing' || phase === 'posting'

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-[10px] uppercase tracking-widest border border-black/30 hover:border-black px-1"
      >
        [delete]
      </button>
    )
  }
  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-widest text-red-700">
        delete?
      </span>
      <button
        type="button"
        onClick={() => void submit()}
        disabled={isBusy}
        className="text-[10px] uppercase tracking-widest border-2 border-red-600 bg-red-600 text-white px-1 font-black disabled:opacity-50 hover:bg-red-700 hover:border-red-700"
      >
        {phase === 'signing' ? 'sign…' : phase === 'posting' ? 'deleting…' : 'yes'}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={isBusy}
        className="text-[10px] uppercase tracking-widest border border-black/30 hover:border-black px-1 disabled:opacity-50"
      >
        no
      </button>
      {error && <CommentErrorBlock code={error.code} message={error.message} />}
    </span>
  )
}

// =============================================================================
// Compose
// =============================================================================

function ComposeBox({ postId }: { postId: string }) {
  const { address, isConnected } = useAccount()
  const { isWhitelisted, isLoading: isCheckingWhitelist } = useIsWhitelisted(address)
  const {
    submit,
    phase,
    error,
    needsConnect,
    dismissNeedsConnect,
    reset,
  } = useSubmitComment(postId)

  const [body, setBody] = useState('')

  // On a successful post, clear the textarea so the user can immediately
  // write a follow-up. Side effect — kept to a single transition (success
  // → idle) by `reset()` resetting phase too.
  useEffect(() => {
    if (phase === 'success') {
      setBody('')
      reset()
    }
  }, [phase, reset])

  const trimmed = body.trim()
  const tooLong = body.length > MAX_BODY_LENGTH
  const isBusy = phase === 'signing' || phase === 'posting'
  const canSend = trimmed.length > 0 && !tooLong && !isBusy

  const onSend = () => {
    if (!canSend) return
    void submit(trimmed)
  }

  return (
    <div className="space-y-2">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="add a comment…"
        rows={3}
        maxLength={MAX_BODY_LENGTH + 100}
        className="w-full border-2 border-black bg-white px-3 py-2 text-sm font-mono"
      />
      <div className="flex items-center justify-between gap-3">
        <span
          className={
            'text-[10px] uppercase tracking-widest ' +
            (tooLong ? 'text-red-700 font-black' : 'text-neutral-600')
          }
        >
          {body.length} / {MAX_BODY_LENGTH}
        </span>
        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          className="text-[11px] uppercase tracking-widest font-black border-2 border-red-600 bg-red-600 text-white px-3 py-1 disabled:opacity-50 hover:bg-red-700 hover:border-red-700 transition-colors"
        >
          {phase === 'signing'
            ? 'sign…'
            : phase === 'posting'
              ? 'posting…'
              : '[ send ]'}
        </button>
      </div>

      {error && <CommentErrorBlock code={error.code} message={error.message} />}

      <WhitelistGateModal
        open={needsConnect}
        onClose={dismissNeedsConnect}
        isConnected={isConnected}
        address={address}
        isCheckingWhitelist={isCheckingWhitelist}
        isWhitelisted={isWhitelisted}
        title="[comment as guardian]"
      />
    </div>
  )
}

// =============================================================================
// Error block
// =============================================================================

function CommentErrorBlock({
  code,
  message,
}: {
  code: string
  message: string
}) {
  // Map a few common server codes to friendlier copy. Anything we don't
  // remap falls through to the message string the server sent.
  const display = friendlyErrorMessage(code, message)
  return (
    <p className="border-2 border-red-700 bg-red-50 px-3 py-2 text-xs uppercase tracking-widest text-red-700">
      <span className="font-black">[{code}]</span> {display}
    </p>
  )
}

const friendlyErrorMessage = (code: string, fallback: string): string => {
  switch (code) {
    case 'RateLimited':
      return 'wait a few seconds before commenting again.'
    case 'DuplicateSubmission':
      return 'looks like that comment is already posted.'
    case 'BodyTooLong':
      return `comments are limited to ${MAX_BODY_LENGTH} characters.`
    case 'BodyTooShort':
      return 'comment cannot be empty.'
    case 'InvalidSignature':
      return 'signature failed to verify — please try again.'
    case 'InvalidTimestamp':
      return 'signed timestamp is too old or too far in the future.'
    case 'PostNotFound':
      return 'this post no longer exists.'
    case 'CommentNotFound':
      return 'this comment no longer exists.'
    case 'NotCommentOwner':
      return 'only the original author can edit or delete this comment.'
    case 'NotWhitelisted':
      return 'only guardians can comment.'
    case 'UserRejected':
      return 'signature rejected.'
    case 'NetworkError':
      return fallback
    default:
      return fallback
  }
}
