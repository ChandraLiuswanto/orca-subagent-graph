import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Collector } from './collect.ts'
import type { DetailStoreLike } from './collect.ts'
import type { Entry } from './store.ts'
import type { Level } from './model.ts'
const NOW = Date.parse('2026-11-09T12:00:00Z'), DAY = 86400000
const count: Level = { kind: 'count' }, live: Level = { kind: 'live' }, all: Level = { kind: 'history', days: 36500 }
const iso = (n: number) => new Date(n).toISOString()
const worker = (id: string, extra: any = {}) => ({ dispatchId: id, runId: 'r', taskId: 't' + id, dispatchStatus: 'completed', resource: { releaseState: 'released' }, ...extra })
const openWorker = (id: string, extra: any = {}) => worker(id, { resource: { releaseState: 'held', terminalHandle: 'h' + id }, ...extra })
const wl = (workers: any[], extra: any = {}) => ({ workers, ...extra })
const show = (terminal: any = { handle: 'h', connected: false, exitCause: { kind: 'operator_close' } }, status = 'completed', extra: any = {}) => ({ dispatch: { createdAt: iso(NOW - DAY), completedAt: iso(NOW - 2 * 3600000), status }, ...(terminal === null ? {} : { terminal }), ...extra })
const entry = (extra: Partial<Entry> = {}): Entry => ({ run: 'r', c: iso(NOW - DAY), cr: null, fu: null, a: null, m: null, d: iso(NOW - 2 * 3600000), seen: NOW, ...extra })
function memory() {
  const entries = new Map<string, Entry>(), puts: { gen: number; entry: Entry }[] = [], drops: string[] = []
  const store: DetailStoreLike = { generation: 0, get: (h, id) => entries.get(h + id), put(h, id, e, gen) { puts.push({ gen, entry: e }); if (gen === this.generation) entries.set(h + id, e) }, drop(h, id) { drops.push(id); entries.delete(h + id) }, touch() {} }
  return { store, entries, puts, drops }
}
function fixture(workers: any[], opts: { runs?: any[]; terminal?: any; store?: DetailStoreLike; host?: string; response?: (args: string[]) => any } = {}) {
  const calls: string[][] = []; let now = NOW
  const cli = async (args: string[]) => {
    calls.push(args)
    const custom = opts.response?.(args)
    if (custom !== undefined) return custom
    if (args[1] === 'worker-list') return wl(workers)
    if (args[1] === 'run-list') return { runs: opts.runs ?? [{ id: 'r', objective: 'Goal', created_at: iso(NOW - 600000) }] }
    if (args[1] === 'task-list') return { tasks: [{ id: 't1', title: 'Task' }] }
    if (args[1] === 'worker-show') {
      const id = args[args.indexOf('--dispatch') + 1], w = workers.find(w => w.dispatchId === id)
      return show(opts.terminal === undefined ? { handle: w?.agentTerminalHandle ?? w?.resource?.terminalHandle, connected: false, exitCause: { kind: 'operator_close' } } : opts.terminal)
    }
    throw Error('unexpected ' + args.join(' '))
  }
  const collector = new Collector(cli, opts.store, () => now)
  return { collector, calls, advance(ms: number) { now += ms }, shows: () => calls.filter(a => a[1] === 'worker-show').map(a => a[a.indexOf('--dispatch') + 1]) }
}

test('workspace/task extraction, short rows first, and certified steady state', async () => {
  const workers = [openWorker('1', { workspace: 'wt::/a' }), worker('2', { workspace: { id: 'wt::/b' } }), worker('3', { projection: { workspace: { id: 'wt::/c' } } }), worker('4', { resource: { worktreeId: 'wt::/d', releaseState: 'released' } }), worker('5')]
  let published = false
  const f = fixture(workers, { response(args) { if (args[1] === 'worker-show') assert.ok(published) } })
  const result = await f.collector.rows('local', count, r => { published = true; assert.equal(r.rows.length, 5) })
  assert.deepEqual(result.rows.map(r => r.workspace), ['wt::/a', 'wt::/b', 'wt::/c', 'wt::/d', null])
  assert.deepEqual(result.rows.map(r => r.task_id), ['t1', 't2', 't3', 't4', 't5'])
  assert.deepEqual(f.shows(), ['1']); assert.equal(result.rows[1].details, false)
  f.calls.length = 0; await f.collector.rows('local', count)
  assert.deepEqual(f.calls.map(a => a[1]), ['worker-list'])
})

