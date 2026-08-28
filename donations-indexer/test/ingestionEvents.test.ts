import { describe, expect, test } from 'bun:test'
import {
  PORTAL_INGESTION_SCHEMA,
  createPortalIngestionEvents,
  type PortalIngestionEvent,
} from '../src/ingestionEvents.ts'

describe('Donations Portal ingestion event contract', () => {
  test('uses the same schema-v1 fields and emits the explicit idle outcome', () => {
    let nowMs = 4_000
    const events: PortalIngestionEvent[] = []
    const ingestion = createPortalIngestionEvents({
      family: 'donations',
      chain: 'ethereum',
      now: () => nowMs,
      writeEvent: (event) => events.push(event),
    })

    ingestion.initializeDurableCursor({ height: 25 })
    ingestion.start()
    ingestion.observePortalHead({ height: 30 })
    nowMs = 5_500
    ingestion.emitRunOutcome({ outcome: 'idle' })

    expect(events).toEqual([
      {
        schema: PORTAL_INGESTION_SCHEMA,
        family: 'donations',
        chain: 'ethereum',
        event: 'restart',
        cursor_height: 25,
        portal_head_height: 30,
        portal_lag_seconds: 0,
        seconds_since_durable_progress: 0,
        portal_head_advanced: false,
        retry_count: 0,
      },
      {
        schema: PORTAL_INGESTION_SCHEMA,
        family: 'donations',
        chain: 'ethereum',
        event: 'run_outcome',
        cursor_height: 25,
        portal_head_height: 30,
        portal_lag_seconds: 1,
        seconds_since_durable_progress: 1,
        portal_head_advanced: false,
        retry_count: 0,
        outcome: 'idle',
      },
    ])
  })

  test('keeps every documented run outcome and cursor classification exact', () => {
    const events: PortalIngestionEvent[] = []
    const ingestion = createPortalIngestionEvents({
      family: 'donations',
      chain: 'base',
      now: () => 1_000,
      writeEvent: (event) => events.push(event),
    })

    ingestion.initializeDurableCursor({ height: 3 })
    ingestion.start()
    ingestion.observePortalHead({ height: 8 })
    events.length = 0
    ingestion.emitCursorClassification({ classification: 'advanced' })
    ingestion.emitCursorClassification({ classification: 'idempotent' })
    ingestion.emitCursorClassification({ classification: 'stale' })
    ingestion.emitRunOutcome({ outcome: 'success' })
    ingestion.emitRunOutcome({ outcome: 'failed' })

    expect(events.map((event) => event.classification ?? event.outcome)).toEqual([
      'advanced',
      'idempotent',
      'stale',
      'success',
      'failed',
    ])
    for (const event of events) {
      expect(event.schema).toBe('thatsrekt.portal.ingestion.v1')
      expect(typeof event.cursor_height).toBe('number')
      expect(typeof event.portal_head_height).toBe('number')
      expect(typeof event.portal_lag_seconds).toBe('number')
      expect(typeof event.seconds_since_durable_progress).toBe('number')
      expect(typeof event.portal_head_advanced).toBe('boolean')
      expect(typeof event.retry_count).toBe('number')
    }
  })
})
