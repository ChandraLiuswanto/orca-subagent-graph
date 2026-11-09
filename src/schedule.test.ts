import test from 'node:test'
import assert from 'node:assert/strict'
import { Scheduler, ATTENTION_MS } from './schedule.ts'
import type { HostRunner, PassResult } from './schedule.ts'
import type { Level, Row } from './model.ts'

const empty = (): PassResult => ({ rows: [], partial: false })
const row = { id: 'one', host: 'local' } as Row
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function harness(names = ['local', 'remote']) {
  let time = 0, sequence = 0
  const timers = new Map<number, { fn: () => void; at: number }>()
  const passes: { host: string; level: Level; publish: (r: PassResult) => void; demand: () => Level; done: ReturnType<typeof deferred<PassResult>> }[] = []
  const changes: boolean[] = []
  const run: HostRunner = (host, level, publish, demand) => {
    const done = deferred<PassResult>()
    passes.push({ host, level, publish, demand, done })
    return done.promise
  }
  const scheduler = new Scheduler({ run, hosts: async () => names, calls: () => 17,
    onChange: p => changes.push(p), now: () => time,
    setTimer: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, at: time + ms }); return id },
    clearTimer: id => { timers.delete(id as number) } })
  return { scheduler, passes, changes, timers,
    hosts: (next: string[]) => { names = next },
    advance: async (ms: number) => {
      const end = time + ms
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        time = next[1].at; timers.delete(next[0]); next[1].fn(); await flush()
      }
      time = end; await flush()
    },
    start: async () => { scheduler.start(); await flush() },
  }
}

test('per-host loops keep local moving while remote hangs; routine ticks stay ok', async () => {
  const h = harness(); await h.start()
  assert.equal(h.passes.length, 2)
  for (let i = 0; i < 3; i++) {
    h.passes.filter(p => p.host === 'local').at(-1)!.done.resolve(empty()); await flush()
    assert.equal(h.scheduler.status()[0].state, 'ok')
    await h.advance(4000)
    assert.equal(h.scheduler.status()[0].state, 'ok')
  }
  assert.equal(h.passes.filter(p => p.host === 'local').length, 4)
  assert.equal(h.scheduler.status()[1].state, 'loading')
  assert.equal(h.scheduler.status()[0].calls, 17)
  h.scheduler.stop(); assert.equal(h.timers.size, 0)
})

test('attention expires, raises run immediately, narrower history does not raise', async () => {
  const h = harness(['local']); h.scheduler.ask({ kind: 'live' }); await h.start()
  assert.deepEqual(h.passes[0].level, { kind: 'live' })
  h.passes[0].done.resolve(empty()); await flush()
  h.scheduler.ask({ kind: 'history', days: 30 }); await flush()
  assert.equal(h.passes.length, 2)
  assert.deepEqual(h.passes[1].level, { kind: 'history', days: 30 })
  h.passes[1].done.resolve(empty()); await flush()
  h.scheduler.ask({ kind: 'history', days: 7 }); await flush()
  assert.equal(h.passes.length, 2)
  await h.advance(ATTENTION_MS + 1000)
  assert.deepEqual(h.passes[0].demand(), { kind: 'count' })
  h.passes.at(-1)!.done.resolve(empty()); await flush(); await h.advance(4000)
  assert.deepEqual(h.passes.at(-1)!.level, { kind: 'count' })
  h.scheduler.stop()
})

for (const failure of [false, true]) test(`force coalesces while queued and running, clears on ${failure ? 'failure' : 'success'}`, async () => {
  const h = harness(['local']); await h.start()
  h.scheduler.force(); h.scheduler.force()
  assert.equal(h.scheduler.status()[0].forced, true)
  h.passes[0].done.resolve(empty()); await flush()
  assert.equal(h.passes.length, 2)
  assert.equal(h.scheduler.status()[0].state, 'loading')
  h.scheduler.force(); assert.equal(h.passes.length, 2)
  if (failure) h.passes[1].done.reject(new Error('broken'))
  else h.passes[1].done.resolve(empty())
  await flush()
  assert.equal(h.scheduler.status()[0].forced, false)
  assert.equal(h.changes.at(-1), false)
  await h.advance(4000); assert.equal(h.passes.length, 3)
  h.scheduler.stop()
})

