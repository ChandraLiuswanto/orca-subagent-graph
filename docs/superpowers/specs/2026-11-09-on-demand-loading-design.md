# Subagent Graph: on-demand loading

Date: 2026-11-09 · Plugin version at start: 0.3.0

## Problem

The worker fetches full details for every worker on every host, whether or not
anyone is looking. On a paired server this times out and repeats.

Measured on 2026-11-09:

- **Per tick (every 4 s), panel open or closed:** one `worker-list --full` per
  host. On the first tick there are also one `worker-show` per worker, one
  `task-list` per run, and one `run-list`. On fedora: 68 workers, 22 runs,
  about 92 CLI calls.
- **Cost of one CLI call:** about 150 ms on fedora, almost all of it Node.js
  start-up. On the Windows desktop against `100.88.18.84`: 1.8–2.9 s for one
  `worker-list`. `--full` (178 KB) is no slower than the short form (22 KB),
  so start-up and the encrypted connection dominate, not data size.
- **The Windows errors:** 6 `orca.exe` calls run at once against the server,
  some go past the 8 s limit in `run()`, and Node kills them. The message
  Windows shows (`<host>: Command failed: …orca.exe orchestration worker-list
  …`) is Node's text for a killed program. Failed `worker-show` calls retry
  after 30 s, so the errors keep coming back.
- **The panel timeout:** `graph.read` waits for that first full load, and the
  panel gives up after 20 s (`panel/app.js:269`).
- **How little of it is needed:** at measurement time 0 workers were running
  and 2 were in a reclaimable state. The other 66 had finished hours or days
  ago, yet their details were fetched anyway.

