import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DetailStore, EXPIRY_MS, MAX_BYTES, STORE_VERSION, WRITE_EVERY_MS } from './store.ts'
import type { Entry, StorageLike } from './store.ts'

const entry = (seen = 100, extra: Partial<Entry> = {}): Entry => ({ run: 'r', c: 'created', cr: null, fu: null, a: null, m: null, d: null, seen, ...extra })
function harness() {
  let now = 100
  const values = new Map<string, unknown>()
  const calls: string[] = [], logs: string[] = []
  const timers = new Map<number, { at: number; fn: () => void }>()
  let next = 0
  const storage: StorageLike = {
    async keys() { calls.push('keys'); return [...values.keys()] },
    async get(k) { calls.push(`get:${k}`); return values.get(k) },
    async set(k, v) { calls.push(`set:${k}`); values.set(k, structuredClone(v)) },
    async delete(k) { calls.push(`delete:${k}`); values.delete(k) },
  }
  const opts = { now: () => now, setTimer(fn: () => void, ms: number) { const id = ++next; timers.set(id, { at: now + ms, fn }); return id }, clearTimer(t: unknown) { timers.delete(t as number) } }
  const store = new DetailStore(storage, m => logs.push(m), opts)
  return { store, storage, values, calls, logs, opts, timers, advance(ms: number) { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn() } } }
}
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }

test('round trip persists a versioned host value and proof', async () => {
  const h = harness(), e = entry(100, { th: 'term', ex: 'exited', xt: 50 })
  h.store.put('local', 'd', e, 0); await h.store.flushNow()
  assert.deepEqual(h.values.get('details:local'), { v: STORE_VERSION, items: { d: e } })
  const fresh = new DetailStore(h.storage, () => {}, h.opts)
  await fresh.load(); assert.deepEqual(fresh.get('local', 'd'), e)
})

test('load ignores malformed values and entries, sanitizes invalid proof', async () => {
  const h = harness()
  h.values.set('details:old', { v: 2, items: { d: entry() } })
  h.values.set('details:null', null)
  h.values.set('details:good', { v: 1, items: { bad: entry(100, { run: '' }), badSeen: entry(Infinity), good: entry(100, { th: 't', ex: 'unknown' as any, xt: 2 }) } })
  await h.store.load(); await h.store.flushNow()
  assert.equal(h.store.get('old', 'd'), undefined)
  assert.equal(h.store.get('good', 'bad'), undefined)
  assert.equal(h.store.get('good', 'badSeen'), undefined)
  assert.deepEqual(h.store.get('good', 'good'), entry())
})

test('expiry scans every host, deletes empty keys, and preserves unrelated storage', async () => {
  const h = harness(); h.advance(EXPIRY_MS)
  h.values.set('details:a', { v: 1, items: { old: entry(0), current: entry(EXPIRY_MS) } })
  h.values.set('details:b', { v: 1, items: { old: entry(0) } })
  h.values.set('other', 1)
  await h.store.load(); await h.store.flushNow()
  assert.equal(h.store.get('a', 'old'), undefined)
  assert.ok(h.store.get('a', 'current'))
  assert.equal(h.values.has('details:b'), false)
  assert.equal(h.values.get('other'), 1)
})

test('size trimming drops oldest entries and measures UTF-8 bytes', async () => {
  const h = harness()
  h.store.put('a', 'old', entry(1, { m: 'é'.repeat(MAX_BYTES / 3) }), 0)
  h.store.put('a', 'new', entry(2, { m: 'é'.repeat(MAX_BYTES / 3) }), 0)
  await h.store.flushNow()
  const value = h.values.get('details:a') as any
  assert.ok(Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_BYTES)
  assert.equal(value.items.old, undefined); assert.ok(value.items.new)
})

test('load trims an oversized valid host on its next write', async () => {
  const h = harness()
  h.values.set('details:a', { v: 1, items: {
    old: entry(1, { m: 'x'.repeat(MAX_BYTES) }), new: entry(2),
  } })
  await h.store.load(); await h.store.flushNow()
  const value = h.values.get('details:a') as any
  assert.equal(value.items.old, undefined); assert.ok(value.items.new)
})

