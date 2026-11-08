import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Collector } from './collect.ts'

const base = { runId: 'run1', dispatchStatus: 'completed', resource: { releaseState: 'released' } }

test('rows carry workspace and task id without extra per-poll CLI calls', async () => {
  const calls: string[][] = []
  const cli = async (args: string[]) => {
    calls.push(args)
    switch (args[1]) {
      case 'worker-list':
        return {
          workers: [
            { ...base, dispatchId: 'd1', taskId: 't1', projection: { workspace: { id: 'wt::/p/a' } } },
            { ...base, dispatchId: 'd2', taskId: 't2', resource: { ...base.resource, worktreeId: 'wt::/p/b' } },
            { ...base, dispatchId: 'd3', taskId: 't3', workspace: 'wt::/p/c' },
            { ...base, dispatchId: 'd4', taskId: 't4' }
          ]
        }
      case 'run-list':
        return { runs: [] }
      case 'task-list':
        return { tasks: [] }
      case 'worker-show':
        return { dispatch: { createdAt: '2026-11-08 10:00:00', completedAt: '2026-11-08 10:01:00', status: 'completed' } }
    }
    throw new Error('unexpected ' + args.join(' '))
  }
  const c = new Collector(cli)
  const rows = await c.rows('local')
  assert.deepEqual(rows.map((r) => r.workspace), ['wt::/p/a', 'wt::/p/b', 'wt::/p/c', null])
  assert.deepEqual(rows.map((r) => r.task_id), ['t1', 't2', 't3', 't4'])

  calls.length = 0
  const again = await c.rows('local')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], 'worker-list')
  assert.deepEqual(again.map((r) => r.workspace), ['wt::/p/a', 'wt::/p/b', 'wt::/p/c', null])
})