Orca has no plugin API for orchestration data (stablyai/orca#37684 is open),
and plugin workers cannot run on the paired server (#37788). The CLI remains
the only supported path.

## Goals

1. **Background stays cheap.** While the panel is closed, the worker does only
   what the status bar counter needs.
2. **Details only for what's on screen.** Live loads only live and recent
   runs. History loads only when the History tab is opened.
3. **Fetch once.** A settled worker's details are fetched once and survive
   restarts.
4. **No timeouts.** `graph.read` always answers before the panel gives up.
   One slow or unreachable host never stalls the others or floods the error
   line.

## Non-goals

- Talking to Orca's socket directly, or a long-running helper process. Both
  are possible later; this spec stays on the supported CLI.
- Changes to how the graph is drawn, beyond loading and error states.
- Pi in-session subagents.
- A companion server on the remote host (for example on port 6769). Orca's
  headless server has no plugin service (`orca plugin list` there answers
  "Plugin service is not available on this runtime"), so it would be a
  separate install. Revisit only if the first History load stays too slow.
- Saving the panel's drawn graph, or any data other than R6's details.

## Definitions

- **Settled worker:** `dispatchStatus` is `completed`, `failed` or
  `circuit_broken`.
- **Active worker:** not settled (`pending` or `dispatched`).
- **Possibly open worker:** settled, has a terminal handle, its
  `releaseState` is not `released`, its `worker-list` liveness
  (`projection.liveness.verdict`) is not `exited`, and it has no trusted
  closed knowledge (R6). The rule is "probe unless proven closed". A
  verdict of `unverifiable` (no evidence) never counts as closed by
  itself. This tightens the existing test in `collect.ts`. On fedora
  today, 62 of 77 workers pass the old test and 58 still pass with the
  verdict check, so closed knowledge matters.
- **Details:** what `worker-show` adds per worker: creation time, creator
  (parent) dispatch, follow-up link, agent, model, completion time and
  terminal liveness. Details of a settled worker never change and are cached
  for good.
- **Panel attention:** the panel has asked `graph.read` within the last
  `ATTENTION_MS` (30 s). The open panel already asks at least every 15 s
  (`panel/app.js`, last `setInterval`). A hidden panel sends no requests at
  all (R4b), so attention lapses about 30 s after the panel closes or is
  hidden.

## Requirements

### R1 Three load levels

The collector takes a level for each host on every pass. Every level lists
workers with `worker-list --full --limit 100` (as `collect.ts` does today):
the short form lacks `dispatchStatus`, `runId`, `agentTerminalHandle` and
`resource`, which the tests below read.

| Level | When | `worker-list` | `worker-show` for | `task-list` for | `run-list` |
|---|---|---|---|---|---|
| `count` | no panel attention | 1 page | active and possibly-open workers without saved details or closed knowledge | none | none |
| `live` | Live tab has attention | 1 page | count's set, plus every worker of a Live run without details | Live runs only | when an unknown run appears (existing 60 s guard) |
| `history` | History tab asked | up to 5 pages | every worker in the chosen range without details | every run in the range | as `live` |

- **Live runs:** runs with an active or possibly-open worker, plus runs that
  were created within `RECENT_MS` (1 h, from `run-list` `created_at`) or
  whose newest known completion time (from details, saved or fetched) is
  within `RECENT_MS`. If that is empty, each project's newest run, matching
  `liveRuns` today. A run that started long ago and just finished stays in
  Live once its details are known; before that it may only appear in
  History.
- **History range:** comes from `graph.read`'s `range`. 1d/7d/30d/all map to
  pages as today: 1 page up to 7d, 5 pages beyond.
- **Without details:** a worker row still draws, marked loading. Status,
  phase, run and workspace come from `worker-list`. Times, nesting, agent
  and model show as loading until fetched. This happens right after a tab
  opens, while its first pass at the higher level runs (R4).
- **Range filter for rows without details:** uses the run's `run-list`
  `created_at`, never the worker's missing times. Today's filter lets them
  through by accident (`toMs('')` is NaN, so `!(NaN < cutoff)` is true,
  `worker.ts` near line 203); the new filter must not depend on that.

### R2 Polling

- **Local host:** every 4 s at the current level (unchanged).
- **Remote hosts:** every 15 s (`REMOTE_POLL_MS`), at any level. At count
  level with nothing running, that is one `worker-list --full` call per
  15 s.
- **Hosts run independently.** Each host has its own loop and its own pass
  in flight. A slow or hung host never delays another host's pass, the
  local 4 s cadence, or `graph.read`. The snapshot merges the latest rows
  from each host. Today's single serial `collect()` (`worker.ts`, one host
  after another behind one `busy` promise) is replaced.
- **Leaving attention:** when attention lapses, the next pass drops back to
  `count`. Cached details stay; nothing is refetched.

### R3 Concurrency and timeouts

- **Concurrency:** at most 6 CLI calls at once for the local host, and at
  most 2 per remote host. This covers both `worker-show` and `task-list`
  (`task-list` already uses `lanes` in the uncommitted change).
- **Per-call timeout:** 8 s local, 20 s remote.
- **Error text:** when Node kills a call for timing out, report `timed out
  after Ns` instead of `Command failed: <command line>`.
- **Host backoff:** after a remote `worker-list` fails or times out, skip that
  host for 30 s, then 60 s, then 120 s (cap). Any success resets it. While
  backed off, the host keeps its last rows, marked stale.
- **Shutdown:** `deactivate` first starts R6's final write, then kills CLI
  children still running, so a plugin restart leaves no `orca` or
  `orca.exe` processes behind. Orca allows about 2 s for both.

### R4 `graph.read` always answers

- **Short rows first.** A host's pass publishes its rows into the snapshot
  as soon as its `worker-list` returns, before any `worker-show` or
  `task-list`. Details are merged in as they arrive.
- **Answer at once when possible.** If a snapshot exists, `graph.read`
  answers with it right away, even while passes are running. Hosts that are
  mid-pass show `state: 'loading'`. It does not wait for the pass; the
  worker posts `graph.changed` when the pass finishes.
- **Raising the level starts a pass now.** `graph.read` records attention
  and the requested level (`live`, or `history` with its range) per host.
  Levels are ordered `count` < `live` < `history`, and `history` with a
  wider range than its last load (1d < 7d < 30d < all) counts as higher.
  If that is higher than the level the host's data was last loaded at, it
  queues a pass at the new level for that host right away, the way R4a
  queues a forced pass (it does not wait for the next tick, and it does not
  clear backoff). The immediate answer carries the lower-level rows, drawn
  as loading (R1). A host in backoff runs that pass at `retryAt` and shows
  `stale` with its retry time meanwhile, not `loading`.
- **Deadline only for the first load.** With no snapshot yet, `graph.read`
  waits at most 12 s (the uncommitted `settle` deadline), then answers with
  an empty snapshot marked "Loading…".
- **Progress:** History loads can take a while on a remote host. The worker
  posts `graph.changed` at most every 2 s while a history pass is running.
  Each resulting `graph.read` answers at once with the rows loaded so far.
- **When `graph.changed` is posted:** when the snapshot's rows or
  `hostStatus` change, compared with a dedupe key. The key covers row
  content and each host's `state`, `reason`, `partial` and `forced`, and
  ignores `calls`, `okAt` and `retryAt`, so an unchanged pass every 4 s
  posts nothing. (Today it is posted only when the status bar key changes,
  `worker.ts` near lines 165–173; that is too narrow for R4a.)
- **Per-host status:** the snapshot gains `hostStatus: { host, state:
  'ok' | 'loading' | 'stale' | 'error', reason?, okAt?, retryAt?, partial,
  forced, calls }[]`.
  - `partial`: R4's partial flag below.
  - `forced`: a forced pass (R4a) is queued or running for this host.
  - `calls`: CLI calls made for this host since the worker started. Tests
    and the success criteria read it.
  - `reason`: why the host is not `ok`, for example `timed out after 20s` or
    the CLI's error message.
  - `okAt`: when the host last answered successfully.
  - `retryAt`: when a backed-off host is tried next.
  - The panel shows one short line per host that is not `ok` (for example
    "100.88.18.84: timed out after 20s, retrying in 60s"), replacing the
    current joined error string.
- **Partial counts:** `worker-list` reads one page (100 rows, newest first).
  When the last page read reports more (`page.hasMore` or `nextCursor`),
  the host is marked `partial`. A long-running old worker can then be
  missing from the count. The panel's host status area says older workers
  may be missing. The status bar tooltip, capped at 256 characters by Orca
  (`PLUGIN_STATUS_BAR_TOOLTIP_MAX_LENGTH`), adds only a short
  ` (partial)`.

### R4a Refresh button and last-updated time (former O4)

- **Button:** a refresh button in the panel header sends `graph.read` with
  `force: true`.
  - `force` skips the "fresh enough" shortcut (`latest` under 4 s old), and
    it does not fold into a pass already running. For each host, it queues
    one pass to start as soon as that host's current pass ends (or now, if
    none is running). A second force while one is queued or running adds
    nothing.
  - `forced` clears when that pass ends, whether it succeeds or fails, and
    when `graph.clearCache` cancels it. Since the dedupe key includes
    `forced`, the clear alone posts `graph.changed`, on the failure path
    too.
  - For hosts that are `stale` or `error`, it clears the backoff and tries
    them once now. If that fails, backoff resumes at the next step, and
    `retryAt` is set again.
  - The pass stays within R1's level and R3's limits.
  - `graph.read` answers at once (R4), with `forced: true` on the hosts
    involved. The button is disabled while any host has `forced: true`, and
    re-enabled by the snapshot that `graph.changed` brings when the passes
    end. It does not depend on the request promise.
