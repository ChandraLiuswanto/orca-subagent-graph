import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRuns, chip, liveOnly, phaseOf, type Row } from './model.ts'

function row(over: Partial<Row>): Row {
  return {
    id: 'ctx_a', host: 'local', run_id: 'run_1', status: 'completed', creator_dispatch_id: null,
    follow_up_of_dispatch_id: null, created_at: '2026-11-08 10:00:00', completed_at: null, title: 'T',
    agent: 'pi', model: null, worker_state: 'succeeded', release_state: 'retained',
    terminal_handle: 'term_a', objective: 'Obj', ...over
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
  assert.equal(liveOnly(none).length, 1) // still shows the newest run
})

test('same dispatch ids on two hosts stay separate', () => {
  const snap = buildRuns([row({ status: 'dispatched' }), row({ host: 'fedora', status: 'dispatched' })], undefined, 0)
  assert.equal(snap.runs.length, 2)
  assert.equal(snap.totals.running, 2)
  assert.deepEqual(snap.hosts.sort(), ['fedora', 'local'])
})
