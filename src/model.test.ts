import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRuns, chip, formatDuration, groupProjects, liveRuns, nodeDuration, pathOf, phaseOf, projectLabels, RECENT_MS, toMs, type Row } from './model.ts'

function row(over: Partial<Row>): Row {
  return {
    id: 'ctx_a', host: 'local', run_id: 'run_1', status: 'completed', creator_dispatch_id: null,
    follow_up_of_dispatch_id: null, created_at: '2026-11-08 10:00:00', completed_at: null, title: 'T',
    agent: 'pi', model: null, worker_state: 'succeeded', release_state: 'retained',
    terminal_handle: 'term_a', objective: 'Obj', task_id: 'task_a',
    workspace: 'wt1::/home/u/proj-a', ...over
  }
}

test('phase: running, idle when the terminal is open, done when closed or released, failed', () => {
  const open = (r: Row) => r.terminal_handle === 'term_open'
  assert.equal(phaseOf(row({ status: 'dispatched' }), open), 'running')
  assert.equal(phaseOf(row({ terminal_handle: 'term_open' }), open), 'idle')
  assert.equal(phaseOf(row({ terminal_handle: 'term_shut' }), open), 'done')
  assert.equal(phaseOf(row({ terminal_handle: 'term_open', release_state: 'released' }), open), 'done')
  assert.equal(phaseOf(row({ status: 'failed' }), open), 'failed')
})

test('nests workers under the worker that started them and folds follow-ups', () => {
  const rows = [
    row({ id: 'ctx_root', terminal_handle: 'term_root', status: 'dispatched', created_at: '2026-11-08 10:00:00' }),
    row({ id: 'ctx_kid', creator_dispatch_id: 'ctx_root', terminal_handle: 'term_kid', created_at: '2026-11-08 10:01:00' }),
    row({ id: 'ctx_grand', creator_dispatch_id: 'ctx_kid', status: 'dispatched', created_at: '2026-11-08 10:02:00' }),
    row({ id: 'ctx_kid2', follow_up_of_dispatch_id: 'ctx_kid', creator_dispatch_id: 'ctx_root', status: 'dispatched', created_at: '2026-11-08 10:03:00' }),
    row({ id: 'ctx_other', run_id: 'run_0', objective: 'Old', terminal_handle: 'term_x', created_at: '2026-11-07 09:00:00' })
  ]
  const snap = buildRuns(rows, () => false, 0)
  assert.equal(snap.runs.length, 2)
  assert.equal(snap.runs[0].id, 'run_1') // newest first
  const [root] = snap.runs[0].roots
  assert.equal(root.id, 'ctx_root')
  assert.equal(root.children.length, 1)
  const kid = root.children[0]
  assert.equal(kid.followUps, 1)
  assert.equal(kid.phase, 'running') // latest follow-up wins
  assert.equal(kid.children[0].id, 'ctx_grand')
  assert.deepEqual(snap.totals, { running: 3, idle: 0, done: 1, failed: 0, maxDepth: 3 })
})

test('chip counts running + idle and hides at zero', () => {
  const idle = buildRuns([row({ release_state: 'open' })], undefined, 0)
  assert.equal(chip(idle).text, '1 subagent')
  assert.equal(chip(idle).visible, true)
  const none = buildRuns([row({})], () => false, 0)
  assert.deepEqual(chip(none), { visible: false })
  assert.equal(liveRuns(none.runs, toMs('2026-11-09 10:00:00')).length, 1) // still shows the newest run
})

test('same dispatch ids on two hosts stay separate', () => {
  const snap = buildRuns([row({ status: 'dispatched' }), row({ host: 'fedora', status: 'dispatched' })], undefined, 0)
  assert.equal(snap.runs.length, 2)
  assert.equal(snap.totals.running, 2)
  assert.deepEqual(snap.hosts.sort(), ['fedora', 'local'])
})

const T = (s: string) => toMs('2026-11-08 ' + s)

