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
  task_id: string | null
  /** Orca workspace, '<worktreeId>::<absolute path>' (or just a path). */
  workspace: string | null
  /** Run creation time from `run-list` (`created_at`), when known. */
  run_created_at: string | null
  /** True once worker-show details (times, creator, follow-up, agent, model) are known. */
  details: boolean
}

/** running: still working. idle: finished, terminal still open. done: finished and closed. */
export type Phase = 'running' | 'idle' | 'done' | 'failed'

export type Node = {
  id: string
  host: string
  taskId: string | null
  workspace: string | null
  title: string
  agent: string | null
  model: string | null
  phase: Phase
  status: string
  terminal: string | null
  createdAt: string
  completedAt: string | null
  followUps: number
  loading: boolean // the node's newest row has details === false
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
  /** Workspace of the root worker (earliest worker with no creator). */
  workspace: string | null
  /** Project key: host + path (see projectKey). */
  project: string
  /** Latest completed_at among the run's workers, ms; null when none settled. */
  endedAt: number | null
  /** Latest created_at / completed_at among the run's workers, ms. */
  lastActivityAt: number
  /** Worker nodes (follow-ups folded) and deepest nesting level. */
  workers: number
  depth: number
}

export type Project = {
  key: string
  host: string
  path: string | null
  label: string
  counts: Record<Phase, number>
  lastActivityAt: number
  runs: Run[]
}

export type Snapshot = {
  at: number
  runs: Run[]
  totals: Record<Phase, number> & { maxDepth: number }
  hosts: string[]
  error?: string
  hostStatus: HostStatus[] // buildRuns() returns [], worker.ts fills it in
}

export type HostState = 'ok' | 'loading' | 'stale' | 'error'
export type HostStatus = {
  host: string
  state: HostState
  reason?: string
  okAt?: number
  retryAt?: number
  partial: boolean
  forced: boolean
  calls: number
}

export type Level = { kind: 'count' } | { kind: 'live' } | { kind: 'history'; days: number }
/** count < live < history; a history with more days ranks higher. */
export function levelRank(l: Level): number {
  return l.kind === 'count' ? 0 : l.kind === 'live' ? 1 : 2 + l.days
}
export function pagesFor(l: Level): number {
  return l.kind === 'history' && l.days > 7 ? 5 : 1
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
  // Detail-less rows have no created_at; fall back to the run's time. Unknown sorts last, ties by id.
  const sortKey = (r: Row) => {
    const t = toMs(r.created_at)
    const u = isFinite(t) ? t : toMs(r.run_created_at)
    return isFinite(u) ? u : Infinity
  }
  rows = [...rows].sort((a, b) => {
    const ka = sortKey(a)
    const kb = sortKey(b)
    return ka === kb ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : ka < kb ? -1 : 1
  })
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
  const rootSeen = new Set<string>()
  const fallbackSet = new Set<string>()

  for (const row of rows) {
    const key = k(row.host, rootOf(row.host, row.id))
    const phase = phaseOf(row, open)
    let node = nodes.get(key)
    if (!node) {
      node = {
        id: rootOf(row.host, row.id),
        host: row.host,
        taskId: row.task_id,
        workspace: row.workspace,
        title: row.title || row.id,
        agent: row.agent,
        model: row.model,
        phase,
        status: row.status,
        terminal: row.terminal_handle,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        followUps: 0,
        loading: !row.details,
        children: []
      }
      nodes.set(key, node)
      parentOf.set(key, row.creator_dispatch_id ? k(row.host, rootOf(row.host, row.creator_dispatch_id)) : null)
      runOfNode.set(key, k(row.host, row.run_id))
    } else {
      // Oldest first: the latest follow-up decides the worker's current state.
      node.followUps += 1
      node.phase = phase
      node.loading = !row.details
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
        createdAt: row.run_created_at || row.created_at,
        counts: zero(),
        roots: [],
        workspace: null,
        project: projectKey(row.host, null),
        endedAt: null,
        lastActivityAt: NaN,
        workers: 0,
        depth: 0
      })
    }
    const run = runs.get(rk)!
    // Rows are oldest first, so the first creator-less, non-follow-up row is the root worker.
    if (!rootSeen.has(rk) && !row.creator_dispatch_id && !row.follow_up_of_dispatch_id) {
      rootSeen.add(rk)
      run.workspace = row.workspace
    } else if (!rootSeen.has(rk) && !fallbackSet.has(rk)) {
      fallbackSet.add(rk)
      run.workspace = row.workspace // first row's workspace until a root shows up
    }
    const done = toMs(row.completed_at)
    if (isFinite(done)) run.endedAt = Math.max(run.endedAt ?? done, done)
    for (const t of [toMs(row.created_at), toMs(row.run_created_at), done]) if (isFinite(t)) run.lastActivityAt = isFinite(run.lastActivityAt) ? Math.max(run.lastActivityAt, t) : t
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
    run.workers += 1
    run.depth = Math.max(run.depth, depth)
    totals[n.phase] += 1
    totals.maxDepth = Math.max(totals.maxDepth, depth)
    for (const c of n.children) walk(c, depth + 1, run)
  }
  for (const run of runs.values()) {
    for (const r of run.roots) walk(r, 1, run)
    run.project = projectKey(run.host, pathOf(run.workspace))
    if (!isFinite(run.lastActivityAt)) run.lastActivityAt = 0
  }

  const list = [...runs.values()].sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt))
  return { at: now, runs: list, totals, hosts: [...new Set(rows.map((r) => r.host))], hostStatus: [] }
}

