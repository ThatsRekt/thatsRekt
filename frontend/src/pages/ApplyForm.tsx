/**
 * /apply — guardian application form.
 *
 * Anonymous users fill out contact + justification, solve a Turnstile
 * challenge, then call the submitGuardianApplication mutation. No wallet
 * required.
 *
 * Aesthetic: brutalist, matches /about and /guardians — uppercase heading,
 * border-2 border-black, bg-[#f5f4ee], rekt-link, neutral-700 labels.
 * No em-dashes anywhere (house rule).
 */
import { useEffect, useReducer, useRef, type FormEvent } from 'react'
import {
  CONTACT_TYPES,
  CONTACT_TYPE_LABELS,
  CONTACT_TYPE_PLACEHOLDERS,
  CONTACT_TYPE_HINTS,
  EXTRA_CONTACTS_MAX,
  JUSTIFICATION_MIN,
  JUSTIFICATION_MAX,
  validateContactValue,
  validateJustification,
  submitGuardianApplication,
  type ContactType,
  type ContactInput,
  type GuardianApplicationErrorCode,
} from '../lib/guardian'

// ---------------------------------------------------------------------------
// Cloudflare Turnstile
//
// Loaded from the Cloudflare CDN (script injected once on mount). Site key
// comes from the build-time Vite env VITE_TURNSTILE_SITE_KEY. If the key
// is absent (dev without the env set), we fall back to the Turnstile
// always-pass TEST site key so local dev and CI don't require a real key.
//
// Test site key: 1x00000000000000000000AA (documented by Cloudflare at
// https://developers.cloudflare.com/turnstile/troubleshooting/testing/)
// ---------------------------------------------------------------------------

const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA'
const TURNSTILE_SITE_KEY =
  import.meta.env.VITE_TURNSTILE_SITE_KEY ?? TURNSTILE_TEST_SITE_KEY

// ---------------------------------------------------------------------------
// Form state
// ---------------------------------------------------------------------------

interface ContactRow {
  readonly id: number
  readonly type: ContactType
  readonly value: string
}

interface FormState {
  readonly justification: string
  readonly primaryContact: ContactRow
  readonly extraContacts: readonly ContactRow[]
  readonly honeypot: string
  readonly turnstileToken: string
  readonly isSubmitting: boolean
  readonly result:
    | null
    | { readonly kind: 'success'; readonly applicationId: string }
    | { readonly kind: 'error'; readonly code: GuardianApplicationErrorCode; readonly message: string }
}

type FormAction =
  | { type: 'SET_JUSTIFICATION'; value: string }
  | { type: 'SET_PRIMARY_TYPE'; contactType: ContactType }
  | { type: 'SET_PRIMARY_VALUE'; value: string }
  | { type: 'ADD_EXTRA' }
  | { type: 'REMOVE_EXTRA'; id: number }
  | { type: 'SET_EXTRA_TYPE'; id: number; contactType: ContactType }
  | { type: 'SET_EXTRA_VALUE'; id: number; value: string }
  | { type: 'SET_HONEYPOT'; value: string }
  | { type: 'SET_TURNSTILE_TOKEN'; token: string }
  | { type: 'SET_SUBMITTING'; value: boolean }
  | { type: 'SET_RESULT'; result: FormState['result'] }

let nextId = 1
const mkId = () => nextId++

const initialState: FormState = {
  justification: '',
  primaryContact: { id: mkId(), type: 'telegram', value: '' },
  extraContacts: [],
  honeypot: '',
  turnstileToken: '',
  isSubmitting: false,
  result: null,
}

function reducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case 'SET_JUSTIFICATION':
      return { ...state, justification: action.value }
    case 'SET_PRIMARY_TYPE':
      return {
        ...state,
        primaryContact: { ...state.primaryContact, type: action.contactType, value: '' },
      }
    case 'SET_PRIMARY_VALUE':
      return {
        ...state,
        primaryContact: { ...state.primaryContact, value: action.value },
      }
    case 'ADD_EXTRA':
      if (state.extraContacts.length >= EXTRA_CONTACTS_MAX) return state
      return {
        ...state,
        extraContacts: [
          ...state.extraContacts,
          { id: mkId(), type: 'telegram', value: '' },
        ],
      }
    case 'REMOVE_EXTRA':
      return {
        ...state,
        extraContacts: state.extraContacts.filter((c) => c.id !== action.id),
      }
    case 'SET_EXTRA_TYPE':
      return {
        ...state,
        extraContacts: state.extraContacts.map((c) =>
          c.id === action.id ? { ...c, type: action.contactType, value: '' } : c,
        ),
      }
    case 'SET_EXTRA_VALUE':
      return {
        ...state,
        extraContacts: state.extraContacts.map((c) =>
          c.id === action.id ? { ...c, value: action.value } : c,
        ),
      }
    case 'SET_HONEYPOT':
      return { ...state, honeypot: action.value }
    case 'SET_TURNSTILE_TOKEN':
      return { ...state, turnstileToken: action.token }
    case 'SET_SUBMITTING':
      return { ...state, isSubmitting: action.value }
    case 'SET_RESULT':
      return { ...state, result: action.result, isSubmitting: false }
    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// Derived validation
// ---------------------------------------------------------------------------

function isContactValid(contact: ContactRow): boolean {
  return validateContactValue(contact.type, contact.value) === null
}

function isFormValid(state: FormState): boolean {
  if (validateJustification(state.justification) !== null) return false
  if (!isContactValid(state.primaryContact)) return false
  for (const extra of state.extraContacts) {
    if (!isContactValid(extra)) return false
  }
  // Turnstile token is required. Submit must stay disabled until the widget
  // fires its callback with a non-empty token. Without this gate the button
  // enables before the challenge completes, guaranteeing a TurnstileFailed
  // server response on every submission that races the widget.
  if (state.turnstileToken === '') return false
  return true
}

// ---------------------------------------------------------------------------
// Turnstile helpers
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string
          callback: (token: string) => void
          'expired-callback': () => void
          'error-callback': () => void
          theme?: 'light' | 'dark' | 'auto'
        },
      ) => string
      reset: (widgetId: string) => void
      remove: (widgetId: string) => void
    }
    onTurnstileLoad?: () => void
  }
}

// ---------------------------------------------------------------------------
// ContactRow component
// ---------------------------------------------------------------------------

