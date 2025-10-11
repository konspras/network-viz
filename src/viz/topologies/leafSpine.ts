import type { Layout, NodeDef, LinkDef } from '../data.ts'

export function makeLeafSpineLayout(): Layout {
  const nodes: NodeDef[] = []
  const links: LinkDef[] = []

  // Spines on top
  const spines: NodeDef[] = [
    { id: 'sp1', type: 'switch', x: 0.3, y: 0.12 },
    { id: 'sp2', type: 'switch', x: 0.7, y: 0.12 },
  ]
  nodes.push(...spines)

  // Two ToRs in the middle
  const tors: NodeDef[] = [
    { id: 'tor1', type: 'switch', x: 0.3, y: 0.36 },
    { id: 'tor2', type: 'switch', x: 0.7, y: 0.36 },
  ]
  nodes.push(...tors)

  // Two racks of 16 servers each in a single horizontal line near the bottom
  const countPerRack: number = 16
  const yHosts = 0.82
  const line1Start = 0.08
  const line1End = 0.48
  const line2Start = 0.52
  const line2End = 0.92
  const servers1: NodeDef[] = []
  for (let i = 0; i < countPerRack; i++) {
    const t = i / (countPerRack - 1)
    const x = line1Start + (line1End - line1Start) * t
    const id = `r1s${String(i + 1).padStart(2, '0')}`
    servers1.push({ id, type: 'host', x, y: yHosts })
  }
  const servers2: NodeDef[] = []
  for (let i = 0; i < countPerRack; i++) {
    const t = i / (countPerRack - 1)
    const x = line2Start + (line2End - line2Start) * t
    const id = `r2s${String(i + 1).padStart(2, '0')}`
    servers2.push({ id, type: 'host', x, y: yHosts })
  }
  nodes.push(...servers1, ...servers2)

  // Links: each server to its ToR
  for (const s of servers1) links.push({ id: `${s.id}-tor1`, a: s.id, b: 'tor1' })
  for (const s of servers2) links.push({ id: `${s.id}-tor2`, a: s.id, b: 'tor2' })

  // ToR to both spines (leaf-spine full fanout)
  for (const sp of spines) {
    links.push({ id: `tor1-${sp.id}`, a: 'tor1', b: sp.id })
    links.push({ id: `tor2-${sp.id}`, a: 'tor2', b: sp.id })
  }

  return { nodes, links }
}
