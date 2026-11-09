import { execFile, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

export function findCli(override: string): string | null {
  if (override && existsSync(override)) return override
  return [...candidates(), ...onPath()].find((p) => existsSync(p)) ?? null
}

// Host names reach a cmd.exe command line for .cmd shims; allow only plain characters.
export const SAFE_ARG = /^[A-Za-z0-9_.:\/=,-]*$/
const children = new Set<ChildProcess>()

export function running(): number { return children.size }

export function killAll(): void {
  for (const child of children) child.kill('SIGKILL')
  children.clear()
}

export function run(cliPath: string, args: string[], timeoutMs = 8000): Promise<any> {
  const isCmd = /\.cmd$/i.test(cliPath)
  if (isCmd && !args.every((a) => SAFE_ARG.test(a))) {
    return Promise.reject(new Error('Refusing to pass unusual characters through orca.cmd; set the CLI path to orca.exe'))
  }
  // cmd.exe /s /c "<"shim" args>": one verbatim string so Node does not re-quote it.
  const cmdLine = '/d /s /c "' + ['"' + cliPath + '"', ...args, '--json'].join(' ') + '"'
  return new Promise((resolve, reject) => {
    const child = execFile(
      isCmd ? ENV.ComSpec ?? 'cmd.exe' : cliPath,
      isCmd ? [cmdLine] : [...args, '--json'],
      { timeout: timeoutMs, maxBuffer: 8 << 20, windowsHide: true, env: ENV, windowsVerbatimArguments: isCmd },
      (err, stdout) => {
        children.delete(child)
        let parsed: any = null
        let hasJson = false
        try {
          parsed = JSON.parse(String(stdout))
          hasJson = true
        } catch {}
        if (parsed?.ok) return resolve(parsed.result)
        if (!hasJson && err && (err.killed || err.signal)) {
          return reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`))
        }
        reject(new Error(parsed?.error?.message ?? (err ? err.message : 'orca CLI returned no JSON')))
      }
    )
    children.add(child)
  })
}
