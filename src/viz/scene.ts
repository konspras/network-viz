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
  const worldSize = { width: 1400, height: 880 }
  root.hitArea = new Rectangle(0, 0, size.width, size.height)
  const positions = new Map<string, { x: number; y: number }>()
  const nodeGfx = new Map<string, Graphics>()
  const linkGfx = new Map<string, Graphics>()
  const linkByEnds = new Map<string, LinkDef>()
  const torGeom = new Map<string, { left: number; right: number; top: number; bottom: number; spineAnchors: Record<string, number> }>()
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
    const usableWidth = Math.max(100, worldSize.width - margin * 2)
    const usableHeight = Math.max(100, worldSize.height - margin * 2)
    const x = margin + n.x * usableWidth
    const y = margin + n.y * usableHeight
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
    gridLayer.rect(0, 0, w, h).fill({ color: 0xffffff })
    if (gapScreen < 4) return // too dense; skip lines
    const offsetX = ((world.position.x % gapScreen) + gapScreen) % gapScreen
    const offsetY = ((world.position.y % gapScreen) + gapScreen) % gapScreen
    gridLayer.stroke({ color: 0x1a0000, width: 0.5, alpha: 0.08 })
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
    host: 0x1f2937,
    tor: 0x4b5563,
    spine: 0x6b7280,
    switch: 0x374151,
  }

  const colorForLinkUsage = (u: number) => {
    const value = clamp01(u)
    if (value <= 0.01) return 0xcbd5e1
    if (value < 0.6) return lerpColor(0x22c55e, 0xf97316, (value - 0.01) / 0.59)
    return lerpColor(0xf97316, 0xef4444, (value - 0.6) / 0.4)
  }

  const colorForQueueUsage = (u: number) => {
    const value = clamp01(u)
    if (value <= 0.0) return 0xffe0b8
    if (value < 0.6) return lerpColor(0xffc777, 0xf97316, value / 0.6)
    return lerpColor(0xf97316, 0xef4444, (value - 0.6) / 0.4)
  }

  function nodeFillColor(node: NodeDef): number {
    if (node.type === 'host') return nodeColors.host
    if (node.id.startsWith('tor')) return nodeColors.tor
    if (node.id.startsWith('sp')) return nodeColors.spine
    return nodeColors.switch
  }

  function useQueueLabel(key: string, x: number, y: number, value: number, anchorY = 1) {
    let label = queueLabels.get(key)
    if (!label) {
      label = new Text({
        text: '',
        style: { fill: 0xf8fafc, fontSize: 11, fontWeight: '600' },
        resolution: 3,
      })
      queueLabelLayer.addChild(label)
      queueLabels.set(key, label)
    }
    queueLabelsUsed.add(key)
    label.visible = true
    label.anchor.set(0.5, anchorY)
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
    const strokeW = 2
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
          const padX = 26
          left = minS - padX
          right = maxS + padX
        }
        const torBaseHeight = 56
        const h = torBaseHeight * 2
        const top = p.y - h / 2
        const bottom = p.y + h / 2
        // Save geometry for link alignment
        const torState = { left, right, top, bottom, spineAnchors: {} as Record<string, number> }
        torGeom.set(id, torState)
        // Draw ToR body
        g.roundRect(left, top, right - left, h, 4).fill({ color: fill }).stroke({ color: 0x0, width: strokeW })
        // Per-link egress queues inside ToR aligned over each server
        if (serverIds.length) {
          const spineLinks = layout.links
            .filter((l) => (l.a === id && l.b.startsWith('sp')) || (l.b === id && l.a.startsWith('sp')))
            .map((link) => {
              const other = link.a === id ? link.b : link.a
              return { link, spineId: other, x: positions.get(other)?.x ?? p.x }
            })
            .sort((a, b) => a.x - b.x)

          const innerTop = top + 18
          const innerBottom = bottom - 18
          const innerHeightRaw = Math.max(42, innerBottom - innerTop)
          let rowGap = Math.min(14, Math.max(8, innerHeightRaw * 0.2))
          let rowHeight = (innerHeightRaw - rowGap) / 2
          if (rowHeight < 14) {
            rowHeight = 14
            rowGap = Math.max(6, innerHeightRaw - rowHeight * 2)
          }
          const spineRowTop = innerTop
          const hostRowTop = innerBottom - rowHeight

          const drawQueueBar = (
            centerX: number,
            barWidth: number,
            rowTop: number,
            rowHeight: number,
            queueValue: number,
            key: string,
            direction: 'up' | 'down',
          ) => {
            const bx = centerX - barWidth / 2
            g.roundRect(bx, rowTop, barWidth, rowHeight, 2).fill({ color: 0x1e2430, alpha: 0.9 })
            const norm = clamp01(queueValue / maxQueueKb)
            const filledH = rowHeight * norm
            const fillTop = direction === 'up' ? rowTop : rowTop + rowHeight - filledH
            g.roundRect(bx, fillTop, barWidth, filledH, 2).fill({ color: colorForQueueUsage(norm), alpha: 0.95 })
            useQueueLabel(key, centerX, rowTop + rowHeight / 2, Math.min(queueValue, maxQueueKb), 0.5)

            const triHeight = 5
            const triHalf = Math.min(barWidth / 2, 5)
            if (direction === 'up') {
              const baseY = rowTop - 1
              const apexY = baseY - triHeight
              g.moveTo(centerX - triHalf, baseY)
              g.lineTo(centerX + triHalf, baseY)
              g.lineTo(centerX, apexY)
              g.closePath()
              g.fill({ color: 0x1e2430, alpha: 0.95 })
            } else {
              const baseY = rowTop + rowHeight + 1
              const apexY = baseY + triHeight
              g.moveTo(centerX - triHalf, baseY)
              g.lineTo(centerX + triHalf, baseY)
              g.lineTo(centerX, apexY)
              g.closePath()
              g.fill({ color: 0x1e2430, alpha: 0.95 })
            }
          }

          // Upper row: ToR -> Spine egress queues
          if (spineLinks.length) {
            const torState = torGeom.get(id)!
            const torWidth = right - left
            const count = spineLinks.length
            const barWidthTop = Math.min(26, Math.max(12, torWidth * 0.18 / Math.max(1, count)))
            spineLinks.forEach(({ link, spineId }, idx) => {
              const frac = (idx + 1) / (count + 1)
              const cxBase = left + torWidth * frac
              const cx = Math.min(Math.max(cxBase, left + 24), right - 24)
              const queueValue = getLinkQueue(link, id)
              torState.spineAnchors[spineId] = cx
              drawQueueBar(cx, barWidthTop, spineRowTop, rowHeight, queueValue, `${id}:spine:${spineId}`, 'up')
            })
          }

          // Lower row: ToR -> Host egress queues
          const contentWidth = Math.max(0, right - left - 48)
          const maxHosts = Math.max(1, serverIds.length)
          const baseWidth = contentWidth / maxHosts
          const barW = Math.min(26, Math.max(12, baseWidth * 0.9))
          for (const sid of serverIds) {
            const link = layout.links.find(l => (l.a === sid && l.b === id) || (l.b === sid && l.a === id))!
            const qLevel = getLinkQueue(link, id)
            const cx = Math.min(Math.max(positions.get(sid)!.x, left + 24), right - 24)
            drawQueueBar(cx, barW, hostRowTop, rowHeight, qLevel, `${id}:${sid}`, 'down')
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
        const spineBaseHeight = 42
        const spineQueueBaseHeight = spineBaseHeight - 20
        const h = spineBaseHeight * 2
        const top = p.y - h / 2
        const bottom = p.y + h / 2
        g.roundRect(left, top, right - left, h, 4).fill({ color: fill }).stroke({ color: 0x0, width: strokeW })

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
        const maxTors = Math.max(1, sortedTorIds.length)
        const baseBarWidth = usableWidth / maxTors
        const barWidth = Math.min(26, Math.max(12, baseBarWidth * 0.9))
        const labelY = top + 10
        const innerTop = labelY + 6
        const innerBottom = bottom - 4
        const innerHeightRaw = Math.max(6, innerBottom - innerTop)
        const queueHeightTarget = Math.min(innerHeightRaw, spineQueueBaseHeight * 2)
        const queueOffset = (innerHeightRaw - queueHeightTarget) / 2
        const queueTop = innerTop + queueOffset
        const queueBottom = queueTop + queueHeightTarget
        sortedTorIds.forEach((tid) => {
          const link = layout.links.find(l => (l.a === tid && l.b === id) || (l.b === tid && l.a === id))
          const anchorCenter = anchors[tid] ?? (left + spanWidth / 2)
          const safeCenter = Math.min(Math.max(anchorCenter, left + barWidth / 2 + 4), right - barWidth / 2 - 4)
          const barLeft = safeCenter - barWidth / 2
          const qLevel = link ? getLinkQueue(link, id) : 0
          g.roundRect(barLeft, queueTop, barWidth, queueHeightTarget, 2).fill({ color: 0x1e2430, alpha: 0.9 })
          const norm = clamp01(qLevel / maxQueueKb)
          const filledH = queueHeightTarget * norm
          g.roundRect(barLeft, queueBottom - filledH, barWidth, filledH, 2).fill({ color: colorForQueueUsage(norm), alpha: 0.95 })
          useQueueLabel(`${id}:${tid}`, safeCenter, queueTop + queueHeightTarget / 2, Math.min(qLevel, maxQueueKb), 0.5)
        })
      }
    } else {
      const radius = 14
      g.circle(p.x, p.y, radius).fill({ color: fill }).stroke({ color: 0x0, width: strokeW })
      // queue bar underneath (matches switch styling, vertical fill)
      const barW = 14
      const barH = 32
      const top = p.y + radius + 6
      const bottom = top + barH
      const bx = p.x - barW / 2
      g.roundRect(bx, top, barW, barH, 3).fill({ color: 0x1e2430, alpha: 0.9 })
      const norm = clamp01(queue / maxQueueKb)
      const filledH = barH * norm
      g.roundRect(bx, bottom - filledH, barW, filledH, 3).fill({ color: colorForQueueUsage(norm), alpha: 0.95 })
      const bucketSpacing = 6
      const bucketWidth = barW + 4
      const bucketLeft = p.x - bucketWidth / 2
      const bucketTop = bottom + bucketSpacing
      const bucketHeight = barH
      const bucketRadius = 4
      const bucketStroke = { color: 0xcbd5f5, width: 2, alpha: 0.85 } as const
      g.roundRect(bucketLeft, bucketTop, bucketWidth, bucketHeight, bucketRadius).stroke(bucketStroke)
      const handleWidth = Math.max(6, bucketWidth * 0.6)
      const handleLeft = bucketLeft + (bucketWidth - handleWidth) / 2
      const handleRight = handleLeft + handleWidth
      const handleTop = bucketTop - 6
      g.moveTo(handleLeft, bucketTop)
      g.quadraticCurveTo(bucketLeft + bucketWidth / 2, handleTop, handleRight, bucketTop)
      g.stroke(bucketStroke)
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
    const isUplink = (from: NodeDef, to: NodeDef) => {
      if (from.metricsKind === 'host' && to.metricsKind === 'tor') return true
      if (from.metricsKind === 'tor' && to.metricsKind === 'aggr') return true
      return false
    }
    const dashedForward = isUplink(aNode, bNode)
    const dashedReverse = isUplink(bNode, aNode)

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
        const anchor = tor.spineAnchors[aNode.id]
        const endX = anchor !== undefined ? anchor : (tor.left + tor.right) / 2
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
        const anchor = tor.spineAnchors[bNode.id]
        const startX = anchor !== undefined ? anchor : (tor.left + tor.right) / 2
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
    const separation = 6

    const forwardStart = { x: a.x + nx * separation, y: a.y + ny * separation }
    const forwardEnd = { x: b.x + nx * separation, y: b.y + ny * separation }
    const reverseStart = { x: b.x - nx * separation, y: b.y - ny * separation }
    const reverseEnd = { x: a.x - nx * separation, y: a.y - ny * separation }

    const widthAB = 2.4 + 9.5 * normAB
    const widthBA = 2.4 + 9.5 * normBA

    const colorAB = colorForLinkUsage(normAB)
    const colorBA = colorForLinkUsage(normBA)

    const dashLength = 18
    const gapLength = 10

    const drawStroke = (start: { x: number; y: number }, end: { x: number; y: number }, width: number, color: number, dashed: boolean) => {
      if (!dashed) {
        g.moveTo(start.x, start.y)
        g.lineTo(end.x, end.y)
        g.stroke({ width, color, alpha: 0.95, cap: 'round', join: 'round' })
        return
      }
      const total = Math.hypot(end.x - start.x, end.y - start.y)
      if (total === 0) return
      const dirX = (end.x - start.x) / total
      const dirY = (end.y - start.y) / total
      let dist = 0
      while (dist < total) {
        const dash = Math.min(dashLength, total - dist)
        const sx = start.x + dirX * dist
        const sy = start.y + dirY * dist
        const ex = start.x + dirX * (dist + dash)
        const ey = start.y + dirY * (dist + dash)
        g.moveTo(sx, sy)
        g.lineTo(ex, ey)
        dist += dash + gapLength
      }
      g.stroke({ width, color, alpha: 0.95, cap: 'round', join: 'round' })
    }

    drawStroke(forwardStart, forwardEnd, widthAB, colorAB, dashedForward)
    drawStroke(reverseStart, reverseEnd, widthBA, colorBA, dashedReverse)

    drawArrowhead(forwardStart, forwardEnd, colorAB, normAB, widthAB)
    drawArrowhead(reverseStart, reverseEnd, colorBA, normBA, widthBA)

    function drawArrowhead(
      from: { x: number; y: number },
      to: { x: number; y: number },
      color: number,
      magnitude: number,
      strokeWidth: number,
    ) {
      const baseLen = 7 + 5 * magnitude
      const widthScaled = Math.max(strokeWidth * 1.6, 5)
      const arrowLen = Math.max(baseLen, widthScaled)
      const arrowWidth = Math.max(arrowLen * 0.55, strokeWidth * 1.2)
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

  let autoFitApplied = false

  function layoutResize(w: number, h: number) {
    size.width = w
    size.height = h
    root.hitArea = new Rectangle(0, 0, size.width, size.height)
    // Recompute projected positions (world coordinates remain constant)
    for (const n of layout.nodes) {
      const p = toPx(n)
      positions.set(n.id, p)
      const hostLabel = hostLabels.get(n.id)
      if (hostLabel) {
        hostLabel.position.set(p.x, p.y)
      }
    }
    placeTierLabels()
    const { minX, minY, maxX, maxY } = getClampBounds()
    const worldW = maxX - minX
    const worldH = maxY - minY
    const ratioW = worldW > 0 ? size.width / worldW : 1
    const ratioH = worldH > 0 ? size.height / worldH : 1
    const fitScaleRaw = Math.max(ratioW, ratioH)
    const fitScale = fitScaleRaw > 0 ? Math.min(1, fitScaleRaw) : 1
    minScale = Math.min(maxScale, fitScale)
    if (!autoFitApplied) {
      scale = minScale
      world.scale.set(scale)
      const worldCenterX = (minX + maxX) / 2
      const worldCenterY = (minY + maxY) / 2
      const viewCenterX = size.width / 2
      const viewCenterY = size.height / 2
      world.position.set(viewCenterX - worldCenterX * scale, viewCenterY - worldCenterY * scale)
      autoFitApplied = true
    } else {
      scale = Math.max(scale, minScale)
      world.scale.set(scale)
    }
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
  const clampPad = 600
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
