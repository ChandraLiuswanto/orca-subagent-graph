# Subagent Graph: project grouping and UX pass

Date: 2026-11-08 · Plugin version at start: 0.2.1

## Problem

When the user switches to another project, the graph "disappears".

Cause, verified on fedora: the collector already receives workers from every
project (`worker-list` without `--run` has scope `all`: 52 workers across 8
workspace paths). The Live view, however, keeps only runs with a running or
idle worker plus the single newest run (`liveOnly` in `src/model.ts` and
`liveRuns` in `panel/app.js`). Orca releases a finished worker's terminal about
2 minutes after `worker_done`. After that, a project's run drops out of Live as
soon as any other project starts a run. Every worker row carries its `workspace`
(`<worktreeId>::<absolute path>`), but the plugin ignores it.

## Goals

1. **Group by project, show all.** Live view shows one section per project,
   covering every project with relevant runs, not just the current one.
2. **Finished runs stay visible.** A project's run stays in Live after it
   finishes, for a recent window, instead of only the newest run surviving.
3. **UI/UX improvements** from the Mobbin review (below), scoped to a narrow
   sidebar panel.

## Non-goals

- Following the active Orca worktree automatically (the user chose "show all").
- Pi in-session subagents (not recorded by Orca).
- New CLI calls per tick beyond what the collector makes today.

## Requirements

### R1 Project identity

- `Row` gains `workspace: string | null` from `worker-list`'s `workspace`
  field. The path is the part after `::`; no `::` means the whole string.
- A run's project is the workspace of its root worker: the earliest-created
  worker with no creator. Nested workers in another worktree still draw under
  their parent's run.
- A project key is `host + path`. The label is the path's last segment. When
  two projects share a label, show the shortest distinguishing suffix
  (`main` vs `surface-probe/main`). The tooltip shows the full path and host.
- A run with no workspace goes under "Unknown project".

### R2 Live view

- Live includes runs that have a running or idle worker, **plus** runs that
  finished within the last **1 hour** (a constant `RECENT_MS`), for every
  project. This replaces "plus the newest run".
- If that leaves Live empty, show each project's single newest run, so Live is
  never blank while history exists.
- Runs are grouped under collapsible project headers. Header: label, host pill
  for non-local hosts, aggregate pills (running/idle/failed), time of the most
  recent activity.
- Project order: projects with running workers first, then idle, then by most
  recent activity. Runs inside a project: newest first.
- Collapse state per project persists in `localStorage`, like run collapse
  state does today. Projects with live workers default to open; others default
  to closed.

### R3 History view

- Same project grouping, filtered by the existing range selector.

### R4 Status bar chip

- Unchanged count (running + idle). The tooltip adds the per-project
  breakdown, up to 3 projects then "+N more", within the 256-character limit.

### R5 UI/UX improvements (from Mobbin references)

| # | Change | Reference |
|---|---|---|
| U1 | **Status filter chips** above the tree: All · Running · Idle · Failed · Done, with counts. Filters nodes, and hides runs and projects that end up empty | Zapier Zap history status filter; n8n executions filter |
| U2 | **Text search** box: matches task title, run objective, project label, model, dispatch id | Zapier "Search Zap runs"; Braintrust log search |
| U3 | **Duration on every node.** Running: live elapsed ("2m 10s"). Settled: completed minus created. Replaces the bare "ago" text, which moves to the tooltip | n8n "Succeeded in 44ms"; Databricks node "6m 53s"; Adaline latency column |
| U4 | **Status icon plus text, not colour alone.** A glyph per phase (spinner/pulse, pause, check, cross) beside the coloured dot, for colour-blind users and readability at small sizes | Attio run history; incident.io "✓ Succeeded" badge |
| U5 | **Node detail on click for every node**, including done ones. Inline expansion under the node: dispatch id (copyable), task id, terminal, agent and model, created/completed times, duration, follow-up count. Running or idle nodes keep "Focus terminal" as a button inside it instead of focusing on any click | Databricks "Job run details" side pane; Attio run hover card; Zoho execution details |
| U6 | **Run header summary line**: "3 workers · depth 2 · 4m 12s total" under the objective | Snowflake "Succeeded · 1 task ran · 6m 26s" |
| U7 | **Empty state with guidance**: explain what appears here and show the one-line `orca orchestration worker-start` example, instead of "No orchestration workers yet." | Tana agent empty states; Railway "No logs found for this filter" |
| U8 | **Failed nodes stand out**: red left border on the node and the run auto-expands; failed runs sort above done ones inside a project | Braintrust error-row tint; Zapier "Stopped / Errored" |

Out of scope from the review (too heavy for a sidebar): zoomable DAG canvas,
activity histogram (Adaline, Braintrust), and the split detail pane.

## Edge cases

- The same path on two hosts is two projects (key includes host).
- A path that is the home directory or `/tmp/...` still groups normally; the
  label falls back to the full path when the last segment is empty.
- A filter or search that matches nothing shows "No matches", plus a "Clear
  filters" action.
- A long project list must still fit a 280px-wide sidebar: labels ellipsize,
  and pills wrap under the label.
- Persisted collapse and filter state that references vanished projects is
  pruned. The cap stays at 200 keys.

## Success criteria

- Starting a run in project A, letting it finish, then starting a run in
  project B: both appear in Live under separate project headers for 1 hour
  after A finishes.
- `node --test src/model.test.ts` passes. New tests cover: project grouping,
  label disambiguation, the 1h recent window, the newest-per-project fallback,
  root-worker project choice for cross-worktree nested workers, and duration
  formatting.
- No extra CLI calls per poll compared with 0.2.1.
- Manual check from the Windows client against fedora (paired-server path).
- Version bumped to 0.3.0.

## Mobbin references

- Zapier Zap history: https://mobbin.com/screens/9a0d3026-2f86-4e69-a601-392eb5ba9a89
- n8n executions: https://mobbin.com/screens/aa1c8a64-fd1a-442b-8a86-246dc495b1b4
- Attio workflow runs: https://mobbin.com/screens/d8d6c229-4909-490c-83a1-a84958f82b83
- Databricks job run: https://mobbin.com/screens/35674f25-fede-4c71-b1ff-1e450ca90636
- Snowflake graph run: https://mobbin.com/screens/ab418e9e-2245-4b15-8ea7-9de8d32a889b
- Braintrust logs: https://mobbin.com/screens/16fc833f-6d16-4385-aa12-b845670e0891
- incident.io workflow activity: https://mobbin.com/screens/a42143a6-b342-4116-8541-845968594147
- Adaline monitor: https://mobbin.com/screens/f2cd6dd6-31a7-4bdd-a763-c9f50648dcac
- Railway service panel: https://mobbin.com/screens/d9df9c96-28f1-4732-af07-7eec727bac78
- Tana agent page: https://mobbin.com/screens/8d3199a0-dfb3-4145-b7da-851658ff1684
