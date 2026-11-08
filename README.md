# Subagent Graph (Orca plugin)

Shows how many Orca orchestration subagents you have and draws them as a nested graph.

- **Status bar chip:** "N subagents" counts running workers plus idle ones whose terminal is still open. It's hidden at 0, and the tooltip shows running vs idle and how deep the nesting goes.
- **Subagents panel** (right sidebar): **Live** shows runs with running or idle workers, plus the newest run. **History** shows all runs in a range (24h, 7d, 30d or All). Each run is a collapsible tree: coordinator, then workers, then the workers they started. Follow-ups sent to the same worker fold into one node, and clicking a running or idle node focuses its terminal.

Data comes from the `orca` CLI (`orchestration worker-list / worker-show / task-list / run-list`), so it works on Windows, macOS and Linux. It also covers **paired Orca servers**: with the default `hosts = auto`, it watches this machine plus every server in `orca environment list`, for example a Windows desktop watching a headless Linux box.

Pi's in-session subagents (pi-subagents) aren't recorded by Orca's orchestration, so they don't appear here.

## Install

Orca → Settings → Plugins → Install plugin → **Git URL**:

    https://github.com/ChandraLiuswanto/orca-subagent-graph

Enable it and approve full access (it runs a small background worker that calls the `orca` CLI). Then open **Subagents** in the right sidebar.

### Settings

- **Orca hosts to watch:** `auto` (default), or a list such as `local,fedora`, using the names from `orca environment list`.
- **Orca CLI path:** only needed if `orca.exe` / `orca` isn't found automatically.

## Test

    node --test src/model.test.ts
