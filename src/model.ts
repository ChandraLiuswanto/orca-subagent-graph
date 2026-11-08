// Pure data shaping: worker records from the Orca CLI -> runs -> nested worker trees.
// No Node or Orca imports, so tests can feed it plain rows.

export type Row = {
  id: string // dispatch id
  host: string // 'local' or a paired Orca server name
  run_id: string
  status: string // dispatch status: pending | dispatched | completed | failed | circuit_broken
  creator_dispatch_id: string | null
  follow_up_of_dispatch_id: string | null
  created_at: string
  completed_at: string | null
  title: string | null
  agent: string | null
  model: string | null
  worker_state: string | null
  release_state: string | null
  terminal_handle: string | null
  objective: string | null
}

/** running: still working. idle: finished, terminal still open. done: finished and closed. */
export type Phase = 'running' | 'idle' | 'done' | 'failed'

export type Node = {
  id: string
  host: string
  title: string
  agent: string | null
  model: string | null
  phase: Phase
  status: string
  terminal: string | null
  createdAt: string
  completedAt: string | null
  followUps: number
  children: Node[]
}

export type Run = {
  id: string
  host: string
  objective: string
  coordinator: string | null
  createdAt: string
  counts: Record<Phase, number>
  roots: Node[]
}

export type Snapshot = {
  at: number
  runs: Run[]
  totals: Record<Phase, number> & { maxDepth: number }
  hosts: string[]
  error?: string
}

const ACTIVE = new Set(['pending', 'dispatched'])

/** `open(row)` answers whether the worker's terminal is still alive; undefined = unknown. */
export function phaseOf(row: Row, open: (row: Row) => boolean | undefined = (r) => r.release_state === 'open'): Phase {
  if (ACTIVE.has(row.status)) return 'running'
  if (row.status === 'failed' || row.status === 'circuit_broken' || row.worker_state === 'failed') {
    return 'failed'
  }
  if (row.release_state === 'released') return 'done'
  if (!row.terminal_handle) return 'done'
  return open(row) === true ? 'idle' : 'done'
}

const zero = (): Record<Phase, number> => ({ running: 0, idle: 0, done: 0, failed: 0 })

/** Orca stores "2026-11-08 11:33:34" (UTC) or ISO strings; both sort and parse as UTC. */
export function toMs(s: string | null): number {
  if (!s) return NaN
  return Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z')
}

/**
 * Builds one tree per run. A follow-up dispatch (same worker reused via `send`) folds into the
 * dispatch it continues, so one worker is one node. Nesting comes from creator_dispatch_id: a
 * worker that started its own workers is their parent.
 */
export function buildRuns(rows: Row[], open: (row: Row) => boolean | undefined = (r) => r.release_state === 'open', now = Date.now()): Snapshot {
  rows = [...rows].sort((a, b) => toMs(a.created_at) - toMs(b.created_at))
  const k = (host: string, id: string) => host + '\u0000' + id
  const byId = new Map<string, Row>(rows.map((r) => [k(r.host, r.id), r]))
  const rootOf = (host: string, id: string): string => {
    let cur = id
    for (let i = 0; i < 64; i++) {
      const prev = byId.get(k(host, cur))?.follow_up_of_dispatch_id
      if (!prev || !byId.has(k(host, prev))) return cur
      cur = prev
    }
    return cur
  }

  const nodes = new Map<string, Node>()
  const runs = new Map<string, Run>()
  const parentOf = new Map<string, string | null>()
  const runOfNode = new Map<string, string>()

  for (const row of rows) {
    const key = k(row.host, rootOf(row.host, row.id))
    const phase = phaseOf(row, open)
    let node = nodes.get(key)
    if (!node) {
      node = {
        id: rootOf(row.host, row.id),
        host: row.host,
        title: row.title || row.id,
        agent: row.agent,
        model: row.model,
        phase,
        status: row.status,
        terminal: row.terminal_handle,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        followUps: 0,
        children: []
      }
      nodes.set(key, node)
      parentOf.set(key, row.creator_dispatch_id ? k(row.host, rootOf(row.host, row.creator_dispatch_id)) : null)
      runOfNode.set(key, k(row.host, row.run_id))
    } else {
      // Oldest first: the latest follow-up decides the worker's current state.
      node.followUps += 1
      node.phase = phase
      node.status = row.status
      node.completedAt = row.completed_at
      node.terminal = row.terminal_handle ?? node.terminal
      if (row.title) node.title = row.title
    }
    const rk = k(row.host, row.run_id)
    if (!runs.has(rk)) {
      runs.set(rk, {
        id: row.run_id,
        host: row.host,
        objective: row.objective || row.run_id,
        coordinator: row.host === 'local' ? 'main agent' : `main agent on ${row.host}`,
        createdAt: row.created_at,
        counts: zero(),
        roots: []
      })
    }
  }

  for (const [key, node] of nodes) {
    const parent = parentOf.get(key)
    const parentNode = parent ? nodes.get(parent) : undefined
    if (parentNode && parentNode !== node) parentNode.children.push(node)
    else runs.get(runOfNode.get(key)!)!.roots.push(node)
  }

  const totals = { ...zero(), maxDepth: 0 }
  const walk = (n: Node, depth: number, run: Run): void => {
    run.counts[n.phase] += 1
    totals[n.phase] += 1
    totals.maxDepth = Math.max(totals.maxDepth, depth)
    for (const c of n.children) walk(c, depth + 1, run)
  }
  for (const run of runs.values()) for (const r of run.roots) walk(r, 1, run)

  const list = [...runs.values()].sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt))
  return { at: now, runs: list, totals, hosts: [...new Set(rows.map((r) => r.host))] }
}

/** The status bar chip: "2 subagents" (running + idle), hidden when there are none. */
export function chip(s: Snapshot): { visible: boolean; text?: string; tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; tooltip?: string } {
  const live = s.totals.running + s.totals.idle
  if (s.error && live === 0) return { visible: true, text: 'subagents ?', tone: 'warning', tooltip: s.error.slice(0, 250) }
  if (live === 0) return { visible: false }
  const parts = [`${s.totals.running} running`, `${s.totals.idle} idle`]
  if (s.totals.maxDepth > 1) parts.push(`nested ${s.totals.maxDepth} deep`)
  return {
    visible: true,
    text: `${live} subagent${live === 1 ? '' : 's'}`,
    tone: s.totals.running > 0 ? 'accent' : 'neutral',
    tooltip: `Orca workers: ${parts.join(', ')}. Open the Subagents panel for the graph.`.slice(0, 256)
  }
}

/** Keep only runs that have a running/idle worker, plus the newest run. */
export function liveOnly(s: Snapshot): Run[] {
  const live = s.runs.filter((r) => r.counts.running + r.counts.idle > 0)
  if (s.runs[0] && !live.includes(s.runs[0])) live.push(s.runs[0])
  return live.sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt))
}
