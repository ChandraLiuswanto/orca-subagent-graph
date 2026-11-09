// Trusted worker: asks the Orca CLI for orchestration workers (this machine and any paired Orca
// servers), keeps the "N subagents" status bar chip current and answers the panel.
import type { OrcaWorkerApi } from 'orca/worker'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Collector } from './collect.ts'
import { buildRuns, chip, groupProjects, liveRuns, toMs, type Row, type Snapshot } from './model.ts'

const POLL_MS = 4000
const RANGES: Record<string, number> = { '1d': 1, '7d': 7, '30d': 30, all: 36500 }

// The plugin worker gets a minimal environment (PATH, HOME, APPDATA is not even passed on
// Windows), so find Orca's per-user folders and its CLI ourselves.
function candidates(): string[] {
  const home = os.homedir()
  const out: string[] = []
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
    // .exe launchers first: they avoid cmd.exe quoting entirely.
    for (const dir of [path.join(local, 'Programs', 'Orca'), path.join(local, 'Programs', 'orca'), path.join(local, 'orca')]) {
      out.push(path.join(dir, 'resources', 'bin', 'orca.exe'))
    }
    out.push(path.join(roaming, 'orca', 'cli', 'bin', 'orca.cmd'), path.join(roaming, 'Orca', 'cli', 'bin', 'orca.cmd'))
  } else if (process.platform === 'darwin') {
    out.push('/Applications/Orca.app/Contents/Resources/bin/orca', path.join(home, 'Applications/Orca.app/Contents/Resources/bin/orca'))
    out.push(path.join(home, 'Library', 'Application Support', 'orca', 'cli', 'bin', 'orca'), '/usr/local/bin/orca')
  } else {
    out.push(path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'orca', 'cli', 'bin', 'orca'))
    out.push(path.join(home, '.orca', 'cli', 'bin', 'orca'), '/usr/local/bin/orca', '/usr/bin/orca')
  }
  return out
}

// Orca hands plugin workers only PATH/HOME/TEMP-style variables. The Windows CLI needs APPDATA to
// find %APPDATA%\\orca\\orca-runtime.json, so rebuild the per-user folders from the home directory.
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (process.platform === 'win32') {
    const home = env.USERPROFILE ?? os.homedir()
    env.USERPROFILE ??= home
    env.APPDATA ??= path.join(home, 'AppData', 'Roaming')
    env.LOCALAPPDATA ??= path.join(home, 'AppData', 'Local')
    env.SystemRoot ??= env.SYSTEMROOT ?? 'C:\\Windows'
  }
  return env
}
const ENV = childEnv()

function onPath(): string[] {
  const names = process.platform === 'win32' ? ['orca.exe', 'orca.cmd'] : ['orca']
  const dirs = String(ENV.PATH ?? ENV.Path ?? '').split(path.delimiter).filter(Boolean)
  return dirs.flatMap((d) => names.map((n) => path.join(d, n)))
}

function findCli(override: string): string | null {
  if (override && existsSync(override)) return override
  return [...candidates(), ...onPath()].find((p) => existsSync(p)) ?? null
}

// Host names reach a cmd.exe command line for .cmd shims; allow only plain characters.
const SAFE_ARG = /^[A-Za-z0-9_.:\/=,-]*$/

function run(cliPath: string, args: string[], timeoutMs = 8000): Promise<any> {
  const isCmd = /\.cmd$/i.test(cliPath)
  if (isCmd && !args.every((a) => SAFE_ARG.test(a))) {
    return Promise.reject(new Error('Refusing to pass unusual characters through orca.cmd; set the CLI path to orca.exe'))
  }
  // cmd.exe /s /c "<"shim" args>": one verbatim string so Node does not re-quote it.
  const cmdLine = '/d /s /c "' + ['"' + cliPath + '"', ...args, '--json'].join(' ') + '"'
  return new Promise((resolve, reject) => {
    execFile(
      isCmd ? ENV.ComSpec ?? 'cmd.exe' : cliPath,
      isCmd ? [cmdLine] : [...args, '--json'],
      { timeout: timeoutMs, maxBuffer: 8 << 20, windowsHide: true, env: ENV, windowsVerbatimArguments: isCmd },
      (err, stdout) => {
        let parsed: any = null
        try {
          parsed = JSON.parse(String(stdout))
        } catch {}
        if (parsed?.ok) return resolve(parsed.result)
        reject(new Error(parsed?.error?.message ?? (err ? err.message : 'orca CLI returned no JSON')))
      }
    )
  })
}

type Settings = { hosts: string; cliPath: string }
let timer: ReturnType<typeof setInterval> | null = null

