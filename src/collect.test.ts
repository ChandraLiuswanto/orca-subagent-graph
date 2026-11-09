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

for (const settled of [
  { resource: { releaseState: 'released' } },
  { projection: { liveness: { verdict: 'exited' } } },
]) test(`active details refresh once after settling: ${JSON.stringify(settled)}`, async () => {
  const workers = [openWorker('1', { dispatchStatus: 'dispatched' })], m = memory()
  const f = fixture(workers, { store: m.store, response(args) {
    if (args[1] === 'worker-show' && workers[0].dispatchStatus === 'dispatched') {
      return show({ connected: true }, 'dispatched', { dispatch: { createdAt: iso(NOW - DAY), completedAt: null, status: 'dispatched' } })
    }
  } })
  const first = await f.collector.rows('local', count)
  assert.equal(first.rows[0].completed_at, null); assert.equal(m.puts.length, 0)
  Object.assign(workers[0], { dispatchStatus: 'completed', ...settled })
  const second = await f.collector.rows('local', count)
  assert.deepEqual(f.shows(), ['1', '1'])
  assert.equal(second.rows[0].completed_at, iso(NOW - 2 * 3600000))
  assert.equal(m.entries.get('local1')?.d, second.rows[0].completed_at)
  await f.collector.rows('local', count)
  assert.deepEqual(f.shows(), ['1', '1'])
})

for (const missing of [false, true]) test(`null completion gets only one settled refresh, missing terminal: ${missing}`, async () => {
  const workers = [openWorker('1', { dispatchStatus: 'dispatched' })]
  const f = fixture(workers, { response(args) {
    if (args[1] === 'worker-show') return show(missing ? null : { handle: 'h1', exitCause: { kind: 'exited' } }, workers[0].dispatchStatus, {
      dispatch: { createdAt: iso(NOW - DAY), completedAt: null, status: workers[0].dispatchStatus },
    })
  } })
  await f.collector.rows('local', count)
  Object.assign(workers[0], { dispatchStatus: 'completed', ...(!missing ? { resource: { releaseState: 'released', terminalHandle: 'h1' } } : {}) })
  for (let pass = 0; pass < 4; pass++) {
    f.advance(60000)
    const result = await f.collector.rows('local', count)
    assert.equal(result.rows[0].completed_at, null)
  }
  assert.deepEqual(f.shows(), ['1', '1'])
  if (missing) {
    f.advance(419999); await f.collector.rows('local', count)
    assert.deepEqual(f.shows(), ['1', '1'])
    f.advance(1); await f.collector.rows('local', count)
    assert.deepEqual(f.shows(), ['1', '1', '1'])
  }
})

test('failed settled refresh retries after 30s backoff, then stops on null completion', async () => {
  const workers = [openWorker('1', { dispatchStatus: 'dispatched' })]
  let fail = false
  const f = fixture(workers, { response(args) {
    if (args[1] !== 'worker-show') return
    if (fail) throw Error('timeout')
    return show(null, workers[0].dispatchStatus, { dispatch: { completedAt: null } })
  } })
  await f.collector.rows('local', count)
  Object.assign(workers[0], { dispatchStatus: 'completed', resource: { releaseState: 'released' } })
  fail = true; await f.collector.rows('local', count)
  fail = false; f.advance(29999); await f.collector.rows('local', count)
  assert.deepEqual(f.shows(), ['1', '1'])
  f.advance(1); await f.collector.rows('local', count)
  await f.collector.rows('local', count)
  assert.deepEqual(f.shows(), ['1', '1', '1'])
})

for (const reset of ['clear', 'run reuse']) test(`settled refresh allowance resets on ${reset}`, async () => {
  const workers = [worker('1')]
  const f = fixture(workers, { response(args) {
    if (args[1] === 'worker-show') return show(null, 'completed', { dispatch: { completedAt: null } })
  } })
  // History supplies the initial details for an already released worker.
  await f.collector.rows('local', all)
  await f.collector.rows('local', count)
  assert.deepEqual(f.shows(), ['1', '1'])
  if (reset === 'clear') f.collector.clear()
  else workers[0].runId = 'another-run'
  await f.collector.rows('local', all)
  await f.collector.rows('local', count)
  await f.collector.rows('local', count)
  assert.deepEqual(f.shows(), ['1', '1', '1', '1'])
})

test('publishes page-one short rows before page two resolves', async () => {
  let resolve!: (v: any) => void, started!: () => void
  const began = new Promise<void>(r => { started = r })
  const updates: any[] = []
  const f = fixture([], { response(args) {
    if (args[1] !== 'worker-list') return
    if (!args.includes('--cursor')) return wl([worker('1')], { nextCursor: 'second' })
    started(); return new Promise(r => { resolve = r })
  } })
  const pass = f.collector.rows('local', all, r => updates.push(r))
  await began
  const early = updates.slice()
  resolve(wl([worker('2')]))
  await pass
  assert.equal(early.length, 1)
  assert.equal(early[0].partial, true)
  assert.deepEqual(early[0].rows.map((r: any) => [r.id, r.details]), [['1', false]])
  assert.deepEqual(updates[1].rows.map((r: any) => r.id), ['1', '2'])
  assert.equal(updates[1].partial, false)
})

test('publishes each completed worker-show with its new details', async () => {
  const pending = new Map<string, (v: any) => void>()
  let started!: () => void
  const began = new Promise<void>(r => { started = r }), updates: any[] = []
  const f = fixture([openWorker('1'), openWorker('2')], { response(args) {
    if (args[1] !== 'worker-show') return
    return new Promise(r => {
      pending.set(args[args.indexOf('--dispatch') + 1], r)
      if (pending.size === 2) started()
    })
  } })
  const pass = f.collector.rows('local', count, r => updates.push(r))
  await began
  pending.get('2')!(show())
  // Let the probe's await continuation publish before resolving the other show.
  await new Promise<void>(r => setImmediate(r))
  const afterOne = updates.slice()
  pending.get('1')!(show())
  await pass
  assert.equal(afterOne.length, 2)
  assert.deepEqual(afterOne[1].rows.map((r: any) => r.details), [false, true])
  assert.equal(updates.length, 3)
  assert.deepEqual(updates[2].rows.map((r: any) => r.details), [true, true])
})

test('publishes run-list and task-list enrichment as results arrive', async () => {
  const updates: any[] = [], f = fixture([worker('1')])
  await f.collector.rows('local', all, r => updates.push(r))
  assert.deepEqual(updates.map(r => [r.rows[0].objective, r.rows[0].details, r.rows[0].title]), [
    [null, false, null], ['Goal', false, null], ['Goal', true, null], ['Goal', true, 'Task'],
  ])
})

test('failed shows back off for 30s and preserve prior open state', async () => {
  let fail = false
  const f = fixture([openWorker('1')], { terminal: { connected: true }, response(args) { if (fail && args[1] === 'worker-show') throw Error('timeout') } })
  await f.collector.rows('local', count); fail = true
  const r = await f.collector.rows('local', count); assert.equal(r.rows[0].release_state, 'open')
  f.calls.length = 0; await f.collector.rows('local', count); assert.deepEqual(f.shows(), [])
  f.advance(30001); await f.collector.rows('local', count); assert.deepEqual(f.shows(), ['1'])
})