- **Last updated:** the header shows "updated 12s ago" from the oldest
  `okAt` among listed hosts, ticking locally without new requests. If a
  listed host has no `okAt` yet, the header says "not loaded yet" for it
  instead. The tooltip lists each host's time.
- **No new capability:** panel and worker only; no consent prompt.
- **No loops:** `graph.changed` triggers a normal `load()`, never a forced
  one.

### R4b A hidden panel sends nothing

- **Today's gap:** the 15 s reload and the 1 s tick skip while
  `document.hidden`, but `graph.changed` calls `load()` unconditionally
  (`panel/app.js`, `api.plugin.on('graph.changed', load)`). Progress posts
  and status changes would keep attention alive behind a hidden panel.
- **Change:** `load()` returns early while `document.hidden` and remembers
  that a load was skipped. On `visibilitychange` to visible, the panel loads
  once. A forced refresh is never sent while hidden.

### R5 Status bar counter

- **Inputs:** uses only count-level data, so it stays correct while the panel
  is closed.
- **Unreachable hosts:** count as unknown. Show `subagents ?` only when every
  host is unreachable; otherwise count what is known. The tooltip adds
  `, <n> host(s) unreachable` (short, within the 256-character cap); the
  panel's host status area names them.

### R6 Keep details across restarts

