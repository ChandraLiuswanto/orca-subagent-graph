import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const win: any = {}
vm.runInNewContext(readFileSync(new URL('../panel/graph.js', import.meta.url), 'utf8'), { window: win })
const G = win.SGGraph

// Arrays built inside the vm context have another prototype; compare through JSON.
const plain = (v: unknown) => JSON.parse(JSON.stringify(v))
const NOW = Date.parse('2026-11-09T10:00:00Z')
const st = (over: object) => ({ host: 'h1', state: 'ok', partial: false, forced: false, calls: 0, ...over })

test('hostLines: stale with retry, error without retry, loading, partial; ok omitted', () => {
  const lines = G.hostLines([
    st({ host: 'a', state: 'stale', reason: 'timed out', retryAt: NOW + 12000 }),
    st({ host: 'b', state: 'error', reason: 'refused', retryAt: NOW - 1 }),
    st({ host: 'c', state: 'error' }),
    st({ host: 'd', state: 'loading' }),
    st({ host: 'e', state: 'ok', partial: true }),
    st({ host: 'f', state: 'ok' })
  ], NOW)
  assert.deepEqual(plain(lines), [
    'a: timed out, retrying in 12s',
    'b: refused',
    'c: unreachable',
    'd: loading…',
    'e: showing the newest 100 workers; older ones may be missing'
  ])
})

test('hostLines: partial on a stale host adds a second line', () => {
  const lines = G.hostLines([st({ host: 'a', state: 'stale', reason: 'x', partial: true })], NOW)
  assert.deepEqual(plain(lines), ['a: x', 'a: showing the newest 100 workers; older ones may be missing'])
})

test('updatedLabel: empty, not loaded yet, oldest okAt', () => {
  assert.equal(G.updatedLabel([], NOW), '')
  assert.equal(G.updatedLabel([st({ okAt: NOW - 5000 }), st({ host: 'b' })], NOW), 'not loaded yet')
  assert.equal(G.updatedLabel([st({ okAt: NOW - 5000 }), st({ host: 'b', okAt: NOW - 30000 })], NOW), 'updated 30s ago')
})

test('updatedTitle: one line per host', () => {
  const t = G.updatedTitle([st({ host: 'a', okAt: Date.now() - 5000 }), st({ host: 'b' })])
  assert.equal(t, 'a: 5s ago\nb: not loaded yet')
})

function deferred() {
  let resolve!: (v: unknown) => void
  let reject!: (e: unknown) => void
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

function harness(hidden: boolean) {
  const calls: any[] = []
  const pending: ReturnType<typeof deferred>[] = []
  const snaps: unknown[] = []
  const errors: unknown[] = []
  const state = { hidden }
  const loader = G.createLoader({
    request: (p: unknown) => { calls.push(p); const d = deferred(); pending.push(d); return d.promise },
    isHidden: () => state.hidden,
    onSnap: (s: unknown) => snaps.push(s),
    onError: (e: unknown) => errors.push(e)
  })
  return { calls, pending, snaps, errors, state, loader }
}

test('createLoader: hidden load does not request; visible() requests once', async () => {
  const h = harness(true)
  h.loader.load(false)
  assert.equal(h.calls.length, 0)
  h.state.hidden = false
  h.loader.visible()
  assert.equal(h.calls.length, 1)
  assert.deepEqual(plain(h.calls[0]), { force: false })
  h.pending[0].resolve('snap')
  await tick()
  assert.deepEqual(h.snaps, ['snap'])
  h.loader.visible()
  assert.equal(h.calls.length, 1)
})

test('createLoader: visible() with nothing skipped does nothing', () => {
  const h = harness(false)
  h.loader.visible()
  assert.equal(h.calls.length, 0)
})

test('createLoader: loads during an in-flight request coalesce into one more, carrying force', async () => {
  const h = harness(false)
  h.loader.load(false)
  h.loader.load(true)
  h.loader.load(false)
  assert.equal(h.calls.length, 1)
  h.pending[0].resolve('one')
  await tick()
  assert.equal(h.calls.length, 2)
  assert.deepEqual(plain(h.calls[1]), { force: true })
  h.pending[1].resolve('two')
  await tick()
  assert.equal(h.calls.length, 2)
  assert.deepEqual(h.snaps, ['one', 'two'])
})

test('createLoader: errors go to onError and the queued load still runs', async () => {
  const h = harness(false)
  h.loader.load(false)
  h.loader.load(false)
  h.pending[0].reject(new Error('boom'))
  await tick()
  assert.equal(h.errors.length, 1)
  assert.equal(h.calls.length, 2)
})

test('createLoader: load(true) while hidden sends nothing, even after visible()', () => {
  const h = harness(true)
  h.loader.load(true)
  assert.equal(h.calls.length, 0)
  h.state.hidden = false
  h.loader.visible()
  assert.equal(h.calls.length, 1)
  assert.deepEqual(plain(h.calls[0]), { force: false })
})
