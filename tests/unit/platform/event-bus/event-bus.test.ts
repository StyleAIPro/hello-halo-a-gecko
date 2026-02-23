/**
 * Unit tests for platform/event-bus
 *
 * Tests:
 * - Filter engine (matchesFilter, type glob, field path, operators)
 * - Dedup cache (TTL, maxSize, duplicate detection)
 * - EventBus core (emit, subscribe, dispatch, source lifecycle)
 */

import { describe, it, expect, vi } from 'vitest'
import {
  matchesFilter,
  matchTypeGlob,
  getByPath,
  createDedupCache,
  initEventBus,
  shutdownEventBus
} from '../../../../src/main/platform/event-bus'
import { applyOperator, evaluateRule } from '../../../../src/main/platform/event-bus/filter'
import { createEventBus } from '../../../../src/main/platform/event-bus/event-bus'
import type { HaloEvent, EventFilter, FilterRule, EventSourceAdapter, EventEmitFn } from '../../../../src/main/platform/event-bus/types'

// ============================================================================
// matchTypeGlob
// ============================================================================

describe('matchTypeGlob', () => {
  it('should match exact type', () => {
    expect(matchTypeGlob('file.changed', 'file.changed')).toBe(true)
    expect(matchTypeGlob('file.changed', 'file.created')).toBe(false)
  })

  it('should match wildcard pattern', () => {
    expect(matchTypeGlob('file.changed', 'file.*')).toBe(true)
    expect(matchTypeGlob('file.created', 'file.*')).toBe(true)
    expect(matchTypeGlob('webhook.received', 'file.*')).toBe(false)
  })

  it('should match universal wildcard', () => {
    expect(matchTypeGlob('anything', '*')).toBe(true)
    expect(matchTypeGlob('file.changed', '*')).toBe(true)
  })
})

// ============================================================================
// getByPath
// ============================================================================

describe('getByPath', () => {
  const obj = {
    type: 'file.changed',
    payload: {
      extension: '.ts',
      items: [{ name: 'first' }, { name: 'second' }],
      nested: { deep: { value: 42 } }
    }
  }

  it('should resolve top-level fields', () => {
    expect(getByPath(obj, 'type')).toBe('file.changed')
  })

  it('should resolve nested fields', () => {
    expect(getByPath(obj, 'payload.extension')).toBe('.ts')
  })

  it('should resolve array indices', () => {
    expect(getByPath(obj, 'payload.items[0].name')).toBe('first')
    expect(getByPath(obj, 'payload.items[1].name')).toBe('second')
  })

  it('should resolve deeply nested paths', () => {
    expect(getByPath(obj, 'payload.nested.deep.value')).toBe(42)
  })

  it('should return undefined for missing paths', () => {
    expect(getByPath(obj, 'nonexistent')).toBeUndefined()
    expect(getByPath(obj, 'payload.nonexistent.path')).toBeUndefined()
    expect(getByPath(obj, 'payload.items[99].name')).toBeUndefined()
  })

  it('should return undefined for empty path', () => {
    expect(getByPath(obj, '')).toBeUndefined()
  })
})

// ============================================================================
// applyOperator
// ============================================================================

describe('applyOperator', () => {
  it('eq: strict equality', () => {
    expect(applyOperator('.ts', 'eq', '.ts')).toBe(true)
    expect(applyOperator('.ts', 'eq', '.js')).toBe(false)
    expect(applyOperator(42, 'eq', 42)).toBe(true)
  })

  it('neq: strict inequality', () => {
    expect(applyOperator('.ts', 'neq', '.js')).toBe(true)
    expect(applyOperator('.ts', 'neq', '.ts')).toBe(false)
  })

  it('contains: string substring', () => {
    expect(applyOperator('hello world', 'contains', 'world')).toBe(true)
    expect(applyOperator('hello world', 'contains', 'xyz')).toBe(false)
  })

  it('contains: array includes', () => {
    expect(applyOperator([1, 2, 3], 'contains', 2)).toBe(true)
    expect(applyOperator([1, 2, 3], 'contains', 4)).toBe(false)
  })

  it('matches: regex', () => {
    expect(applyOperator('hello-123', 'matches', '\\d+')).toBe(true)
    expect(applyOperator('hello', 'matches', '^hello$')).toBe(true)
    expect(applyOperator('world', 'matches', '^hello$')).toBe(false)
  })

  it('matches: invalid regex returns false', () => {
    expect(applyOperator('hello', 'matches', '[')).toBe(false)
  })

  it('gt / lt: numeric comparison', () => {
    expect(applyOperator(10, 'gt', 5)).toBe(true)
    expect(applyOperator(3, 'gt', 5)).toBe(false)
    expect(applyOperator(3, 'lt', 5)).toBe(true)
    expect(applyOperator(10, 'lt', 5)).toBe(false)
  })

  it('in / nin: array membership', () => {
    expect(applyOperator('.ts', 'in', ['.ts', '.js', '.tsx'])).toBe(true)
    expect(applyOperator('.py', 'in', ['.ts', '.js', '.tsx'])).toBe(false)
    expect(applyOperator('.py', 'nin', ['.ts', '.js', '.tsx'])).toBe(true)
    expect(applyOperator('.ts', 'nin', ['.ts', '.js', '.tsx'])).toBe(false)
  })
})

