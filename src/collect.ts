// Collects worker rows through the `orca` CLI, so it works on any OS and against paired Orca
// servers (`--environment <name>`), e.g. a Windows desktop watching a headless Linux box.
import type { Row } from './model.ts'

/** Runs `orca <args> --json` and returns the parsed `result`, or throws with Orca's message. */
export type Cli = (args: string[]) => Promise<any>

type Static = {
  created_at: string
  creator_dispatch_id: string | null
  follow_up_of_dispatch_id: string | null
  agent: string | null
  model: string | null
  completed_at: string | null
}

const SETTLED = new Set(['completed', 'failed', 'circuit_broken'])

export class Collector {
  private statics = new Map<string, Static>()
  private closed = new Set<string>()
  private titles = new Map<string, Map<string, string>>()
  private objectives = new Map<string, string>()

  private cli: Cli
  constructor(cli: Cli) {
    this.cli = cli
  }

  private envArgs(host: string): string[] {
    return host === 'local' ? [] : ['--environment', host]
  }

  /** One host: worker-list (+pages), run objectives, task titles, and a worker-show where needed. */
  async rows(host: string, maxPages = 1): Promise<Row[]> {
    const env = this.envArgs(host)
    const workers: any[] = []
    let cursor: string | null = null
    for (let page = 0; page < maxPages; page++) {
      const res = await this.cli(['orchestration', 'worker-list', '--full', '--limit', '100', ...(cursor ? ['--cursor', cursor] : []), ...env])
      workers.push(...(res?.workers ?? []))
      cursor = res?.nextCursor ?? null
      if (!cursor) break
    }

    // Run objectives: one call; refresh when an unknown run shows up.
    const runIds = new Set(workers.map((w) => w.runId))
    if ([...runIds].some((id) => !this.objectives.has(host + id))) {
      const res = await this.cli(['orchestration', 'run-list', '--full', '--limit', '100', ...env]).catch(() => null)
      for (const r of res?.runs ?? []) this.objectives.set(host + r.id, r.objective)
    }

    // Task titles: per run, refreshed when a task id is new.
    for (const runId of runIds) {
      const known = this.titles.get(host + runId)
      const need = workers.some((w) => w.runId === runId && !known?.has(w.taskId))
      if (!need) continue
      const res = await this.cli(['orchestration', 'task-list', '--run', runId, ...env]).catch(() => null)
      const map = new Map<string, string>()
      for (const t of res?.tasks ?? []) map.set(t.id, t.title)
      this.titles.set(host + runId, map)
    }

    // worker-show for: never seen, still running, or settled but terminal maybe still open.
    const shows = workers.filter((w) => {
      const key = host + w.dispatchId
      const s = this.statics.get(key)
      if (!s) return true
      if (!SETTLED.has(w.dispatchStatus)) return false // static known; running needs nothing else
      if (!s.completed_at) return true
      const handle = w.agentTerminalHandle ?? w.resource?.terminalHandle
      return !!handle && w.resource?.releaseState !== 'released' && !this.closed.has(key)
    })
    const openNow = new Set<string>()
    await lanes(shows, 6, async (w) => {
      const key = host + w.dispatchId
      const res = await this.cli(['orchestration', 'worker-show', '--dispatch', w.dispatchId, '--full', ...env]).catch(() => null)
      if (!res) return
      const d = res.dispatch ?? {}
      const launch = res.worker?.startOptions?.launch?.effective ?? {}
      this.statics.set(key, {
        created_at: d.createdAt ?? '',
        creator_dispatch_id: d.creatorDispatchId ?? null,
        follow_up_of_dispatch_id: d.followUpOf ?? d.followUpOfDispatchId ?? null,
        agent: launch.agent ?? res.worker?.startOptions?.agent ?? null,
        model: launch.model ?? null,
        completed_at: d.completedAt ?? null
      })
      const t = res.terminal
      if (t && t.connected && !t.exitCause) openNow.add(key)
      else if (SETTLED.has(d.status ?? w.dispatchStatus)) this.closed.add(key)
    })

    return workers.map((w): Row => {
      const key = host + w.dispatchId
      const s = this.statics.get(key)
      const release = w.resource?.releaseState ?? null
      const closed = this.closed.has(key) || release === 'released'
      return {
        id: w.dispatchId,
        host,
        run_id: w.runId,
        status: w.dispatchStatus ?? 'pending',
        creator_dispatch_id: s?.creator_dispatch_id ?? null,
        follow_up_of_dispatch_id: s?.follow_up_of_dispatch_id ?? null,
        created_at: s?.created_at ?? '',
        completed_at: s?.completed_at ?? null,
        title: this.titles.get(host + w.runId)?.get(w.taskId) ?? null,
        agent: s?.agent ?? null,
        model: s?.model ?? null,
        worker_state: w.workerState ?? null,
        // Encode the liveness probe into release_state so model.phaseOf stays pure.
        release_state: closed ? 'released' : openNow.has(key) ? 'open' : release,
        terminal_handle: w.agentTerminalHandle ?? w.resource?.terminalHandle ?? null,
        objective: this.objectives.get(host + w.runId) ?? null
      }
    })
  }
}

async function lanes<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: Math.min(n, queue.length) }, async () => {
      for (let it = queue.shift(); it !== undefined; it = queue.shift()) await fn(it)
    })
  )
}
