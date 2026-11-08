;(function () {
  var api = window.orca
  var Graph = window.SGGraph
  var app = document.getElementById('app')
  var summary = document.getElementById('summary')
  var rangeSel = document.getElementById('range')
  var toastEl = document.getElementById('toast')
  var view = { mode: 'live', range: '7d', busy: false, again: false, open: {} }
  try {
    var saved = JSON.parse(localStorage.getItem('sg.view') || '{}')
    if (saved.mode) view.mode = saved.mode
    if (saved.range) view.range = saved.range
    if (saved.open) view.open = saved.open
  } catch (e) {}

  function persist() {
    var ids = Object.keys(view.open)
    if (ids.length > 200) ids.slice(0, ids.length - 200).forEach(function (k) { delete view.open[k] })
    try { localStorage.setItem('sg.view', JSON.stringify({ mode: view.mode, range: view.range, open: view.open })) } catch (e) {}
  }

  function toast(text) {
    toastEl.textContent = text
    toastEl.hidden = false
    clearTimeout(toast.t)
    toast.t = setTimeout(function () { toastEl.hidden = true }, 3500)
  }

  function liveRuns(snap) {
    var live = snap.runs.filter(function (r) { return r.counts.running + r.counts.idle > 0 })
    if (snap.runs[0] && live.indexOf(snap.runs[0]) < 0) live.push(snap.runs[0])
    return live.sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1 })
  }

  function focus(node) {
    api.plugin.request('terminal.focus', { terminal: node.terminal, host: node.host }, { timeoutMs: 8000 }).then(function (r) {
      if (!r || !r.ok) toast((r && r.reason) || 'Could not open that terminal')
    }, function () { toast('Could not open that terminal') })
  }

  function pills(c) {
    var out = ''
    if (c.running) out += '<span class="pill running">' + c.running + ' running</span>'
    if (c.idle) out += '<span class="pill idle">' + c.idle + ' idle</span>'
    if (c.failed) out += '<span class="pill failed">' + c.failed + ' failed</span>'
    if (c.done) out += '<span class="pill">' + c.done + ' done</span>'
    return out
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] })
  }

  function draw(snap) {
    app.textContent = ''
    if (snap.error) {
      var e = document.createElement('div')
      e.className = 'err'
      e.textContent = snap.error
      app.appendChild(e)
    }
    var t = snap.totals
    summary.textContent = (t.running + t.idle) + ' subagent' + (t.running + t.idle === 1 ? '' : 's') + ' · ' + t.running + ' running'
    var runs = view.mode === 'live' ? liveRuns(snap) : snap.runs
    if (!runs.length) {
      var em = document.createElement('div')
      em.className = 'empty'
      em.textContent = view.mode === 'live' ? 'No orchestration workers yet.' : 'No runs in this range.'
      app.appendChild(em)
      return
    }
    runs.forEach(function (run, i) {
      var d = document.createElement('details')
      d.className = 'run'
      var live = run.counts.running + run.counts.idle > 0
      var def = view.mode === 'live' || live || i === 0
      d.open = run.id in view.open ? view.open[run.id] : def
      setTimeout(function () {
        d.addEventListener('toggle', function () {
          if (d.open === def) delete view.open[run.id]
          else view.open[run.id] = d.open
          persist()
        })
      }, 0)
      var s = document.createElement('summary')
      s.innerHTML = '<span class="t">' + esc(run.objective) + '</span>' + (run.host && run.host !== 'local' ? '<span class="pill">' + esc(run.host) + '</span>' : '') + '<span class="mut">' + esc(Graph.ago(run.createdAt)) + '</span><span class="c">' + pills(run.counts) + '</span>'
      s.title = run.id
      d.appendChild(s)
      var g = document.createElement('div')
      g.className = 'graph'
      g.appendChild(Graph.render(run, focus, (app.clientWidth || 320) - 30))
      d.appendChild(g)
      app.appendChild(d)
    })
  }

  function load() {
    if (!api || !api.plugin) return
    if (view.busy) { view.again = true; return }
    view.busy = true
    var range = view.mode === 'live' ? '7d' : view.range
    api.plugin.request('graph.read', { range: range }, { timeoutMs: 20000 }).then(function (snap) {
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

  if (api && api.plugin) api.plugin.on('graph.changed', load)
  setMode(view.mode)
  var lastW = 0
  window.addEventListener('resize', function () { var w = app.clientWidth; if (Math.abs(w - lastW) > 20) { lastW = w; load() } })
  // Relative times and running pulses stay fresh even when nothing changed.
  setInterval(function () { if (!document.hidden) load() }, 15000)
})()
