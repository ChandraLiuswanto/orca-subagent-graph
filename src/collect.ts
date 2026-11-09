// Worker rows collected through the cross-platform Orca CLI, including paired hosts.
import { levelRank, pagesFor, RECENT_MS, pathOf, projectKey } from './model.ts'
import type { Row, Level } from './model.ts'
import type { DetailStore, Entry, Proof } from './store.ts'
export type Cli = (args: string[]) => Promise<any>
export type DetailStoreLike = Pick<DetailStore, 'generation' | 'get' | 'put' | 'drop' | 'touch'>
type Closed = { th: string; ex: Proof; xt: number }
type Result = { rows: Row[]; partial: boolean }
const SETTLED = new Set(['completed', 'failed', 'circuit_broken'])
const PROOFS = new Set(['operator_close', 'signaled', 'exited'])
const handleOf = (w: any): string | undefined => w.agentTerminalHandle ?? w.resource?.terminalHandle
const active = (w: any) => !SETTLED.has(w.dispatchStatus)
const keyOf = (host: string, id: string) => JSON.stringify([host, id])
const time = (s: string | null | undefined) => s ? Date.parse(s) : NaN
const rankTime = (s: string | undefined) => Number.isFinite(time(s)) ? time(s) : -Infinity

export class Collector {
  private statics = new Map<string, Entry>()
  private settledTried = new Set<string>()
  private closed = new Map<string, Closed>()
  private missing = new Map<string, number>()
  private titles = new Map<string, Map<string, string>>()
  private objectives = new Map<string, string>()
  private runCreated = new Map<string, string>()
  private lastOpen = new Set<string>()
  private backoff = new Map<string, number>()
  private runListAt = new Map<string, number>()
  private epoch = 0
  private cli: Cli
  private store?: DetailStoreLike
  private now: () => number
  constructor(cli: Cli, store?: DetailStoreLike, now: () => number = Date.now) {
    this.cli = cli; this.store = store; this.now = now
  }

  clear(): void {
    this.epoch++
    this.statics.clear(); this.settledTried.clear(); this.closed.clear(); this.missing.clear(); this.titles.clear()
    this.objectives.clear(); this.runCreated.clear(); this.lastOpen.clear(); this.backoff.clear(); this.runListAt.clear()
  }