export default function activate(orca: OrcaWorkerApi): void {
  const host = orca.host as unknown as { call(method: string, params?: Record<string, unknown>): Promise<any> }
  let settings: Settings = { hosts: 'auto', cliPath: '' }
  let cliPath: string | null = null
  const collector = new Collector((args) => {
    if (!cliPath) return Promise.reject(new Error('Orca CLI not found; set its path in the plugin settings'))
    return run(cliPath, args)
  })

  let latest: Snapshot | null = null
  let lastChip = ''
  let busy: Promise<Snapshot> | null = null

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
    // auto: this machine plus every paired Orca server
    if (hostsCache && Date.now() - hostsCache.at < 60000) return hostsCache.list
    const out = ['local']
    try {
      const res = await run(cliPath!, ['environment', 'list'])
      for (const e of res?.environments ?? []) {
        const sel = String(e?.name && SAFE_ARG.test(e.name) ? e.name : e?.id ?? '')
        if (sel) out.push(sel)
      }
    } catch {}
    hostsCache = { at: Date.now(), list: out }
    return out
  }

  async function collect(pages: number): Promise<Snapshot> {
    const rows: Row[] = []
    const errors: string[] = []
    await loadSettings()
    for (const h of await hostList()) {
      try {
        rows.push(...(await collector.rows(h, pages)))
      } catch (e) {
        errors.push(`${h}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const snap = buildRuns(rows)
    if (errors.length) snap.error = errors.join(' | ')
    return snap
  }

  let busyPages = 0
  function refresh(pages = 1): Promise<Snapshot> {
    if (busy && busyPages >= pages) return busy
    const prev = busy ?? Promise.resolve(null)
    busyPages = pages
    const next: Promise<Snapshot> = prev.catch(() => null).then(() => collect(pages))
    busy = next.finally(() => {
      if (busy === next || busyPages === pages) busy = null
    })
    return next
  }

  async function tick(): Promise<void> {
    latest = await refresh()
    const next = chip(latest)
    const key = JSON.stringify(next) + latest.runs.map((r) => r.id + JSON.stringify(r.counts)).join()
    if (key !== lastChip) {
      lastChip = key
      await host.call('statusBar.update', { id: 'subagents', ...next }).catch((e: unknown) => {
        orca.log(`statusBar.update failed: ${e instanceof Error ? e.message : String(e)}`)
      })
      orca.panels.post('graph.changed', { at: latest.at })
    }
  }

  // The panel times out at 20s. A first collect against a big history (one worker-show per worker)
  // or a slow paired server can take longer, so answer with what we have and let graph.changed
  // trigger a reload once the collect finishes.
  const READ_DEADLINE_MS = 12000
  async function settle(p: Promise<Snapshot>): Promise<Snapshot> {
    let t: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((r) => (t = setTimeout(() => r(null), READ_DEADLINE_MS)))
    const won = await Promise.race([p, late]).finally(() => clearTimeout(t))
    if (won) return won
    p.then((s) => {
      latest = s
      orca.panels.post('graph.changed', { at: s.at })
    }, () => {})
    if (latest) return latest
    const empty = buildRuns([])
    empty.error = 'Still loading subagents from the Orca CLI…'
    return empty
  }

  orca.panels.handle('graph.read', async (input) => {
    const { range: r, view } = (input ?? {}) as { range?: string; view?: string }
    const live = view === 'live'
    const days = live ? 7 : RANGES[String(r ?? '7d')] ?? 7
    const fresh = latest && Date.now() - latest.at < POLL_MS && days <= 7
    const snap = fresh ? latest! : await settle(refresh(days > 7 ? 5 : 1))
    const cutoff = Date.now() - days * 86400000
    // Live: active + finished within RECENT_MS, every project. History: the range.
    const runs = live ? liveRuns(snap.runs) : snap.runs.filter((x) => !(toMs(x.createdAt) < cutoff))
    // Projects reference runs by index so each run is serialized once.
    const index = new Map(runs.map((x, i) => [x, i]))
    const projects = groupProjects(runs, snap.runs).map(({ runs: list, ...p }) => ({ ...p, runs: list.map((x) => index.get(x)!) }))
    return { ...snap, runs, projects, knownProjects: [...new Set(snap.runs.map((x) => x.project))] }
  })

  orca.panels.handle('terminal.focus', async (input) => {
    const { terminal, host: h } = (input ?? {}) as { terminal?: string; host?: string }
    if (!terminal || !/^term_[A-Za-z0-9-]+$/.test(terminal)) return { ok: false, reason: 'No terminal for this worker' }
    try {
      await run(cliPath!, ['terminal', 'focus', '--terminal', terminal, ...(h && h !== 'local' ? ['--environment', h] : [])])
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  })

  void tick()
  if (timer) clearInterval(timer)
  timer = setInterval(() => void tick(), POLL_MS)
}

export function deactivate(): void {
  if (timer) clearInterval(timer)
  timer = null
}