/** The status bar chip: "2 subagents" (running + idle), hidden when there are none. */
export function chip(s: Snapshot): { visible: boolean; text?: string; tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'; tooltip?: string } {
  const live = s.totals.running + s.totals.idle
  const bad = s.hostStatus.filter((h) => h.state === 'error' || h.state === 'stale')
  if (s.hostStatus.length > 0 && bad.length === s.hostStatus.length) {
    const reasons = s.hostStatus.map((h) => h.reason).filter((r): r is string => !!r)
    return { visible: true, text: 'subagents ?', tone: 'warning', tooltip: reasons.join('; ').slice(0, 250) }
  }
  if (s.error && live === 0) return { visible: true, text: 'subagents ?', tone: 'warning', tooltip: s.error.slice(0, 250) }
  if (live === 0) return { visible: false }
  const parts = [`${s.totals.running} running`, `${s.totals.idle} idle`]
  if (s.totals.maxDepth > 1) parts.push(`nested ${s.totals.maxDepth} deep`)
  const suffix = (s.hostStatus.some((h) => h.partial) ? ' (partial)' : '') + (bad.length ? `, ${bad.length} host${bad.length === 1 ? '' : 's'} unreachable` : '')
  const budget = 256 - suffix.length
  const head = `Orca workers: ${parts.join(', ')}.`
  const tail = ' Open the Subagents panel for the graph.'
  const busy = groupProjects(s.runs).filter((p) => p.counts.running + p.counts.idle > 0)
  const shown = busy.slice(0, 3)
  const more = busy.length > 3 ? `, +${busy.length - 3} more` : ''
  const byProject = (label: (p: Project) => string) =>
    shown.length ? ` By project: ${shown.map((p) => `${label(p)} ${p.counts.running + p.counts.idle}`).join(', ')}${more}.` : ''
  let tooltip = head + byProject((p) => p.label) + tail
  // Too long: drop the closing hint, then ellipsize each label to an equal share so the
  // "By project:" list and its "+N more" suffix always survive.
  if (tooltip.length > budget) tooltip = head + byProject((p) => p.label)
  if (tooltip.length > 256) {
    const fixed = (head + byProject(() => '')).length
    const share = Math.max(1, Math.floor((budget - fixed) / shown.length))
    tooltip = head + byProject((p) => (p.label.length <= share ? p.label : p.label.slice(0, share - 1) + '…'))
  }
  if (tooltip.length > budget) tooltip = tooltip.slice(0, budget - 1) + '…'
  tooltip += suffix
  return {
    visible: true,
    text: `${live} subagent${live === 1 ? '' : 's'}`,
    tone: s.totals.running > 0 ? 'accent' : 'neutral',
    tooltip
  }
}

/** How long a finished run stays in Live. */
export const RECENT_MS = 60 * 60 * 1000

const isLive = (r: Run) => r.counts.running + r.counts.idle > 0

/**
 * Live view: runs with a running/idle worker plus runs that finished within RECENT_MS, for every
 * project. When that is empty, each project's newest run, so Live is never blank.
 */
