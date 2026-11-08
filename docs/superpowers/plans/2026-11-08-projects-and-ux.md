# Plan: project grouping and UX pass (Subagent Graph 0.3.0)

Spec: `docs/superpowers/specs/2026-11-08-projects-and-ux-design.md` (approved).
Checkout: `/home/chandraliuswanto/orca/workspaces/subagent-graph/projects-ux`,
branch `ChandraLiuswanto/projects-ux`, base `master` @ 9ffb5f0. No push, merge or
rebase.

**Goal:** group runs by project in Live and History, keep finished runs in Live
for 1 h, and ship UX items U1 to U8, all in a 280 px sidebar, with no extra CLI
calls per poll.

**Architecture:** all grouping, recency and labelling logic is pure and tested
in `src/model.ts`. `src/collect.ts` only adds two fields to each `Row` from data
it already fetches. `src/worker.ts` picks Live or History runs and returns
project groups to the panel. The panel draws project → run → indented HTML tree
(SVG is replaced so a node's details can expand inline and wrap at 280 px).

**Test command:** `node --test src/*.test.ts` (Node 25 runs `.ts` directly; there
is no `tsc`/`package.json`, so contracts below are the type check).

**Reference draft:** an earlier draft of this work is in `git stash list` as
`stash@{0}` (`git show stash@{0}:src/model.ts`, `…:panel/app.js`, etc.). You may
copy from it, but this plan wins where they differ. Never `git stash pop/drop`.

## Shared contracts (every task relies on these names)

### `src/model.ts` (Task 1 owns)

```ts
export type Row = { /* existing fields */ task_id: string | null; workspace: string | null }
export type Node = { /* existing fields */ taskId: string | null; workspace: string | null }
export type Run = {
  /* existing: id, host, objective, coordinator, createdAt, counts, roots */
  workspace: string | null   // workspace of the root worker (see R1)
  project: string            // projectKey(host, pathOf(workspace))
  endedAt: number | null     // max completed_at (ms) over the run's rows; null if none
  lastActivityAt: number     // max of created_at/completed_at (ms); 0 if none parse
  workers: number            // node count (follow-ups folded)
  depth: number              // deepest nesting level, root workers = 1
}
export type Project = {
  key: string; host: string; path: string | null; label: string
  counts: Record<Phase, number>; lastActivityAt: number; runs: Run[]
}
export const RECENT_MS = 3_600_000
export function pathOf(workspace: string | null): string | null
export function projectKey(host: string, path: string | null): string   // host + '\u0000' + (path ?? '')
export function projectLabels(list: { key: string; path: string | null }[]): Map<string, string>
export function groupProjects(runs: Run[], universe?: Run[]): Project[]
export function liveRuns(runs: Run[], now?: number): Run[]
export function formatDuration(ms: number): string
export function nodeDuration(n: Pick<Node, 'phase' | 'createdAt' | 'completedAt'>, now?: number): number
```

`liveOnly` is removed (its only caller is `src/model.test.ts`).

### `graph.read` payload (Task 3 produces, Task 5 consumes)

Request `{ range: '1d'|'7d'|'30d'|'all', view: 'live'|'history' }`. Response:

```js
{
  at, totals, hosts, error?,          // unchanged Snapshot fields (totals stay global)
  runs: Run[],                        // Live: liveRuns(all). History: range-filtered.
  projects: Array<Omit<Project,'runs'> & { runs: number[] }>, // indexes into runs, in display order
  knownProjects: string[]             // keys of every project in the full snapshot (for pruning)
}
```

### `window.SGGraph` (Task 4 produces, Task 5 consumes)

```js
SGGraph.render(run, opts) -> HTMLElement   // <ul class="tree">
//   opts = { roots: Node[] /* filtered copy; may carry n.ctx=true */, focus(node), copy(text),
//            isOpen(key) -> bool, toggle(key) }   key = node.host + ':' + node.id
SGGraph.ago(msOrIso) -> '5m ago'            // accepts a number (ms) or Orca/ISO string
SGGraph.duration(ms) -> '2m 10s'           // identical output to formatDuration
SGGraph.nodeMs(node, now?) -> number        // identical to nodeDuration
SGGraph.toMs(msOrIso) -> number
SGGraph.glyph(phase) -> html string         // <span class="st PHASE"><i class="dot PHASE"></i><svg class="gl …">…</svg></span>
SGGraph.esc(s) -> html-escaped string
```

### CSS class contract (Task 4 emits, Task 5 styles in `panel/style.css`)

`ul.tree`, nested `ul`, `li.<phase>` (+ `li.ctx` for dimmed context), `li.root`,
`div.card.<phase>` / `div.card.root` (`role="button"`, `tabindex=0`,
`aria-expanded`), `.st.<phase>`, `.dot.<phase>`, `svg.gl` (+ `.spin` for
running), `.txt`, `.title`, `.sub`, `.sub .ph` (phase word), `.sub .dur` (and
`data-start="<ms>"` on running nodes so the panel can tick it), `div.detail` with
`dl/dt/dd`, `button.copy[data-copy]`, `button.focus`.

## Blast Radius

| Changed | Dependents found (file:line) | Handling |
|---|---|---|
| `Row` (+`task_id`, `workspace`) | `src/collect.ts:115` builds rows; `src/model.test.ts:5` `row()` factory | Task 2 edits collect; Task 1 updates factory |
| `Node`/`Run` new fields | `src/model.ts:84` buildRuns; `panel/app.js:86`, `panel/graph.js:50` read runs | Task 1 builds them; Tasks 4/5 read them |
| `liveOnly` removed | `src/model.test.ts:3,50` only (`grep -rn liveOnly`) | Task 1 swaps to `liveRuns` |
| `chip()` tooltip | `src/worker.ts:165` (statusBar.update); `src/model.test.ts:46-49` | Task 1 changes + tests; worker call unchanged |
| `buildRuns` signature | unchanged; callers `src/worker.ts:146`, tests | unaffected: same params/return type (fields only added) |
| `toMs` | `src/worker.ts:181`, `src/model.ts` | unaffected |
| `graph.read` handler + payload | `src/worker.ts:176`; consumer `panel/app.js:102` | Task 3 edits handler; Task 5 rewrites consumer |
| `panel/app.js liveRuns()` | `panel/app.js:29,64` | Task 5 deletes it (worker does Live selection) |
| `SGGraph.render` signature (SVG → HTML, opts object) | `panel/app.js:91` only | Task 4 changes; Task 5 calls new signature |
| `SGGraph.ago` | `panel/app.js:86` | Task 4 keeps name, now also accepts ms |
| `#legend` / `.legend` | `panel/index.html:22`, `panel/style.css:26` | Task 5 removes both (glyph chips replace legend) |
| `localStorage 'sg.view'` shape (`open` values become `{o,d}`, keys `p:`/`r:` prefixed, new `status`) | `panel/app.js:10,19` | Task 5; old bare-id keys pruned on load |
| `Collector.rows()` | `src/worker.ts:141` | unaffected: same signature, no new CLI call (Task 2 test proves it) |
| `orca-plugin.json` version | Orca plugin loader | Task 6 bumps to 0.3.0 |
| `README.md` Live description | `README.md:6` | Task 6 |

## Tasks and file ownership

| Task | Files written | Blocked by |
|---|---|---|
| 1 model | `src/model.ts`, `src/model.test.ts` | — |
| 2 collector | `src/collect.ts`, `src/collect.test.ts` (new) | — |
| 3 worker | `src/worker.ts` | 1 |
| 4 tree | `panel/graph.js` | — |
| 5 panel | `panel/app.js`, `panel/index.html`, `panel/style.css` | — (codes to contracts) |
| 6 docs | `README.md`, `orca-plugin.json` | 3, 5 (describes final behaviour) |

Heads 1, 2, 4, 5 run in parallel. No file has two writers.

---

### Task 1: model (`src/model.ts`, `src/model.test.ts`)

- [ ] **Step 1: failing tests.** In `src/model.test.ts`: import
  `{ buildRuns, chip, formatDuration, groupProjects, liveRuns, nodeDuration, pathOf, phaseOf, projectLabels, RECENT_MS, toMs, type Row }`;
  the `row()` factory gains `task_id: 'task_a', workspace: 'wt1::/home/u/proj-a'`;
  replace `liveOnly(none).length` with `liveRuns(none.runs, toMs('2026-11-09 10:00:00')).length`.
  Add these tests (the draft in `git show stash@{0}:src/model.test.ts` lines 60+ has them):
  1. `pathOf`: `'wt::/a/b'→'/a/b'`, `'/a/b'→'/a/b'`, `null→null`.
  2. Grouping: rows in `/p/alpha` (2 runs), `/p/beta` (running), fedora `/p/alpha`,
     and `workspace: null` → 4 projects; beta first (running); then
     `[['fedora','alpha'],['local','alpha'],['local','Unknown project']]` by
     latest activity; alpha's runs newest first.
  3. Failed run sorts above a newer done run inside one project.
  4. Labels: `/w/new_bsa_react/main` + `/w/new_bsa_react/surface-probe/main` →
     `new_bsa_react/main` and `surface-probe/main`; `/home/u`→`u`; `/`→`/`;
     `null`→`Unknown project`; `/x/a/b` + `/y/a/b` → `x/a/b`, `y/a/b`.
  5. Recent window: run A (project A) completed 10:20, run B (project B)
     running, run old (A) completed 08:00. At 10:30 → `['r_b','r_a']`; at
     `10:20 + RECENT_MS` → still both; one second later → `['r_b']`;
     `groupProjects(live, all)` labels `['B','A']`. Also: two projects
     `/x/main` and `/y/main`, only one live → label stays `x/main` because
     `universe` is passed.
  6. Fallback: nothing recent → each project's newest run (`['r_a2','r_b1']`);
     `liveRuns([])` → `[]`.
  7. Cross-worktree nesting: root in `w1::/p/main`, kids created by root in
     `/p/child-wt` and `/p/other`, kid row listed first → one run,
     `workspace === 'w1::/p/main'`, 2 children, `workers 3`, `depth 2`, label `main`.
  8. Durations: `0→'0s'`, `44000→'44s'`, `130000→'2m 10s'`, `3_900_000→'1h 05m'`,
     `26h→'1d 2h'`, `NaN→''`, `-1→''`; `nodeDuration` done 10:00→10:06:53 =
     `'6m 53s'`; running from 10:00 at now 10:02:10 = `'2m 10s'`; done without
     completedAt → `''`.
  9. Chip: 5 running projects with 60+-char names → tooltip matches
     `/By project: .*\+2 more/` and length ≤ 256; one running worker in
     `proj-a` → exactly
     `'Orca workers: 1 running, 0 idle. By project: proj-a 1. Open the Subagents panel for the graph.'`.
- [ ] **Step 2:** `node --test src/model.test.ts` → new tests FAIL.
- [ ] **Step 3: implement** per the contracts:
  - `buildRuns` copies `task_id`/`workspace` onto nodes. Run `workspace`: the
    first row (rows are sorted oldest first) with no `creator_dispatch_id` and
    no `follow_up_of_dispatch_id`; until one is seen, fall back to the first
    row's workspace. Track `endedAt`, `lastActivityAt` while iterating rows;
    `workers`/`depth` in the existing `walk`; set `project` after the walk;
    `lastActivityAt` 0 when nothing parsed.
  - `liveRuns(runs, now)`: keep runs with `running+idle>0` or
    `(endedAt ?? lastActivityAt) >= now - RECENT_MS`; if empty, the newest run
    (by `createdAt`) per `project`; sort newest `createdAt` first.
  - `projectLabels`: null path → `'Unknown project'`; split on `/` or `\`
    dropping empties; no segments → full path; otherwise group by last segment
    and for each path use the shortest suffix (joined with `/`) not shared by
    another *different* path in its group (same path on two hosts shares a
    label; the host pill separates them).
  - `groupProjects(runs, universe = runs)`: bucket by `run.project`, sum
    counts, max `lastActivityAt`; labels computed over projects from `runs`
    plus `universe` (so labels match across Live/History). Runs inside a
    project: live (running+idle>0) first, then any failed, then done; newest
    `createdAt` first within each. Projects: running>0 first, then idle>0,
    then by `lastActivityAt` desc.
  - `formatDuration`: `<60s → 'Ns'`, `<60m → 'Mm Ss'`, `<24h → 'Hh MMm'`
    (minutes zero-padded), else `'Dd Hh'`; non-finite or negative → `''`.
  - `nodeDuration`: running → `now - created`; else `completed - created`.
  - `chip`: tooltip = `Orca workers: <parts>.` + (if any project has
    running+idle) ` By project: <label> <n>, … (max 3)[, +N more].` +
    ` Open the Subagents panel for the graph.`; if > 256 chars drop the last
    sentence and cut to 255 + `…`. Other chip fields unchanged.
- [ ] **Step 4:** `node --test src/model.test.ts` → all pass.
- [ ] **Step 5:** commit `src/model.ts src/model.test.ts`:
  `model: project identity and grouping, 1h Live window, durations, per-project chip tooltip`.

### Task 2: collector (`src/collect.ts`, new `src/collect.test.ts`)

- [ ] **Step 1: failing test** `src/collect.test.ts` using a fake `Cli` that
  counts calls and answers by `args[1]`:
  `worker-list` → two workers (`dispatchId`, `taskId`, `runId`,
  `dispatchStatus:'completed'`, `resource.releaseState:'released'`): one with
  `projection.workspace.id = 'wt::/p/a'`, one with only
  `resource.worktreeId = 'wt::/p/b'`; plus a third with top-level
  `workspace: 'wt::/p/c'` and one with none; `run-list` → `{runs:[]}`;
  `task-list` → `{tasks:[]}`; `worker-show` → `{dispatch:{createdAt:'2026-11-08 10:00:00', completedAt:'2026-11-08 10:01:00', status:'completed'}}`.
  Assert rows' `workspace` = `'wt::/p/a'`, `'wt::/p/b'`, `'wt::/p/c'`, `null`
  and `task_id` = the `taskId`s. Then call `rows('local')` a second time and
  assert it made exactly **1** CLI call (`worker-list` only), proving no extra
  per-poll calls.
- [ ] **Step 2:** `node --test src/collect.test.ts` → FAIL (fields missing).
- [ ] **Step 3:** in the row mapping add `task_id: w.taskId ?? null` and
  `workspace: workspaceOf(w)`, where `workspaceOf` reads, in order, top-level
  `w.workspace` (string, or object `.id`), `w.projection?.workspace?.id`,
  `w.resource?.worktreeId`; non-empty strings only, else `null`. No new CLI
  calls.
- [ ] **Step 4:** `node --test src/collect.test.ts` passes. (`src/model.test.ts`
  may fail until Task 1 lands; that is not this task's concern.)
- [ ] **Step 5:** commit `src/collect.ts src/collect.test.ts`:
  `collector: read workspace and task id from worker-list`.

### Task 3: worker (`src/worker.ts`), blocked by Task 1

- [ ] **Step 1:** change the import to
  `import { buildRuns, chip, groupProjects, liveRuns, toMs, type Row, type Snapshot } from './model.ts'`.
- [ ] **Step 2:** replace the `graph.read` handler:

```ts
orca.panels.handle('graph.read', async (input) => {
  const { range: r, view } = (input ?? {}) as { range?: string; view?: string }
  const live = view === 'live'
  const days = live ? 7 : RANGES[String(r ?? '7d')] ?? 7
  const snap = days > 7 ? await refresh(5) : latest && Date.now() - latest.at < POLL_MS ? latest : await refresh()
  const cutoff = Date.now() - days * 86400000
  // Live: active + finished within RECENT_MS, every project. History: the range.
  const runs = live ? liveRuns(snap.runs) : snap.runs.filter((x) => !(toMs(x.createdAt) < cutoff))
  // Projects reference runs by index so each run is serialized once.
  const index = new Map(runs.map((x, i) => [x, i]))
  const projects = groupProjects(runs, snap.runs).map(({ runs: list, ...p }) => ({ ...p, runs: list.map((x) => index.get(x)!) }))
  return { ...snap, runs, projects, knownProjects: [...new Set(snap.runs.map((x) => x.project))] }
})
```

  Nothing else in the file changes (Windows/paired-server code stays as is).
- [ ] **Step 3: verify** `node --test src/*.test.ts` green; the file parses:
  `node --input-type=module -e "import('./src/worker.ts').then(m=>console.log(typeof m.default))"`
  prints `function` (the `orca/worker` import is type-only and is erased);
  `grep -rn liveOnly src panel` prints nothing.
- [ ] **Step 4:** commit `src/worker.ts`:
  `worker: graph.read returns Live runs and project groups`.

### Task 4: tree renderer (`panel/graph.js`)

Rewrite as an IIFE that sets `window.SGGraph` per the contract (draft:
`git show stash@{0}:panel/graph.js`). Requirements:

- [ ] `render` returns `<ul class="tree"><li class="root">` with a
  coordinator card (`run.coordinator`), then nested `<ul>` of `opts.roots`
  (default `run.roots`), depth-first, one `li` per node.
- [ ] Node card (U3, U4, U8): `glyph(phase)` + title (ellipsized via CSS) +
  sub line `<span class="ph">phase</span> · <span class="dur">duration</span> · agent · model · +N follow-ups`.
  Running nodes: `.dur` carries `data-start` (created ms) and live elapsed;
  settled: completed − created, omitted when unknown. The relative "ago" goes in
  the card `title` tooltip ("started 5m ago" / "finished 2m ago") with the id
  and status. Glyphs: running = spinning arc (`.spin`), idle = pause bars,
  done = check, failed = cross; inline SVG using `currentColor`.
- [ ] U5: every node card is clickable/keyboard-activatable (Enter/Space) and
  calls `opts.toggle(key)`; when `opts.isOpen(key)`, a `div.detail` follows the
  card with a `<dl>`: Dispatch (`<code>` + `button.copy[data-copy=id]` → `opts.copy(id)`),
  Task, Terminal, Agent · model, Created, Completed ("still running" when
  running), Duration, Follow-ups, Host (non-local only). Running/idle nodes with
  a terminal get `button.focus` "Focus terminal" → `opts.focus(node)`; clicking
  a node no longer focuses directly. Buttons stop propagation.
- [ ] `li` gets `ctx` class when `node.ctx` (context ancestor kept by a filter).
- [ ] All interpolated text goes through `esc`. ES5 style like the rest of the
  panel (no build step).
- [ ] **Verify:** `node -e "global.window={};global.document=null;require('./panel/graph.js');const G=window.SGGraph;const a=[0,44e3,13e4,39e5,936e5,NaN,-1].map(G.duration);if(JSON.stringify(a)!=='[\"0s\",\"44s\",\"2m 10s\",\"1h 05m\",\"1d 2h\",\"\",\"\"]')throw a;console.log('ok')"`
  prints `ok`.
- [ ] Commit `panel/graph.js`: `panel: HTML tree with status glyphs, durations and inline node details`.

### Task 5: panel shell (`panel/app.js`, `panel/index.html`, `panel/style.css`)

Code only against the contracts above (draft: `git show stash@{0}:panel/app.js`
and `…:panel/style.css`, `…:panel/index.html`).

- [ ] `index.html`: wrap header in `div.top` (sticky). Remove `#legend`. Add
  `div.tools` with `input#search[type=search]` (placeholder "Search tasks,
  runs, projects, models, ids") and `div#filters.chips[role=toolbar]`.
- [ ] `app.js` request: `graph.read` with `{ range, view: view.mode }`; delete
  the local `liveRuns`. Resolve `snap.projects[i].runs` indexes into
  `snap.runs`.
- [ ] R2/R3 project sections: `<details class="proj">` per project, summary =
  caret, `.pl` label (ellipsis), host pill when host ≠ local, `.pm` with
  running/idle/failed pills (no done) and `ago(lastActivityAt)`; title tooltip =
  full path + host + run count. Default open iff running+idle>0. Inside: runs
  in the given order.
- [ ] Run card `<details class="run">` (+`has-failed` when failed>0: red left
  border). Default open when live, failed>0 (U8 auto-expand), in Live mode, or
  first in History. Summary: objective + `ago(createdAt)` on line 1; U6 line 2:
  `"N workers · depth D · <dur> total"` (running: `"<dur> so far"`, from
  createdAt to now; settled: createdAt to `endedAt || lastActivityAt`) plus
  counts pills. Tree: `SGGraph.render(run, opts)`; node detail open state in
  memory (`view.nodes`), toggle re-draws from the last snapshot.
- [ ] Collapse persistence in `localStorage 'sg.view'`: keys `p:<projectKey>`
  and `r:<host>:<runId>`, value `{o: open, d: defaultAtThatTime, f: failedAtThatTime}`
  where `f` is `run.counts.failed > 0` (always `false` for `p:` keys). An override
  applies only while both `d` and `f` are unchanged. A run that gains a failure
  therefore drops a stored collapse and re-expands (U8), even in Live where its
  default was already open. Check it in the harness: collapse a running run,
  re-serve the fixture with that run failed, and the run reopens, in both Live
  and History.
  Ignore the async `toggle` event caused by setting `.open` in code (compare with
  the last known value). On each draw prune `p:` keys not in
  `snap.knownProjects` and legacy keys without `p:`/`r:` prefix; cap stays 200.
  Also persist `status` filter.
- [ ] U1 chips: `All N · Running N · Idle N · Failed N · Done N` (glyph +
  text), counts reflect the current search; clicking a chip sets
  `view.status` (clicking the active one returns to All). Filter keeps
  matching nodes plus their ancestors as `ctx` (dimmed) copies; runs/projects
  with no remaining nodes are hidden. While filtering, sections are forced
  open and toggles are not persisted.
- [ ] U2 search (debounced ~120 ms, Esc clears): a run matches when its
  objective, project label or run id contains the query (case-insensitive) —
  then all its nodes show; otherwise nodes match on title, model or dispatch id.
- [ ] Empty states (U7): filters active and nothing left → "No matches." +
  `Clear filters` button (resets status and search). History with known
  projects but none in range → "No runs in this range." Otherwise guidance:
  what appears here (workers started through Orca orchestration, grouped by
  project, nested under their starter, this machine and paired servers) and
  `<pre>` with `orca orchestration worker-start --agent pi --spec "Summarize README.md"`
  plus a Copy button.
- [ ] Copy uses `navigator.clipboard.writeText` with a textarea/execCommand
  fallback, toast on result. Focus keeps the existing `terminal.focus` request.
- [ ] Every 1 s, update `.dur[data-start]` text with `SGGraph.duration(now - start)`;
  keep the 15 s reload and the `graph.changed` listener; drop the
  resize-redraw (HTML tree reflows by itself).
- [ ] `style.css`: style every class in the CSS contract plus `.top .bar .seg
  .tools #search .chips .proj .caret .pl .pm .run .has-failed .rh .rs .pill(.host)
  .empty .ex .err .toast`. Must fit 280 px: labels ellipsize, `.pm` pills and run
  pills wrap (`flex-wrap`), tree indents 14 px per level with CSS connector
  lines, `.detail dd { overflow-wrap:anywhere }`. Failed cards: red left border
  + faint red tint. Respect `prefers-reduced-motion` for the spinner.
- [ ] **Verify** in headless Chromium at 280×800 using a harness page (in
  `.scratch/`, not committed) that defines `window.orca.plugin.request/on`
  returning a fixture payload in the contract shape (≥3 projects incl. one
  remote host and two `main` labels, a running node, an idle node, a failed
  run, a 3-deep tree). Load `panel/graph.js` from the working tree if Task 4 has
  committed it; otherwise use `git show stash@{0}:panel/graph.js > .scratch/graph.js`
  (same contract). Playwright 1.59 is available via `npx playwright`.
  Check: no horizontal scrollbar on `body`, no console errors, chips filter,
  search "No matches" + Clear works, node detail opens. Screenshot to
  `.scratch/panel-280.png`.
- [ ] Commit the three files: `panel: project sections, status chips, search, run summary, empty state`.

### Task 6: docs and version (`README.md`, `orca-plugin.json`), blocked by 3 and 5

- [ ] `orca-plugin.json` `"version": "0.3.0"`.
- [ ] README panel bullet: Live shows runs with running/idle workers plus runs
  that finished in the last hour, for every project (falls back to each
  project's newest run); runs grouped under collapsible project headers;
  status chips, search, durations, click a node for details and "Focus
  terminal". Test line becomes `node --test src/*.test.ts`.
- [ ] Verify `node -e "JSON.parse(require('fs').readFileSync('orca-plugin.json'))"`
  and `node --test src/*.test.ts`.
- [ ] Commit both: `docs: README for projects and UX; version 0.3.0`.

## Final verification (coordinator)

`node --test src/*.test.ts` green; real-data probe through `Collector` against
local Orca shows several projects and second-tick call count 1; harness
screenshot at 280 px. Not verifiable here: the manual Windows paired-client
check (spec success criterion), so it gets reported to the user.