test('count only shows active without details and possibly-open, never run/task lists', async () => {
  const f = fixture([worker('released'), worker('active', { dispatchStatus: 'dispatched' }), openWorker('probe'), openWorker('exited', { projection: { liveness: { verdict: 'exited' } } })])
  await f.collector.rows('local', count); assert.deepEqual(f.shows(), ['active', 'probe'])
  assert.ok(f.calls.every(a => ['worker-list', 'worker-show'].includes(a[1])))
  f.calls.length = 0; await f.collector.rows('local', count); assert.deepEqual(f.shows(), [])
})

test('live loads recent-created and open runs, not old closed runs', async () => {
  const f = fixture([worker('recent', { runId: 'recent' }), worker('old', { runId: 'old' }), openWorker('open', { runId: 'open' }), worker('peer', { runId: 'open' })], {
    runs: ['recent', 'old', 'open'].map(id => ({ id, created_at: iso(NOW - (id === 'recent' ? 600000 : 2 * DAY)) })), terminal: { connected: true },
  })
  const r = await f.collector.rows('local', live)
  assert.deepEqual(new Set(f.shows()), new Set(['recent', 'open', 'peer']))
  assert.equal(r.rows.find(r => r.id === 'recent')?.run_created_at, iso(NOW - 600000))
})

test('live uses recent completion from restored details', async () => {
  const m = memory(); m.entries.set('localdone', entry({ run: 'finished', d: iso(NOW - 1000) }))
  const f = fixture([worker('done', { runId: 'finished' }), worker('peer', { runId: 'finished' }), worker('old', { runId: 'old' })], { store: m.store, runs: [{ id: 'finished', created_at: iso(NOW - 2 * DAY) }, { id: 'old', created_at: iso(NOW - DAY) }] })
  await f.collector.rows('local', live); assert.deepEqual(f.shows(), ['peer'])
})

test('live fallback selects newest run per project, unknown oldest', async () => {
  const f = fixture([worker('a', { runId: 'a', workspace: '/a' }), worker('older', { runId: 'older', workspace: '/a' }), worker('b', { runId: 'b', workspace: '/b' }), worker('unknown', { runId: 'unknown', workspace: '/a' })], { runs: [{ id: 'a', created_at: iso(NOW - 2 * DAY) }, { id: 'older', created_at: iso(NOW - 3 * DAY) }, { id: 'b', created_at: iso(NOW - 4 * DAY) }] })
  await f.collector.rows('local', live); assert.deepEqual(new Set(f.shows()), new Set(['a', 'b']))
})

test('history pages at most five, reports partial and filters run age/unknown', async () => {
  let pages = 0
  const f = fixture([], { runs: [{ id: 'r', created_at: iso(NOW - DAY) }, { id: 'old', created_at: iso(NOW - 40 * DAY) }], response(args) {
    if (args[1] === 'worker-list') { pages++; return wl(pages === 1 ? [worker('recent'), worker('old', { runId: 'old' }), worker('unknown', { runId: 'unknown' })] : [], { nextCursor: String(pages), page: { hasMore: true } }) }
  } })
  const r = await f.collector.rows('remote', { kind: 'history', days: 30 })
  assert.equal(pages, 5); assert.equal(r.partial, true); assert.deepEqual(f.shows(), ['recent'])
  pages = 0
  await f.collector.rows('remote', all); assert.deepEqual(new Set(f.shows()), new Set(['recent', 'old', 'unknown']))
})