- **What is saved:** the detail fields of settled workers, and closed
  knowledge for their terminals. Live liveness ("open now") is never saved.
- **Why closed knowledge can be saved:** a settled dispatch does not
  reopen. `send` to a finished worker makes a new dispatch; the old one
  stays settled. Measured: `ctx_987cec20a409` stayed `completed` with
  `exitCause: operator_close` on `term_f1843…`, while its follow-up
  `ctx_0e13b48216ee` runs on `term_95ba…`. A terminal handle can, however,
  be reused by a later dispatch (`worker-start --terminal`): on fedora 11
  handles are each shared by two completed dispatches. So closed knowledge
  belongs to one dispatch id and one handle, never to a handle alone.
- **What counts as proof** (from the probe's `worker-show`):
  - **Certified:** `terminal.exitCause.kind` is `operator_close`,
    `signaled` or `exited` (Orca's proven kinds,
    `shared/terminal/pty/lifecycle/terminal-exit-cause.js`). Saved and
    trusted with no time limit, under the guards below.
  - **Missing (not proof):** `worker-show` returns no `terminal` at all
    (`observation.status: 'missing'`). This is 44 of the 58 possibly-open
    workers on fedora today. Orca returns the same result when its terminal
    lookup fails (`showTerminal(…).catch(() => null)` in
    `main/chunks/orcad-migration-source-retention-*.js`), so it is a
    negative lookup, not a closed terminal. It is kept in memory only for
    10 min to avoid probing again, its liveness stays unknown (not open,
    not closed), and it is never saved or used to mark a worker released.
    After a restart these workers are probed again, within R1's level and
    R3's limits. That is the cost of not guessing.
  - **Not proof:** `exitCause.kind: 'unknown'` (unverified stop, missing
    host status), or `connected: false` with no cause. Not saved. In
    memory, it is probed again after 10 min.
  - The same rules apply to in-memory closed knowledge.
- **Guards:** closed knowledge is used only while all of these hold, and is
  otherwise discarded and the worker probed again:
  - the entry's dispatch id is the row's (the layout keys by dispatch id);
  - the row is settled and carries the same handle;
  - its liveness verdict is not `live`;
  - no other row in the current `worker-list` with the same handle is
    active or appears before this one (the list is newest first, and
    `worker-list --full` rows carry no timestamps), in which case the
    handle may have been reused. Saved creation times (`c`) are compared
    only when both rows have one. When the page is `partial`, a shared
    handle counts as ambiguous, and the worker is probed.
- **What it saves:** on fedora today, the 14 workers with certified proof
  are not probed after a restart. The 44 `missing` ones are, once (about
  52 s over the remote CLI at 2 lanes, off the `graph.read` path).
- **Where:** the plugin's own store (`orca.storage`). The manifest adds the
  `storage:own` capability. Orca treats that as new access
  (`plugin-update-access-growth.js`), so the update asks for approval again.
  Declining may keep the updated plugin from activating at all; the release
  notes must say so.
- **Layout:** one key per host, `details:<host>`, holding `{ v: 1, items: {
  <dispatchId>: { run, c, cr, fu, a, m, d, th?, ex?, xt?, seen } } }` (run
  id, created, creator, follow-up, agent, model, completed, closed terminal
  handle, proof kind (`operator_close`, `signaled` or `exited`; the kind
  string only, not the whole cause object), time of the proving probe,
  last time seen in a `worker-list` by the pass clock). Short field names keep each entry around
  150–200 bytes; 68 workers is about 14 KiB. Bump `v` whenever a field is
  removed or changes meaning.
- **Limits:** Orca allows 256 KiB per value, 5 MiB total and 1024 keys. It
  rejects an oversized value (`action_failed`) rather than truncating it, so
  trimming is the plugin's job. Measure the serialized UTF-8 size. Above
  200 KiB, drop the entries with the oldest `seen` first.
- **Expiry:** entries not seen for 30 days are dropped. Expiry runs over
  every `details:*` key from `storage.keys()`, so it also covers hosts no
  longer in the `hosts` setting (a key left empty is deleted) and entries
  left behind by `orchestration reset` or a replaced Orca database. An
  entry missing from a partial `worker-list` page is not deleted for that
  reason alone.
- **When it is written:** when entries changed. Writes are coalesced (at
  most one every 10 s per host, with a trailing write so the last change is
  not lost) and serialized (one write in flight per key). `deactivate` makes
  one best-effort final write. Orca awaits `deactivate` but stops the
  process after about 2 s, and skips `deactivate` when the connection
  drops, so nothing may depend on it. `deactivate` receives no arguments; it
  uses the `orca` handle kept from `activate`.
- **When it is read:** once at startup, before the first pass, then pruned
  by expiry and size. Each entry is validated; a missing, unparsable or
  wrong-version value, or an invalid entry, is ignored and overwritten
  later.
- **Trust:** a saved entry stands in for `worker-show` only for a row in the
  current `worker-list` that is settled and has the same run id. If the row
  is active, or the run differs, the entry is discarded and refetched.
- **Failures:** storage calls reject with a plain `Error` carrying only a
  message (codes such as `consent_required` or `action_failed` appear only
  in the text). On the first failure, log one line, stop writing for the
  rest of the session and carry on in memory. A failure never changes R1's
  levels or adds CLI calls.
- **Clearing:** a `graph.clearCache` request, with no panel UI, deletes the
  plugin's `details:*` keys and the in-memory cache. It is for debugging or
  use right after an `orchestration reset`; expiry covers the normal case.
  Clearing bumps a cache generation number. Writes queued and passes
  started or queued before the bump (including forced and level-raise
  passes) are dropped, so old data cannot reappear in storage.

## Edge cases

- **History opened, then closed mid-load:** finish the calls already running,
  start no new ones, and keep what loaded.
- **Range changed during a history load:** a new pass at the new range
  replaces the queued one. Workers already loaded stay cached.
- **Worker settles while the panel is closed:** the count pass sees the
  status change in `worker-list` and probes it once because it is possibly
  open, which captures its completion time.
- **Plugin worker restarts:** settled-worker details and closed knowledge
  are restored from storage (R6). `worker-show` runs only for:
  - workers in the current level's set with no valid detail entry (missing,
    or a run id mismatch);
  - possibly-open workers, which by definition lack trusted closed
    knowledge: never proven closed (including every `missing` result,
    which is not saved), proof discarded by a guard, or verdict `live`.