test('workspace path: part after ::, whole string otherwise', () => {
  assert.equal(pathOf('wt::/a/b'), '/a/b')
  assert.equal(pathOf('/a/b'), '/a/b')
  assert.equal(pathOf(null), null)
})

test('groups runs by project (host + path), unknown workspace gets its own group', () => {
  const rows = [
    row({ id: 'a', run_id: 'r_a', workspace: 'w1::/p/alpha', created_at: '2026-11-08 10:00:00' }),
    row({ id: 'a2', run_id: 'r_a2', workspace: 'w1::/p/alpha', created_at: '2026-11-08 10:30:00' }),
    row({ id: 'b', run_id: 'r_b', workspace: 'w2::/p/beta', status: 'dispatched', created_at: '2026-11-08 09:00:00' }),
    row({ id: 'c', run_id: 'r_c', host: 'fedora', workspace: 'w1::/p/alpha', created_at: '2026-11-08 11:00:00' }),
    row({ id: 'd', run_id: 'r_d', workspace: null, created_at: '2026-11-08 08:00:00' })
  ]
  const projects = groupProjects(buildRuns(rows, () => false, 0).runs)
  assert.equal(projects.length, 4)
  assert.equal(projects[0].label, 'beta') // running first
  assert.deepEqual(projects[0].counts, { running: 1, idle: 0, done: 0, failed: 0 })
  assert.deepEqual(projects.slice(1).map((p) => [p.host, p.label]), [['fedora', 'alpha'], ['local', 'alpha'], ['local', 'Unknown project']])
  assert.deepEqual(projects[2].runs.map((r) => r.id), ['r_a2', 'r_a']) // newest first
})

test('failed runs sort above done ones inside a project', () => {
  const rows = [
    row({ id: 'x', run_id: 'r_fail', status: 'failed', created_at: '2026-11-08 10:00:00' }),
    row({ id: 'y', run_id: 'r_done', created_at: '2026-11-08 11:00:00' })
  ]
  const [p] = groupProjects(buildRuns(rows, () => false, 0).runs)
  assert.deepEqual(p.runs.map((r) => r.id), ['r_fail', 'r_done'])
})

test('labels: shortest distinguishing suffix; empty last segment falls back to the full path', () => {
  const labels = projectLabels([
    { key: '1', path: '/w/new_bsa_react/main' },
    { key: '2', path: '/w/new_bsa_react/surface-probe/main' },
    { key: '3', path: '/home/u' },
    { key: '4', path: '/' },
    { key: '5', path: null },
    { key: '6', path: '/x/a/b' },
    { key: '7', path: '/y/a/b' }
  ])
  assert.equal(labels.get('1'), 'new_bsa_react/main')
  assert.equal(labels.get('2'), 'surface-probe/main')
  assert.equal(labels.get('3'), 'u')
  assert.equal(labels.get('4'), '/')
  assert.equal(labels.get('5'), 'Unknown project')
  assert.equal(labels.get('6'), 'x/a/b')
  assert.equal(labels.get('7'), 'y/a/b')
})

test('live: active runs plus runs that finished within 1h, across projects', () => {
  const rows = [
    row({ id: 'a', run_id: 'r_a', workspace: 'w::/p/A', created_at: '2026-11-08 10:00:00', completed_at: '2026-11-08 10:20:00' }),
    row({ id: 'b', run_id: 'r_b', workspace: 'w::/p/B', status: 'dispatched', created_at: '2026-11-08 10:25:00' }),
    row({ id: 'old', run_id: 'r_old', workspace: 'w::/p/A', created_at: '2026-11-08 07:00:00', completed_at: '2026-11-08 08:00:00' })
  ]
  const runs = buildRuns(rows, () => false, 0).runs
  const at = (now: number) => liveRuns(runs, now).map((r) => r.id)
  assert.deepEqual(at(T('10:30:00')), ['r_b', 'r_a'])
  assert.deepEqual(at(T('10:20:00') + RECENT_MS), ['r_b', 'r_a']) // exactly 1h after A finished
  assert.deepEqual(at(T('10:20:01') + RECENT_MS), ['r_b'])
  const groups = groupProjects(liveRuns(runs, T('10:30:00')))
  assert.deepEqual(groups.map((p) => p.label), ['B', 'A'])
})