test('first worker-list failure propagates, later-page failure keeps partial rows', async () => {
  const f = fixture([], { response(args) { if (args[1] === 'worker-list') throw Error('offline') } })
  await assert.rejects(f.collector.rows('local', count), /offline/)
  let page = 0
  const g = fixture([], { response(args) { if (args[1] === 'worker-list') { if (page++) throw Error('later'); return wl([worker('1')], { nextCursor: 'c' }) } } })
  const r = await g.collector.rows('local', all); assert.equal(r.partial, true); assert.equal(r.rows.length, 1)
})

test('certified proof persists and survives restart', async () => {
  const m = memory(), f = fixture([openWorker('1')], { store: m.store })
  await f.collector.rows('local', count)
  assert.deepEqual(m.entries.get('local1'), entry({ th: 'h1', ex: 'operator_close', xt: NOW }))
  f.calls.length = 0; await f.collector.rows('local', count); assert.deepEqual(f.shows(), [])
  const restart = fixture([openWorker('1')], { store: m.store }); await restart.collector.rows('local', count); assert.deepEqual(restart.shows(), [])
})

for (const terminal of [null, { connected: false }, { exitCause: { kind: 'unknown' } }]) test(`uncertified terminal ${JSON.stringify(terminal)} is negative-cached only ten minutes`, async () => {
  const m = memory(), f = fixture([openWorker('1')], { store: m.store, terminal })
  await f.collector.rows('local', count); assert.equal(m.entries.get('local1')?.ex, undefined)
  f.calls.length = 0; await f.collector.rows('local', count); assert.deepEqual(f.shows(), [])
  f.advance(600001); await f.collector.rows('local', count); assert.deepEqual(f.shows(), ['1'])
  const restart = fixture([openWorker('1')], { store: m.store, terminal }); await restart.collector.rows('local', count); assert.deepEqual(restart.shows(), ['1'])
})

for (const guard of ['newer', 'active', 'live', 'partial', 'handle', 'created']) test(`proof invalidation: ${guard}`, async () => {
  const m = memory(); m.entries.set('localold', entry({ th: 'hold', ex: 'exited', xt: NOW }))
  const old = openWorker('old'), shared = openWorker('shared', { resource: { terminalHandle: 'hold', releaseState: 'released' } })
  if (guard === 'active') shared.dispatchStatus = 'dispatched'
  if (guard === 'live') old.projection = { liveness: { verdict: 'live' } }
  if (guard === 'handle') old.resource.terminalHandle = 'changed'
  if (guard === 'created') m.entries.set('localshared', entry({ c: iso(NOW) }))
  const workers = guard === 'newer' ? [shared, old] : ['active', 'partial', 'created'].includes(guard) ? [old, shared] : [old]
  const f = fixture(workers, { store: m.store, terminal: null, response(args) { if (guard === 'partial' && args[1] === 'worker-list') return wl(workers, { page: { hasMore: true } }) } })
  await f.collector.rows('local', count)
  assert.ok(f.shows().includes('old')); assert.equal(m.entries.get('localold')?.ex, undefined)
})

test('creation times override list order when both are known', async () => {
  const m = memory()
  m.entries.set('localold', entry({ c: iso(NOW), th: 'hold', ex: 'exited', xt: NOW }))
  m.entries.set('localshared', entry({ c: iso(NOW - DAY) }))
  const f = fixture([openWorker('shared', { resource: { terminalHandle: 'hold', releaseState: 'released' } }), openWorker('old')], { store: m.store })
  await f.collector.rows('local', count); assert.deepEqual(f.shows(), [])
})

test('persisted entries are touched on every pass, including warm in-memory details', async () => {
  const m = memory(); let touches = 0
  m.store.touch = () => { touches++ }
  m.entries.set('local1', entry({ th: 'h1', ex: 'exited', xt: NOW }))
  const f = fixture([openWorker('1')], { store: m.store })
  await f.collector.rows('local', count); await f.collector.rows('local', count)
  assert.equal(touches, 2)
})

