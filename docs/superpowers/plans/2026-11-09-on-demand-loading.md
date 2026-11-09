# On-demand loading: implementation plan

Spec: [docs/superpowers/specs/2026-11-09-on-demand-loading-design.md](../specs/2026-11-09-on-demand-loading-design.md) (approved, `lgtm`).
Worktree: `~/orca/workspaces/subagent-graph/on-demand-loading`, branch `feat/on-demand-loading`, base `master` (`1698459`).
Already on the branch: `b3472ee` (task-list lanes, 12 s `settle`), `6f48647` (spec).

**Goal:** the worker does count-level work while the panel is closed, loads details only for what the
panel shows, keeps settled details and certified closed proof across restarts, and never lets one
host or one long pass block `graph.read`.

**Architecture:** split today's `worker.ts` monolith into four units with narrow interfaces:

- `src/cli.ts`: runs the `orca` binary, timeout text, kill-on-shutdown.
- `src/store.ts`: R6 persistence (`details:<host>` keys).
- `src/collect.ts`: one host, one pass, at a given level.
- `src/schedule.ts`: per-host loops, levels, attention, force, backoff, `hostStatus`.

`src/worker.ts` wires them to Orca (`graph.read`, `graph.changed`, `graph.clearCache`,
status bar, `deactivate`). The panel gains host status lines, a refresh button, the
"updated Ns ago" label, loading rows and visibility gating.

**Tech:** TypeScript run directly by Node (type stripping, no build), `node:test`, plain browser JS
in `panel/`. Tests: `node --test src/*.test.ts` (there is no `package.json`; `tsc` cannot run because
`.orca/types` is absent, so the tests are the gate).

## Conventions for every task

- TDD: write the failing test first, run it, implement, run `node --test src/*.test.ts` (whole suite
  green), commit. One commit per task (bead), message `<area>: <what>`.
- Stage explicit paths only (`git add src/x.ts src/x.test.ts`). Never `git add -A`/`.`. Never push,
  pull, fetch or rebase. On `index.lock`, wait and retry.
- Imports use the `.ts` extension (`import { x } from './model.ts'`), as today.
- Only TypeScript that Node's type stripping accepts: no `enum`, no `namespace`, no parameter
  properties (`constructor(private x)`), no decorators. Use `type`, plain fields and
  `import type`.
- Keep functions pure where the plan says so; inject clocks/timers for anything time-based so tests
  never sleep more than a few ms.

## Shared contracts (all tasks code against these exactly)

### `src/model.ts` additions (Task 1 owns)

```ts
export type Row = {
  // ...all existing fields unchanged...
  /** Run creation time from `run-list` (`created_at`), when known. */
  run_created_at: string | null
  /** True once worker-show details (times, creator, follow-up, agent, model) are known. */
  details: boolean
}
// Node gains:
  loading: boolean // the node's newest row has details === false
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
// Snapshot gains:
  hostStatus: HostStatus[] // buildRuns() returns [], worker.ts fills it in
```

### Levels (Task 1 owns them in `src/model.ts`; Tasks 4 and 5 import them)

```ts
export type Level = { kind: 'count' } | { kind: 'live' } | { kind: 'history'; days: number }
/** count < live < history; a history with more days ranks higher. */
export function levelRank(l: Level): number // count 0, live 1, history 2 + days (days: 1, 7, 30, 36500)
export function pagesFor(l: Level): number // history with days > 7 -> 5, else 1
```

### `src/store.ts` (Task 2 owns)

```ts
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
export class DetailStore {
  constructor(storage: StorageLike | null, log: (m: string) => void, opts?: { now?: () => number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void })
  readonly generation: number
  load(): Promise<void> // once, before the first pass
  get(host: string, id: string): Entry | undefined
  put(host: string, id: string, e: Entry, gen: number): void // ignored when gen !== generation
  drop(host: string, id: string): void
  touch(host: string, id: string): void // sets seen=now only if the old seen is > 1 day old; marks dirty then
  clear(): Promise<void> // SYNCHRONOUSLY, before its first await: generation += 1, cancel timers and dirty set, empty memory. Then delete every details:* key (serialized behind any in-flight set). Puts with the new generation made during the deletes are written after them.
  flushNow(): Promise<void> // best-effort immediate write of dirty hosts (deactivate)
}
```

### `src/cli.ts` (Task 3 owns)

```ts
export function findCli(override: string): string | null // moved from worker.ts unchanged
export const SAFE_ARG: RegExp // moved
export function run(cliPath: string, args: string[], timeoutMs: number): Promise<any> // moved + R3 text + tracking
export function killAll(): void // SIGKILL every child still running (R3 shutdown)
export function running(): number // children in flight (tests)
```

### `src/schedule.ts` (Task 5 owns)

```ts
import type { HostStatus, Level, Row } from './model.ts'
export type PassResult = { rows: Row[]; partial: boolean }
/** `demand()` returns the level the panel wants right now (count once attention lapses). */
export type HostRunner = (host: string, level: Level, onRows: (r: PassResult) => void, demand: () => Level) => Promise<PassResult>
export const ATTENTION_MS = 30000
export class Scheduler {
  constructor(opts: {
    run: HostRunner
    hosts: () => Promise<string[]>
    calls: (host: string) => number
    onChange: (progress: boolean) => void // progress=true for mid-pass row publishes
    localMs?: number // 4000
    remoteMs?: number // 15000
    now?: () => number
    setTimer?: (fn: () => void, ms: number) => unknown
    clearTimer?: (t: unknown) => void
  })
  start(): void
  stop(): void
  ask(level: Level): void // panel attention + level raise
  force(): void
  cancelQueued(): void // graph.clearCache; synchronous; bumps the scheduler epoch so results of passes started before it are dropped
  rows(): Row[] // latest rows of every host, merged
  status(): HostStatus[]
  hasData(): boolean
  firstData(): Promise<void> // resolves when any host has published rows (even [])
}
```

