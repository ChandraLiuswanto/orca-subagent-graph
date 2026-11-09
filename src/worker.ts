// Trusted worker: merges independent host passes and answers the panel without waiting for details.
import type { OrcaWorkerApi } from 'orca/worker'
import { findCli, SAFE_ARG, run, killAll } from './cli.ts'
import { Collector } from './collect.ts'
import { buildRuns, chip, groupProjects, liveRuns, toMs, type Snapshot } from './model.ts'
import { Scheduler } from './schedule.ts'
import { DetailStore, type StorageLike } from './store.ts'

const RANGES: Record<string, number> = { '1d': 1, '7d': 7, '30d': 30, all: 36500 }
type Settings = { hosts: string; cliPath: string }
let api: OrcaWorkerApi | null = null
let scheduler: Scheduler | null = null
let store: DetailStore | null = null
let progressTimer: ReturnType<typeof setTimeout> | undefined

export default function activate(orca: OrcaWorkerApi): void {
  api = orca
  const host = orca.host as unknown as { call(method: string, params?: Record<string, unknown>): Promise<any> }
  let settings: Settings = { hosts: 'auto', cliPath: '' }
  let cliPath: string | null = null
  const calls = new Map<string, number>()
  const granted = orca.grantedCapabilities?.includes('storage:own')
  const details = new DetailStore(granted ? orca.storage as StorageLike : null, orca.log)
  store = details
  const collector = new Collector((args) => {
    const envIndex = args.indexOf('--environment')
    const name = envIndex < 0 ? 'local' : args[envIndex + 1]
    calls.set(name, (calls.get(name) ?? 0) + 1)
    if (!cliPath) return Promise.reject(new Error('Orca CLI not found; set its path in the plugin settings'))
    return run(cliPath, args, envIndex < 0 ? 8000 : 20000)
  }, details)

  let settingsAt = 0
  let hostsCache: { at: number; list: string[] } | null = null
  async function loadSettings(): Promise<void> {
    if (Date.now() - settingsAt < 60000 && cliPath) return
    settingsAt = Date.now()
    try {
      const s = await orca.settings.get()
      settings = { hosts: String(s?.hosts ?? 'auto'), cliPath: String(s?.cliPath ?? '') }
    } catch {}
    cliPath = findCli(settings.cliPath)
  }

  async function hostList(): Promise<string[]> {
    const raw = settings.hosts.trim()
    if (raw && raw !== 'auto') return raw.split(',').map((h) => h.trim()).filter(Boolean)
    if (hostsCache && Date.now() - hostsCache.at < 60000) return hostsCache.list
    const out = ['local']
    try {
      const res = await run(cliPath!, ['environment', 'list'], 8000)
      for (const e of res?.environments ?? []) {
        const sel = String(e?.name && SAFE_ARG.test(e.name) ? e.name : e?.id ?? '')
        if (sel) out.push(sel)
      }
    } catch {}
    hostsCache = { at: Date.now(), list: out }
    return out
  }

  const loop = new Scheduler({
    run: (h, l, on, demand) => collector.rows(h, l, on, demand),
    hosts: async () => { await loadSettings(); return hostList() },
    calls: (h) => calls.get(h) ?? 0,
    onChange: publish,
  })
  scheduler = loop

  function snapshot(): Snapshot {
    const s = buildRuns(loop.rows())
    s.hostStatus = loop.status()
    if (!loop.hasData()) s.error = 'Still loading subagents from the Orca CLI…'
    return s
  }

  let lastChip = ''
  let lastPosted = ''
  let lastPostAt = -Infinity
  function publish(progress: boolean): void {
    if (api !== orca || scheduler !== loop) return
    const s = snapshot()
    const next = chip(s)
    const chipKey = JSON.stringify(next)
    if (chipKey !== lastChip) {
      lastChip = chipKey
      void host.call('statusBar.update', { id: 'subagents', ...next }).catch((e: unknown) => {
        orca.log(`statusBar.update failed: ${e instanceof Error ? e.message : String(e)}`)
      })
    }
    // Include all run/node content, not timestamps or call counters from host status.
    const key = JSON.stringify([s.runs, s.hostStatus.map(h => [h.host, h.state, h.reason ?? '', h.partial, h.forced])])
    if (key === lastPosted) {
      clearTimeout(progressTimer)
      progressTimer = undefined
      return
    }
    const delay = 2000 - (Date.now() - lastPostAt)
    if (progress && delay > 0) {
      progressTimer ??= setTimeout(() => {
        progressTimer = undefined
        publish(true)
      }, delay)
      return
    }
    clearTimeout(progressTimer)
    progressTimer = undefined
    lastPosted = key
    lastPostAt = Date.now()
    orca.panels.post('graph.changed', { at: s.at })
  }

  orca.panels.handle('graph.read', async (input) => {
    const { range: r, view, force } = (input ?? {}) as { range?: string; view?: string; force?: boolean }
    const range = String(r ?? '7d')
    const live = view === 'live'
    const days = RANGES[range] ?? 7
    loop.ask(live ? { kind: 'live' } : { kind: 'history', days })
    if (force) loop.force()
    if (!loop.hasData()) {
      let deadline: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        loop.firstData(),
        new Promise<void>(resolve => { deadline = setTimeout(resolve, 12000) }),
      ]).finally(() => clearTimeout(deadline))
    }
    const snap = snapshot()
    const cutoff = Date.now() - days * 86400000
    const runs = live ? liveRuns(snap.runs) : snap.runs.filter(r => {
      const t = toMs(r.createdAt)
      return Number.isFinite(t) ? t >= cutoff : range === 'all'
    })
    const index = new Map(runs.map((x, i) => [x, i]))
    const projects = groupProjects(runs, snap.runs).map(({ runs: list, ...p }) => ({ ...p, runs: list.map((x) => index.get(x)!) }))
    return { ...snap, runs, projects, knownProjects: [...new Set(snap.runs.map((x) => x.project))] }
  })

  orca.panels.handle('graph.clearCache', async () => {
    loop.cancelQueued()
    collector.clear()
    const done = details.clear()
    publish(false)
    await done
    return { ok: true }
  })

  orca.panels.handle('terminal.focus', async (input) => {
    const { terminal, host: h } = (input ?? {}) as { terminal?: string; host?: string }
    if (!terminal || !/^term_[A-Za-z0-9-]+$/.test(terminal)) return { ok: false, reason: 'No terminal for this worker' }
    try {
      await run(cliPath!, ['terminal', 'focus', '--terminal', terminal, ...(h && h !== 'local' ? ['--environment', h] : [])], 8000)
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  })

  void details.load().finally(() => {
    if (api === orca && scheduler === loop) loop.start()
  })
}

export async function deactivate(): Promise<void> {
  scheduler?.stop()
  const w = store?.flushNow() ?? Promise.resolve()
  killAll()
  clearTimeout(progressTimer)
  progressTimer = undefined
  api = null
  scheduler = null
  store = null
  let deadline: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    w,
    new Promise<void>(resolve => { deadline = setTimeout(resolve, 1500) }),
  ]).finally(() => clearTimeout(deadline))
}