function ContactRowInput({
  contact,
  label,
  onTypeChange,
  onValueChange,
  onRemove,
  showRemove,
}: {
  contact: ContactRow
  label: string
  onTypeChange: (t: ContactType) => void
  onValueChange: (v: string) => void
  onRemove?: () => void
  showRemove: boolean
}) {
  const error = contact.value
    ? validateContactValue(contact.type, contact.value)
    : null

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-widest text-neutral-700">{label}</span>
        {showRemove && onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="remove contact"
            className="text-xs uppercase tracking-widest text-red-600 hover:underline font-black"
          >
            remove
          </button>
        )}
      </div>
      <div className="flex gap-2">
        <select
          value={contact.type}
          onChange={(e) => onTypeChange(e.target.value as ContactType)}
          className="border-2 border-black bg-[#f5f4ee] px-2 py-2 text-xs uppercase tracking-widest font-black focus:outline-none focus:ring-2 focus:ring-black"
          aria-label={`contact type for ${label}`}
        >
          {CONTACT_TYPES.map((t) => (
            <option key={t} value={t}>
              {CONTACT_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={contact.value}
          onChange={(e) => onValueChange(e.target.value)}
          placeholder={CONTACT_TYPE_PLACEHOLDERS[contact.type]}
          maxLength={128}
          className={
            'flex-1 border-2 bg-[#f5f4ee] px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-black ' +
            (error ? 'border-red-500' : 'border-black')
          }
          aria-label={`contact value for ${label}`}
          aria-describedby={error ? `contact-error-${contact.id}` : undefined}
        />
      </div>
      <p className="text-xs text-neutral-500">{CONTACT_TYPE_HINTS[contact.type]}</p>
      {error && (
        <p id={`contact-error-${contact.id}`} className="text-xs text-red-600 font-black">
          {error}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Turnstile widget
// ---------------------------------------------------------------------------

function TurnstileWidget({ onToken }: { onToken: (token: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)

  useEffect(() => {
    // Inject the Turnstile script once if not already present.
    if (!document.getElementById('cf-turnstile-script')) {
      window.onTurnstileLoad = () => renderWidget()
      const script = document.createElement('script')
      script.id = 'cf-turnstile-script'
      script.src =
        'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad'
      script.async = true
      script.defer = true
      document.head.appendChild(script)
    } else if (window.turnstile) {
      renderWidget()
    }

    function renderWidget() {
      if (!containerRef.current || !window.turnstile) return
      if (widgetIdRef.current !== null) {
        window.turnstile.remove(widgetIdRef.current)
      }
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: (token: string) => onToken(token),
        'expired-callback': () => onToken(''),
        'error-callback': () => onToken(''),
        theme: 'light',
      })
    }

    return () => {
      if (widgetIdRef.current !== null && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current)
        widgetIdRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div>
      <div ref={containerRef} className="cf-turnstile" />
      {/* Fallback hint if the widget hasn't loaded yet */}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ApplyForm page
// ---------------------------------------------------------------------------

export function ApplyForm() {
  const [state, dispatch] = useReducer(reducer, initialState)

  const justLen = state.justification.length
  const justError = state.justification ? validateJustification(state.justification) : null
  const formValid = isFormValid(state)
  const canAddExtra = state.extraContacts.length < EXTRA_CONTACTS_MAX

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!formValid || state.isSubmitting) return

    dispatch({ type: 'SET_SUBMITTING', value: true })

    const extraContacts: ContactInput[] = state.extraContacts.map((c) => ({
      type: c.type,
      value: c.value,
    }))

    const result = await submitGuardianApplication({
      justification: state.justification,
      primaryContact: { type: state.primaryContact.type, value: state.primaryContact.value },
      extraContacts,
      honeypot: state.honeypot,
      turnstileToken: state.turnstileToken,
    })

    if (result.ok) {
      dispatch({ type: 'SET_RESULT', result: { kind: 'success', applicationId: result.applicationId } })
    } else {
      dispatch({ type: 'SET_RESULT', result: { kind: 'error', code: result.code, message: result.message } })
    }
  }

  // Success view
  if (state.result?.kind === 'success') {
    return (
      <article className="space-y-10">
        <header className="space-y-3 border-b-2 border-black pb-6">
          <h1 className="font-black uppercase tracking-tighter text-4xl sm:text-5xl leading-none">
            apply to guard
          </h1>
        </header>
        <section className="border-2 border-black bg-[#f5f4ee] p-6 space-y-4">
          <p className="text-xl font-black uppercase tracking-tighter leading-none">
            application received
          </p>
          <p className="text-base leading-relaxed text-neutral-800">
            Your application has been submitted. The governance multisig will review it
            and reach out via your contact method. Approval goes through a 3-day onchain
            timelock once accepted.
          </p>
          <p className="text-xs text-neutral-500 font-mono">
            ref: {state.result.applicationId}
          </p>
        </section>
      </article>
    )
  }

  return (
    <article className="space-y-10">
      <header className="space-y-3 border-b-2 border-black pb-6">
        <h1 className="font-black uppercase tracking-tighter text-4xl sm:text-5xl leading-none">
          apply to guard
        </h1>
        <p className="text-xs uppercase tracking-widest text-neutral-700">
          [open application · no wallet required · reviewed by governance]
        </p>
        <p className="text-base leading-relaxed text-neutral-800">
          Guardians are onchain addresses authorized to report hack attacks and confirm
          peer reports. To become a guardian, submit this form. The governance multisig
          reviews applications; approved addresses are added through a 3-day timelock.
          Provide a contact method so the team can reach you for vetting.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-8" noValidate>

        {/* Justification */}
        <section className="space-y-3">
          <div className="flex items-baseline justify-between">
            <label
              htmlFor="justification"
              className="text-xs uppercase tracking-widest text-neutral-700 font-black"
            >
              justification
            </label>
            <span
              className={
                'text-xs font-mono ' +
                (justLen > JUSTIFICATION_MAX
                  ? 'text-red-600'
                  : justLen >= JUSTIFICATION_MIN
                  ? 'text-neutral-500'
                  : 'text-neutral-500')
              }
              aria-live="polite"
            >
              {justLen} / {JUSTIFICATION_MAX}
            </span>
          </div>
          <textarea
            id="justification"
            name="justification"
            value={state.justification}
            onChange={(e) => dispatch({ type: 'SET_JUSTIFICATION', value: e.target.value })}
            maxLength={JUSTIFICATION_MAX}
            rows={6}
            placeholder="Describe your security background, what protocols or chains you monitor, your detection approach, and any prior hack reports you have made. Minimum 50 characters."
            className={
              'w-full border-2 bg-[#f5f4ee] px-3 py-2 text-sm font-mono leading-relaxed focus:outline-none focus:ring-2 focus:ring-black resize-y ' +
              (justError ? 'border-red-500' : 'border-black')
            }
            aria-label="justification"
            aria-describedby={justError ? 'justification-error' : undefined}
          />
          {justError && state.justification && (
            <p id="justification-error" className="text-xs text-red-600 font-black">
              {justError}
            </p>
          )}
          {!justError && (
            <p className="text-xs text-neutral-500">
              Minimum {JUSTIFICATION_MIN} characters. Explain your background and how you
              detect hacks.
            </p>
          )}
        </section>

        {/* Primary contact */}
        <section className="space-y-4">
          <h2 className="text-xs uppercase tracking-widest text-neutral-700 font-black border-t-2 border-neutral-200 pt-4">
            contact method
          </h2>
          <p className="text-xs text-neutral-600">
            Provide at least one way for the team to reach you. Up to 3 contacts total.
          </p>

          <ContactRowInput
            contact={state.primaryContact}
            label="primary contact"
            onTypeChange={(t) => dispatch({ type: 'SET_PRIMARY_TYPE', contactType: t })}
            onValueChange={(v) => dispatch({ type: 'SET_PRIMARY_VALUE', value: v })}
            showRemove={false}
          />

          {/* Extra contacts */}
          {state.extraContacts.map((extra, i) => (
            <ContactRowInput
              key={extra.id}
              contact={extra}
              label={`extra contact ${i + 1}`}
              onTypeChange={(t) => dispatch({ type: 'SET_EXTRA_TYPE', id: extra.id, contactType: t })}
              onValueChange={(v) => dispatch({ type: 'SET_EXTRA_VALUE', id: extra.id, value: v })}
              onRemove={() => dispatch({ type: 'REMOVE_EXTRA', id: extra.id })}
              showRemove
            />
          ))}

          {canAddExtra && (
            <button
              type="button"
              onClick={() => dispatch({ type: 'ADD_EXTRA' })}
              className="text-xs uppercase tracking-widest font-black text-neutral-700 hover:text-black border-2 border-dashed border-neutral-400 hover:border-black px-4 py-2 transition-colors"
            >
              + add another contact
            </button>
          )}
        </section>

        {/* Turnstile */}
        <section className="space-y-2">
          <p className="text-xs uppercase tracking-widest text-neutral-700 font-black">
            human verification
          </p>
          <TurnstileWidget onToken={(token) => dispatch({ type: 'SET_TURNSTILE_TOKEN', token })} />
          <p className="text-xs text-neutral-500">
            Complete the challenge above. Required to prevent automated submissions.
          </p>
        </section>

        {/* Honeypot — off-screen, aria-hidden, not keyboard-focusable */}
        <div
          aria-hidden="true"
          style={{ position: 'absolute', left: '-9999px', top: '-9999px' }}
        >
          <input
            type="text"
            name="website"
            value={state.honeypot}
            onChange={(e) => dispatch({ type: 'SET_HONEYPOT', value: e.target.value })}
            tabIndex={-1}
            autoComplete="off"
            data-testid="honeypot"
            aria-hidden="true"
          />
        </div>

        {/* Error banner */}
        {state.result?.kind === 'error' && (
          <div
            role="alert"
            className="border-2 border-red-600 bg-red-50 px-4 py-3 space-y-1"
          >
            <p className="text-sm font-black uppercase text-red-600">
              submission failed ({state.result.code})
            </p>
            <p className="text-sm text-neutral-800">{state.result.message}</p>
          </div>
        )}

        {/* Submit */}
        <div className="pt-2">
          <button
            type="submit"
            disabled={!formValid || state.isSubmitting}
            className={
              'border-2 border-black px-6 py-3 text-sm uppercase tracking-widest font-black transition-colors ' +
              (formValid && !state.isSubmitting
                ? 'bg-black text-[#f5f4ee] hover:bg-neutral-800 cursor-pointer'
                : 'bg-neutral-200 text-neutral-400 cursor-not-allowed')
            }
          >
            {state.isSubmitting ? 'submitting...' : 'submit application'}
          </button>
          <p className="mt-2 text-xs text-neutral-500">
            No wallet required. Your application will be reviewed by the governance multisig.
          </p>
        </div>
      </form>
    </article>
  )
}