### `graph.read` answer (Task 6 produces, Task 7 consumes)

Input: `{ range?: '1d'|'7d'|'30d'|'all', view?: 'live'|'history', force?: boolean }`.
Output: today's shape plus `hostStatus: HostStatus[]`:
`{ at, runs, totals, hosts, error?, projects, knownProjects, hostStatus }`. Each `runs[].roots[]` node
carries `loading`. `error` is set only for the "Still loading subagents from the Orca CLI…" empty
first answer.

### `graph.clearCache` (Task 6): input none, output `{ ok: true }`.

## Blast Radius

Built from `grep -n` over `src/` and `panel/` at `6f48647`.

| Changed | Dependents found (file:line) | Handling |
|---|---|---|
| `Row` type (+`run_created_at`, `details`) | `src/collect.ts:115-139` builds rows; `src/model.test.ts:5-12` `row()` helper; `src/model.ts:110` `buildRuns` | Task 4 fills the fields; Task 1 updates the `row()` helper and `buildRuns` |
| `Node` (+`loading`) | `panel/graph.js:72-75,104-112` reads `agent`/`model`/`createdAt`/`completedAt` | Task 7 renders loading |
| `Snapshot` (+`hostStatus`) | `src/worker.ts:102,135-147,180-215`; `src/model.ts:223` `chip` | Task 6 fills it; Task 1 makes `chip` read it |
| `buildRuns` sort/createdAt fallback | `src/worker.ts:144,195`; `src/model.test.ts:32,46,49,55,77...` | Task 1 keeps existing tests green and adds fallback tests |
| `liveRuns` recency rule | `src/worker.ts:205`; `src/model.test.ts:51,121-139` | Task 1; existing tests must stay green |
| `chip` (partial/unreachable suffix, `?` rule) | `src/worker.ts:163`; `src/model.test.ts:47-50` and tooltip tests | Task 1 adds tests; 256-char cap kept |
| `Collector.rows(host, maxPages)` → `rows(host, level, onRows?)` | `src/worker.ts:139`; `src/collect.test.ts:31,36` | Task 4 changes signature and the test; Task 6 is the only production caller |
| `Collector` constructor (+store) | `src/worker.ts:97` | Task 6 |
| `run()`/`findCli`/`SAFE_ARG`/`childEnv` move to `src/cli.ts` | `src/worker.ts:58-90,99,115,125,210,123` | Task 3 creates `cli.ts`; Task 6 deletes the copies in `worker.ts` and imports |
| `refresh`/`busy`/`collect`/`tick`/`settle` in `worker.ts` | only `worker.ts` itself (`161-200,224-228`) | Task 6 replaces them with `Scheduler` |
| `graph.read` contract (+`force`, +`hostStatus`) | `panel/app.js:269` | Task 7 sends `force`, reads `hostStatus` |
| `graph.changed` posting rule | `panel/app.js:310` listener | Task 6 (dedupe), Task 7 (hidden gating) |
| new `graph.clearCache` | none | Task 6 |
| `panel/index.html` header | `panel/app.js:5-10` element lookups; `panel/style.css` | Task 7 |
| `orca-plugin.json` `capabilities` (+`storage:own`), `version` 0.4.0 | Orca consent (re-approval); `README.md` | Task 6 edits both; README release note |
| `deactivate()` (now async, uses saved handles) | Orca plugin host awaits it with no args (`main/plugin-host-entry.js`) | Task 6 |
| `lanes()` helper in `collect.ts` | `src/collect.ts:68,82` only | Task 4 (per-host width) |
| `tsconfig.json` | includes `src` only; no build step | unaffected: new files live in `src/`, types-only |

## Ownership map and order

| Task | Files (exclusive) | Blocked by | Owner lane |
|---|---|---|---|
| 1 model | `src/model.ts`, `src/model.test.ts` | none | W3 (Sonnet, low) |
| 2 store | `src/store.ts`, `src/store.test.ts` | none | W1 (Sol, medium) |
| 3 cli | `src/cli.ts`, `src/cli.test.ts` | none | W2 (Sol, medium) |
| 7 panel | `panel/app.js`, `panel/graph.js`, `panel/index.html`, `panel/style.css`, `src/panel.test.ts` | none | W4 (Sonnet, low) |
| 4 collect | `src/collect.ts`, `src/collect.test.ts` | 1, 2 | W1 |
| 5 schedule | `src/schedule.ts`, `src/schedule.test.ts` | 1 | W2 |
| 6 worker | `src/worker.ts`, `orca-plugin.json`, `README.md` | 3, 4, 5 | W2 |

`Level`, `levelRank` and `pagesFor` live in `src/model.ts` (Task 1), so Tasks 4 and 5 both depend only
on the small model contract and run in parallel with each other. Task 5 tests against a fake
`HostRunner`; it never imports `collect.ts`.

Heads that run in parallel at once: 1, 2, 3, 7. Then 4 (after 1, 2) and 5 (after 1) in parallel.
Task 6 is the join.

---

## Task 1: model.ts (types, loading rows, liveRuns, chip)

**Files:** modify `src/model.ts`, `src/model.test.ts`.

