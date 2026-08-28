const assert = require('node:assert/strict')
const test = require('node:test')

const { DataSource } = require('typeorm')
const {
  createIsolatedRegistryFixture,
} = require('./support/isolatedRegistryPostgres.cjs')
const {
  readRegistryPortalDurableProgressAtMs,
} = require('../lib/portalProgress.js')

const HEIGHT = 50_517_211
const HASH = `0x${HEIGHT.toString(16).padStart(64, '0')}`

test('reads only the Registry durable progress timestamp matching the current cursor', async () => {
  const fixture = await createIsolatedRegistryFixture()
  const dataSource = new DataSource({
    type: 'postgres',
    url: fixture.databaseUrl,
    ssl: false,
  })
  try {
    await fixture.pool.query(
      `INSERT INTO squid_processor.status (id, height, hash, nonce)
       VALUES (0, -1, '0x', 0)`,
    )
    await fixture.pool.query(
      `UPDATE squid_processor.status SET height = $1, hash = $2 WHERE id = 0`,
      [HEIGHT, HASH],
    )
    await dataSource.initialize()

    const durableProgressAtMs = await readRegistryPortalDurableProgressAtMs({
      dataSource,
      cursor: { height: HEIGHT, hash: HASH },
    })
    assert.equal(typeof durableProgressAtMs, 'number')
    assert.ok(durableProgressAtMs >= 0)
    assert.equal(
      await readRegistryPortalDurableProgressAtMs({
        dataSource,
        cursor: { height: HEIGHT + 1, hash: HASH },
      }),
      undefined,
    )
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy()
    await fixture.close()
  }
})