test('live falls back to each project\'s newest run when nothing is recent', () => {
  const rows = [
    row({ id: 'a1', run_id: 'r_a1', workspace: 'w::/p/A', created_at: '2026-11-08 07:00:00', completed_at: '2026-11-08 07:10:00' }),
    row({ id: 'a2', run_id: 'r_a2', workspace: 'w::/p/A', created_at: '2026-11-08 08:00:00', completed_at: '2026-11-08 08:10:00' }),
    row({ id: 'b1', run_id: 'r_b1', workspace: 'w::/p/B', created_at: '2026-11-08 06:00:00', completed_at: '2026-11-08 06:10:00' })
  ]
  const runs = buildRuns(rows, () => false, 0).runs
  assert.deepEqual(liveRuns(runs, T('20:00:00')).map((r) => r.id), ['r_a2', 'r_b1'])
  assert.deepEqual(liveRuns([], T('20:00:00')), [])
})

test('a run belongs to its root worker\'s project even when nested workers use another worktree', () => {
  const rows = [
    row({ id: 'kid', run_id: 'r', creator_dispatch_id: 'root', workspace: 'w2::/p/child-wt', created_at: '2026-11-08 10:01:00' }),
    row({ id: 'root', run_id: 'r', workspace: 'w1::/p/main', created_at: '2026-11-08 10:00:00' }),
    row({ id: 'kid2', run_id: 'r', creator_dispatch_id: 'root', workspace: 'w3::/p/other', created_at: '2026-11-08 10:02:00' })
  ]
  const snap = buildRuns(rows, () => false, 0)
  assert.equal(snap.runs.length, 1)
  assert.equal(snap.runs[0].workspace, 'w1::/p/main')
  assert.equal(snap.runs[0].roots[0].children.length, 2)
  assert.equal(snap.runs[0].workers, 3)
  assert.equal(snap.runs[0].depth, 2)
  const [p] = groupProjects(snap.runs)
  assert.equal(p.label, 'main')
})

test('duration formatting and node durations', () => {
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(44_000), '44s')
  assert.equal(formatDuration(130_000), '2m 10s')
  assert.equal(formatDuration(3_600_000 + 5 * 60_000), '1h 05m')
  assert.equal(formatDuration(26 * 3_600_000), '1d 2h')
  assert.equal(formatDuration(NaN), '')
  assert.equal(formatDuration(-1), '')
  const n = { createdAt: '2026-11-08 10:00:00', completedAt: '2026-11-08 10:06:53' }
  assert.equal(formatDuration(nodeDuration({ ...n, phase: 'done' })), '6m 53s')
  assert.equal(formatDuration(nodeDuration({ ...n, completedAt: null, phase: 'running' }, T('10:02:10'))), '2m 10s')
  assert.equal(formatDuration(nodeDuration({ ...n, completedAt: null, phase: 'done' })), '')
})

test('chip tooltip lists up to 3 projects then +N more, within 256 chars', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'].map((x) =>
    row({ id: x, run_id: 'r_' + x, workspace: 'w::/p/' + x.repeat(60), status: 'dispatched' })
  )
  const c = chip(buildRuns(rows, () => false, 0))
  assert.match(c.tooltip!, /By project: .*\+2 more/)
  assert.ok(c.tooltip!.length <= 256)
  const one = chip(buildRuns([row({ status: 'dispatched' })], () => false, 0))
  assert.equal(one.tooltip, 'Orca workers: 1 running, 0 idle. By project: proj-a 1. Open the Subagents panel for the graph.')
})