1. Add `run_created_at` and `details` to `Row`, `loading` to `Node`, `HostState`/`HostStatus` types,
   `hostStatus` to `Snapshot`, and `Level`/`levelRank`/`pagesFor` (exact shapes in Shared
   contracts). Test `levelRank` ordering (count < live < history 1 < 7 < 30 < 36500) and `pagesFor`.
2. Update the test `row()` helper with `run_created_at: null, details: true`.
3. `buildRuns`:
   - Sort key: `toMs(created_at)`, falling back to `toMs(run_created_at)`. A NaN key sorts as
     +Infinity, so detail-less rows go after the rows whose time is known. The sort must be
     deterministic: break ties by `id`.
   - `node.loading = !row.details` for the newest row folded into the node (same place
     `node.phase` is updated).
   - `run.createdAt`: the row's `run_created_at` when set, else the first row's `created_at`, as
     today.
   - `lastActivityAt` also considers `toMs(run_created_at)`.
   - Return `hostStatus: []`.
4. `liveRuns(runs, now)`: keep `isLive(r)` OR recent, where recent is
   `toMs(r.createdAt) >= now - RECENT_MS || (r.endedAt ?? -Infinity) >= now - RECENT_MS`.
   The project-newest fallback stays. Existing tests at `model.test.ts:121-139` must still pass;
   adjust nothing in them.
5. `chip(s)`:
   - `bad = s.hostStatus.filter(h => h.state === 'error' || h.state === 'stale')`.
   - `subagents ?` (tone warning) when `s.hostStatus.length > 0 && bad.length === s.hostStatus.length`.
     The tooltip is the first non-empty `reason`s joined with `; `, sliced to 250 characters.
   - Keep today's `s.error && live === 0` → `?` rule for snapshots with an empty `hostStatus`.
   - Otherwise there is a suffix appended to the tooltip: `' (partial)'` if any host has
     `partial`, then `, ${bad.length} host${bad.length === 1 ? '' : 's'} unreachable` if
     `bad.length`. The suffix is reserved inside the 256-character budget: every truncation step
     in today's code uses `256 - suffix.length`, and the suffix goes on the end. When
     `live === 0` the chip stays hidden, as today.
6. Tests to add:
   - Detail-less rows build: no NaN order, `loading` true, `run.createdAt` from `run_created_at`.
   - Deterministic order with mixed known/unknown times.
   - `liveRuns` keeps a run created 10 min ago with no completion. It keeps an old run whose
     `endedAt` is 10 min ago, and drops an old run that ended 2 h ago.
   - `chip` shows `?` when all hosts are error or stale, and shows the count plus
     `, 1 host unreachable` when one of two hosts is down.
   - `chip` adds ` (partial)`. A long project list plus both suffixes stays ≤ 256 characters,
     and the suffix survives.
7. Commit: `model: loading rows, run creation times, host status in the chip`.

## Task 2: store.ts (R6 persistence)

**Files:** create `src/store.ts`, `src/store.test.ts`.

Behaviour (spec R6):

- **Layout:** key `details:<host>`, value `{ v: 1, items: { [dispatchId]: Entry } }`.
- **`load()`:** read `keys()`, then `get()` every `details:*` key. For each value:
  - Ignore it if `v !== STORE_VERSION`.
  - Validate every entry: `run`/`c` are non-empty strings, and `cr`/`fu`/`a`/`m`/`d` are a
    string or null. `ex`, if present, is one of the `Proof` kinds and comes with a string `th`
    and a number `xt`; otherwise drop `th`/`ex`/`xt` but keep the details. `seen` is a finite
    number.
  - Invalid entries are skipped.
  - Entries with `now - seen > EXPIRY_MS` are dropped. A host whose items end up empty has its
    key deleted. Any change made by load marks that host dirty.
  - `load()` never throws.
- **Writes:**
  - Coalesced per host: at most one `set` per `WRITE_EVERY_MS` per host, with a trailing write
    for changes made during the wait.
  - Serialized: one `set` in flight at a time, across all hosts.
  - Encode: `JSON.stringify` the value. If `Buffer.byteLength(json, 'utf8') > MAX_BYTES`, drop
    entries with the oldest `seen` first until it fits.
- **Failure:** the first rejected storage call (`get`/`set`/`delete`/`keys`) calls `log` once with
  the message, disables all further storage calls for the session, and keeps working in memory.
  No retries.
- **`storage === null`** (capability not granted): memory only, no log spam (one log line at
  construction).
- **`clear()`:**
  - Synchronously, before the first `await`: `generation += 1`, cancel the timers and the pending
    dirty set, and empty memory.
  - Then, serialized behind any in-flight `set` (which may finish but is followed by the deletes):
    delete every `details:*` key from `keys()`.
  - `put` with an older `gen` is ignored. Puts with the new generation made during the deletes
    stay in memory and are written after the deletes finish.
  - Test: right after calling `clear()` (not awaited), `generation` is already bumped and `get`
    returns undefined.
- **`flushNow()`:** cancel the timers and write every dirty host now, in sequence. Resolves even
  on failure.

Tests (inject `now`, `setTimer`/`clearTimer` as a manual timer queue, and an in-memory fake
`StorageLike` that records calls and can be told to reject):

- Round trip: put → flush → new store → load → get equals.
- Wrong `v`, a non-object value, and an invalid entry are ignored; a bad proof keeps the details
  but drops `th`/`ex`/`xt`.
- 30-day expiry across two hosts' keys, and an emptied key is deleted.
- Trimming at `MAX_BYTES` removes the oldest `seen` first: use a small override, or build big
  entries.