// ============================================================================
// matchesFilter (integration)
// ============================================================================

describe('matchesFilter', () => {
  function makeEvent(overrides?: Partial<HaloEvent>): HaloEvent {
    return {
      id: 'evt-1',
      type: 'file.changed',
      source: 'file-watcher',
      timestamp: Date.now(),
      payload: { extension: '.ts', filePath: '/src/index.ts' },
      ...overrides
    }
  }

  it('should match everything with empty filter', () => {
    expect(matchesFilter(makeEvent(), {})).toBe(true)
  })

  it('should match by type', () => {
    expect(matchesFilter(makeEvent(), { types: ['file.changed'] })).toBe(true)
    expect(matchesFilter(makeEvent(), { types: ['file.*'] })).toBe(true)
    expect(matchesFilter(makeEvent(), { types: ['webhook.received'] })).toBe(false)
  })

  it('should match by source', () => {
    expect(matchesFilter(makeEvent(), { sources: ['file-watcher'] })).toBe(true)
    expect(matchesFilter(makeEvent(), { sources: ['webhook'] })).toBe(false)
  })

  it('should match by rule', () => {
    const filter: EventFilter = {
      rules: [{ field: 'payload.extension', op: 'eq', value: '.ts' }]
    }
    expect(matchesFilter(makeEvent(), filter)).toBe(true)
  })

  it('should AND all criteria', () => {
    const filter: EventFilter = {
      types: ['file.*'],
      sources: ['file-watcher'],
      rules: [{ field: 'payload.extension', op: 'eq', value: '.ts' }]
    }
    expect(matchesFilter(makeEvent(), filter)).toBe(true)

    // Failing source
    expect(matchesFilter(makeEvent(), { ...filter, sources: ['webhook'] })).toBe(false)
  })

  it('should OR within types array', () => {
    const filter: EventFilter = {
      types: ['file.created', 'file.changed', 'file.deleted']
    }
    expect(matchesFilter(makeEvent({ type: 'file.changed' }), filter)).toBe(true)
    expect(matchesFilter(makeEvent({ type: 'webhook.received' }), filter)).toBe(false)
  })
})

// ============================================================================
// DedupCache
// ============================================================================

describe('DedupCache', () => {
  it('should detect duplicate within TTL', () => {
    const cache = createDedupCache({ ttlMs: 1000, maxSize: 100 })

    const first = cache.isDuplicate('key1', 1000)
    expect(first).toBe(false)

    const second = cache.isDuplicate('key1', 1500)
    expect(second).toBe(true) // within 1000ms TTL
  })

  it('should not detect duplicate after TTL expires', () => {
    const cache = createDedupCache({ ttlMs: 1000, maxSize: 100 })

    cache.isDuplicate('key1', 1000)
    const result = cache.isDuplicate('key1', 2500) // 1500ms later, TTL expired
    expect(result).toBe(false)
  })

  it('should return false for null/undefined keys', () => {
    const cache = createDedupCache()
    expect(cache.isDuplicate(null)).toBe(false)
    expect(cache.isDuplicate(undefined)).toBe(false)
  })

  it('should respect maxSize', () => {
    const cache = createDedupCache({ ttlMs: 60_000, maxSize: 3 })

    cache.isDuplicate('a', 100)
    cache.isDuplicate('b', 200)
    cache.isDuplicate('c', 300)
    cache.isDuplicate('d', 400) // should evict 'a'

    expect(cache.size()).toBeLessThanOrEqual(3)
  })

  it('should clear all entries', () => {
    const cache = createDedupCache()
    cache.isDuplicate('a')
    cache.isDuplicate('b')
    expect(cache.size()).toBe(2)

    cache.clear()
    expect(cache.size()).toBe(0)
  })
})