  async rows(host: string, level: Level, onRows?: (r: Result) => void, demand: () => Level = () => level): Promise<Result> {
    const epoch = this.epoch, gen = this.store?.generation ?? 0
    const alive = () => epoch === this.epoch
    const wanted = () => alive() && levelRank(demand()) >= levelRank(level)
    const empty = (): Result => ({ rows: [], partial: false })
    const env = host === 'local' ? [] : ['--environment', host]
    const call = (args: string[]) => this.cli(['orchestration', ...args, ...env])
    const key = (id: string) => keyOf(host, id)
    const width = host === 'local' ? 6 : 2
    const workers: any[] = []
    let cursor: string | null = null, partial = false
    const trusted = (w: any, index: number): boolean => {
      const proof = this.closed.get(key(w.dispatchId)), h = handleOf(w)
      if (!proof || !h || active(w) || proof.th !== h || w.projection?.liveness?.verdict === 'live') return false
      return !workers.some((other, j) => {
        if (index === j || handleOf(other) !== h) return false
        if (partial || active(other)) return true
        const a = time(this.statics.get(key(w.dispatchId))?.c), b = time(this.statics.get(key(other.dispatchId))?.c)
        return Number.isFinite(a) && Number.isFinite(b) ? b > a : j < index
      })
    }
    const invalidate = () => {
      for (const [i, w] of workers.entries()) {
        if (!alive()) return
        const k = key(w.dispatchId)
        if (this.closed.has(k) && !trusted(w, i)) {
          this.closed.delete(k); this.missing.delete(k)
          const s = this.statics.get(k)
          if (s) {
            const { th, ex, xt, ...details } = s
            this.statics.set(k, details)
            this.store?.put(host, w.dispatchId, details, gen)
          }
        }
      }
    }
    const mapRows = (): Row[] => workers.map((w, i) => {
      const k = key(w.dispatchId), s = this.statics.get(k), release = w.resource?.releaseState ?? null
      return {
        id: w.dispatchId, host, run_id: w.runId, status: w.dispatchStatus ?? 'pending',
        creator_dispatch_id: s?.cr ?? null, follow_up_of_dispatch_id: s?.fu ?? null,
        created_at: s?.c ?? '', completed_at: s?.d ?? null,
        title: this.titles.get(key(w.runId))?.get(w.taskId) || null,
        agent: s?.a ?? null, model: s?.m ?? null, worker_state: w.workerState ?? null,
        release_state: trusted(w, i) || release === 'released' ? 'released' : this.lastOpen.has(k) ? 'open' : release,
        terminal_handle: handleOf(w) ?? null, objective: this.objectives.get(key(w.runId)) ?? null,
        task_id: w.taskId ?? null, workspace: workspaceOf(w), details: !!s,
        run_created_at: this.runCreated.get(key(w.runId)) ?? null,
      }
    })
    const publish = () => { if (alive()) onRows?.({ rows: mapRows(), partial }) }
    for (let page = 0; page < pagesFor(level); page++) {
      if (!alive()) return empty()
      if (page && !wanted()) break
      let res: any
      try { res = await call(['worker-list', '--full', '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])]) }
      catch (error) { if (!alive()) return empty(); if (!page) throw error; partial = true; break }
      if (!alive()) return empty()
      const added = res?.workers ?? []
      workers.push(...added)
      cursor = res?.nextCursor ?? null
      partial = !!(res?.page?.hasMore || cursor)
      for (const w of added) {
        if (!alive()) return empty()
        const k = key(w.dispatchId)
        const saved = this.store?.get(host, w.dispatchId)
        if (saved) this.store?.touch(host, w.dispatchId)
        if (!this.statics.has(k)) {
          if (saved) {
            if (saved.run !== w.runId || active(w)) this.store?.drop(host, w.dispatchId)
            else {
              this.statics.set(k, { ...saved })
              if (saved.th !== undefined && saved.ex !== undefined && saved.xt !== undefined) this.closed.set(k, { th: saved.th, ex: saved.ex, xt: saved.xt })
            }
          }
        }
        // A dispatch id reused for another run cannot inherit this session's details either.
        const s = this.statics.get(k)
        if (s && s.run !== w.runId) { this.statics.delete(k); this.settledTried.delete(k); this.closed.delete(k); this.missing.delete(k); this.lastOpen.delete(k); this.store?.drop(host, w.dispatchId) }
      }
      invalidate()
      publish()
      if (!cursor) break
    }

    if (!alive()) return empty()
    const runIds = [...new Set<string>(workers.map(w => w.runId))]
    if (level.kind !== 'count' && wanted() && runIds.some(id => !this.runCreated.has(key(id))) &&
        this.now() - (this.runListAt.get(host) ?? -Infinity) > 60000) {
      this.runListAt.set(host, this.now())
      const res = await call(['run-list', '--full', '--limit', '100']).catch(() => null)
      if (!alive()) return empty()
      for (const r of res?.runs ?? []) {
        if (typeof r.objective === 'string') this.objectives.set(key(r.id), r.objective)
        if (typeof r.created_at === 'string') this.runCreated.set(key(r.id), r.created_at)
      }
      publish()
    }

    const possible = (w: any, i: number) => !active(w) && !!handleOf(w) && w.resource?.releaseState !== 'released' &&
      w.projection?.liveness?.verdict !== 'exited' && !trusted(w, i) &&
      this.now() - (this.missing.get(key(w.dispatchId)) ?? -Infinity) >= 600000
    const countWorkers = workers.filter((w, i) => {
      const k = key(w.dispatchId), s = this.statics.get(k)
      if ((this.backoff.get(k) ?? 0) > this.now()) return false
      // Details cached while active need one final refresh even after release/exit.
      return (active(w) && !s) || (!active(w) && !!s && !s.d && !this.settledTried.has(k)) || possible(w, i)
    })
    const probe = async (w: any) => {
      if (!alive()) return
      const k = key(w.dispatchId)
      if ((this.backoff.get(k) ?? 0) > this.now()) return
      const s = this.statics.get(k)
      if (!active(w) && s && !s.d) this.settledTried.add(k)
      const res = await call(['worker-show', '--dispatch', w.dispatchId, '--full']).catch(() => null)
      if (!alive()) return
      if (!res) { this.backoff.set(k, this.now() + 30000); this.settledTried.delete(k); publish(); return }
      this.backoff.delete(k)
      const d = res.dispatch ?? {}, launch = res.worker?.startOptions?.launch?.effective ?? {}
      const e: Entry = { run: w.runId, c: d.createdAt ?? '', cr: d.creatorDispatchId ?? null,
        fu: d.followUpOf ?? d.followUpOfDispatchId ?? null, a: launch.agent ?? res.worker?.startOptions?.agent ?? null,
        m: launch.model ?? null, d: d.completedAt ?? null, seen: this.now() }
      this.closed.delete(k); this.missing.delete(k); this.lastOpen.delete(k)
      const t = res.terminal, settled = SETTLED.has(d.status ?? w.dispatchStatus)
      if (t?.connected && !t.exitCause) this.lastOpen.add(k)
      else if (settled && PROOFS.has(t?.exitCause?.kind) && (t.handle ?? handleOf(w))) {
        const proof: Closed = { th: t.handle ?? handleOf(w), ex: t.exitCause.kind, xt: this.now() }
        this.closed.set(k, proof); Object.assign(e, proof)
      } else this.missing.set(k, this.now())
      this.statics.set(k, e)
      if (settled) this.store?.put(host, w.dispatchId, e, gen)
      publish()
    }
    // Count work always completes; level-only calls are checked at dequeue time.
    await lanes(countWorkers.map(w => ({ w, needs: 'count' as const })), width, async item => { if (alive()) await probe(item.w) })
    if (!alive()) return empty()
    invalidate()

    const selected = new Set<string>()
    if (level.kind === 'live') {
      for (const w of workers) {
        const s = this.statics.get(key(w.dispatchId))
        if (active(w) || this.lastOpen.has(key(w.dispatchId)) || time(this.runCreated.get(key(w.runId))) >= this.now() - RECENT_MS || time(s?.d) >= this.now() - RECENT_MS) selected.add(w.runId)
      }
      if (!selected.size) {
        const newest = new Map<string, string>()
        for (const w of workers) {
          const project = projectKey(host, pathOf(workspaceOf(w))), prior = newest.get(project)
          if (!prior || rankTime(this.runCreated.get(key(w.runId))) > rankTime(this.runCreated.get(key(prior)))) newest.set(project, w.runId)
        }
        for (const id of newest.values()) selected.add(id)
      }
    } else if (level.kind === 'history') {
      for (const id of runIds) if (level.days >= 36500 || time(this.runCreated.get(key(id))) >= this.now() - level.days * 86400000) selected.add(id)
    }
    const extras = workers.filter(w => selected.has(w.runId) && !this.statics.has(key(w.dispatchId)) && !countWorkers.includes(w))
    await lanes(extras.map(w => ({ w, needs: 'level' as const })), width, async item => { if (wanted()) await probe(item.w) })
    if (!alive()) return empty()
    invalidate()
    const stale = [...selected].filter(id => workers.some(w => w.runId === id && !this.titles.get(key(id))?.has(w.taskId)))
    await lanes(stale, width, async id => {
      if (!wanted()) return
      const res = await call(['task-list', '--run', id]).catch(() => null)
      if (!alive()) return
      const known = new Map(this.titles.get(key(id)) ?? [])
      for (const t of res?.tasks ?? []) known.set(t.id, t.title)
      for (const w of workers) if (w.runId === id && !known.has(w.taskId)) known.set(w.taskId, '')
      this.titles.set(key(id), known)
      publish()
    })
    if (!alive()) return empty()
    return { rows: mapRows(), partial }
  }
}

function workspaceOf(w: any): string | null {
  const top = w?.workspace
  for (const v of [typeof top === 'string' ? top : top?.id, w?.projection?.workspace?.id, w?.resource?.worktreeId]) if (typeof v === 'string' && v) return v
  return null
}
async function lanes<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item)
  }))
}
