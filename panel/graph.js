// Left-to-right tree layout drawn as SVG: coordinator -> workers -> nested workers.
// Exposes window.SGGraph.render(run, onNodeClick) -> SVGElement.
;(function () {
  var NS = 'http://www.w3.org/2000/svg'
  var H = 40 // node height
  var GY = 10 // vertical gap between leaves
  var PAD = 8

  function el(name, attrs, parent) {
    var n = document.createElementNS(NS, name)
    for (var k in attrs) n.setAttribute(k, attrs[k])
    if (parent) parent.appendChild(n)
    return n
  }

  function clip(text, max) {
    text = String(text || '')
    return text.length > max ? text.slice(0, max - 1) + '…' : text
  }

  function ago(iso) {
    if (typeof iso !== 'string' || !iso) return ''
    var t = Date.parse(iso.indexOf('T') > 0 ? iso : iso.replace(' ', 'T') + 'Z')
    if (!isFinite(t)) return ''
    var s = Math.max(0, (Date.now() - t) / 1000)
    if (s < 60) return Math.round(s) + 's ago'
    if (s < 3600) return Math.round(s / 60) + 'm ago'
    if (s < 86400) return Math.round(s / 3600) + 'h ago'
    return Math.round(s / 86400) + 'd ago'
  }

  var IND = 22 // indent per nesting level
  // Indented tree: one row per node in depth-first order, so any depth fits a narrow sidebar.
  function layout(root, width) {
    var row = 0
    var maxDepth = 0
    function place(n, depth) {
      maxDepth = Math.max(maxDepth, depth)
      n._x = PAD + depth * IND
      n._y = PAD + row * (H + GY)
      n._w = Math.max(150, width - n._x - PAD)
      row++
      var kids = n.children || []
      for (var i = 0; i < kids.length; i++) place(kids[i], depth + 1)
    }
    place(root, 0)
    return { width: Math.max(width, PAD + maxDepth * IND + 150 + PAD), height: PAD * 2 + row * (H + GY) - GY }
  }

  function render(run, onClick, width) {
    var root = {
      id: '__coord__' + run.id,
      root: true,
      title: 'Coordinator',
      sub: run.coordinator ? clip(run.coordinator, 30) : 'main agent',
      children: run.roots
    }
    var size = layout(root, Math.max(220, width || 320))
    var svg = el('svg', { width: size.width, height: size.height, viewBox: '0 0 ' + size.width + ' ' + size.height })
    var links = el('g', {}, svg)
    var nodes = el('g', {}, svg)

    ;(function draw(n) {
      var kids = n.children || []
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i]
        var x1 = n._x + 12, y1 = n._y + H, y2 = c._y + H / 2, x2 = c._x
        el('path', {
          d: 'M' + x1 + ',' + y1 + ' V' + (y2 - 6) + ' Q' + x1 + ',' + y2 + ' ' + (x1 + 6) + ',' + y2 + ' H' + x2,
          class: 'link' + (c.phase === 'running' ? ' live' : '')
        }, links)
        draw(c)
      }
      var g = el('g', {
        class: 'node ' + (n.root ? 'root' : n.phase) + (!n.root && n.terminal && n.phase !== 'done' ? ' clickable' : ''),
        transform: 'translate(' + n._x + ',' + n._y + ')'
      }, nodes)
      el('rect', { width: n._w, height: H, rx: 7 }, g)
      if (!n.root) {
        var cx = 12, cy = H / 2
        if (n.phase === 'running') el('circle', { cx: cx, cy: cy, r: 4, class: 'ring' }, g)
        el('circle', { cx: cx, cy: cy, r: 4, fill: 'var(--' + n.phase + ')' }, g)
      }
      var tx = n.root ? 10 : 24
      var title = el('text', { x: tx, y: 16, class: 'title' }, g)
      var chars = Math.floor((n._w - tx - 8) / 6.6)
      title.textContent = clip(n.title, chars)
      var sub = el('text', { x: tx, y: 31, class: 'sub' }, g)
      if (n.root) {
        sub.textContent = clip(n.sub, Math.floor((n._w - tx - 8) / 5.8))
      } else {
        var bits = [n.agent || 'agent']
        if (n.model) bits.push(n.model)
        bits.push(n.phase === 'running' ? 'started ' + ago(n.createdAt) : ago(n.completedAt || n.createdAt))
        if (n.followUps) bits.push('+' + n.followUps + ' follow-up' + (n.followUps > 1 ? 's' : ''))
        sub.textContent = clip(bits.join(' · '), Math.floor((n._w - tx - 8) / 5.8))
      }
      var tip = el('title', {}, g)
      tip.textContent = n.root
        ? 'Coordinator ' + (run.coordinator || '')
        : n.title + '\n' + n.id + '\nstate: ' + n.phase + ' (' + n.status + ')' + (n.terminal ? '\nterminal: ' + n.terminal : '')
      if (!n.root && n.terminal && n.phase !== 'done') {
        g.addEventListener('click', function () { onClick(n) })
      }
    })(root)
    return svg
  }

  window.SGGraph = { render: render, ago: ago }
})()
