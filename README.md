# Subagent Graph (Orca plugin)

Shows how many Orca orchestration subagents you have and draws them as a nested graph.

- **Status bar chip:** "N subagents" counts running workers plus idle ones whose terminal is still open. It's hidden at 0, and the tooltip shows running vs idle and how deep the nesting goes.
- **Subagents panel** (right sidebar): **Live** shows runs with running or idle workers, plus runs that finished in the last hour, for every project (if there are none, it falls back to each project's newest run). **History** shows all runs in a range (24h, 7d, 30d or All). Runs are grouped under collapsible project headers. Each run is a collapsible tree: coordinator, then workers, then the workers they started. Follow-ups sent to the same worker fold into one node. Nodes have status chips and durations, and there's a search box. Click a node for details and a **Focus terminal** button.

Data comes from the `orca` CLI (`orchestration worker-list / worker-show / task-list / run-list`), so it works on Windows, macOS and Linux. It also covers **paired Orca servers**: with the default `hosts = auto`, it watches this machine plus every server in `orca environment list`, for example a Windows desktop watching a headless Linux box.

Pi's in-session subagents (pi-subagents) aren't recorded by Orca's orchestration, so they don't appear here.

## What it loads

While the panel is closed or hidden, the worker loads only what the status bar count needs. Live loads details for live and recent runs; History loads its selected range when you open it. Settled worker details are cached across restarts. Each host polls independently, so a slow paired server does not hold up local results. Use the refresh button to request a new pass; the header shows when hosts last answered.

## 0.4.0

This update adds `storage:own` to save worker details across restarts. Orca asks for approval again after updating, and the update will not activate until you approve it. If storage is unavailable, the worker keeps an in-memory cache for the current session.

To reset saved details and closed-terminal knowledge in a development plugin, call `graph.clearCache`:

    orca plugin dev request . graph.clearCache --json

The next passes rebuild the cache from the CLI.

## Install

Orca → Settings → Plugins → Install plugin → **Git URL**:

    https://github.com/ChandraLiuswanto/orca-subagent-graph

Enable it and approve full access (it runs a small background worker that calls the `orca` CLI). Then open **Subagents** in the right sidebar.

### Settings

- **Orca hosts to watch:** `auto` (default), or a list such as `local,fedora`, using the names from `orca environment list`.
- **Orca CLI path:** only needed if `orca.exe` / `orca` isn't found automatically.

## Test

    node --test src/*.test.ts