- **Storage not granted:** if the plugin runs without `storage:own` in
  `orca.grantedCapabilities`, it skips storage entirely and keeps details in
  memory only, as today, logging one line. It checks the grant list, not
  errors. Note that declining the update's approval may instead keep the
  updated plugin from running (see R6).
- **The same dispatch id on two hosts:** cannot collide, because each host
  has its own key.
- **`hosts` setting changes:** hosts no longer listed drop out of the
  snapshot and their backoff state is cleared.
- **Panel hidden:** sends no requests at all (R4b), so attention lapses.
- **A host hangs:** its pass waits out its own per-call timeouts, while the
  other hosts keep their cadence (R2) and `graph.read` keeps answering at
  once (R4).

## Success criteria

How each is checked: unit tests run the collector and scheduler against a
fake CLI that records every call and can delay, fail or hang. The
`hostStatus[].calls` counter checks the live criteria by hand (read it
from `orca plugin dev request` before and after).

- **Panel closed, steady state:** once details and closed knowledge are
  cached, each pass makes 1 + (number of active and possibly-open workers
  with no closed knowledge) CLI calls. With nothing running, that is 1.
  (Fake-CLI test, and `calls` on fedora.)
- **First pass after a cold start (empty storage):** may probe every
  possibly-open worker once. It never blocks `graph.read` or other hosts,
  and its results are saved, so it is not repeated after a restart.
