import { Container, Graphics, Text } from 'pixi.js'
import type { Layout, Snapshot, NetworkEvent, NodeDef, LinkDef } from './data'

export function buildScene(root: Container, layout: Layout) {
  const nodesLayer = new Container()
  const linksLayer = new Container()
  const packetsLayer = new Container()
  const labelsLayer = new Container()
  root.addChild(linksLayer, nodesLayer, packetsLayer, labelsLayer)

  const size = { width: 800, height: 600 }
  const positions = new Map<string, { x: number; y: number }>()
  const nodeGfx = new Map<string, Graphics>()
  const nodeLabel = new Map<string, Text>()
  const linkGfx = new Map<string, Graphics>()
  const linkByEnds = new Map<string, LinkDef>()

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
    const label = new Text({ text: n.id, style: { fill: 0xb0b8c0, fontSize: 12 } })
    labelsLayer.addChild(label)
    nodeLabel.set(n.id, label)
  }
  for (const l of layout.links) {
    linkByEnds.set(l.id, l)
    const g = new Graphics()
    linksLayer.addChild(g)
    linkGfx.set(l.id, g)
  }

  function drawNode(id: string, queue: number) {
    const n = layout.nodes.find((x) => x.id === id)!
    const p = positions.get(id)!
    const g = nodeGfx.get(id)!
    g.clear()
    const radius = n.type === 'switch' ? 18 : 12
    const fill = lerpColor(0x1f6feb, 0xeb3b5a, queue)
    g.circle(p.x, p.y, radius).fill({ color: fill, alpha: 0.95 }).stroke({ color: 0x0, width: 2, alpha: 0.5 })
    // queue bar underneath
    const barW = 40
    const barH = 6
    const bx = p.x - barW / 2
    const by = p.y + radius + 8
    g.roundRect(bx, by, barW, barH, 3).fill({ color: 0x2a2e35, alpha: 0.8 })
    g.roundRect(bx, by, barW * clamp01(queue), barH, 3).fill({ color: 0xff9f43, alpha: 0.9 })
    const label = nodeLabel.get(id)!
    label.position.set(p.x - label.width / 2, p.y - radius - 16)
  }

  function drawLink(id: string, throughput: number) {
    const l = linkByEnds.get(id)!
    const a = positions.get(l.a)!
    const b = positions.get(l.b)!
    const g = linkGfx.get(id)!
    g.clear()
    const width = 2 + 6 * clamp01(throughput)
    const color = lerpColor(0x4b5563, 0x22c55e, clamp01(throughput))
    g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width, color, alpha: 0.9 })
  }

  // Packets as small moving dots along link segments
  type Packet = {
    sprite: Graphics
    path: string[]
    segIndex: number
    t: number // 0..1 along current segment
    color: number
  }
  const packets: Packet[] = []

  function emitEvent(ev: NetworkEvent) {
    if (ev.path.length < 2) return
    const sprite = new Graphics()
    packetsLayer.addChild(sprite)
    const color = ev.color ?? 0xffffff
    const pkt: Packet = { sprite, path: ev.path.slice(), segIndex: 0, t: 0, color }
    packets.push(pkt)
  }

  function update(snapshot: Snapshot) {
    for (const l of layout.links) {
      const s = snapshot.links[l.id]?.throughput ?? 0
      drawLink(l.id, s)
    }
    for (const n of layout.nodes) {
      const q = snapshot.nodes[n.id]?.queue ?? 0
      drawNode(n.id, q)
    }
    // move packets
    const speed = 160 // px per second
    const dt = 1 / 60 // approx; real dt comes from ticker but we keep it simple here
    for (let i = packets.length - 1; i >= 0; i--) {
      const p = packets[i]
      const aId = p.path[p.segIndex]
      const bId = p.path[p.segIndex + 1]
      if (!aId || !bId) {
        // done
        p.sprite.destroy()
        packets.splice(i, 1)
        continue
      }
      const a = positions.get(aId)!
      const b = positions.get(bId)!
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.max(1, Math.hypot(dx, dy))
      const step = (speed * dt) / dist
      p.t += step
      if (p.t >= 1) {
        p.segIndex++
        p.t = 0
      }
      const x = a.x + dx * p.t
      const y = a.y + dy * p.t
      p.sprite.clear()
      p.sprite.circle(x, y, 4).fill({ color: p.color, alpha: 0.95 }).stroke({ color: 0x0, width: 1, alpha: 0.7 })
    }
  }

  function reset() {
    // Clear packets
    for (const p of packets) p.sprite.destroy()
    packets.length = 0
  }

  function layoutResize(w: number, h: number) {
    size.width = w
    size.height = h
    // Recompute projected positions
    for (const n of layout.nodes) {
      const p = toPx(n)
      positions.set(n.id, p)
    }
  }

  return { update, emitEvent, reset, layoutResize }
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
