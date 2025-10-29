import { Container, Graphics, Text, Rectangle } from 'pixi.js'
import type { Layout, Snapshot, NodeDef, LinkDef, LinkSnapshot } from './types'

// When DRAW_LINK_FILL is true, every call to drawStroke ends with:

// g.stroke({ width, color, alpha: 0.95, cap: 'round', join: 'round' })
// Inside Pixi this does much more than draw a line—it builds a new GraphicsContext mesh, allocates fresh vertex and index buffers for that line, 
// and uploads them to the GPU. We call it twice per link (forward and reverse) every frame, so dozens of new GPU geometries are created each tick.

// Those geometry buffers aren’t reclaimed immediately. Pixi keeps them in its geometry cache until the geometry GC runs (renderer.geometry.gc). 
// Because we never trigger that GC, the old buffers just pile up on the GPU. That’s why the Chrome “GPU Process” blows up to gigabytes whenever link fill drawing is enabled. 
// As soon as we skip g.stroke, the allocations stop, so memory stays flat.

// So the “explosion” isn’t a JavaScript leak; it’s accumulated GPU geometry buffers produced by the g.stroke(…) calls. 
// We’ll either need to run the geometry GC regularly (e.g., app.renderer.geometry.gc.run()), or switch to a custom mesh/line renderer that reuses vertex buffers instead of generating a fresh mesh every frame.

// Next step https://chatgpt.com/c/68fbb02d-15f8-832a-ae1c-9bdb8429bc40 