export function liveRuns(runs: Run[], now = Date.now()): Run[] {
  const recent = (r: Run) => toMs(r.createdAt) >= now - RECENT_MS || (r.endedAt ?? -Infinity) >= now - RECENT_MS
  let out = runs.filter((r) => isLive(r) || recent(r))
  if (!out.length) {
    const newest = new Map<string, Run>()
    for (const r of runs) {
      const cur = newest.get(r.project)
      if (!cur || toMs(r.createdAt) > toMs(cur.createdAt)) newest.set(r.project, r)
    }
    out = [...newest.values()]
  }
  return out.sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt))
}

/** Workspace '<worktreeId>::<path>' -> path; no '::' means the whole string is the path. */
export function pathOf(workspace: string | null): string | null {
  if (!workspace) return null
  const i = workspace.indexOf('::')
  return (i >= 0 ? workspace.slice(i + 2) : workspace) || null
}

export function projectKey(host: string, path: string | null): string {
  return host + '\u0000' + (path ?? '')
}

const segments = (p: string) => p.split(/[\\/]+/).filter(Boolean)

/**
 * Labels: the path's last segment; projects that share it get the shortest suffix that tells
 * them apart ("main" vs "surface-probe/main"). The same path on two hosts keeps one label (the
 * host pill tells them apart). An empty last segment ("/") falls back to the full path.
 */
export function projectLabels(list: { key: string; path: string | null }[]): Map<string, string> {
  const out = new Map<string, string>()
  const suffix = (p: string, n: number) => segments(p).slice(-n).join('/')
  const groups = new Map<string, { key: string; path: string }[]>()
  for (const it of list) {
    if (it.path === null) { out.set(it.key, 'Unknown project'); continue }
    const base = suffix(it.path, 1)
    if (!base) { out.set(it.key, it.path); continue }
    groups.set(base, [...(groups.get(base) ?? []), { key: it.key, path: it.path }])
  }
  for (const group of groups.values()) {
    for (const it of group) {
      const others = group.filter((o) => o.path !== it.path)
      const max = segments(it.path).length
      let n = 1
      while (n < max && others.some((o) => suffix(o.path, n) === suffix(it.path, n))) n++
      out.set(it.key, suffix(it.path, n))
    }
  }
  return out
}

const runRank = (r: Run) => (isLive(r) ? 0 : r.counts.failed > 0 ? 1 : 2)

/**
 * One section per project. Projects with running workers first, then idle, then by latest
 * activity. Inside a project: live runs, then failed, then done; newest first within each.
 * `universe` (all known runs) only feeds label disambiguation.
 */
export function groupProjects(runs: Run[], universe: Run[] = runs): Project[] {
  const map = new Map<string, Project>()
  for (const r of runs) {
    let p = map.get(r.project)
    if (!p) {
      p = { key: r.project, host: r.host, path: pathOf(r.workspace), label: '', counts: zero(), lastActivityAt: 0, runs: [] }
      map.set(r.project, p)
    }
    p.runs.push(r)
    for (const k of Object.keys(p.counts) as Phase[]) p.counts[k] += r.counts[k]
    p.lastActivityAt = Math.max(p.lastActivityAt, r.lastActivityAt)
  }
  const list = [...map.values()]
  // Label against every known project so a label does not change between Live and History.
  const known = new Map<string, string | null>(list.map((p) => [p.key, p.path]))
  for (const r of universe) if (!known.has(r.project)) known.set(r.project, pathOf(r.workspace))
  const labels = projectLabels([...known].map(([key, path]) => ({ key, path })))
  for (const p of list) {
    p.label = labels.get(p.key) ?? 'Unknown project'
    p.runs.sort((a, b) => runRank(a) - runRank(b) || toMs(b.createdAt) - toMs(a.createdAt))
  }
  const rank = (p: Project) => (p.counts.running > 0 ? 0 : p.counts.idle > 0 ? 1 : 2)
  return list.sort((a, b) => rank(a) - rank(b) || b.lastActivityAt - a.lastActivityAt)
}

/** "2m 10s", "4h 05m"; '' for unknown. Keep in sync with panel/graph.js duration(). */
export function formatDuration(ms: number): string {
  if (!isFinite(ms) || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ' + (s % 60) + 's'
  const h = Math.floor(m / 60)
  if (h < 24) return h + 'h ' + String(m % 60).padStart(2, '0') + 'm'
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h'
}

/** Node duration: running = elapsed so far; settled = completed - created. */
export function nodeDuration(n: Pick<Node, 'phase' | 'createdAt' | 'completedAt'>, now = Date.now()): number {
  const start = toMs(n.createdAt)
  if (n.phase === 'running') return now - start
  return toMs(n.completedAt) - start
}
