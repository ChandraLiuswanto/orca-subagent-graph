// Indented tree as nested HTML lists: coordinator -> workers -> nested workers. Any depth fits a
// narrow sidebar, and a node's details expand inline under it.
// Exposes window.SGGraph = { render, ago, duration, toMs, glyph, nodeMs, esc }.
;(function () {
  function toMs(v) {
    if (typeof v === 'number') return v
    if (typeof v !== 'string' || !v) return NaN
    return Date.parse(v.indexOf('T') > 0 ? v : v.replace(' ', 'T') + 'Z')
  }

  function ago(v) {
    var t = toMs(v)
    if (!isFinite(t)) return ''
    var s = Math.max(0, (Date.now() - t) / 1000)
    if (s < 60) return Math.round(s) + 's ago'
    if (s < 3600) return Math.round(s / 60) + 'm ago'
    if (s < 86400) return Math.round(s / 3600) + 'h ago'
    return Math.round(s / 86400) + 'd ago'
  }

  // Same output as formatDuration in src/model.ts.
  function duration(ms) {
    if (!isFinite(ms) || ms < 0) return ''
    var s = Math.floor(ms / 1000)
    if (s < 60) return s + 's'
    var m = Math.floor(s / 60)
    if (m < 60) return m + 'm ' + (s % 60) + 's'
    var h = Math.floor(m / 60)
    if (h < 24) return h + 'h ' + (m % 60 < 10 ? '0' : '') + (m % 60) + 'm'
    return Math.floor(h / 24) + 'd ' + (h % 24) + 'h'
  }

  /** Running: elapsed so far. Settled: completed - created. */
  function nodeMs(n, now) {
    var start = toMs(n.createdAt)
    return n.phase === 'running' ? (now === undefined ? Date.now() : now) - start : toMs(n.completedAt) - start
  }

  function fmtTime(v) {
    var t = toMs(v)
    return isFinite(t) ? new Date(t).toLocaleString() : '—'
  }

  // One glyph per phase next to the coloured dot, so state never relies on colour alone.
  var GLYPHS = {
    running: '<svg class="gl spin" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5a4.5 4.5 0 1 1-4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    idle: '<svg class="gl" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5v7M8 2.5v7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    done: '<svg class="gl" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.2 6.4l2.4 2.4 5.2-5.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    failed: '<svg class="gl" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'
  }
  function glyph(phase) {
    return '<span class="st ' + esc(phase) + '"><i class="dot ' + esc(phase) + '"></i>' + (GLYPHS[phase] || '') + '</span>'
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] })
  }

  function h(tag, cls, html) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (html != null) n.innerHTML = html
    return n
  }

  function detail(n, opts) {
    var d = h('div', 'detail')
    var rows = [
      ['Dispatch', '<code>' + esc(n.id) + '</code><button class="copy" data-copy="' + esc(n.id) + '" title="Copy dispatch id">Copy</button>'],
      ['Task', n.taskId ? '<code>' + esc(n.taskId) + '</code>' : '—'],
      ['Terminal', n.terminal ? '<code>' + esc(n.terminal) + '</code>' : '—'],
      ['Agent', esc(n.agent || 'agent') + (n.model ? ' · ' + esc(n.model) : '')],
      ['Created', esc(fmtTime(n.createdAt))],
      ['Completed', n.phase === 'running' ? 'still running' : esc(fmtTime(n.completedAt))],
      ['Duration', esc(duration(nodeMs(n)) || '—')],
      ['Follow-ups', esc(n.followUps || 0)]
    ]
    if (n.host && n.host !== 'local') rows.push(['Host', esc(n.host)])
    var dl = h('dl')
    rows.forEach(function (r) { dl.innerHTML += '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>' })
    d.appendChild(dl)
    if (n.terminal && (n.phase === 'running' || n.phase === 'idle')) {
      var b = h('button', 'focus', 'Focus terminal')
      b.addEventListener('click', function (ev) { ev.stopPropagation(); opts.focus(n) })
      d.appendChild(b)
    }
    d.addEventListener('click', function (ev) {
      var c = ev.target.closest('.copy')
      if (c) { ev.stopPropagation(); opts.copy(c.dataset.copy) }
    })
    return d
  }

  function nodeLi(n, opts) {
    var li = h('li', n.phase + (n.ctx ? ' ctx' : ''))
    var key = (n.host || '') + ':' + n.id
    var open = opts.isOpen(key)
    var card = h('div', 'card ' + n.phase)
    card.setAttribute('role', 'button')
    card.setAttribute('tabindex', '0')
    card.setAttribute('aria-expanded', open ? 'true' : 'false')
    card.dataset.key = key
    var bits = ['<span class="ph">' + esc(n.phase) + '</span>']
    var ms = nodeMs(n)
    if (n.phase === 'running') bits.push('<span class="dur" data-start="' + esc(toMs(n.createdAt)) + '">' + esc(duration(ms)) + '</span>')
    else if (duration(ms)) bits.push('<span class="dur">' + esc(duration(ms)) + '</span>')
    bits.push(esc(n.agent || 'agent'))
    if (n.model) bits.push(esc(n.model))
    if (n.followUps) bits.push('+' + esc(n.followUps) + ' follow-up' + (n.followUps > 1 ? 's' : ''))
    card.innerHTML = glyph(n.phase) + '<div class="txt"><div class="title">' + esc(n.title) + '</div><div class="sub">' + bits.join(' · ') + '</div></div>'
    card.title = n.title + '\n' + n.id + '\nstate: ' + n.phase + ' (' + n.status + ')\n' +
      (n.phase === 'running' ? 'started ' + ago(n.createdAt) : (n.completedAt ? 'finished ' + ago(n.completedAt) : 'started ' + ago(n.createdAt)))
    function toggle() { opts.toggle(key) }
    card.addEventListener('click', toggle)
    card.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle() } })
    li.appendChild(card)
    if (open) li.appendChild(detail(n, opts))
    if (n.children && n.children.length) li.appendChild(list(n.children, opts))
    return li
  }

  function list(nodes, opts) {
    var ul = h('ul')
    nodes.forEach(function (c) { ul.appendChild(nodeLi(c, opts)) })
    return ul
  }

  /** opts: { roots, focus(node), copy(text), isOpen(key), toggle(key) } */
  function render(run, opts) {
    var tree = h('ul', 'tree')
    var li = h('li', 'root')
    var card = h('div', 'card root', '<div class="txt"><div class="title">Coordinator</div><div class="sub">' + esc(run.coordinator || 'main agent') + '</div></div>')
    card.title = 'Coordinator ' + (run.coordinator || '')
    li.appendChild(card)
    var roots = opts.roots || run.roots
    if (roots.length) li.appendChild(list(roots, opts))
    tree.appendChild(li)
    return tree
  }

  window.SGGraph = { render: render, ago: ago, duration: duration, toMs: toMs, glyph: glyph, nodeMs: nodeMs, esc: esc }
})()
