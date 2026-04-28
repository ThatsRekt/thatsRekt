import { GraphQLClient } from 'graphql-request'

/**
 * Resolve the Mesh GraphQL endpoint at runtime.
 *
 * Priority:
 *   1. `VITE_GRAPHQL_ENDPOINT` build-time env (explicit override).
 *   2. `window.location.hostname` + `:4350` (LAN-friendly default).
 *
 * The runtime fallback means the same build works for:
 *   - localhost dev: `http://localhost:5173` → endpoint `http://localhost:4350/graphql`
 *   - LAN dev:       `http://192.168.1.42:5173` → endpoint `http://192.168.1.42:4350/graphql`
 *   - Future hosted: dynamic per-deployment without a rebuild.
 *
 * If the page is served over HTTPS, the endpoint inherits the same scheme.
 */
const DEFAULT_PORT = '4350'

function resolveEndpoint(): string {
  const explicit = import.meta.env.VITE_GRAPHQL_ENDPOINT
  if (explicit) return explicit
  if (typeof window === 'undefined') {
    // SSR / build time fallback (we don't actually SSR; this is just safe)
    return `http://localhost:${DEFAULT_PORT}/graphql`
  }
  const { protocol, hostname } = window.location
  return `${protocol}//${hostname}:${DEFAULT_PORT}/graphql`
}

const ENDPOINT = resolveEndpoint()

export const gqlClient = new GraphQLClient(ENDPOINT)
export const GRAPHQL_ENDPOINT = ENDPOINT
