import { describe, expect, it } from 'bun:test'
import { formatScanReport, scanText } from './scan-retired-routemesh'

const retiredEndpoint = [
  'https://lb.',
  'routeme.sh/rpc/8453/',
  '00000000-0000-0000-0000-000000000000',
].join('')

describe('retired RouteMesh scanner', () => {
  it('counts retired endpoint literals without returning their values', () => {
    expect(scanText(`const rpc = '${retiredEndpoint}'`)).toBe(1)
    expect(scanText('const rpc = "https://base.rpc.example.test"')).toBe(0)
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
