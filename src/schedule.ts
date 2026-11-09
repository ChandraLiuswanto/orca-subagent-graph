import { levelRank } from './model.ts'
import type { HostStatus, Level, Row } from './model.ts'

export type PassResult = { rows: Row[]; partial: boolean }
export type HostRunner = (host: string, level: Level, onRows: (r: PassResult) => void, demand: () => Level) => Promise<PassResult>
export const ATTENTION_MS = 30000

type Options = {
  run: HostRunner
  hosts: () => Promise<string[]>
  calls: (host: string) => number
  onChange: (progress: boolean) => void
  localMs?: number
  remoteMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}
type Kind = 'tick' | 'raise' | 'force'
type Host = {
  name: string
  rows: Row[]
  partial: boolean
  loaded: Level | null
  published: boolean
  okAt?: number
  reason?: string
  failures: number
  retryAt?: number
  inFlight: boolean
  queued: 'force' | 'raise' | null
  forced: boolean
  passKind: Kind
  timer?: unknown
}

export class Scheduler {
  private opts: Options
  private now: () => number
  private setTimer: (fn: () => void, ms: number) => unknown
  private clearTimer: (t: unknown) => void
  private hosts = new Map<string, Host>()
  private active = false
  private epoch = 0
  private lifecycle = 0
  private discovering: Promise<void> | null = null
  private lastAsk = -Infinity
  private askLevel: Level = { kind: 'count' }
  private data = false
  private dataPromise: Promise<void>
  private resolveData!: () => void

  constructor(opts: Options) {
    this.opts = opts
    this.now = opts.now ?? Date.now
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>))
    this.dataPromise = new Promise(resolve => { this.resolveData = resolve })
  }

  start(): void {
    if (this.active) return
    this.active = true
    void this.discover()
  }

  stop(): void {
    this.active = false
    this.lifecycle++
    for (const host of this.hosts.values()) this.clearHostTimer(host)
  }

  private current(): Level {
    return this.now() - this.lastAsk < ATTENTION_MS ? this.askLevel : { kind: 'count' }
  }

  ask(level: Level): void {
    this.lastAsk = this.now()
    this.askLevel = level
    for (const host of this.hosts.values()) {
      if (levelRank(level) <= levelRank(host.loaded ?? { kind: 'count' })) continue
      if ((host.retryAt ?? 0) > this.now()) continue
      if (!host.queued) host.queued = 'raise'
      if (!host.inFlight) this.launch(host)
    }
  }

  force(): void {
    for (const host of this.hosts.values()) {
      if (host.forced) continue
      host.forced = true
      if (host.reason !== undefined) host.retryAt = undefined
      host.queued = 'force'
      if (!host.inFlight) this.launch(host)
    }
  }

  cancelQueued(): void {
    this.epoch++
    for (const host of this.hosts.values()) {
      host.queued = null
      host.forced = false
      host.rows = []
      host.partial = false
      host.loaded = null
    }
  }

  rows(): Row[] { return [...this.hosts.values()].flatMap(host => host.rows) }
  hasData(): boolean { return this.data }
  firstData(): Promise<void> { return this.dataPromise }

  status(): HostStatus[] {
    return [...this.hosts.values()].map(host => ({
      host: host.name,
      state: host.inFlight && (host.passKind !== 'tick' || host.okAt === undefined)
        ? 'loading' : host.reason !== undefined ? (host.published ? 'stale' : 'error') : 'ok',
      // Panel responses must be JSON values, including optional properties.
      ...(host.reason !== undefined ? { reason: host.reason } : {}),
      ...(host.okAt !== undefined ? { okAt: host.okAt } : {}),
      ...(host.retryAt !== undefined ? { retryAt: host.retryAt } : {}),
      partial: host.partial, forced: host.forced, calls: this.opts.calls(host.name),
    }))
  }

  private markData(host: Host, result: PassResult): void {
    host.rows = result.rows
    host.partial = result.partial
    host.published = true
    if (!this.data) {
      this.data = true
      this.resolveData()
    }
  }

  private clearHostTimer(host: Host): void {
    if (host.timer !== undefined) this.clearTimer(host.timer)
    host.timer = undefined
  }

  private valid(host: Host): boolean {
    return this.active && this.hosts.get(host.name) === host
  }

  private discover(): Promise<void> {
    if (this.discovering) return this.discovering
    const lifecycle = this.lifecycle
    this.discovering = (async () => {
      try {
        const names = await this.opts.hosts()
        if (!this.active || lifecycle !== this.lifecycle) return
        const next = new Map<string, Host>()
        for (const name of names) {
          if (next.has(name)) continue
          next.set(name, this.hosts.get(name) ?? {
            name, rows: [], partial: false, loaded: null, published: false,
            failures: 0, inFlight: false, queued: null, forced: false, passKind: 'tick',
          })
        }
        for (const [name, host] of this.hosts) if (!next.has(name)) this.clearHostTimer(host)
        const added = [...next.values()].filter(host => !this.hosts.has(host.name))
        this.hosts = next
        for (const host of added) this.launch(host)
      } catch {
        // Discovery is best-effort; keep existing hosts and their independent loops.
      }
    })().finally(() => { this.discovering = null })
    return this.discovering
  }

  private schedule(host: Host): void {
    if (!this.valid(host)) return
    this.clearHostTimer(host)
    const cadence = host.name === 'local' ? this.opts.localMs ?? 4000 : this.opts.remoteMs ?? 15000
    const delay = host.retryAt === undefined ? cadence : Math.max(0, host.retryAt - this.now())
    host.timer = this.setTimer(() => {
      host.timer = undefined
      void this.discover().then(() => { if (this.valid(host)) this.launch(host) })
    }, delay)
  }

  private launch(host: Host): void {
    if (!this.valid(host) || host.inFlight) return
    this.clearHostTimer(host)
    const kind = host.queued ?? 'tick'
    host.queued = null
    host.passKind = kind
    host.inFlight = true
    const epoch = this.epoch
    const lifecycle = this.lifecycle
    const level = this.current()
    const current = () => this.valid(host) && lifecycle === this.lifecycle && epoch === this.epoch
    void (async () => {
      try {
        const result = await this.opts.run(host.name, level, result => {
          if (!current()) return
          this.markData(host, result)
          this.opts.onChange(true)
        }, () => this.current())
        if (current()) {
          this.markData(host, result)
          host.loaded = level
          host.okAt = this.now()
          host.failures = 0
          host.retryAt = undefined
          host.reason = undefined
        }
      } catch (err) {
        if (current()) {
          host.reason = err instanceof Error ? err.message : String(err)
          if (host.name !== 'local') {
            host.failures++
            host.retryAt = this.now() + [30000, 60000, 120000][Math.min(host.failures, 3) - 1]
          }
        }
      } finally {
        host.inFlight = false
        if (current()) {
          if (kind === 'force') host.forced = false
          this.opts.onChange(false)
        }
        if (this.valid(host) && lifecycle === this.lifecycle) {
          const backedOff = (host.retryAt ?? 0) > this.now()
          if (host.queued && (host.queued === 'force' || !backedOff)) this.launch(host)
          else this.schedule(host)
        }
      }
    })()
  }
}
