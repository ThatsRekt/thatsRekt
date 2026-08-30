import { expect, test } from 'bun:test'
import pkg from 'pg'

import { acquireIndexerLock, type IndexerLock } from '../src/indexerLock.ts'

const { Pool } = pkg

const TEST_DB_URL =
  process.env.TEST_DB_URL ??
  'postgres://postgres:postgres@localhost:5432/donations_test'

test('keeps a chain singleton session-scoped while other chains acquire independently', async () => {
  const initialBscPool = new Pool({ connectionString: TEST_DB_URL, max: 1 })
  const duplicateBscPool = new Pool({ connectionString: TEST_DB_URL, max: 1 })
  const reacquiredBscPool = new Pool({ connectionString: TEST_DB_URL, max: 1 })
  const polygonPool = new Pool({ connectionString: TEST_DB_URL, max: 1 })

  let bscLock: IndexerLock | null = null
  let duplicateBscLock: IndexerLock | null = null
  let polygonLock: IndexerLock | null = null

  try {
    bscLock = await acquireIndexerLock(initialBscPool, 56)
    expect(bscLock).not.toBeNull()
    if (bscLock === null) throw new Error('expected the first BSC lock acquisition to succeed')

    duplicateBscLock = await acquireIndexerLock(duplicateBscPool, 56)
    expect(duplicateBscLock).toBeNull()

    await bscLock.release()
    bscLock = null

    bscLock = await acquireIndexerLock(reacquiredBscPool, 56)
    expect(bscLock).not.toBeNull()
    if (bscLock === null) throw new Error('expected BSC lock acquisition to succeed after release')

    polygonLock = await acquireIndexerLock(polygonPool, 137)
    expect(polygonLock).not.toBeNull()
    if (polygonLock === null) throw new Error('expected Polygon to acquire while BSC is locked')
  } finally {
    await Promise.allSettled([
      bscLock?.release(),
      duplicateBscLock?.release(),
      polygonLock?.release(),
    ])
    await Promise.allSettled([
      initialBscPool.end(),
      duplicateBscPool.end(),
      reacquiredBscPool.end(),
      polygonPool.end(),
    ])
  }
})
