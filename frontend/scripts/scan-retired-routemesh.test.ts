import { createHash } from 'node:crypto'
import { describe, expect, it } from 'bun:test'
import { formatScanReport, scanText } from './scan-retired-routemesh'

const retiredEndpoint = [
  'https://lb.',
  'routeme.sh/rpc/8453/',
  '00000000-0000-0000-0000-000000000000',
].join('')
const replacementEndpoint = [
  'https://lb.',
  'routeme.sh/rpc/8453/',
  '11111111-1111-1111-1111-111111111111',
].join('')
const retiredFingerprint = createHash('sha256').update(retiredEndpoint).digest('hex')

describe('retired RouteMesh scanner', () => {
  it('matches only configured retired endpoint fingerprints', () => {
    const fingerprints: Readonly<Record<string, true>> = { [retiredFingerprint]: true }

    expect(scanText(`const rpc = '${retiredEndpoint}'`, fingerprints)).toBe(1)
    expect(scanText(`const rpc = '${replacementEndpoint}'`, fingerprints)).toBe(0)
    expect(scanText('const rpc = "https://base.rpc.example.test"', fingerprints)).toBe(0)
  })

  it('reports only filenames and counts', () => {
    const report = formatScanReport({
      'src/lib/wagmi.ts': 0,
      'dist/assets/index.js': 0,
    })

    expect(report).toBe(
      'src/lib/wagmi.ts: 0\ndist/assets/index.js: 0\nfiles=2 occurrences=0',
    )
    expect(report).not.toContain('https://')
  })
})