// ============================================================================
// createEventBus (core integration)
// ============================================================================

describe('createEventBus', () => {
  it('should emit and dispatch events to matching subscribers', async () => {
    const bus = createEventBus()
    const handler = vi.fn()

    bus.on({ types: ['file.*'] }, handler)
    bus.start()

    bus.emit({
      type: 'file.changed',
      source: 'test',
      payload: { filePath: '/a.ts' }
    })

    // Dispatch is async, give it a tick
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0][0].type).toBe('file.changed')
    expect(handler.mock.calls[0][0].id).toBeDefined()
    expect(handler.mock.calls[0][0].timestamp).toBeGreaterThan(0)

    bus.stop()
  })

  it('should NOT dispatch when bus is stopped', () => {
    const bus = createEventBus()
    const handler = vi.fn()
    bus.on({ types: ['*'] }, handler)
    // Don't call start()

    bus.emit({ type: 'test', source: 'test', payload: {} })
    expect(handler).not.toHaveBeenCalled()
  })

  it('should deduplicate events with same dedupKey', async () => {
    const bus = createEventBus({ ttlMs: 60_000 })
    const handler = vi.fn()
    bus.on({}, handler)
    bus.start()

    bus.emit({ type: 'test', source: 'test', payload: {}, dedupKey: 'dup1' })
    bus.emit({ type: 'test', source: 'test', payload: {}, dedupKey: 'dup1' })

    await new Promise(resolve => setTimeout(resolve, 10))

    expect(handler).toHaveBeenCalledOnce()
    bus.stop()
  })

  it('should unsubscribe when unsub function is called', async () => {
    const bus = createEventBus()
    const handler = vi.fn()

    const unsub = bus.on({}, handler)
    bus.start()

    bus.emit({ type: 'test', source: 'test', payload: {} })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(handler).toHaveBeenCalledOnce()

    unsub()

    bus.emit({ type: 'test', source: 'test', payload: {} })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(handler).toHaveBeenCalledOnce() // Still 1, not 2

    bus.stop()
  })

  it('should isolate handler errors', async () => {
    const bus = createEventBus()
    const badHandler = vi.fn().mockRejectedValue(new Error('boom'))
    const goodHandler = vi.fn()

    bus.on({}, badHandler)
    bus.on({}, goodHandler)
    bus.start()

    bus.emit({ type: 'test', source: 'test', payload: {} })
    await new Promise(resolve => setTimeout(resolve, 10))

    // Both handlers should have been called despite the first throwing
    expect(badHandler).toHaveBeenCalledOnce()
    expect(goodHandler).toHaveBeenCalledOnce()

    bus.stop()
  })

  it('should manage source adapter lifecycle', () => {
    const bus = createEventBus()

    const mockSource: EventSourceAdapter = {
      id: 'test-source',
      type: 'internal',
      start: vi.fn(),
      stop: vi.fn()
    }

    bus.registerSource(mockSource)
    expect(bus.listSources()).toHaveLength(1)
    expect(bus.listSources()[0].id).toBe('test-source')
    expect(bus.listSources()[0].running).toBe(false)

    bus.start()
    expect(mockSource.start).toHaveBeenCalledOnce()
    expect(bus.listSources()[0].running).toBe(true)

    bus.stop()
    expect(mockSource.stop).toHaveBeenCalledOnce()
  })

  it('should start source immediately if bus is already running', () => {
    const bus = createEventBus()
    bus.start()

    const mockSource: EventSourceAdapter = {
      id: 'late-source',
      type: 'internal',
      start: vi.fn(),
      stop: vi.fn()
    }

    bus.registerSource(mockSource)
    expect(mockSource.start).toHaveBeenCalledOnce()

    bus.stop()
  })
})

// ============================================================================
// initEventBus / shutdownEventBus
// ============================================================================

describe('initEventBus / shutdownEventBus', () => {
  it('should return singleton service', () => {
    const bus1 = initEventBus()
    const bus2 = initEventBus()
    expect(bus1).toBe(bus2)

    shutdownEventBus()
  })

  it('should create fresh instance after shutdown', () => {
    const bus1 = initEventBus()
    shutdownEventBus()
    const bus2 = initEventBus()
    expect(bus2).not.toBe(bus1)

    shutdownEventBus()
  })
})