test('remote backoff grows and caps; force bypass keeps failure count, success resets', async () => {
  const h = harness(['remote']); await h.start()
  h.passes[0].publish({ rows: [row], partial: true })
  for (const delay of [30000, 60000, 120000, 120000]) {
    h.passes.at(-1)!.done.reject(new Error('offline')); await flush()
    const status = h.scheduler.status()[0]
    assert.equal(status.state, 'stale'); assert.equal(status.reason, 'offline')
    h.scheduler.ask({ kind: 'live' }); await flush()
    assert.equal(h.scheduler.status()[0].state, 'stale')
    const before = h.passes.length
    await h.advance(delay - 1); assert.equal(h.passes.length, before)
    await h.advance(1); assert.equal(h.passes.length, before + 1)
  }
  h.passes.at(-1)!.done.resolve(empty()); await flush()
  await h.advance(15000)
  h.passes.at(-1)!.done.reject(new Error('again')); await flush()
  const retry = h.scheduler.status()[0].retryAt!
  h.scheduler.force(); await flush()
  assert.equal(h.scheduler.status()[0].forced, true)
  h.passes.at(-1)!.done.reject(new Error('forced failure')); await flush()
  assert.equal(h.scheduler.status()[0].retryAt, retry + 30000)
  h.scheduler.stop()
})

test('a raise queued during a failing remote pass respects the new backoff', async () => {
  const h = harness(['remote']); await h.start()
  h.passes[0].publish(empty())
  h.scheduler.ask({ kind: 'live' })
  h.passes[0].done.reject(new Error('offline')); await flush()
  assert.equal(h.passes.length, 1)
  assert.equal(h.scheduler.status()[0].state, 'stale')
  await h.advance(29999); assert.equal(h.passes.length, 1)
  await h.advance(1); assert.equal(h.passes.length, 2)
  h.scheduler.stop()
})

test('local failure never backs off, firstData waits for publication even empty', async () => {
  const h = harness(['local']); let received = false
  void h.scheduler.firstData().then(() => { received = true })
  await h.start(); h.passes[0].done.reject(new Error('no rows')); await flush()
  assert.equal(h.scheduler.hasData(), false); assert.equal(received, false)
  assert.equal(h.scheduler.status()[0].state, 'error')
  assert.equal(h.scheduler.status()[0].retryAt, undefined)
  await h.advance(4000)
  h.passes[1].publish(empty()); await flush()
  assert.equal(received, true); assert.equal(h.scheduler.hasData(), true)
  assert.equal(h.changes.at(-1), true)
  h.passes[1].done.resolve(empty()); await flush()
  h.scheduler.stop()
})

test('cancelQueued clears cache and discards old progress, result, and queued force', async () => {
  const h = harness(['local']); await h.start()
  h.passes[0].publish({ rows: [row], partial: true })
  h.scheduler.force(); h.scheduler.cancelQueued()
  assert.deepEqual(h.scheduler.rows(), [])
  assert.equal(h.scheduler.status()[0].partial, false)
  assert.equal(h.scheduler.status()[0].forced, false)
  h.passes[0].publish({ rows: [row], partial: true })
  h.passes[0].done.resolve({ rows: [row], partial: true }); await flush()
  assert.deepEqual(h.scheduler.rows(), [])
  assert.equal(h.scheduler.status()[0].okAt, undefined)
  assert.equal(h.passes.length, 1)
  h.scheduler.ask({ kind: 'live' }); await flush()
  assert.equal(h.passes.length, 2)
  h.scheduler.stop()
})

test('host discovery removes disappeared hosts and starts newcomers in host order', async () => {
  const h = harness(); await h.start()
  h.passes[0].done.resolve({ rows: [row], partial: false }); await flush()
  h.hosts(['local', 'new'])
  await h.advance(4000)
  assert.deepEqual(h.scheduler.status().map(s => s.host), ['local', 'new'])
  assert.equal(h.passes.filter(p => p.host === 'new').length, 1)
  h.passes[1].publish({ rows: [{ ...row, id: 'removed' }], partial: false })
  assert.deepEqual(h.scheduler.rows(), [row])
  h.scheduler.stop()
})