for (const kind of ['operator_close', 'signaled', 'exited'] as const) test(`certifies ${kind}`, async () => {
  const m = memory(), f = fixture([openWorker('1')], { store: m.store, terminal: { handle: 'h1', exitCause: { kind } } })
  await f.collector.rows('local', count); assert.equal(m.entries.get('local1')?.ex, kind)
})

test('run mismatch and active entries are dropped, and puts capture generation', async () => {
  const m = memory(); m.entries.set('local1', entry({ run: 'wrong' })); m.entries.set('local2', entry())
  const f = fixture([openWorker('1'), worker('2', { dispatchStatus: 'dispatched' })], { store: m.store, response(args) { if (args[1] === 'worker-show') m.store.generation++ } })
  await f.collector.rows('local', count)
  assert.deepEqual(m.drops, ['1', '2']); assert.ok(m.puts.length); assert.ok(m.puts.every(p => p.gen === 0))
})

test('clear forgets details and every in-flight result is fenced', async () => {
  let resolve!: (v: any) => void, started!: () => void
  const began = new Promise<void>(r => { started = r }), m = memory()
  let pending = true, publishes = 0
  const f = fixture([openWorker('1')], { store: m.store, response(args) { if (pending && args[1] === 'worker-show') { started(); return new Promise(r => { resolve = r }) } } })
  const pass = f.collector.rows('local', count, () => publishes++)
  await began; f.collector.clear(); resolve(show()); assert.deepEqual(await pass, { rows: [], partial: false })
  assert.equal(m.puts.length, 0); assert.equal(publishes, 1)
  pending = false; await f.collector.rows('local', count); assert.equal(f.shows().length, 2)
  m.entries.clear() // graph.clearCache also clears the persistent store
  f.collector.clear(); await f.collector.rows('local', count); assert.equal(f.shows().length, 3)
})

test('demand lapse stops level work but completes count probes with remote width two', async () => {
  const workers = [openWorker('count'), ...Array.from({ length: 10 }, (_, i) => worker(String(i)))]
  let demand: Level = all, running = 0, peak = 0, extras = 0
  const f = fixture(workers, { response(args) {
    if (args[1] !== 'worker-show') return
    running++; peak = Math.max(peak, running)
    const id = args[args.indexOf('--dispatch') + 1]
    if (id !== 'count' && ++extras === 2) demand = count
    return Promise.resolve().then(() => { running--; return show() })
  } })
  await f.collector.rows('remote', all, undefined, () => demand)
  assert.equal(extras, 2); assert.ok(f.shows().includes('count')); assert.ok(peak <= 2)
  assert.equal(f.calls.filter(a => a[1] === 'task-list').length, 0)
})

test('demand lapse after first page skips history pages and run-list', async () => {
  let demand: Level = all
  const f = fixture([worker('1')], { response(args) { if (args[1] === 'worker-list') { demand = count; return wl([worker('1')], { nextCursor: 'more' }) } } })
  const r = await f.collector.rows('remote', all, undefined, () => demand)
  assert.equal(r.partial, true); assert.deepEqual(f.calls.map(a => a[1]), ['worker-list'])
})

test('failed shows back off for 30s and preserve prior open state', async () => {
  let fail = false
  const f = fixture([openWorker('1')], { terminal: { connected: true }, response(args) { if (fail && args[1] === 'worker-show') throw Error('timeout') } })
  await f.collector.rows('local', count); fail = true
  const r = await f.collector.rows('local', count); assert.equal(r.rows[0].release_state, 'open')
  f.calls.length = 0; await f.collector.rows('local', count); assert.deepEqual(f.shows(), [])
  f.advance(30001); await f.collector.rows('local', count); assert.deepEqual(f.shows(), ['1'])
})