- **Live opened, fedora, cold cache:** Live rows have their details
  within 3 s of opening. The first answer may come earlier with rows drawn
  as loading. `worker-show` runs only for workers of Live runs, not all 77.
  (Fake-CLI test with 150 ms per call, and a timed check on fedora.)
- **History opened:** the panel never shows `graph.read timed out`. It gets
  an answer within 12 s: rows if any host has them, otherwise "Loading…".
  Rows appear as each host returns and fill in as details load. (Fake-CLI
  test with a hung first `worker-list`.)
- **Windows with `100.88.18.84` paired:** with the panel closed, about one
  `orca.exe` call every 15 s per remote host (`calls` grows by about 4 a
  minute). No `Command failed` lines; a failure shows as one host status
  line with its retry time.
- **Tests:** `node --test src/*.test.ts` passes. New tests cover level
  selection, Live-run selection by `created_at` and by newest completion,
  the range filter for rows without details, a level raise starting a pass
  at once, `graph.changed` dedupe (no post for an unchanged pass), backoff
  timing, the timed-out message, the per-host concurrency limit, and the R6
  store (round-trip, trimming at the size cap, ignoring a bad or
  wrong-version value or invalid entry, 30-day expiry across all
  `details:*` keys, discarding an entry whose dispatch is active again or
  whose run id differs, saving only certified proof and never `unknown` or
  `missing`, `missing` held in memory for 10 min only, discarding closed
  knowledge on a handle change, a `live` verdict, a reused handle, or a
  shared handle with unknown creation time or a partial page, rows
  published before details, coalesced and serialized writes with a trailing write,
  stopping writes after the first failure, clearing the cache with a
  generation bump that drops a pending write), `force` queueing behind a
  running pass and clearing backoff, `forced` clearing after a failed
  pass, `partial` from `hasMore`, a hung remote
  host not delaying local passes or `graph.read`, `graph.read` answering at
  once while a pass runs, and `deactivate` writing first, then killing
  running calls.
- **Hidden panel:** a `graph.changed` while hidden sends no `graph.read`;
  becoming visible sends one. (Panel test, or a manual check in
  `orca plugin dev inspect`.)
- **Refresh button:** pressing it on a backed-off host starts a pass right
  away, the button stays disabled until `forced` clears, and "updated Ns
  ago" resets on success.
- **After a restart:** with storage warm, restarting the plugin and opening
  History calls `worker-show` only for the workers named in the "Plugin
  worker restarts" edge case. On fedora with nothing running, that is 0–1.
  (Fake-CLI test, and `calls` on fedora.)

## Deferred (reviewed, not in scope)

A three-model review (Opus, Astra, DeepSeek) of the optional additions put O4
in scope (R4a) and deferred these:

- **O2 React to `agent.status.changed`.** Deferred (LATER, LATER, NEVER).
  The event comes from desktop terminal panes. Its payload has a pane key and
  terminal id, but no dispatch, task or host (`orca-host.d.ts:230`). Nothing
  shows it firing for workers on a paired server. It also needs `agent:read`,
  a second consent prompt. If revived: test it on a paired server first, use
  it only as a debounced "poll local now" hint, never as data, and add an
  `engines.orca` floor for the event's `since`.
- **O3 Direct local socket.** Deferred (LATER from all three). It works on
  Windows (named pipe), but only for the local host. The paired server goes
  over a WebSocket it doesn't cover. It copies an internal protocol
  (orchestration contract version, runtime fence, keepalive frames, runtime
  id checks), so it can break silently on Orca updates. It also reuses the
  runtime `authToken` without any consent prompt. If revived: an opt-in,
  local-only, read-only setting with CLI fallback, ideally after
  stablyai/orca#37684 adds a real host API.