export function buildScene(root: Container, layout: Layout) {
  const DRAW_LINKS = true // Toggle link rendering (disabled while debugging GPU allocations)
  const DRAW_LINK_FILL = true // Toggle link fill (disabled while debugging GPU allocations)
  const DRAW_NODES = true // Toggle node rendering (disabled while debugging GPU allocations)
  const SHOW_QUEUE_LABELS = true // Toggle queue labels (disabled while hunting GPU leak)
  const SHOW_HOST_BUCKETS = false // Toggle host bucket graphics (disabled during GPU leak hunt)
  const SHOW_HOST_QUEUES = false // Toggle host queue bars beneath endpoints
  const SHOW_TOR_SPINE_QUEUES = true // Toggle ToR->spine queue bars (disabled during GPU leak hunt)
  const SHOW_PACKET_FLOW = true // Toggle animated packet flow along links
  const SHOW_SPINE_DASHBOARD = false // Toggle dashboard gauges above spines
  const PACKETS_PER_DIRECTION = 25
  // const PACKET_MIN_SCALE = 100 // Zoom threshold for packets (increase to require deeper zoom)
  const PACKET_MIN_SCALE = 0.5 // Zoom threshold for packets (increase to require deeper zoom)
  // const PACKET_MIN_SCALE = 3.5 // Zoom threshold for packets (increase to require deeper zoom)
  const PACKET_SPEED = 0.6 // Constant per-frame speed multiplier
  const PACKET_STEP = 0.02 // Constant progress increment per frame
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
  packetsLayer.visible = false
  const labelsLayer = new Container()
  world.addChild(linksLayer, nodesLayer, packetsLayer, labelsLayer)

  const size = { width: 800, height: 600 }
  const worldSize = { width: 1400, height: 880 }
  root.hitArea = new Rectangle(0, 0, size.width, size.height)
  const positions = new Map<string, { x: number; y: number }>()
  const nodeVisuals = new Map<string, NodeVisual>()
  const linkGfx = new Map<string, { forward: Graphics; reverse: Graphics }>()
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
  const dashboardLayer = new Container()
  labelsLayer.addChild(dashboardLayer)
  const dashboardVisuals: DashboardVisual[] = []
  const maxQueueKb = 700
  const nodeColors = {
    host: 0xfce2c4,
    tor: 0xe5e7eb,
    spine: 0xe5e7eb,
    switch: 0xe2e8f0,
  }

  const colorForLinkUsage = (u: number) => {
    const value = clamp01(u)
    if (value <= 0.01) return 0x6b7280
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

  type QueueValueSource =
    | { kind: 'node'; nodeId: string }
    | { kind: 'link'; linkId: string; sourceNodeId: string }

  type QueueLabelDescriptor = {
    key: string
    position: { x: number; y: number }
    anchorY: number
  }

  type QueueVisual = {
    fill: Graphics
    width: number
    height: number
    anchor: 'top' | 'bottom'
    valueSource: QueueValueSource
    maxValue: number
    label?: QueueLabelDescriptor
  }

  type NodeVisual = {
    update: (snapshot: Snapshot) => void
    destroy: () => void
  }

  type DashboardVisual = {
    container: Container
    title: Text
    value: Text
  }

  const baseQueueTemplate = new Graphics()
  baseQueueTemplate.rect(-0.5, 0, 1, 1).fill({ color: 0xffffff })
  const baseQueueGeometry: any = (baseQueueTemplate as any).geometry
  const incrementQueueGeometryRef = () => {
    if (baseQueueGeometry && typeof baseQueueGeometry.refCount === 'number') {
      baseQueueGeometry.refCount += 1
    }
  }

  const createQueueFillGraphic = (anchor: 'top' | 'bottom') => {
    const g = new Graphics()
    if (baseQueueGeometry) {
      ;(g as any).geometry = baseQueueGeometry
      incrementQueueGeometryRef()
    } else {
      g.rect(-0.5, 0, 1, 1).fill({ color: 0xffffff })
    }
    g.visible = false
    g.alpha = 0.95
    g.pivot.set(0, anchor === 'bottom' ? 1 : 0)
    g.tint = 0xffffff
    return g
  }

  type PacketVisual = {
    graphic: Graphics
    progress: number
    speed: number
    jitterMag: number
    jitterPhase: number
  }

  const basePacketTemplate = new Graphics()
  basePacketTemplate.circle(0, 0, 1.6).fill({ color: 0xffffff })
  const basePacketGeometry: any = (basePacketTemplate as any).geometry
  const incrementPacketGeometryRef = () => {
    if (basePacketGeometry && typeof basePacketGeometry.refCount === 'number') {
      basePacketGeometry.refCount += 1
    }
  }

  const createPacketVisual = (initialProgress: number): PacketVisual => {
    const graphic = new Graphics()
    if (basePacketGeometry) {
      ;(graphic as any).geometry = basePacketGeometry
      incrementPacketGeometryRef()
    } else {
      graphic.circle(0, 0, 1.6).fill({ color: 0xffffff })
    }
    graphic.visible = false
    graphic.alpha = 0.85
    packetsLayer.addChild(graphic)
    return {
      graphic,
      progress: initialProgress % 1,
      speed: 0,
      jitterMag: 0.75 + Math.random() * 0.25,
      jitterPhase: Math.random() * Math.PI * 2,
    }
  }

  const linkPackets = new Map<string, { forward: PacketVisual[]; reverse: PacketVisual[] }>()

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
  const baseLinkTemplate = new Graphics()
  baseLinkTemplate.rect(0, -0.5, 1, 1).fill({ color: 0xffffff })
  const baseLinkGeometry: any = (baseLinkTemplate as any).geometry
  const incrementLinkGeometryRef = () => {
    if (baseLinkGeometry && typeof baseLinkGeometry.refCount === 'number') {
      baseLinkGeometry.refCount += 1
    }
  }
  const DASH_LENGTH = 18
  const DASH_GAP = 10

  type LinkGraphicMeta = {
    dashed: boolean
    geometryReady: boolean
    lastLength?: number
  }

  const getLinkGraphicMeta = (graphic: Graphics): LinkGraphicMeta => {
    let meta = (graphic as any)._linkMeta as LinkGraphicMeta | undefined
    if (!meta) {
      meta = { dashed: false, geometryReady: false }
      ;(graphic as any)._linkMeta = meta
    }
    return meta
  }

  const assignSolidGeometry = (graphic: Graphics) => {
    if (baseLinkGeometry) {
      ;(graphic as any).geometry = baseLinkGeometry
      incrementLinkGeometryRef()
    } else {
      graphic.clear()
      graphic.rect(0, -0.5, 1, 1).fill({ color: 0xffffff })
    }
  }

  const createLinkGraphic = (dashed: boolean) => {
    const g = new Graphics()
    if (!dashed) {
      assignSolidGeometry(g)
    }
    g.tint = 0xffffff
    g.alpha = 0.95
    g.visible = false
    g.position.set(0, 0)
    g.scale.set(1, 1)
    const meta = getLinkGraphicMeta(g)
    meta.dashed = dashed
    meta.geometryReady = !dashed
    meta.lastLength = dashed ? undefined : 1
    return g
  }

  function rebuildNodeVisuals() {
    for (const visual of nodeVisuals.values()) {
      visual.destroy()
    }
    nodeVisuals.clear()
    nodesLayer.removeChildren()
    torGeom.clear()
    spineGeom.clear()

    for (const node of layout.nodes) {
      const visual = createNodeVisual(node)
      nodeVisuals.set(node.id, visual)
    }
  }

  function rebuildDashboard() {
    dashboardLayer.removeChildren()
    dashboardVisuals.length = 0
    if (!SHOW_SPINE_DASHBOARD) {
      dashboardLayer.visible = false
      return
    }

    dashboardLayer.visible = true
    const descriptors = [
      { title: 'Queueing', color: 0xf97316 },
      { title: 'Throughput', color: 0x38bdf8 },
    ] as const
    const radius = 62

    for (const desc of descriptors) {
      const container = new Container()
      const face = new Graphics()
      face.circle(0, 0, radius).fill({ color: 0x111827, alpha: 0.94 }).stroke({ color: 0xe2e8f0, width: 4 })
      const ring = new Graphics()
      ring.circle(0, 0, radius - 10).stroke({ color: desc.color, width: 4, alpha: 0.65 })
      const notch = new Graphics()
      notch.rect(-3, -radius + 14, 6, 20).fill({ color: desc.color, alpha: 0.9 })

      const value = new Text({
        text: '--',
        style: { fill: 0xf8fafc, fontSize: 26, fontWeight: '700' },
      })
      value.anchor.set(0.5)

      const title = new Text({
        text: desc.title,
        style: { fill: 0xe2e8f0, fontSize: 15, fontWeight: '600' },
      })
      title.anchor.set(0.5, 0)
      title.position.set(0, radius + 18)

      container.addChild(face, ring, notch, value, title)
      dashboardLayer.addChild(container)
      dashboardVisuals.push({ container, title, value })
    }

    updateDashboardLayout()
  }

  function updateDashboardLayout() {
    if (!SHOW_SPINE_DASHBOARD || dashboardVisuals.length === 0) return
    const spines = layout.nodes.filter((node) => node.id.startsWith('sp'))
    const positionsList = spines
      .map((node) => positions.get(node.id))
      .filter((pos): pos is { x: number; y: number } => !!pos)
    if (!positionsList.length) {
      dashboardLayer.visible = false
      return
    }

    dashboardLayer.visible = true
    const centerX = positionsList.reduce((acc, pos) => acc + pos.x, 0) / positionsList.length
    const minY = positionsList.reduce((acc, pos) => Math.min(acc, pos.y), Infinity)
    const baseY = minY - 140
    const spacing = 180
    const startX = centerX - ((dashboardVisuals.length - 1) * spacing) / 2

    dashboardVisuals.forEach((visual, idx) => {
      visual.container.position.set(startX + idx * spacing, baseY)
    })
  }

  function createNodeVisual(node: NodeDef): NodeVisual {
    if (node.type === 'switch') {
      if (node.id.startsWith('tor')) return createTorNodeVisual(node)
      return createSpineNodeVisual(node)
    }
    return createEndpointNodeVisual(node)
  }

  function createEndpointNodeVisual(node: NodeDef): NodeVisual {
    const disposables: Graphics[] = []
    const queueVisuals: QueueVisual[] = []
    const pos = positions.get(node.id)!
    const fillColor = nodeFillColor(node)

    const radius = 14
    const strokeW = 2
    const body = new Graphics()
    body.circle(pos.x, pos.y, radius).fill({ color: fillColor }).stroke({ color: 0x0, width: strokeW })
    nodesLayer.addChild(body)
    disposables.push(body)

    if (SHOW_HOST_QUEUES) {
      const barW = 14
      const barH = 32
      const top = pos.y + radius + 6
      const bottom = top + barH
      const barBg = new Graphics()
      barBg.roundRect(pos.x - barW / 2, top, barW, barH, 3).fill({ color: 0x1e2430, alpha: 0.9 })
      nodesLayer.addChild(barBg)
      disposables.push(barBg)

      if (SHOW_HOST_BUCKETS && node.type === 'host') {
        const bucketSpacing = 6
        const bucketWidth = barW + 4
        const bucketLeft = pos.x - bucketWidth / 2
        const bucketTop = bottom + bucketSpacing
        const bucketHeight = barH
        const bucketRadius = 4
        const bucketStroke = { color: 0xcbd5f5, width: 2, alpha: 0.85 } as const
        const bucket = new Graphics()
        bucket.roundRect(bucketLeft, bucketTop, bucketWidth, bucketHeight, bucketRadius).stroke(bucketStroke)
        const handleWidth = Math.max(6, bucketWidth * 0.6)
        const handleLeft = bucketLeft + (bucketWidth - handleWidth) / 2
        const handleRight = handleLeft + handleWidth
        const handleTop = bucketTop - 6
        bucket.moveTo(handleLeft, bucketTop)
        bucket.quadraticCurveTo(bucketLeft + bucketWidth / 2, handleTop, handleRight, bucketTop)
        bucket.stroke(bucketStroke)
        nodesLayer.addChild(bucket)
        disposables.push(bucket)
      }

      const fill = createQueueFillGraphic('bottom')
      fill.position.set(pos.x, bottom)
      fill.scale.x = barW
      fill.scale.y = 0
      nodesLayer.addChild(fill)
      disposables.push(fill)
      queueVisuals.push({
        fill,
        width: barW,
        height: barH,
        anchor: 'bottom',
        valueSource: { kind: 'node', nodeId: node.id },
        maxValue: maxQueueKb,
      })
    }

    const hostLabel = hostLabels.get(node.id)
    if (hostLabel) {
      hostLabel.position.set(pos.x, pos.y)
    }

    return {
      update(snapshot) {
        if (hostLabel) {
          hostLabel.visible = true
        }
        for (const queue of queueVisuals) {
          updateQueueVisual(queue, snapshot)
        }
      },
      destroy() {
        for (const gfx of disposables) {
          gfx.destroy()
        }
      },
    }
  }

  function createTorNodeVisual(node: NodeDef): NodeVisual {
    const disposables: Graphics[] = []
    const queueVisuals: QueueVisual[] = []
    const pos = positions.get(node.id)!
    const fillColor = nodeFillColor(node)

    const serverIds: string[] = []
    for (const l of layout.links) {
      if (l.a === node.id) {
        const other = l.b
        const otherNode = layout.nodes.find(nn => nn.id === other)
        if (otherNode && otherNode.type === 'host') serverIds.push(other)
      } else if (l.b === node.id) {
        const other = l.a
        const otherNode = layout.nodes.find(nn => nn.id === other)
        if (otherNode && otherNode.type === 'host') serverIds.push(other)
      }
    }

    let left = pos.x - 23
    let right = pos.x + 23
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
    const top = pos.y - h / 2
    const bottom = pos.y + h / 2
    const torState = { left, right, top, bottom, spineAnchors: {} as Record<string, number> }
    torGeom.set(node.id, torState)

    const body = new Graphics()
    body.roundRect(left, top, right - left, h, 4).fill({ color: fillColor }).stroke({ color: 0x0, width: 2 })
    nodesLayer.addChild(body)
    disposables.push(body)

    if (serverIds.length) {
      const spineLinks = layout.links
        .filter(l => (l.a === node.id && l.b.startsWith('sp')) || (l.b === node.id && l.a.startsWith('sp')))
        .map(link => {
          const other = link.a === node.id ? link.b : link.a
          return { link, spineId: other, x: positions.get(other)?.x ?? pos.x }
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

      const triHeight = 5
      const drawArrow = (centerX: number, baseY: number, direction: 'up' | 'down', barWidth: number) => {
        const triHalf = Math.min(barWidth / 2, 5)
        if (direction === 'up') {
          const base = baseY - 1
          const apex = base - triHeight
          body.moveTo(centerX - triHalf, base)
          body.lineTo(centerX + triHalf, base)
          body.lineTo(centerX, apex)
          body.closePath()
          body.fill({ color: 0x1e2430, alpha: 0.95 })
        } else {
          const base = baseY + 1
          const apex = base + triHeight
          body.moveTo(centerX - triHalf, base)
          body.lineTo(centerX + triHalf, base)
          body.lineTo(centerX, apex)
          body.closePath()
          body.fill({ color: 0x1e2430, alpha: 0.95 })
        }
      }

      const addQueueBar = (
        centerX: number,
        barWidth: number,
        rowTop: number,
        rowHeightLocal: number,
        direction: 'up' | 'down',
        valueSource: QueueValueSource,
        labelKey: string,
      ) => {
        const bx = centerX - barWidth / 2
        body.roundRect(bx, rowTop, barWidth, rowHeightLocal, 2).fill({ color: 0x1e2430, alpha: 0.9 })
        const anchor = direction === 'up' ? 'top' : 'bottom'
        const fill = createQueueFillGraphic(anchor)
        fill.position.set(centerX, direction === 'up' ? rowTop : rowTop + rowHeightLocal)
        fill.scale.x = barWidth
        fill.scale.y = 0
        nodesLayer.addChild(fill)
        disposables.push(fill)
        queueVisuals.push({
          fill,
          width: barWidth,
          height: rowHeightLocal,
          anchor,
          valueSource,
          maxValue: maxQueueKb,
          label: { key: labelKey, position: { x: centerX, y: rowTop + rowHeightLocal / 2 }, anchorY: 0.5 },
        })
        drawArrow(centerX, direction === 'up' ? rowTop : rowTop + rowHeightLocal, direction, barWidth)
      }

      if (SHOW_TOR_SPINE_QUEUES && spineLinks.length) {
        const torWidth = right - left
        const count = spineLinks.length
        const barWidthTop = Math.min(26, Math.max(12, torWidth * 0.18 / Math.max(1, count)))
        spineLinks.forEach(({ link, spineId }, idx) => {
          const frac = (idx + 1) / (count + 1)
          const cxBase = left + torWidth * frac
          const cx = Math.min(Math.max(cxBase, left + 24), right - 24)
          torState.spineAnchors[spineId] = cx
          addQueueBar(
            cx,
            barWidthTop,
            spineRowTop,
            rowHeight,
            'up',
            { kind: 'link', linkId: link.id, sourceNodeId: node.id },
            `${node.id}:spine:${spineId}`,
          )
        })
      } else {
        spineLinks.forEach(({ spineId }, idx) => {
          const frac = (idx + 1) / (spineLinks.length + 1)
          const torWidth = right - left
          const cxBase = left + torWidth * frac
          const cx = Math.min(Math.max(cxBase, left + 24), right - 24)
          torState.spineAnchors[spineId] = cx
        })
      }

      const contentWidth = Math.max(0, right - left - 48)
      const maxHosts = Math.max(1, serverIds.length)
      const baseWidth = contentWidth / maxHosts
      const barWHost = Math.min(26, Math.max(12, baseWidth * 0.9))
      for (const sid of serverIds) {
        const link = layout.links.find(l => (l.a === sid && l.b === node.id) || (l.b === sid && l.a === node.id))
        if (!link) continue
        const cx = Math.min(Math.max(positions.get(sid)!.x, left + 24), right - 24)
        addQueueBar(
          cx,
          barWHost,
          hostRowTop,
          rowHeight,
          'down',
          { kind: 'link', linkId: link.id, sourceNodeId: node.id },
          `${node.id}:${sid}`,
        )
      }
    }

    return {
      update(snapshot) {
        for (const queue of queueVisuals) {
          updateQueueVisual(queue, snapshot)
        }
      },
      destroy() {
        for (const gfx of disposables) {
          gfx.destroy()
        }
      },
    }
  }

  function createSpineNodeVisual(node: NodeDef): NodeVisual {
    const disposables: Graphics[] = []
    const queueVisuals: QueueVisual[] = []
    const pos = positions.get(node.id)!
    const fillColor = nodeFillColor(node)

    const torIds = layout.nodes.filter(nn => nn.id.startsWith('tor')).map(nn => nn.id)
    const torXs = torIds.map(id => positions.get(id)!.x)
    const torMin = Math.min(...torXs)
    const torMax = Math.max(...torXs)
    const span = Math.max(120, torMax - torMin + 60)
    const width = span / Math.max(1, torIds.length)
    const left = pos.x - width / 2
    const right = pos.x + width / 2
    const spineBaseHeight = 42
    const spineQueueBaseHeight = spineBaseHeight - 20
    const h = spineBaseHeight * 2
    const top = pos.y - h / 2
    const bottom = pos.y + h / 2

    const body = new Graphics()
    body.roundRect(left, top, right - left, h, 4).fill({ color: fillColor }).stroke({ color: 0x0, width: 2 })
    nodesLayer.addChild(body)
    disposables.push(body)

    const sortedTorIds = torIds.slice().sort((a, b) => positions.get(a)!.x - positions.get(b)!.x)
    const spanWidth = right - left
    const marginX = Math.min(28, Math.max(10, spanWidth * 0.12))
    const usableWidth = Math.max(0, spanWidth - marginX * 2)
    const anchors: Record<string, number> = {}

    if (sortedTorIds.length === 1) {
      anchors[sortedTorIds[0]] = left + spanWidth / 2
    } else if (usableWidth <= 0) {
      sortedTorIds.forEach(tid => {
        anchors[tid] = left + spanWidth / 2
      })
    } else {
      sortedTorIds.forEach((tid, idx) => {
        const t = sortedTorIds.length === 1 ? 0.5 : idx / (sortedTorIds.length - 1)
        anchors[tid] = left + marginX + usableWidth * t
      })
    }

    spineGeom.set(node.id, { left, right, top, bottom, anchors })

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

    sortedTorIds.forEach(tid => {
      const link = layout.links.find(l => (l.a === tid && l.b === node.id) || (l.b === tid && l.a === node.id))
      const anchorCenter = anchors[tid] ?? (left + spanWidth / 2)
      const safeCenter = Math.min(Math.max(anchorCenter, left + barWidth / 2 + 4), right - barWidth / 2 - 4)
      body.roundRect(safeCenter - barWidth / 2, queueTop, barWidth, queueHeightTarget, 2).fill({ color: 0x1e2430, alpha: 0.9 })
      const fill = createQueueFillGraphic('bottom')
      fill.position.set(safeCenter, queueBottom)
      fill.scale.x = barWidth
      fill.scale.y = 0
      nodesLayer.addChild(fill)
      disposables.push(fill)
      if (link) {
        queueVisuals.push({
          fill,
          width: barWidth,
          height: queueHeightTarget,
          anchor: 'bottom',
          valueSource: { kind: 'link', linkId: link.id, sourceNodeId: node.id },
          maxValue: maxQueueKb,
          label: { key: `${node.id}:${tid}`, position: { x: safeCenter, y: queueTop + queueHeightTarget / 2 }, anchorY: 0.5 },
        })
      } else {
        queueVisuals.push({
          fill,
          width: barWidth,
          height: queueHeightTarget,
          anchor: 'bottom',
          valueSource: { kind: 'node', nodeId: tid },
          maxValue: maxQueueKb,
        })
      }
    })

    return {
      update(snapshot) {
        for (const queue of queueVisuals) {
          updateQueueVisual(queue, snapshot)
        }
      },
      destroy() {
        for (const gfx of disposables) {
          gfx.destroy()
        }
      },
    }
  }

  function getQueueValue(source: QueueValueSource, snapshot: Snapshot): number {
    if (source.kind === 'node') {
      return Math.max(0, snapshot.nodes[source.nodeId]?.queue ?? 0)
    }
    const link = linkByEnds.get(source.linkId)
    const snap = snapshot.links[source.linkId]
    if (!link || !snap) return 0
    if (link.a === source.sourceNodeId) return Math.max(0, snap.queueA ?? 0)
    if (link.b === source.sourceNodeId) return Math.max(0, snap.queueB ?? 0)
    return 0
  }

  function updateQueueVisual(visual: QueueVisual, snapshot: Snapshot) {
    const value = getQueueValue(visual.valueSource, snapshot)
    const norm = clamp01(visual.maxValue > 0 ? value / visual.maxValue : 0)
    visual.fill.scale.x = visual.width
    visual.fill.scale.y = visual.height * norm
    visual.fill.tint = colorForQueueUsage(norm)
    visual.fill.visible = norm > 0
    if (SHOW_QUEUE_LABELS && visual.label) {
      const displayValue = Math.max(0, value)
      useQueueLabel(visual.label.key, visual.label.position.x, visual.label.position.y, displayValue, visual.label.anchorY)
    }
  }

  const hidePacketGroup = (packets: PacketVisual[]) => {
    for (const packet of packets) {
      packet.graphic.visible = false
    }
  }

  const hideAllPackets = () => {
    for (const packets of linkPackets.values()) {
      hidePacketGroup(packets.forward)
      hidePacketGroup(packets.reverse)
    }
  }

  let packetDelta = 0
  let packetsAllowed = false

  const updatePacketGroup = (
    packets: PacketVisual[],
    start: { x: number; y: number },
    end: { x: number; y: number },
    intensity: number,
    color: number,
  ) => {
    if (!packetsAllowed) {
      hidePacketGroup(packets)
      return
    }
    if (intensity <= 0) {
      hidePacketGroup(packets)
      return
    }
    const dx = end.x - start.x
    const dy = end.y - start.y
    const len = Math.hypot(dx, dy)
    if (!len) {
      hidePacketGroup(packets)
      return
    }
    const dirX = dx / len
    const dirY = dy / len
    const density = clamp01(intensity)
    const activeCount = Math.max(1, Math.round(density * packets.length))
    const alpha = 0.33 + 0.67 * density
    const jitterScale = 1 + density * 2
    for (let i = 0; i < packets.length; i++) {
      const packet = packets[i]
      if (i < activeCount) {
        packet.speed = PACKET_SPEED
        packet.progress = (packet.progress + packetDelta * packet.speed) % 1
        const offset = packet.progress * len
        const baseX = start.x + dirX * offset
        const baseY = start.y + dirY * offset
        const jitter = Math.sin(packet.progress * Math.PI * 2 + packet.jitterPhase) * packet.jitterMag * jitterScale
        const px = baseX + (-dirY) * jitter
        const py = baseY + dirX * jitter
        packet.graphic.position.set(px, py)
        packet.graphic.tint = color
        packet.graphic.alpha = alpha
        packet.graphic.visible = true
      } else {
        packet.graphic.visible = false
      }
    }
  }

  for (const l of layout.links) {
    linkByEnds.set(l.id, l)
    const aNode = layout.nodes.find(n => n.id === l.a)!
    const bNode = layout.nodes.find(n => n.id === l.b)!
    const forward = createLinkGraphic(isUplink(aNode, bNode))
    const reverse = createLinkGraphic(isUplink(bNode, aNode))
    linksLayer.addChild(forward)
    linksLayer.addChild(reverse)
    linkGfx.set(l.id, { forward, reverse })
    const forwardPackets: PacketVisual[] = []
    const reversePackets: PacketVisual[] = []
    for (let i = 0; i < PACKETS_PER_DIRECTION; i++) {
      const base = i / PACKETS_PER_DIRECTION
      forwardPackets.push(createPacketVisual(base))
      reversePackets.push(createPacketVisual(base))
    }
    linkPackets.set(l.id, { forward: forwardPackets, reverse: reversePackets })
  }

  rebuildNodeVisuals()
  rebuildDashboard()

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
    const w = size.width
    const h = size.height
    gridLayer.clear()
    gridLayer.rect(0, 0, w, h).fill({ color: 0x08090c })
  }
  function useQueueLabel(key: string, x: number, y: number, value: number, anchorY = 1) {
    if (!SHOW_QUEUE_LABELS) return
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

  function drawLink(id: string, usage: LinkSnapshot | undefined) {
    const link = linkByEnds.get(id)!
    let a = positions.get(link.a)!
    let b = positions.get(link.b)!
    const visuals = linkGfx.get(id)!

    if (!DRAW_LINK_FILL) {
      visuals.forward.visible = false
      visuals.reverse.visible = false
      return
    }

    const aNode = layout.nodes.find(n => n.id === link.a)!
    const bNode = layout.nodes.find(n => n.id === link.b)!

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

    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy)
    if (!len) {
      visuals.forward.visible = false
      visuals.reverse.visible = false
      return
    }
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

    updateLinkGraphic(visuals.forward, forwardStart, forwardEnd, widthAB, colorAB, dashedForward)
    updateLinkGraphic(visuals.reverse, reverseStart, reverseEnd, widthBA, colorBA, dashedReverse)

    const packetState = linkPackets.get(id)
    if (packetState) {
      updatePacketGroup(packetState.forward, forwardStart, forwardEnd, normAB, colorAB)
      updatePacketGroup(packetState.reverse, reverseStart, reverseEnd, normBA, colorBA)
    }

  }

  const buildDashedGeometry = (graphic: Graphics, length: number, dash = DASH_LENGTH, gap = DASH_GAP) => {
    graphic.clear()
    const pattern = Math.max(1, dash + gap)
    let offset = 0
    while (offset < length) {
      const remaining = length - offset
      const dashWidth = Math.min(dash, remaining)
      if (dashWidth <= 0) break
      graphic.rect(offset, -0.5, dashWidth, 1).fill({ color: 0xffffff })
      offset += pattern
    }
    const meta = getLinkGraphicMeta(graphic)
    meta.geometryReady = true
    meta.lastLength = length
  }

  function updateLinkGraphic(
    graphic: Graphics,
    start: { x: number; y: number },
    end: { x: number; y: number },
    thickness: number,
    color: number,
    dashed: boolean,
  ) {
    const dx = end.x - start.x
    const dy = end.y - start.y
    const length = Math.hypot(dx, dy)
    if (!length || thickness <= 0) {
      graphic.visible = false
      return
    }

    const meta = getLinkGraphicMeta(graphic)
    const lengthEps = 0.25
    if (meta.dashed !== dashed) {
      meta.dashed = dashed
      meta.geometryReady = false
      meta.lastLength = undefined
      if (!dashed) {
        assignSolidGeometry(graphic)
        meta.geometryReady = true
        meta.lastLength = 1
      }
    }

    if (dashed) {
      if (!meta.geometryReady || meta.lastLength === undefined || Math.abs(meta.lastLength - length) > lengthEps) {
        buildDashedGeometry(graphic, length)
      }
      graphic.scale.set(1, thickness)
    } else {
      graphic.scale.set(length, thickness)
    }

    graphic.visible = true
    graphic.position.set(start.x, start.y)
    graphic.rotation = Math.atan2(dy, dx)
    graphic.tint = color
  }

  // Packets removed

  function update(snapshot: Snapshot) {
    queueLabelsUsed.clear()
    for (const label of hostLabels.values()) label.visible = false
    packetDelta = SHOW_PACKET_FLOW ? PACKET_STEP : 0
    packetsAllowed = SHOW_PACKET_FLOW && scale >= PACKET_MIN_SCALE
    linksLayer.visible = !(DRAW_LINKS && packetsAllowed)
    packetsLayer.visible = packetsAllowed && SHOW_PACKET_FLOW
    if (packetsAllowed && SHOW_PACKET_FLOW) {
      for (const l of layout.links) {
        drawLink(l.id, snapshot.links[l.id])
      }
    } else {
      hideAllPackets()
      if (DRAW_LINKS) {
        for (const l of layout.links) {
          drawLink(l.id, snapshot.links[l.id])
        }
      }
    }
    if (DRAW_NODES) {
      for (const visual of nodeVisuals.values()) {
        visual.update(snapshot)
      }
    }
    for (const [key, label] of queueLabels) {
      if (!queueLabelsUsed.has(key)) {
        label.visible = false
      }
    }
    // no packet movement
  }

  function reset() {
    hideAllPackets()
    packetsLayer.visible = false
    packetDelta = 0
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
    rebuildNodeVisuals()
    rebuildDashboard()
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
    updateDashboardLayout()
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

function isUplink(from: NodeDef, to: NodeDef) {
  if (from.metricsKind === 'host' && to.metricsKind === 'tor') return true
  if (from.metricsKind === 'tor' && to.metricsKind === 'aggr') return true
  return false
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