test('five changes coalesce into an immediate and one trailing write', async () => {
  const h = harness()
  h.store.put('a', '0', entry(), 0); await settle()
  for (let i = 1; i < 5; i++) { h.advance(200); h.store.put('a', `${i}`, entry(), 0) }
  await settle(); assert.equal(h.calls.filter(c => c.startsWith('set')).length, 1)
  h.advance(WRITE_EVERY_MS); await settle()
  assert.equal(h.calls.filter(c => c.startsWith('set')).length, 2)
  assert.equal(Object.keys((h.values.get('details:a') as any).items).length, 5)
})

test('writes across hosts are serialized', async () => {
  const h = harness(); let release!: () => void
  const original = h.storage.set
  h.storage.set = async (k, v) => { if (k === 'details:a') await new Promise<void>(r => { release = r }); await original(k, v) }
  h.store.put('a', 'd', entry(), 0); await settle()
  h.store.put('b', 'd', entry(), 0); await settle()
  assert.equal(h.calls.includes('set:details:b'), false)
  release(); await h.store.flushNow()
  assert.deepEqual(h.calls.filter(c => c.startsWith('set')), ['set:details:a', 'set:details:b'])
})

for (const failing of ['keys', 'get', 'set', 'delete'] as const) test(`first ${failing} failure disables storage once`, async () => {
  const h = harness(); h.values.set('details:a', { v: 1, items: {} })
  h.storage[failing] = async () => { h.calls.push('failure'); throw new Error('denied') }
  if (failing === 'set') { h.store.put('a', 'd', entry(), 0); await h.store.flushNow() }
  else if (failing === 'delete') await h.store.clear()
  else await h.store.load()
  const count = h.calls.length
  h.store.put('b', 'd', entry(), h.store.generation); await h.store.flushNow(); await h.store.clear(); await h.store.load()
  assert.equal(h.calls.length, count); assert.equal(h.logs.length, 1)
})

test('clear synchronously fences old generation and cancels trailing writes', async () => {
  const h = harness()
  h.store.put('a', 'd', entry(), 0); await settle()
  h.store.put('a', 'pending', entry(), 0)
  const clearing = h.store.clear()
  assert.equal(h.store.generation, 1); assert.equal(h.store.get('a', 'd'), undefined)
  h.store.put('a', 'late', entry(), 0)
  await clearing; h.advance(WRITE_EVERY_MS); await h.store.flushNow()
  assert.equal(h.values.has('details:a'), false)
  assert.equal(h.store.get('a', 'late'), undefined)
})

test('clear follows an in-flight set and preserves new-generation puts during deletion', async () => {
  const h = harness(); let release!: () => void
  const original = h.storage.set
  h.storage.set = async (k, v) => { await new Promise<void>(r => { release = r }); await original(k, v) }
  h.store.put('a', 'old', entry(), 0); await settle()
  const clearing = h.store.clear()
  h.store.put('a', 'new', entry(), 1)
  h.storage.set = original; release(); await clearing; await h.store.flushNow()
  assert.deepEqual(Object.keys((h.values.get('details:a') as any).items), ['new'])
  assert.deepEqual(h.calls.filter(c => /set:|delete:/.test(c)), ['set:details:a', 'delete:details:a', 'set:details:a'])
})

test('touch only dirties after one day; drop persists deletion', async () => {
  const h = harness(); h.store.put('a', 'd', entry(), 0); await h.store.flushNow()
  const count = h.calls.length
  h.advance(1000); h.store.touch('a', 'd'); await h.store.flushNow(); assert.equal(h.calls.length, count)
  h.advance(86400000); h.store.touch('a', 'd'); await h.store.flushNow()
  assert.equal(h.store.get('a', 'd')?.seen, 86401100)
  h.store.drop('a', 'd'); await h.store.flushNow(); assert.equal(h.values.has('details:a'), false)
})

test('null storage works in memory and logs only at construction', async () => {
  const logs: string[] = [], store = new DetailStore(null, m => logs.push(m))
  store.put('a', 'd', entry(), 0); assert.deepEqual(store.get('a', 'd'), entry())
  await store.load(); await store.flushNow(); await store.clear(); assert.equal(logs.length, 1)
})