- Coalescing: 5 puts in 1 s produce 1 `set` now plus 1 trailing `set` after 10 s, not 5.
- Serialization: a slow first `set` (pending promise) means the second host's `set` starts only
  after it resolves.
- The first failure logs once, and later puts make no storage calls.
- `clear()` during a pending trailing write: no `set` happens after the deletes, and
  `put(..., oldGen)` is ignored.
- `touch` does not mark dirty within 1 day, and does mark dirty after 1 day.
- `storage === null`: put/get work in memory and nothing throws.

Commit: `store: details and closed proof persisted per host (storage:own)`.

## Task 3: cli.ts (run, timeouts, kill on shutdown)

**Files:** create `src/cli.ts`, `src/cli.test.ts`. Do NOT edit `worker.ts` (Task 6 removes the
copies).

1. Copy `candidates`, `childEnv`/`ENV`, `onPath`, `findCli`, `SAFE_ARG` and `run` from
   `src/worker.ts:13-90` into `src/cli.ts`, and export `findCli`, `SAFE_ARG`, `run`, `killAll`
   and `running`.
2. `run(cliPath, args, timeoutMs)`:
   - Keep the cmd.exe quoting and the `SAFE_ARG` guard as they are.
   - Keep each child returned by `execFile` in a module `Set`, removed in the callback.
   - When the callback's `err` has `killed === true` or `signal` set, and no JSON was parsed,
     reject with `new Error(\`timed out after ${Math.round(timeoutMs / 1000)}s\`)`.
   - Other errors keep today's text: Orca's `error.message`, else `err.message`.
3. `killAll()`: `child.kill('SIGKILL')` for every tracked child, and clear the set.
4. Tests:
   - Write executable fake CLIs into `mkdtempSync(os.tmpdir())`: `#!/usr/bin/env node` scripts
     with chmod 755.
     - Script A prints `{"ok":true,"result":{"x":1}}`.
     - Script B prints `{"ok":false,"error":{"message":"nope"}}`.
     - Script C sleeps 5 s.
   - A resolves to `{x:1}`.
   - B rejects with `nope`.
   - C with `timeoutMs` 200 rejects with exactly `timed out after 0s`. Use 1000 ms and expect
     `timed out after 1s` to keep the text meaningful.
   - C started, then `killAll()`, rejects quickly and `running()` drops to 0.
   - On non-POSIX systems, skip with `test.skip` when `process.platform === 'win32'`.
5. Commit: `cli: timeout text, child tracking and killAll for shutdown`.

## Task 4: collect.ts (levels, proof, guards, short rows first, store)

**Files:** modify `src/collect.ts`, `src/collect.test.ts`.

API:

```ts
import { levelRank, pagesFor, type Level } from './model.ts'
export type Cli = (args: string[]) => Promise<any> // unchanged; worker binds timeouts per host
export class Collector {
  constructor(cli: Cli, store?: DetailStoreLike, now?: () => number)
  rows(host: string, level: Level, onRows?: (r: { rows: Row[]; partial: boolean }) => void, demand?: () => Level): Promise<{ rows: Row[]; partial: boolean }>
  clear(): void // empties statics, closed, missing, titles, objectives, runCreated, lastOpen, backoff; epoch += 1
}
// DetailStoreLike = Pick<DetailStore, 'generation' | 'get' | 'put' | 'drop' | 'touch'>
```

Pass steps for `rows(host, level, onRows, demand)`.

