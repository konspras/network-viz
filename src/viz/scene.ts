import { Container, Graphics, Text, Rectangle } from 'pixi.js'
import type { Layout, Snapshot, NodeDef, LinkDef, LinkSnapshot } from './types'

export function buildScene(root: Container, layout: Layout) {
  // screen-space grid layer (infinite grid) + world container
  const gridLayer = new Graphics()
  root.addChild(gridLayer)
  const world = new Container()
  root.addChild(world)
  // capture events on empty space and respond to wheel anywhere
  root.eventMode = 'static'
  const nodesLayer = new Container()
  const linksLayer = new Container()
  const packetsLayer = new Container()
  const labelsLayer = new Container()
  world.addChild(linksLayer, nodesLayer, packetsLayer, labelsLayer)

  const size = { width: 800, height: 600 }
  root.hitArea = new Rectangle(0, 0, size.width, size.height)
  const positions = new Map<string, { x: number; y: number }>()
  const nodeGfx = new Map<string, Graphics>()
  const linkGfx = new Map<string, Graphics>()
  const linkByEnds = new Map<string, LinkDef>()
  const torGeom = new Map<string, { left: number; right: number; top: number; bottom: number }>()
  const spineGeom = new Map<string, { left: number; right: number; top: number; bottom: number; anchors: Record<string, number> }>()
  const queueLabelLayer = new Container()
  labelsLayer.addChild(queueLabelLayer)
  const queueLabels = new Map<string, Text>()
  const queueLabelsUsed = new Set<string>()
  const hostLabelLayer = new Container()
  labelsLayer.addChild(hostLabelLayer)
  const hostLabels = new Map<string, Text>()

  const margin = 60
  const toPx = (n: NodeDef) => {
    const x = margin + n.x * Math.max(100, size.width - margin * 2)
    const y = margin + n.y * Math.max(100, size.height - margin * 2)
    return { x, y }
  }

  // Precompute positions
  for (const n of layout.nodes) {
    const p = toPx(n)
    positions.set(n.id, p)
    const g = new Graphics()
    nodesLayer.addChild(g)
    nodeGfx.set(n.id, g)
    if (n.type === 'host') {
      const label = new Text({
        text: `${n.metricsId}`,
        style: { fill: 0xf8fafc, fontSize: 12, fontWeight: '700', stroke: { color: 0x111827, width: 2 } },
        resolution: 3,
      })
      label.anchor.set(0.5)
      hostLabelLayer.addChild(label)
      hostLabels.set(n.id, label)
    }
  }
  for (const l of layout.links) {
    linkByEnds.set(l.id, l)
    const g = new Graphics()
    linksLayer.addChild(g)
    linkGfx.set(l.id, g)
  }

  // compute bounds of topology in world coords (include labels offset)
  function computeBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of positions.values()) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
    // also include tier label left margin
    const leftX = Math.min(...Array.from(positions.values()).map(p => p.x)) - 100
    minX = Math.min(minX, leftX)
    const pad = 60
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }
  }
  // Screen-filling grid that scrolls with pan/zoom (tile pattern)
  function drawGridScreen() {
    const gapWorld = 40
    const gapScreen = gapWorld * scale
    const w = size.width
    const h = size.height
    gridLayer.clear()
    gridLayer.rect(0, 0, w, h).fill({ color: 0x0e1013 })
    if (gapScreen < 4) return // too dense; skip lines
    const offsetX = ((world.position.x % gapScreen) + gapScreen) % gapScreen
    const offsetY = ((world.position.y % gapScreen) + gapScreen) % gapScreen
    gridLayer.stroke({ color: 0x1b2230, width: 1, alpha: 0.8 })
    for (let x = offsetX; x <= w; x += gapScreen) {
      gridLayer.moveTo(x, 0).lineTo(x, h)
    }
    for (let y = offsetY; y <= h; y += gapScreen) {
      gridLayer.moveTo(0, y).lineTo(w, y)
    }
    gridLayer.stroke()
  }

  const maxQueueKb = 1000

  const nodeColors = {
    host: 0x1f6feb,
    tor: 0x2563eb,
    spine: 0x0ea5e9,
    switch: 0x334155,
  }

  function nodeFillColor(node: NodeDef): number {
    if (node.type === 'host') return nodeColors.host
    if (node.id.startsWith('tor')) return nodeColors.tor
    if (node.id.startsWith('sp')) return nodeColors.spine
    return nodeColors.switch
  }

  function useQueueLabel(key: string, x: number, y: number, value: number) {
    let label = queueLabels.get(key)
    if (!label) {
      label = new Text({
        text: '',
        style: { fill: 0xf8fafc, fontSize: 11, fontWeight: '600' },
        resolution: 3,
      })
      label.anchor.set(0.5, 1)
      queueLabelLayer.addChild(label)
      queueLabels.set(key, label)
    }
    queueLabelsUsed.add(key)
    label.visible = true
    label.position.set(x, y)
    const rounded = Math.max(0, Math.round(value))
    label.text = `${rounded}`
  }

  function drawNode(id: string, queue: number, _timeSec: number, snapshot: Snapshot) {
    const n = layout.nodes.find((x) => x.id === id)!
    const p = positions.get(id)!
    const g = nodeGfx.get(id)!
    g.clear()
    const fill = nodeFillColor(n)
    const strokeW = 2 / scale
    const getLinkQueue = (link: LinkDef, sourceId: string) => {
      const snap = snapshot.links[link.id]
      if (!snap) return 0
      if (link.a === sourceId) return Math.max(0, snap.queueA ?? 0)
      if (link.b === sourceId) return Math.max(0, snap.queueB ?? 0)
      return 0
    }
    if (n.type === 'switch') {
      const isTor = id.startsWith('tor')
      if (isTor) {
        // Find servers connected to this ToR
        const serverIds: string[] = []
        for (const l of layout.links) {
          if (l.a === id) {
            const other = l.b
            const node = layout.nodes.find(nn => nn.id === other)
            if (node && node.type === 'host') serverIds.push(other)
          } else if (l.b === id) {
            const other = l.a
            const node = layout.nodes.find(nn => nn.id === other)
            if (node && node.type === 'host') serverIds.push(other)
          }
        }
        let left = p.x - 23, right = p.x + 23
        if (serverIds.length) {
          const xs = serverIds.map(sid => positions.get(sid)!.x)
          const minS = Math.min(...xs)
          const maxS = Math.max(...xs)
          const padX = 15
          left = minS - padX
          right = maxS + padX
        }
        const h = 44
        const top = p.y - h / 2
        const bottom = p.y + h / 2
        // Save geometry for link alignment
        torGeom.set(id, { left, right, top, bottom })
        // Draw ToR body
        g.roundRect(left, top, right - left, h, 4).fill({ color: fill, alpha: 0.95 }).stroke({ color: 0x0, width: strokeW, alpha: 0.5 })
        // Per-link egress queues inside ToR aligned over each server
        if (serverIds.length) {
          const labelY = top + 11
          const innerTop = labelY + 6
          const innerBottom = bottom - 4
          const innerHeight = Math.max(6, innerBottom - innerTop)
          // Determine reasonable bar width based on spacing
          const sorted = serverIds.map(sid => positions.get(sid)!.x).sort((a,b)=>a-b)
          let spacing = 10
          for (let i=1;i<sorted.length;i++) spacing = Math.max(spacing, sorted[i]-sorted[i-1])
          const barW = Math.min(10, Math.max(4, spacing * 0.35))
          for (const sid of serverIds) {
            const link = layout.links.find(l => (l.a === sid && l.b === id) || (l.b === sid && l.a === id))!
            const qLevel = getLinkQueue(link, id)
            const cx = Math.min(Math.max(positions.get(sid)!.x, left + 2), right - 2)
            const bx = cx - barW/2
            const by = innerBottom
            // background
            g.roundRect(bx, innerTop, barW, innerHeight, 2).fill({ color: 0x1e2430, alpha: 0.9 })
            // fill from bottom up
            const filledH = innerHeight * clamp01(qLevel / maxQueueKb)
            g.roundRect(bx, by - filledH, barW, filledH, 2).fill({ color: 0xffb020, alpha: 0.95 })
            useQueueLabel(`${id}:${sid}`, cx, labelY, Math.min(qLevel, maxQueueKb))
          }
        }
      } else {
        // Spine rectangle widened to ToR span with per-link queues to ToRs
        const torIds = layout.nodes.filter(nn => nn.id.startsWith('tor')).map(nn => nn.id)
        const torXs = torIds.map(id => positions.get(id)!.x)
        const torMin = Math.min(...torXs)
        const torMax = Math.max(...torXs)
        const span = Math.max(120, torMax - torMin + 60)
        const width = span / Math.max(1, torIds.length)
        const left = p.x - width / 2
        const right = p.x + width / 2
        const h = 42
        const top = p.y - h / 2
        const bottom = p.y + h / 2
        g.roundRect(left, top, right - left, h, 4).fill({ color: fill, alpha: 0.95 }).stroke({ color: 0x0, width: strokeW, alpha: 0.5 })

        const sortedTorIds = torIds.slice().sort((a, b) => positions.get(a)!.x - positions.get(b)!.x)
        const spanWidth = right - left
        const marginX = Math.min(28, Math.max(10, spanWidth * 0.12))
        const usableWidth = Math.max(0, spanWidth - marginX * 2)
        const anchors: Record<string, number> = {}

        if (sortedTorIds.length === 1) {
          anchors[sortedTorIds[0]] = left + spanWidth / 2
        } else if (usableWidth <= 0) {
          sortedTorIds.forEach((tid) => {
            anchors[tid] = left + spanWidth / 2
          })
        } else {
          sortedTorIds.forEach((tid, idx) => {
            const t = sortedTorIds.length === 1 ? 0.5 : idx / (sortedTorIds.length - 1)
            anchors[tid] = left + marginX + usableWidth * t
          })
        }

        spineGeom.set(id, { left, right, top, bottom, anchors })

        // queues aligned above each ToR using shared anchors
        const barWidth = Math.min(16, Math.max(6, usableWidth / Math.max(1, sortedTorIds.length)))
        const labelY = top + 10
        const innerTop = labelY + 6
        const innerBottom = bottom - 4
        const innerHeight = Math.max(6, innerBottom - innerTop)
        sortedTorIds.forEach((tid) => {
          const link = layout.links.find(l => (l.a === tid && l.b === id) || (l.b === tid && l.a === id))
          const anchorCenter = anchors[tid] ?? (left + spanWidth / 2)
          const safeCenter = Math.min(Math.max(anchorCenter, left + barWidth / 2 + 4), right - barWidth / 2 - 4)
          const barLeft = safeCenter - barWidth / 2
          const qLevel = link ? getLinkQueue(link, id) : 0
          g.roundRect(barLeft, innerTop, barWidth, innerHeight, 2).fill({ color: 0x1e2430, alpha: 0.9 })
          const filledH = innerHeight * clamp01(qLevel / maxQueueKb)
          g.roundRect(barLeft, innerBottom - filledH, barWidth, filledH, 2).fill({ color: 0x2dd4bf, alpha: 0.95 })
          useQueueLabel(`${id}:${tid}`, safeCenter, labelY, Math.min(qLevel, maxQueueKb))
        })
      }
    } else {
      const radius = 10
  g.circle(p.x, p.y, radius).fill({ color: fill, alpha: 0.95 }).stroke({ color: 0x0, width: strokeW, alpha: 0.4 })
      // queue bar underneath
      const barW = 34
      const barH = 5
      const bx = p.x - barW / 2
      const by = p.y + radius + 6
      g.roundRect(bx, by, barW, barH, 3).fill({ color: 0x2a2e35, alpha: 0.8 })
      g.roundRect(bx, by, barW * clamp01(queue / maxQueueKb), barH, 3).fill({ color: 0xff9f43, alpha: 0.9 })
      const label = hostLabels.get(id)
      if (label) {
        label.visible = true
        label.position.set(p.x, p.y)
      }
    }
    // no per-node label
  }

  function drawLink(id: string, usage: LinkSnapshot | undefined) {
    const l = linkByEnds.get(id)!
    let a = positions.get(l.a)!
    let b = positions.get(l.b)!
    const g = linkGfx.get(id)!
    g.clear()

    const aNode = layout.nodes.find(n => n.id === l.a)!
    const bNode = layout.nodes.find(n => n.id === l.b)!

    const rawAB = Math.max(0, usage?.aToB ?? 0)
    const rawBA = Math.max(0, usage?.bToA ?? 0)

    const linkCapacityGbps = () => {
      const kinds = `${aNode.metricsKind}-${bNode.metricsKind}`
      if (kinds.includes('host')) return 100
      return 800
    }

    const cap = linkCapacityGbps()
    const normAB = clamp01(cap > 0 ? rawAB / cap : 0)
    const normBA = clamp01(cap > 0 ? rawBA / cap : 0)

    // If tor-host link, start at bottom edge of ToR aligned to server x
    const hostRadius = 10
    if (aNode.type === 'switch' && aNode.id.startsWith('tor') && bNode.type === 'host') {
      const geom = torGeom.get(aNode.id)
      if (geom) {
        const x = Math.min(Math.max(b.x, geom.left + 2), geom.right - 2)
        a = { x, y: geom.bottom }
        b = { x: b.x, y: b.y - hostRadius }
      }
    } else if (bNode.type === 'switch' && bNode.id.startsWith('tor') && aNode.type === 'host') {
      const geom = torGeom.get(bNode.id)
      if (geom) {
        const x = Math.min(Math.max(a.x, geom.left + 2), geom.right - 2)
        b = { x, y: geom.bottom }
        a = { x: a.x, y: a.y - hostRadius }
      }
    } else if (aNode.type === 'switch' && aNode.id.startsWith('sp') && bNode.id.startsWith('tor')) {
      const targetX = positions.get(bNode.id)!.x
      const spine = spineGeom.get(aNode.id)
      const tor = torGeom.get(bNode.id)
      if (spine) {
        const anchor = spine.anchors[bNode.id]
        const startX = anchor !== undefined ? anchor : Math.min(Math.max(targetX, spine.left + 4), spine.right - 4)
        a = { x: startX, y: spine.bottom }
      } else {
        a = { x: a.x, y: a.y + 16 }
      }
      if (tor) {
        const endX = (tor.left + tor.right) / 2
        b = { x: endX, y: tor.top }
      } else {
        b = { x: targetX, y: b.y - 16 }
      }
    } else if (bNode.type === 'switch' && bNode.id.startsWith('sp') && aNode.id.startsWith('tor')) {
      const targetX = positions.get(aNode.id)!.x
      const spine = spineGeom.get(bNode.id)
      const tor = torGeom.get(aNode.id)
      if (spine) {
        const anchor = spine.anchors[aNode.id]
        const endX = anchor !== undefined ? anchor : Math.min(Math.max(targetX, spine.left + 4), spine.right - 4)
        b = { x: endX, y: spine.bottom }
      } else {
        b = { x: b.x, y: b.y + 16 }
      }
      if (tor) {
        const startX = (tor.left + tor.right) / 2
        a = { x: startX, y: tor.top }
      } else {
        a = { x: targetX, y: a.y - 16 }
      }
    }

    // Center guide for context
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const nx = (-dy / len)
    const ny = (dx / len)
    const separation = 4 / scale

    const forwardStart = { x: a.x + nx * separation, y: a.y + ny * separation }
    const forwardEnd = { x: b.x + nx * separation, y: b.y + ny * separation }
    const reverseStart = { x: b.x - nx * separation, y: b.y - ny * separation }
    const reverseEnd = { x: a.x - nx * separation, y: a.y - ny * separation }

    const widthAB = (0.8 + 5 * normAB) / scale
    const widthBA = (0.8 + 5 * normBA) / scale

    const colorFor = (u: number) => {
      if (u <= 0.01) return 0x374151
      if (u < 0.6) return lerpColor(0x22c55e, 0xf97316, (u - 0.01) / 0.59)
      return lerpColor(0xf97316, 0xef4444, (u - 0.6) / 0.4)
    }

    const colorAB = colorFor(normAB)
    const colorBA = colorFor(normBA)

    g.moveTo(forwardStart.x, forwardStart.y).lineTo(forwardEnd.x, forwardEnd.y).stroke({ width: widthAB, color: colorAB, alpha: 0.95, cap: 'round' })
    g.moveTo(reverseStart.x, reverseStart.y).lineTo(reverseEnd.x, reverseEnd.y).stroke({ width: widthBA, color: colorBA, alpha: 0.95, cap: 'round' })

    drawArrowhead(forwardStart, forwardEnd, colorAB, normAB)
    drawArrowhead(reverseStart, reverseEnd, colorBA, normBA)

    function drawArrowhead(from: { x: number; y: number }, to: { x: number; y: number }, color: number, magnitude: number) {
      const arrowLen = (9 + 5 * magnitude) / scale
      const arrowWidth = arrowLen * 0.6
      const angle = Math.atan2(to.y - from.y, to.x - from.x)
      const backX = to.x - Math.cos(angle) * arrowLen
      const backY = to.y - Math.sin(angle) * arrowLen
      const leftX = backX + Math.cos(angle + Math.PI / 2) * arrowWidth
      const leftY = backY + Math.sin(angle + Math.PI / 2) * arrowWidth
      const rightX = backX + Math.cos(angle - Math.PI / 2) * arrowWidth
      const rightY = backY + Math.sin(angle - Math.PI / 2) * arrowWidth
      g.moveTo(to.x, to.y)
      g.lineTo(leftX, leftY)
      g.lineTo(rightX, rightY)
      g.closePath()
      g.fill({ color, alpha: 0.95 })
    }
  }

  // Packets removed

  function update(snapshot: Snapshot) {
    queueLabelsUsed.clear()
    for (const label of hostLabels.values()) label.visible = false
    for (const l of layout.links) {
      drawLink(l.id, snapshot.links[l.id])
    }
    for (const n of layout.nodes) {
      const q = snapshot.nodes[n.id]?.queue ?? 0
      drawNode(n.id, q, snapshot.t, snapshot)
    }
    for (const [key, label] of queueLabels) {
      if (!queueLabelsUsed.has(key)) {
        label.visible = false
      }
    }
    // no packet movement
  }

  function reset() {
    // nothing to reset (packets removed)
  }

  function layoutResize(w: number, h: number) {
    size.width = w
    size.height = h
    root.hitArea = new Rectangle(0, 0, size.width, size.height)
    // Recompute projected positions
    for (const n of layout.nodes) {
      const p = toPx(n)
      positions.set(n.id, p)
      const hostLabel = hostLabels.get(n.id)
      if (hostLabel) {
        hostLabel.position.set(p.x, p.y)
      }
    }
    placeTierLabels()
    drawGridScreen()
    // Update min zoom to fit entire topology
    const { minX, minY, maxX, maxY } = computeBounds()
    const worldW = maxX - minX
    const worldH = maxY - minY
    const fitScale = Math.min(size.width / worldW, size.height / worldH)
    minScale = Math.min(1, fitScale)
    // Clamp/adjust current zoom and center the world
    scale = Math.max(scale, minScale)
    world.scale.set(scale)
    const worldCenterX = (minX + maxX) / 2
    const worldCenterY = (minY + maxY) / 2
    const viewCenterX = size.width / 2
    const viewCenterY = size.height / 2
    world.position.set(viewCenterX - worldCenterX * scale, viewCenterY - worldCenterY * scale)
    clampWorld()
    drawGridScreen()
  }

  // Tier labels: part of the world (terrain-like), increase resolution for crisp zoom
  const tierLabels = {
    servers: new Text({ text: 'Servers', style: { fill: 0x9aa4b2, fontSize: 18 }, resolution: 4 }),
    tors: new Text({ text: 'ToRs', style: { fill: 0x9aa4b2, fontSize: 18 }, resolution: 4 }),
    spines: new Text({ text: 'Spines', style: { fill: 0x9aa4b2, fontSize: 18 }, resolution: 4 }),
  }
  labelsLayer.addChild(tierLabels.spines, tierLabels.tors, tierLabels.servers)

  function placeTierLabels() {
    const spNodes = layout.nodes.filter(n => n.id.startsWith('sp')).map(n => positions.get(n.id)!)
    const torNodes = layout.nodes.filter(n => n.id.startsWith('tor')).map(n => positions.get(n.id)!)
    const srvNodes = layout.nodes.filter(n => n.type === 'host').map(n => positions.get(n.id)!)
    const spY = avg(spNodes.map(p => p.y))
    const torY = avg(torNodes.map(p => p.y))
    const srvY = avg(srvNodes.map(p => p.y))
    const leftSp = Math.min(...spNodes.map(p => p.x))
    const leftTor = Math.min(...torNodes.map(p => p.x))
    const leftSrv = Math.min(...srvNodes.map(p => p.x))
    const leftX = Math.min(leftSp, leftTor, leftSrv) - 90
    tierLabels.spines.position.set(leftX, spY - 8)
    tierLabels.tors.position.set(leftX, torY - 8)
    tierLabels.servers.position.set(leftX, srvY - 8)
  }
  function avg(arr: number[]) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0 }
  placeTierLabels()

  // Zoom & pan interactions
  let scale = 1
  let minScale = 0.2
  const maxScale = 6
  let dragging = false
  let lastX = 0, lastY = 0

  // Clamp view to extended bounds (finite background larger than topology)
  const clampPad = 120
  function getClampBounds() {
    const b = computeBounds()
    return { minX: b.minX - clampPad, minY: b.minY - clampPad, maxX: b.maxX + clampPad, maxY: b.maxY + clampPad }
  }
  function clampWorld() {
    const b = getClampBounds()
    const minPosX = size.width - scale * b.maxX
    const maxPosX = -scale * b.minX
    const minPosY = size.height - scale * b.maxY
    const maxPosY = -scale * b.minY
    if (minPosX <= maxPosX) {
      world.position.x = Math.min(Math.max(world.position.x, minPosX), maxPosX)
    } else {
      const worldCenterX = (b.minX + b.maxX) / 2
      world.position.x = size.width / 2 - worldCenterX * scale
    }
    if (minPosY <= maxPosY) {
      world.position.y = Math.min(Math.max(world.position.y, minPosY), maxPosY)
    } else {
      const worldCenterY = (b.minY + b.maxY) / 2
      world.position.y = size.height / 2 - worldCenterY * scale
    }
  }

  // Attach to root's parent stage interaction through root as container is not interactive by default
  root.eventMode = 'static'
  root.on('wheel', (e: any) => {
    e.preventDefault?.()
    e.stopPropagation?.()
    // smooth exponential zoom
    const zoom = Math.exp(-e.deltaY * 0.0015)
    const oldScale = scale
  scale = Math.min(maxScale, Math.max(minScale, scale * zoom))
    const factor = scale / oldScale
    // zoom towards mouse point: adjust world position
    const mx = e.globalX
    const my = e.globalY
    world.position.x = mx - (mx - world.position.x) * factor
    world.position.y = my - (my - world.position.y) * factor
    world.scale.set(scale)
    clampWorld()
    drawGridScreen()
  })
  root.on('pointerdown', (e: any) => { dragging = true; lastX = e.globalX; lastY = e.globalY; e.stopPropagation?.() })
  root.on('pointerup', () => { dragging = false })
  root.on('pointerupoutside', () => { dragging = false })
  root.on('pointermove', (e: any) => {
    if (!dragging) return
    const dx = e.globalX - lastX
    const dy = e.globalY - lastY
    world.position.x += dx
    world.position.y += dy
    lastX = e.globalX
    lastY = e.globalY
    clampWorld()
    drawGridScreen()
  })

  // Initial grid
  drawGridScreen()

  return { update, reset, layoutResize }
}

function clamp01(x: number) { return Math.min(1, Math.max(0, x)) }

function lerpColor(a: number, b: number, t: number) {
  t = clamp01(t)
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff
  const r = Math.round(ar + (br - ar) * t)
  const g = Math.round(ag + (bg - ag) * t)
  const bl = Math.round(ab + (bb - ab) * t)
  return (r << 16) | (g << 8) | bl
}
