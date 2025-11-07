export type NodeType = 'host' | 'switch'

export type MetricsNodeKind = 'host' | 'tor' | 'aggr'

export type NodeDef = {
  id: string
  type: NodeType
  metricsId: number
  metricsKind: MetricsNodeKind
  // Normalized layout coordinates [0,1]
  x: number
  y: number
}

export type LinkDef = {
  id: string
  a: string
  b: string
  metrics: {
    fromId: number
    fromKind: MetricsNodeKind
    toId: number
    toKind: MetricsNodeKind
  }
}

export type Layout = {
  nodes: NodeDef[]
  links: LinkDef[]
}

export type LinkSnapshot = {
  aToB: number
  bToA: number
  queueA?: number
  queueB?: number
}

export type NodeSnapshot = {
  queue: number
  bucket?: number
  // True when host queue comes from a host-specific scalar series (not inferred from link queues)
  hostQueueFromScalar?: boolean
}

export type Snapshot = {
  t: number
  links: Record<string, LinkSnapshot>
  nodes: Record<string, NodeSnapshot>
}

export type NetworkEvent = {
  t: number
  path: string[]
  color?: number
}

export interface TimeSeriesDataSource {
  readonly layout: Layout
  readonly duration: number
  readonly events: NetworkEvent[]
  sample(t: number): Snapshot
  reset(): void
}