- **Clear guard:** at pass start, capture `epoch` (the Collector's own counter, bumped by `clear()`)
  and `gen = store?.generation`. Every `store.put` passes `gen`. After every `await`, if `epoch`
  changed, the pass stops: it writes nothing to `statics`, `closed`, `missing`, `titles`,
  `objectives`, `runCreated`, `lastOpen` or `backoff`, calls no more `onRows`, starts no more calls,
  and returns `{ rows: [], partial: false }` (the scheduler drops it, Task 5). Implement it as one
  helper `alive()` checked before each map write and before each new call inside `lanes`.
- **Demand guard (spec edge case "History opened, then closed mid-load"):** `demand` defaults to
  `() => level`. Before starting each extra call that the level adds beyond `count` (history pages
  2-5, the level's extra `worker-show`s, `run-list`, `task-list`), check
  `levelRank(demand()) >= levelRank(level)`; if not, start no more of those calls. Calls already
  running finish and their results are kept. The count set (active and possibly-open probes) always
  completes. Do this inside `lanes` by giving each item a `needs: 'count' | 'level'` tag, so a
  lapsed demand skips the remaining `level` items only.

1. **worker-list:** `worker-list --full --limit 100 [--cursor]` for up to `pagesFor(level)`
   pages, keeping today's loop.
   - A failure of the first page throws; the scheduler applies backoff.
   - `partial = !!(lastResponse.page?.hasMore || lastResponse.nextCursor)` for the last page read.
2. **Restore from store:** for each row, call `store.get(host, w.dispatchId)` when no in-memory
   static exists.
   - If the entry's `run !== w.runId`, or the row is active, call `drop` and don't use it.
   - Otherwise fill statics from `c, cr, fu, a, m, d`.
   - Keep `th`/`ex` as closed proof candidates (step 5).
   - For every row with an entry, call `store.touch(host, id)`.
3. **Short rows first:** build rows as in today's mapping, with `details = !!statics`,
   `run_created_at = runCreated.get(host + runId) ?? null` and liveness as currently known.
   Call `onRows?.({ rows, partial })` before any `worker-show`/`task-list`.
4. **run-list:** at levels `live` and `history`, call `run-list --full --limit 100` when an unknown
   run id appears, behind the existing 60 s guard. Store both `objective` and `created_at`
   (`runCreated`). At `count`, no run-list.
5. **Closed knowledge (trusted)** for a settled row with handle `h = w.agentTerminalHandle ??
   w.resource?.terminalHandle`. The proof comes from in-memory `closed` (set by this session's
   probes) or from the store's `th/ex`, and is trusted only if all of these hold:
   - `proof.th === h`;
   - `w.projection?.liveness?.verdict !== 'live'`;
   - no other row in this `worker-list` result has the same handle and is active, or appears
     earlier in the list (lower index = newer). When both rows have a saved creation time `c`,
     compare `c` instead of the index;
   - if `partial` is true and any other row shares the handle, the proof is untrusted
     (ambiguous).

   When a guard fails, delete the in-memory proof, and remove `th/ex/xt` from the store entry
   (re-put it without them, with the current `gen`).
6. **Possibly open** = settled, has a handle, `resource.releaseState !== 'released'`, verdict
   `!== 'exited'`, no trusted proof, and not in `missing` (in-memory negative cache, see 7) unless
   the 10 min have passed.
7. **worker-show set** by level:
   - **count:** active rows without statics, plus possibly-open rows.
   - **live:** count's set, plus every row of a Live run without statics.
     - Live run ids: runs with an active row or a row whose last probe said open (`lastOpen`);
       runs whose `runCreated` is within `RECENT_MS`; runs whose newest known `completed_at`
       (statics) is within `RECENT_MS`.
     - If that set is empty: each project's newest run. The project comes from
       `projectKey(host, pathOf(workspace))`; newest is by `runCreated`, unknown counting as
       oldest.
     - Use `RECENT_MS`, `pathOf` and `projectKey` from `model.ts`.
     - Note: "possibly-open" in the spec's Live-run rule is implemented as "last probe said
       open". Workers whose lookup came back `missing` render as done (unknown liveness), as
       today, so they must not pull every old run into Live.
   - **history:** count's set, plus every row without statics whose run's `runCreated` is within
     `level.days`. When `days >= 36500`, include rows whose run time is unknown too.
   - Honour per-dispatch backoff (30 s after a failed show), as today.
8. **Probe handling** (lanes: 6 when `host === 'local'`, else 2):
   - Store statics as today.
   - If the dispatch is settled (`res.dispatch.status ?? w.dispatchStatus`), `store.put` the
     entry `{run, c, cr, fu, a, m, d, seen: now}`.
   - The terminal outcome decides the liveness:

     | Terminal in the response | Result |
     |---|---|
     | `connected && !exitCause` | open now (`openNow`) |
     | `exitCause.kind` in {`operator_close`, `signaled`, `exited`} and settled | certified: `closed.set(key, {th: res.terminal.handle ?? h, ex: kind, xt: now})`, saved in the entry |
     | no `terminal` object at all | `missing.set(key, now)`: in memory only, liveness unknown |
     | anything else (`kind 'unknown'`, `connected:false` with no cause) | `missing.set(key, now)` (same 10 min re-probe), never saved |
9. **task-list:**
   - **count:** none.
   - **live:** runs that are Live (step 7) with unknown titles.
   - **history:** runs in range with unknown titles.
   - Same `lanes` width as step 8.
10. **Final mapping:**
    - As step 3, with `release_state`:
      - `released` if trusted proof exists or the resource is released;
      - `open` if `openNow`;
      - else the raw release state.
    - `details = !!statics`.
    - Return `{ rows, partial }`.

Tests: rewrite `collect.test.ts` with a fake CLI. It is a function switching on `args[1]` that
records calls and returns fixtures built by small helpers (`wl(rows, {hasMore})`,
`show({status, terminal})`).

- **Existing behaviour kept:** workspace and task id extraction. A second pass makes only
  `worker-list` once everything is settled and proven.
- **Count level:**
  - No `run-list` and no `task-list`.
  - `worker-show` only for active rows without details and possibly-open rows.
  - A settled released row is never shown.
- **`onRows`** is called before the first `worker-show`: the fake CLI asserts it inside the
  `worker-show` branch.
- **Live level:**
  - Shows workers of a run created 10 min ago and of a run with an open worker.
  - Does not show workers of a 2-day-old run with no open worker.
  - Falls back to each project's newest run when nothing is live.
- **History, 30d:** pages up to 5; a run older than 30 d is not shown; unknown run time is excluded
  at 30d and included at `all`.
- **Proof:**
  - `operator_close` is saved to the store with `th/ex/xt`, and the next pass skips the probe.
  - A missing terminal is not saved, is skipped for 10 min (inject `now`), then probed again.
  - `kind 'unknown'` is never saved.
  - A restart (new `Collector` with the same store) skips certified workers and probes missing
    ones.
- **Guards:**
  - A handle reused by an earlier-listed (newer) row discards the proof and probes.
  - A `live` verdict discards it.
  - A partial page with a shared handle probes.
  - A different `th` probes.
- **Store:**
  - An entry with a different run id is dropped and probed.
  - An entry for an active row is dropped.
  - `put` uses the generation captured at pass start: bump the fake store's generation mid-pass,
    and no puts go through with the new gen.
- `partial` is true when `page.hasMore`.
- `clear()` forgets statics, so the next pass shows again.
- **Demand lapse:** a history-30 pass on a remote host (lanes 2) with 10 workers to show. After the
  first 2 shows start, `demand()` returns `{kind:'count'}`. Exactly 2 history `worker-show`s run
  (their statics are kept), no `task-list`/`run-list` and no further pages start, and the count
  set's probes still run.
- **Clear mid-pass:** start a pass whose `worker-show` is a pending promise, call `clear()`, then
  resolve it. `statics`/`closed` stay empty, `onRows` is not called again, no `store.put` happens,
  and the pass returns `{ rows: [], partial: false }`.

Commit: `collect: load levels, certified closed proof, short rows first`.

## Task 5: schedule.ts (per-host loops, attention, force, backoff, status)

**Files:** create `src/schedule.ts`, `src/schedule.test.ts`.

State per host: `{ rows, partial, loaded: Level | null, okAt, reason, failures, retryAt, inFlight:
Promise | null, queued: 'force' | 'raise' | null, forced: boolean, passKind: 'tick' | 'raise' |
'force' }`.

- **Hosts:** `start()` calls `hosts()` and then again on every tick (it is cached by the caller).
  A host that disappears is removed from rows and status.
- **Cadence:** each host has its own timer. `local` reschedules `localMs` after its pass ends;
  other hosts use `remoteMs`. One host's pass never awaits another's.
- **Attention and level:**
  - `ask(level)` records `lastAsk = now` and `askLevel = level`.
  - `current()` is `askLevel` while `now - lastAsk < ATTENTION_MS`, else `{kind:'count'}`.
  - Each pass runs at `current()` (a forced pass too).
- **Raise:** in `ask`, for each host where `levelRank(level) > levelRank(host.loaded ?? count)`:
  - If the host is backed off (`retryAt > now`): leave it; its timer fires at `retryAt`.
  - Otherwise, if nothing is queued, set `queued = 'raise'`, and start now if no pass is in
    flight. The queued pass runs right after the current one ends.
- **Force:** `force()` works per host:
  - If `forced` is already true: nothing.
  - Otherwise set `forced = true`.
  - If the state is `stale`/`error`: clear `retryAt`, but keep `failures` so a failure resumes at
    the next step.
  - Queue `'force'` (it overrides a queued `'raise'`), and start now if idle.
  - `forced` clears when that pass settles (success or failure), and `onChange(false)` is called.
- **Pass:**
  - `run(host, level, onRows, () => this.current())`. `onRows` updates `host.rows`/`partial` and
    calls `onChange(true)`, unless the pass's epoch is old (see `cancelQueued`).
  - **Success:** set `rows`, `partial`, `loaded = level`, `okAt = now`, `failures = 0`,
    `retryAt = undefined`, `reason = undefined`.
  - **Failure:** `reason = err.message`. For hosts other than `local`:
    `failures += 1`, `retryAt = now + [30000, 60000, 120000][min(failures, 3) - 1]`, and the next
    timer fires at `retryAt`. For local: no backoff; the next tick is at `localMs`.
  - Then `onChange(false)`.
- **`status()`** per host:
  - `state`:
    - `'loading'` when a pass is in flight AND (its kind is raise/force, or the host has no
      `okAt` yet);
    - else `'error'` when the last pass failed and the host has no rows ever published;
    - else `'stale'` when the last pass failed (rows kept);
    - else `'ok'`.
    - A backed-off host with a raise waiting reports `stale` (or `error`), never `loading`.
    - Routine ticks never flip the state to `loading`, so an unchanged 4 s pass changes nothing
      in the dedupe key.
  - Plus `reason`, `okAt`, `retryAt`, `partial`, `forced`, `calls: calls(host)`.
- **`rows()`:** concatenates the hosts' rows, in host order.
- **`hasData()`/`firstData()`:** true/resolve once any host has published rows through `onRows`
  or a pass end. A failed pass with no rows does not count.
- **`cancelQueued()`** (synchronous):
  - `epoch += 1`. Each pass captures `epoch` when it starts.
  - Clear every `queued`, and set `forced = false` on every host.
  - Set each host's `rows = []`, `partial = false`, `loaded = null`.
  - A pass already running is not aborted. When it ends with an old epoch, its `onRows` calls and
    its result are ignored (no rows, `loaded`, `okAt` or backoff change), and the host's next timer
    is scheduled as normal. No queued pass from before the call can start afterwards.
- **`stop()`:** clear every timer; no new passes.

Tests (fake `run` returning controllable deferred promises, manual timer queue, injected `now`):

- **Independence:** a remote host whose pass never resolves does not stop `local` from completing
  3 ticks; `status()` shows remote `loading` (no `okAt`) and local `ok`.
- **Attention:**
  - `ask(live)` then no ask for 31 s: the next pass is at count.
  - `ask(history 30)` after a live load queues a raise pass immediately (the run is called with
    the history level before any timer fires).
  - `ask(history 7)` after a history-30 load does not.
- **Force:**
  - While a pass is in flight, `force()` queues one pass that starts right after.
  - A second `force()` adds nothing (count the run calls).
  - `forced` is true while queued and running, and false after it ends, both on success and on
    failure.
- **Backoff:**
  - A remote failure gives `retryAt` 30 s, then 60 s, then 120 s, then 120 s.
  - A success resets it.
  - `force()` on a stale host runs now, and a failure resumes at the next step (60 s after a
    first 30 s).
  - Local never backs off.
- **Raise vs backoff:** a raise on a backed-off host does not run before `retryAt`, and the state
  is `stale`, not `loading`.
- **`firstData`** resolves on the first `onRows` publish.
- **`cancelQueued`** drops a queued forced pass and clears `forced`. A pass running across
  `cancelQueued` resolves with rows, and its rows/`okAt`/`loaded` are not applied.
- **Demand:** the runner's 4th argument returns the live level, then `{kind:'count'}` once 31 s
  pass without `ask`.
- **Status `calls`** comes from the callback.

Commit: `schedule: per-host loops, attention levels, force and backoff`.

## Task 6: worker.ts wiring, manifest, README

**Files:** modify `src/worker.ts`, `orca-plugin.json`, `README.md`.

1. **Imports and per-call options:**
   - Delete the moved helpers from `worker.ts` and import them from `./cli.ts`.
   - `cliFor(args)` sets `remote = args.includes('--environment')`; the timeout is 20000 when
     remote, else 8000.
   - Each call increments `calls[host]`, where `host` is the `--environment` value or `'local'`.
   - `environment list` and `terminal focus` keep using `run` with 8000.
2. **Startup order in `activate`:**
   - Save `orca` in a module variable.
   - `const granted = orca.grantedCapabilities?.includes('storage:own')`.
   - `store = new DetailStore(granted ? orca.storage as StorageLike : null, orca.log)`.
   - `collector = new Collector(cliCall, store)`.
   - `scheduler = new Scheduler({ run: (h, l, on, demand) => collector.rows(h, l, on, demand), hosts:
     async () => { await loadSettings(); return hostList() }, calls: (h) => calls.get(h) ?? 0,
     onChange: publish })`.
   - Then `void store.load().finally(() => scheduler.start())`.
3. **`snapshot()`:**
   - `s = buildRuns(scheduler.rows())`, then `s.hostStatus = scheduler.status()`.
   - If `!scheduler.hasData()`: `s.error = 'Still loading subagents from the Orca CLI…'`.
4. **`publish(progress)`:**
   - Build the snapshot.
   - Chip: compute `chip(s)`. If `JSON.stringify(chip)` changed, call `statusBar.update`, as
     today's `tick` does.
   - Dedupe key: `JSON.stringify` of `s.runs` (ids, counts, and each node's id, phase and
     loading, recursively) plus `hostStatus.map(h => [h.host, h.state, h.reason ?? '',
     h.partial, h.forced])`. `calls`, `okAt` and `retryAt` stay out of it.
   - If the key changed: when `progress` is true, post at most once every 2 s, with a trailing
     post; otherwise post now. The post is `orca.panels.post('graph.changed', { at: s.at })`.
5. **`graph.read`:**
   - Parse `{range, view, force}`.
   - `level`: `view === 'live'` gives `{kind:'live'}`; otherwise
     `{kind:'history', days: RANGES[range] ?? 7}`.
   - Call `scheduler.ask(level)`, and `scheduler.force()` when `force`.
   - If `!scheduler.hasData()`, wait for `Promise.race([scheduler.firstData(), sleep(12000)])`.
     Remove `settle`, `refresh`, `busy`, `tick` and the 4 s freshness shortcut.
   - Build the snapshot.
   - Runs:
     - live: `liveRuns(snap.runs)`;
     - history: `snap.runs.filter(r => { const t = toMs(r.createdAt); return isFinite(t) ? t >=
       cutoff : range === 'all' })`. This is the explicit unknown-time rule replacing the NaN
       accident.
   - Answer with the same shape as today plus `hostStatus`.
6. **`graph.clearCache`:** the order matters (the spec drops passes "started or queued before the
   bump"):
   `scheduler.cancelQueued(); collector.clear(); const done = store.clear(); publish(false); await
   done; return { ok: true }`. The first three calls run synchronously before any `await`
   (`store.clear()` bumps its generation and empties memory before its first await, Task 2), so
   no old pass can refill memory or storage and no queued pass can start under the new generation
   with old data.
7. **`deactivate`:**
   - Async.
   - `scheduler?.stop(); const w = store?.flushNow() ?? Promise.resolve(); killAll();`
   - `await Promise.race([w, new Promise(r => setTimeout(r, 1500))])`.
   - The write starts first and the kill comes second (spec R3/R6).
   - Clear module variables. `activate` stays the default export.
8. **`orca-plugin.json`:**
   - `"version": "0.4.0"`.
   - `capabilities`: `[{"kind":"settings:own"},{"kind":"storage:own"}]`.
   - Then run `orca plugin validate .` and paste its result in `worker_done`.
9. **`README.md`:**
   - A "What it loads" paragraph:
     - Count only while the panel is closed.
     - Live loads live runs.
     - History loads when opened.
     - Details are cached across restarts.
     - The refresh button.
   - A "0.4.0" release note: it now asks for `storage:own` (saved worker details), so Orca asks
     for approval again after updating, and the update won't activate until it is approved.
     `graph.clearCache` resets the cache (`orca plugin dev request` example).
10. **Tests:** worker.ts is glue around Orca; its logic lives in tested modules. Add no worker test
    file. Run the full suite plus `orca plugin validate .`, and check that `node -e "import('./src/worker.ts')"`
    loads without a syntax error (type stripping).
11. Commit: `worker: per-host scheduler, instant graph.read, storage:own (0.4.0)`.

## Task 7: panel (hidden gating, refresh, host lines, loading rows)

**Files:** modify `panel/app.js`, `panel/graph.js`, `panel/index.html`, `panel/style.css`; create
`src/panel.test.ts`.

1. **`panel/graph.js` pure helpers**, exported on `window.SGGraph`:
   - `hostLines(hostStatus, now)` returns strings for hosts that are not `ok` or are partial:
     - `stale`/`error`: `"<host>: <reason>, retrying in <N>s"`, with the clause after the comma
       only when `retryAt > now`, and `reason` defaulting to `unreachable`;
     - `loading`: `"<host>: loading…"`;
     - `partial` (any state): `"<host>: showing the newest 100 workers; older ones may be missing"`.
   - `updatedLabel(hostStatus, now)`:
     - `''` when the list is empty;
     - `'not loaded yet'` when any host lacks `okAt`;
     - otherwise `'updated ' + ago(min okAt)`.
   - `updatedTitle(hostStatus)`: one line per host, `"<host>: <ago(okAt) or not loaded yet>"`.
   - `createLoader({ request, isHidden, onSnap, onError })` returns `{ load(force), visible() }`:
     - `load(force)`: while `isHidden()`, set `skipped = true` and return, without requesting.
       While a request is in flight, set `again = true` and `againForce ||= force`, then run one
       more request after it settles. Otherwise call `request({ force: !!force })` and pass the
       result to `onSnap`/`onError`.
     - `visible()`: if `skipped`, clear it and `load(false)`.
     - Force is never sent while hidden.
2. **`panel/graph.js` loading nodes:** when `n.loading`:
   - the sub line shows `loading…` instead of the agent, model and duration;
   - the detail rows Created, Completed and Duration show `loading…`;
   - the node gets class `loading`.
3. **`panel/index.html`:**
   - In `header.bar`, after `#summary`: `<span id="updated" class="mut"></span><button id="refresh"
     class="icon" title="Refresh now" aria-label="Refresh now">↻</button>`.
   - After `.tools`: `<div id="hosts" class="hosts" hidden></div>`.
4. **`panel/app.js`:**
   - Replace `load()` with `createLoader`. The request is `api.plugin.request('graph.read', {
     range, view: view.mode, force }, { timeoutMs: 20000 })`.
   - `graph.changed` → `loader.load(false)`.
   - The 15 s interval → `loader.load(false)` (the hidden check now lives in the loader).
   - Add `document.addEventListener('visibilitychange', () => { if (!document.hidden)
     loader.visible() })`.
   - `#refresh` click → `loader.load(true)`. The button is disabled when any
     `snap.hostStatus[].forced`. Re-enabling comes only from a later snapshot.
   - In `draw(snap)`:
     - Fill `#hosts` with `hostLines`, hidden when empty.
     - Keep showing `snap.error` (first-load message), as today.
     - Set `#updated` text to `updatedLabel` and its title to `updatedTitle`.
   - The existing 1 s interval also refreshes `#updated` text from `view.last.hostStatus` (no
     request).
5. **`panel/style.css`:** `.hosts` small muted lines with warning colour for stale/error;
   `#refresh` compact icon button, with a disabled style; `.loading` dims the sub line.
6. **`src/panel.test.ts`:** load `panel/graph.js` with `node:vm`
   (`vm.runInNewContext(src, { window: {} })`) and test:
   - `hostLines`: the stale line with its retry, the error without a retry, the loading line,
     the partial line, and ok hosts omitted.
   - `updatedLabel`: empty, not loaded yet, and updated from the oldest `okAt`.
   - `createLoader`:
     - Hidden: `load` does not request. `visible()` then requests once, and `visible()` again
       does nothing.
     - Two `load`s during an in-flight request give exactly one more request after it settles,
       and it carries `force` if either asked for it.
     - `load(true)` while hidden sends nothing.
7. **Manual check (report it in `worker_done`):** `orca plugin check .` renders the panel without
   errors.
8. Commit: `panel: host status lines, refresh button, loading rows, hidden gating`.

---

## Final verification (coordinator, after all beads)

1. `node --test src/*.test.ts`: all green, with the count recorded.
2. `orca plugin validate .` and `orca plugin check .` in the worktree.
3. Live check on fedora, without touching the installed plugin:
   - `orca plugin dev load <worktree>` if Orca allows a dev copy beside the installed id;
     otherwise skip it and report.
   - `orca plugin dev request subagent-graph graph.read '{"view":"live"}'` twice, 20 s apart.
     Read `hostStatus[].calls` and check the steady state is about 1 call per local pass with
     nothing running.
4. Spec success criteria walk-through, one line each, in the final report. The Windows criterion
   is marked "needs a run on the Windows desktop".

## Self-review

- **Spec coverage:**

  | Spec part | Tasks |
  |---|---|
  | R1 | 4 (levels, Live rule, range rule), 1 (loading rows), 6 (range filter) |
  | R2 | 5 |
  | R3 | 3 (timeout text, kill), 4 (lanes), 6 (timeouts, deactivate) |
  | R4 | 4 (short rows), 5 (status, raise), 6 (instant read, 12 s first load, dedupe, 2 s progress) |
  | R4a | 5 (force), 6 (`force` input), 7 (button, label) |
  | R4b | 7 |
  | R5 | 1 |
  | R6 | 2 (store), 4 (proof, guards, generation), 6 (wiring, grantedCapabilities, deactivate order, clearCache) |
  | Edge cases | tests in 2, 4 (demand lapse, clear mid-pass), 5 and 7 |

- **Interpretation noted:** "possibly-open" in the Live-run rule means "last probe said open"
  (Task 4, step 7), so `missing` workers don't flood Live. The routine-tick `loading` state is
  suppressed (Task 5), so the dedupe key is stable.
- **No placeholders:** every task names its files, API, behaviour and tests.
