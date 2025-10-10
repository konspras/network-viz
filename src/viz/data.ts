export type NodeType = 'host' | 'switch'

export type NodeDef = {
  id: string
  type: NodeType
  // Normalized layout coordinates [0,1]
  x: number
  y: number
}

export type LinkDef = {
  id: string
  a: string // node id
  b: string // node id
}

export type Layout = {
  nodes: NodeDef[]
  links: LinkDef[]
}

export type LinkSnapshot = {
  throughput: number // 0..1 normalized
}

export type NodeSnapshot = {
  queue: number // 0..1 normalized
}

export type Snapshot = {
  t: number
  links: Record<string, LinkSnapshot>
  nodes: Record<string, NodeSnapshot>
}

export type NetworkEvent = {
  t: number // time of emission (seconds)
  path: string[] // sequence of node ids to traverse
  color?: number // hex color for packet
}

export class MockDataSource {
  readonly layout: Layout
  readonly duration: number
  readonly events: NetworkEvent[]

  private seed: number
  private linkIds: string[]
  private nodeIds: string[]

  constructor(duration = 30, seed = 42) {
    this.duration = duration
    this.seed = seed
    this.layout = this.buildLayout()
    this.nodeIds = this.layout.nodes.map((n) => n.id)
    this.linkIds = this.layout.links.map((l) => l.id)
    this.events = this.buildEvents()
  }

  sample(t: number): Snapshot {
    // Create smooth pseudo-random waves over time
    const rnd = this.prng(this.seed)
    const links: Record<string, LinkSnapshot> = {}
    for (const id of this.linkIds) {
      const f1 = 0.2 + rnd() * 0.5
      const f2 = 0.1 + rnd() * 0.3
      const phase = rnd() * Math.PI * 2
      const val = 0.5 + 0.5 * Math.sin((t * f1 + phase) * 2 * Math.PI) * 0.6 + 0.4 * Math.sin((t * f2 + phase * 0.7) * 2 * Math.PI)
      links[id] = { throughput: clamp01(val) }
    }

    const nodes: Record<string, NodeSnapshot> = {}
    for (const id of this.nodeIds) {
      const f = 0.15 + rnd() * 0.35
      const phase = rnd() * Math.PI * 2
      const val = 0.5 + 0.5 * Math.sin((t * f + phase) * 2 * Math.PI)
      nodes[id] = { queue: clamp01(val) }
    }

    return { t, links, nodes }
  }

  private buildLayout(): Layout {
    // Simple topology: 2 switches in center, 6 hosts around
    const nodes: NodeDef[] = [
      { id: 's1', type: 'switch', x: 0.45, y: 0.45 },
      { id: 's2', type: 'switch', x: 0.55, y: 0.55 },
      { id: 'h1', type: 'host', x: 0.15, y: 0.25 },
      { id: 'h2', type: 'host', x: 0.15, y: 0.75 },
      { id: 'h3', type: 'host', x: 0.35, y: 0.15 },
      { id: 'h4', type: 'host', x: 0.75, y: 0.15 },
      { id: 'h5', type: 'host', x: 0.85, y: 0.35 },
      { id: 'h6', type: 'host', x: 0.85, y: 0.8 },
    ]
    const links: LinkDef[] = []
    const addLink = (a: string, b: string) => links.push({ id: `${a}-${b}` , a, b })
    addLink('s1', 's2')
    addLink('h1', 's1')
    addLink('h2', 's1')
    addLink('h3', 's1')
    addLink('h4', 's2')
    addLink('h5', 's2')
    addLink('h6', 's2')
    return { nodes, links }
  }

  private buildEvents(): NetworkEvent[] {
    const events: NetworkEvent[] = []
    const rnd = this.prng(this.seed + 1)
    const paths: string[][] = [
      ['h1', 's1', 's2', 'h6'],
      ['h2', 's1', 's2', 'h5'],
      ['h3', 's1', 's2', 'h4'],
      ['h4', 's2', 's1', 'h1'],
      ['h5', 's2', 's1', 'h2'],
      ['h6', 's2', 's1', 'h3'],
    ]
    for (let i = 0; i < 120; i++) {
      const t = rnd() * this.duration
      const path = paths[Math.floor(rnd() * paths.length)]
      const color = hsvToRgbHex(rnd(), 0.7, 1)
      events.push({ t, path, color })
    }
    // Sort by time for sequential emission
    events.sort((a, b) => a.t - b.t)
    return events
  }

  private prng(seed: number) {
    let s = seed >>> 0
    return () => {
      // xorshift32
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      return (s >>> 0) / 4294967295
    }
  }
}

function clamp01(x: number) {
  return Math.min(1, Math.max(0, x))
}

function hsvToRgbHex(h: number, s: number, v: number): number {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  let r = 0, g = 0, b = 0
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break
    case 1: r = q; g = v; b = p; break
    case 2: r = p; g = v; b = t; break
    case 3: r = p; g = q; b = v; break
    case 4: r = t; g = p; b = v; break
    case 5: r = v; g = p; b = q; break
  }
  const to255 = (x: number) => Math.round(x * 255)
  return (to255(r) << 16) | (to255(g) << 8) | to255(b)
}
