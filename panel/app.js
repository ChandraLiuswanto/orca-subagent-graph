;(function () {
  var api = window.orca
  var G = window.SGGraph
  var esc = G.esc
  var app = document.getElementById('app')
  var summary = document.getElementById('summary')
  var rangeSel = document.getElementById('range')
  var searchEl = document.getElementById('search')
  var chipsEl = document.getElementById('filters')
  var toastEl = document.getElementById('toast')
  var PHASES = ['running', 'idle', 'failed', 'done']
  var EXAMPLE = 'orca orchestration worker-start --agent pi --spec "Summarize README.md"'
  // open: collapse overrides keyed 'p:<project>' / 'r:<host>:<run>'; value is {o: open, d: default, f: failed}.
  var view = { mode: 'live', range: '7d', status: 'all', q: '', busy: false, again: false, open: {}, nodes: {}, last: null }
  try {
    var saved = JSON.parse(localStorage.getItem('sg.view') || '{}')
    if (saved.mode) view.mode = saved.mode
    if (saved.range) view.range = saved.range
    if (saved.status && (saved.status === 'all' || PHASES.indexOf(saved.status) >= 0)) view.status = saved.status
    if (saved.open && typeof saved.open === 'object') view.open = saved.open
  } catch (e) {}

  function persist() {
    var ids = Object.keys(view.open)
    if (ids.length > 200) ids.slice(0, ids.length - 200).forEach(function (k) { delete view.open[k] })
    try { localStorage.setItem('sg.view', JSON.stringify({ mode: view.mode, range: view.range, status: view.status, open: view.open })) } catch (e) {}
  }

  /** Drops collapse state for projects that no longer exist anywhere in the snapshot. */
  function prune(known) {
    if (!known) return
    var set = {}
    known.forEach(function (k) { set['p:' + k] = true })
    var changed = false
    Object.keys(view.open).forEach(function (k) {
      // 'p:' keys for vanished projects, and 0.2.x keys (bare run ids) that no longer apply.
      if ((k.indexOf('p:') === 0 && !set[k]) || !/^[pr]:/.test(k)) { delete view.open[k]; changed = true }
    })
    if (changed) persist()
  }

  // An override only applies while the default and failed state it was made under are unchanged,
  // so a run that gains a failure expands again even if it was collapsed (also in Live, where the
  // default was already open).
  function isOpen(key, def, failed) {
    var s = view.open[key]
    if (s && typeof s === 'object' && s.d === def && !!s.f === failed) return !!s.o
    return def
  }

  function remember(d, key, def, failed) {
    // Setting .open in code also fires 'toggle' (async); only react to real changes.
    var was = d.open
    d.addEventListener('toggle', function () {
      if (d.open === was) return
      was = d.open
      if (filtering()) return // forced open while filtering; do not persist
      if (d.open === def) delete view.open[key]
      else view.open[key] = { o: d.open, d: def, f: failed }
      persist()
    })
  }

  function toast(text) {
    toastEl.textContent = text
    toastEl.hidden = false
    clearTimeout(toast.t)
    toast.t = setTimeout(function () { toastEl.hidden = true }, 3500)
  }

  function focus(node) {
    api.plugin.request('terminal.focus', { terminal: node.terminal, host: node.host }, { timeoutMs: 8000 }).then(function (r) {
      if (!r || !r.ok) toast((r && r.reason) || 'Could not open that terminal')
    }, function () { toast('Could not open that terminal') })
  }

  function copy(text) {
    function fallback() {
      var t = document.createElement('textarea')
      t.value = text
      document.body.appendChild(t)
      t.select()
      var ok = false
      try { ok = document.execCommand('copy') } catch (e) {}
      t.remove()
      toast(ok ? 'Copied ' + text : 'Copy failed: ' + text)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast('Copied ' + text) }, fallback)
    else fallback()
  }

  function pills(c, withDone) {
    var out = ''
    if (c.running) out += '<span class="pill running">' + c.running + ' running</span>'
    if (c.idle) out += '<span class="pill idle">' + c.idle + ' idle</span>'
    if (c.failed) out += '<span class="pill failed">' + c.failed + ' failed</span>'
    if (withDone && c.done) out += '<span class="pill">' + c.done + ' done</span>'
    return out
  }

  function filtering() { return view.status !== 'all' || !!view.q }

  function textHit(s, q) { return !!s && String(s).toLowerCase().indexOf(q) >= 0 }

  /**
   * Filters a node list. A node stays when it matches, or as dimmed context ('ctx') when one of
   * its descendants matches. Returns copies; the snapshot is not changed.
   */
  function filterNodes(nodes, match) {
    var out = []
    nodes.forEach(function (n) {
      var kids = filterNodes(n.children || [], match)
      var hit = match(n)
      if (hit || kids.length) {
        var c = {}
        for (var k in n) c[k] = n[k]
        c.children = kids
        c.ctx = !hit
        out.push(c)
      }
    })
    return out
  }

  function walk(nodes, fn) { nodes.forEach(function (n) { fn(n); walk(n.children || [], fn) }) }

  function runMs(run) {
    var start = G.toMs(run.createdAt)
    var end = run.counts.running ? Date.now() : run.endedAt || run.lastActivityAt
    return end - start
  }

  function emptyState(kind) {
    var em = document.createElement('div')
    em.className = 'empty'
    if (kind === 'nomatch') {
      em.innerHTML = '<p>No matches.</p><button class="clear">Clear filters</button>'
      em.querySelector('.clear').addEventListener('click', clearFilters)
    } else if (kind === 'range') {
      em.innerHTML = '<p>No runs in this range.</p><p class="mut">Try a longer range.</p>'
    } else {
      em.innerHTML = '<p><b>No subagents yet.</b></p><p class="mut">Workers that an agent starts through Orca orchestration appear here, grouped by project, as a tree under the agent that started them. This covers this machine and paired Orca servers.</p>' +
        '<p class="mut">Start one from any terminal:</p><pre class="ex"><code>' + esc(EXAMPLE) + '</code></pre><button class="copy-ex">Copy command</button>'
      em.querySelector('.copy-ex').addEventListener('click', function () { copy(EXAMPLE) })
    }
    app.appendChild(em)
  }

  function clearFilters() {
    view.status = 'all'
    view.q = ''
    searchEl.value = ''
    persist()
    if (view.last) draw(view.last)
  }

  function drawChips(counts, total) {
    var html = '<button data-s="all" class="' + (view.status === 'all' ? 'on' : '') + '">All <b>' + total + '</b></button>'
    PHASES.forEach(function (p) {
      html += '<button data-s="' + p + '" class="' + p + (view.status === p ? ' on' : '') + '" title="Show ' + p + ' workers">' + G.glyph(p) + p[0].toUpperCase() + p.slice(1) + ' <b>' + counts[p] + '</b></button>'
    })
    chipsEl.innerHTML = html
  }

  function draw(snap) {
    view.last = snap
    app.textContent = ''
    if (snap.error) {
      var e = document.createElement('div')
      e.className = 'err'
      e.textContent = snap.error
      app.appendChild(e)
    }
    var t = snap.totals
    summary.textContent = (t.running + t.idle) + ' subagent' + (t.running + t.idle === 1 ? '' : 's') + ' · ' + t.running + ' running'
    prune(snap.knownProjects)

    var projects = (snap.projects || []).map(function (p) {
      var o = {}
      for (var k in p) o[k] = p[k]
      o.runs = p.runs.map(function (i) { return typeof i === 'number' ? snap.runs[i] : i }).filter(Boolean)
      return o
    })

    // Search narrows first; chip counts reflect the search, the status chip then filters.
    var q = view.q.trim().toLowerCase()
    var counts = { running: 0, idle: 0, done: 0, failed: 0 }
    var total = 0
    var shown = []
    projects.forEach(function (p) {
      var runs = []
      p.runs.forEach(function (run) {
        var runHit = !q || textHit(run.objective, q) || textHit(p.label, q) || textHit(run.id, q)
        var bySearch = runHit ? run.roots : filterNodes(run.roots, function (n) {
          return textHit(n.title, q) || textHit(n.model, q) || textHit(n.id, q)
        })
        walk(bySearch, function (n) { if (!n.ctx) { counts[n.phase]++; total++ } })
        var roots = view.status === 'all' ? bySearch : filterNodes(bySearch, function (n) { return !n.ctx && n.phase === view.status })
        if (roots.length) runs.push({ run: run, roots: roots })
      })
      if (runs.length) shown.push({ p: p, runs: runs })
    })
    drawChips(counts, total)

    if (!shown.length) {
      if (filtering() && projects.length) emptyState('nomatch')
      else if (view.mode === 'history' && (snap.knownProjects || []).length) emptyState('range')
      else emptyState('none')
      return
    }

    shown.forEach(function (sp) {
      var p = sp.p
      var key = 'p:' + p.key
      var pd = document.createElement('details')
      pd.className = 'proj'
      var pdef = p.counts.running + p.counts.idle > 0
      pd.open = filtering() || isOpen(key, pdef, false)
      remember(pd, key, pdef, false)
      var ps = document.createElement('summary')
      ps.innerHTML = '<span class="caret"></span><span class="pl">' + esc(p.label) + '</span>' +
        (p.host && p.host !== 'local' ? '<span class="pill host">' + esc(p.host) + '</span>' : '') +
        '<span class="pm">' + pills(p.counts, false) + '<span class="mut">' + esc(G.ago(p.lastActivityAt)) + '</span></span>'
      ps.title = (p.path || 'No workspace recorded') + '\nhost: ' + p.host + '\n' + p.runs.length + ' run' + (p.runs.length === 1 ? '' : 's')
      pd.appendChild(ps)

      sp.runs.forEach(function (sr, i) {
        var run = sr.run
        var live = run.counts.running + run.counts.idle > 0
        var rkey = 'r:' + run.host + ':' + run.id
        var def = live || run.counts.failed > 0 || view.mode === 'live' || i === 0
        var d = document.createElement('details')
        d.className = 'run' + (run.counts.failed ? ' has-failed' : '')
        var failed = run.counts.failed > 0
        d.open = filtering() || isOpen(rkey, def, failed)
        remember(d, rkey, def, failed)
        var s = document.createElement('summary')
        var dur = G.duration(runMs(run))
        var line = run.workers + ' worker' + (run.workers === 1 ? '' : 's') + ' · depth ' + run.depth + (dur ? ' · ' + (run.counts.running ? dur + ' so far' : dur + ' total') : '')
        s.innerHTML = '<div class="rh"><span class="t">' + esc(run.objective) + '</span><span class="mut">' + esc(G.ago(run.createdAt)) + '</span></div>' +
          '<div class="rs"><span class="mut">' + esc(line) + '</span><span class="c">' + pills(run.counts, true) + '</span></div>'
        s.title = run.objective + '\n' + run.id
        d.appendChild(s)
        var g = document.createElement('div')
        g.className = 'graph'
        g.appendChild(G.render(run, {
          roots: sr.roots,
          focus: focus,
          copy: copy,
          isOpen: function (k) { return !!view.nodes[k] },
          toggle: function (k) {
            if (view.nodes[k]) delete view.nodes[k]
            else view.nodes[k] = true
            draw(view.last)
          }
        }))
        d.appendChild(g)
        pd.appendChild(d)
      })
      app.appendChild(pd)
    })
  }

  function load() {
    if (!api || !api.plugin) return
    if (view.busy) { view.again = true; return }
    view.busy = true
    var range = view.mode === 'live' ? '7d' : view.range
    api.plugin.request('graph.read', { range: range, view: view.mode }, { timeoutMs: 20000 }).then(function (snap) {
      view.busy = false
      if (snap && Array.isArray(snap.runs) && snap.totals) draw(snap)
      else app.innerHTML = '<div class="err">' + esc((snap && snap.error) || 'No data from the worker') + '</div>'
      if (view.again) { view.again = false; load() }
    }, function (err) {
      view.busy = false
      if (view.again) { view.again = false; setTimeout(load, 500) }
      app.innerHTML = '<div class="err">' + esc((err && err.message) || 'Worker unavailable') + '</div>'
    })
  }

  function setMode(mode) {
    view.mode = mode
    var btns = document.querySelectorAll('.seg button')
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].dataset.view === mode)
    rangeSel.hidden = mode !== 'history'
    persist()
    load()
  }

  document.querySelector('.seg').addEventListener('click', function (ev) {
    var b = ev.target.closest('button')
    if (b) setMode(b.dataset.view)
  })
  rangeSel.value = view.range
  rangeSel.addEventListener('change', function () { view.range = rangeSel.value; persist(); load() })
  chipsEl.addEventListener('click', function (ev) {
    var b = ev.target.closest('button')
    if (!b) return
    view.status = b.dataset.s === view.status ? 'all' : b.dataset.s
    persist()
    if (view.last) draw(view.last)
  })
  var qt = 0
  searchEl.addEventListener('input', function () {
    clearTimeout(qt)
    qt = setTimeout(function () { view.q = searchEl.value; if (view.last) draw(view.last) }, 120)
  })
  searchEl.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && searchEl.value) { searchEl.value = ''; view.q = ''; if (view.last) draw(view.last) } })

  if (api && api.plugin) api.plugin.on('graph.changed', load)
  setMode(view.mode)
  // Running durations tick every second without a reload.
  setInterval(function () {
    if (document.hidden) return
    var els = document.querySelectorAll('.dur[data-start]')
    for (var i = 0; i < els.length; i++) els[i].textContent = G.duration(Date.now() - Number(els[i].dataset.start))
  }, 1000)
  // Relative times stay fresh even when nothing changed.
  setInterval(function () { if (!document.hidden) load() }, 15000)
})()
