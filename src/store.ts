export type Proof = 'operator_close' | 'signaled' | 'exited'
export type Entry = {
  run: string; c: string; cr: string | null; fu: string | null
  a: string | null; m: string | null; d: string | null
  th?: string; ex?: Proof; xt?: number
  seen: number
}
export type StorageLike = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}
export const STORE_VERSION = 1
export const MAX_BYTES = 200 * 1024
export const EXPIRY_MS = 30 * 86400000
export const WRITE_EVERY_MS = 10000
const DAY_MS = 86400000
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function validate(value: unknown): Entry | undefined {
  if (!object(value) || typeof value.run !== 'string' || !value.run || typeof value.c !== 'string' || !value.c ||
      typeof value.seen !== 'number' || !Number.isFinite(value.seen)) return
  for (const key of ['cr', 'fu', 'a', 'm', 'd']) if (value[key] !== null && typeof value[key] !== 'string') return
  const e: Entry = { run: value.run, c: value.c, cr: value.cr as string | null, fu: value.fu as string | null,
    a: value.a as string | null, m: value.m as string | null, d: value.d as string | null, seen: value.seen }
  if (['operator_close', 'signaled', 'exited'].includes(value.ex as string) && typeof value.th === 'string' &&
      typeof value.xt === 'number' && Number.isFinite(value.xt)) {
    e.th = value.th; e.ex = value.ex as Proof; e.xt = value.xt
  }
  return e
}

export class DetailStore {
  private storage: StorageLike | null
  private log: (m: string) => void
  private now: () => number
  private setTimer: (fn: () => void, ms: number) => unknown
  private clearTimer: (t: unknown) => void
  private hosts = new Map<string, Map<string, Entry>>()
  private dirty = new Set<string>()
  private timers = new Map<string, unknown>()
  private lastWrite = new Map<string, number>()
  private queue: Promise<void> = Promise.resolve()
  private loaded?: Promise<void>
  private epoch = 0
  get generation(): number { return this.epoch }

  constructor(storage: StorageLike | null, log: (m: string) => void, opts: {
    now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void
  } = {}) {
    this.storage = storage; this.log = log
    this.now = opts.now ?? Date.now
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>))
    if (!storage) log('Detail storage unavailable; using memory only')
  }

  // Every storage operation, including reads and clear, shares this queue.
  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn).catch(error => {
      if (this.storage) {
        this.storage = null
        this.cancelTimers()
        this.log(`Detail storage disabled: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    return this.queue
  }

  load(): Promise<void> {
    if (this.loaded) return this.loaded
    const gen = this.generation
    this.loaded = this.enqueue(async () => {
      if (!this.storage || gen !== this.generation) return
      const keys = await this.storage.keys()
      for (const key of keys.filter(k => k.startsWith('details:'))) {
        if (gen !== this.generation) return
        const value = await this.storage!.get(key)
        if (gen !== this.generation) return
        if (!object(value) || value.v !== STORE_VERSION || !object(value.items)) continue
        const host = key.slice('details:'.length), items = new Map<string, Entry>()
        let changed = false
        for (const [id, raw] of Object.entries(value.items)) {
          const e = validate(raw)
          if (!e || this.now() - e.seen > EXPIRY_MS) { changed = true; continue }
          items.set(id, e)
          if (JSON.stringify(e) !== JSON.stringify(raw)) changed = true
        }
        this.hosts.set(host, items)
        if (Buffer.byteLength(JSON.stringify({ v: STORE_VERSION, items: Object.fromEntries(items) }), 'utf8') > MAX_BYTES) changed = true
        if (!items.size || changed) this.mark(host)
      }
    })
    return this.loaded
  }

  get(host: string, id: string): Entry | undefined { return this.hosts.get(host)?.get(id) }

  put(host: string, id: string, e: Entry, gen: number): void {
    if (gen !== this.generation) return
    let items = this.hosts.get(host)
    if (!items) { items = new Map(); this.hosts.set(host, items) }
    if (JSON.stringify(items.get(id)) === JSON.stringify(e)) return
    items.set(id, { ...e }); this.mark(host)
  }

  drop(host: string, id: string): void {
    if (this.hosts.get(host)?.delete(id)) this.mark(host)
  }

  touch(host: string, id: string): void {
    const e = this.get(host, id)
    if (e && this.now() - e.seen > DAY_MS) { e.seen = this.now(); this.mark(host) }
  }

  private mark(host: string): void {
    if (!this.storage) return
    this.dirty.add(host)
    if (this.timers.has(host)) return
    const remaining = (this.lastWrite.get(host) ?? -Infinity) + WRITE_EVERY_MS - this.now()
    if (remaining <= 0) { this.write(host, this.generation); return }
    this.timers.set(host, this.setTimer(() => {
      this.timers.delete(host); this.write(host, this.generation)
    }, remaining))
  }

  private write(host: string, gen: number): void {
    this.enqueue(async () => {
      if (!this.storage || gen !== this.generation || !this.dirty.delete(host)) return
      const items = this.hosts.get(host) ?? new Map<string, Entry>()
      const value = { v: STORE_VERSION, items: Object.fromEntries(items) }
      // Trim a snapshot as well as memory; the serialized value never references live entries.
      for (const [id] of [...items].sort((a, b) => a[1].seen - b[1].seen)) {
        if (Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_BYTES) break
        delete value.items[id]; items.delete(id)
      }
      this.lastWrite.set(host, this.now())
      if (items.size) await this.storage.set(`details:${host}`, structuredClone(value))
      else await this.storage.delete(`details:${host}`)
    })
  }

  private cancelTimers(): void {
    for (const timer of this.timers.values()) this.clearTimer(timer)
    this.timers.clear()
  }

  clear(): Promise<void> {
    // This fence must happen synchronously, even while a storage operation is pending.
    this.epoch++
    this.cancelTimers(); this.dirty.clear(); this.hosts.clear(); this.lastWrite.clear()
    return this.enqueue(async () => {
      if (!this.storage) return
      const keys = await this.storage.keys()
      for (const key of keys) if (key.startsWith('details:')) await this.storage!.delete(key)
    })
  }

  async flushNow(): Promise<void> {
    this.cancelTimers()
    for (const host of this.dirty) this.write(host, this.generation)
    await this.queue
  }
}
