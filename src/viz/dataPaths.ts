import type { ScenarioSelection } from './scenarioTypes.ts'
import type { LinkDef, NodeDef } from './types.ts'

type MetricsNodeKind = LinkDef['metrics']['fromKind']

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment)
}

export function joinUrlSegments(...segments: string[]): string {
  const parts: string[] = []
  for (const segment of segments) {
    if (!segment) continue
    const split = segment.split('/')
    for (const piece of split) {
      if (!piece) continue
      parts.push(encodeSegment(piece))
    }
  }
  return parts.join('/')
}

export const PUBLIC_DATA_ROOT = 'data_public'

function selectionRoot(selection: ScenarioSelection): string[] {
  return [PUBLIC_DATA_ROOT, selection.scenario, 'data', selection.protocol, selection.load]
}

function qtsBase(selection: ScenarioSelection): string {
  return joinUrlSegments(...selectionRoot(selection), 'output', 'qts')
}

function hostSeriesBase(selection: ScenarioSelection, kind: 'budget_bytes' | 'credit_backlog'): string {
  return joinUrlSegments(
    ...selectionRoot(selection),
    'output',
    'cc',
    kind,
    `load_${selection.load}`,
  )
}

export function getDirectionCsvPath(
  selection: ScenarioSelection,
  startKind: MetricsNodeKind,
  startId: number,
  endKind: MetricsNodeKind,
  endId: number,
): string {
  const dirPath = joinUrlSegments(qtsBase(selection), startKind)
  const fileName = `qts_${startKind}_${startId}_${endKind}_${endId}.csv`
  return `${dirPath}/${fileName}`
}

export function getLinkDirectionPaths(
  selection: ScenarioSelection,
  link: LinkDef,
): { forward: string; reverse: string } {
  const forward = getDirectionCsvPath(
    selection,
    link.metrics.fromKind,
    link.metrics.fromId,
    link.metrics.toKind,
    link.metrics.toId,
  )
  const reverse = getDirectionCsvPath(
    selection,
    link.metrics.toKind,
    link.metrics.toId,
    link.metrics.fromKind,
    link.metrics.fromId,
  )
  return { forward, reverse }
}

export const HOST_SCALAR_SERIES = [
  { key: 'budget_bytes', kind: 'budget_bytes' as const, fileName: 'budget_bytes.csv' },
  { key: 'credit_backlog', kind: 'credit_backlog' as const, fileName: 'credit_backlog.csv' },
] as const

export type HostScalarSeriesKey = (typeof HOST_SCALAR_SERIES)[number]['key']

export function getHostScalarCsvPath(
  selection: ScenarioSelection,
  node: NodeDef,
  seriesKey: HostScalarSeriesKey,
): string | null {
  if (node.type !== 'host') return null
  const spec = HOST_SCALAR_SERIES.find((entry) => entry.key === seriesKey)
  if (!spec) return null
  const base = hostSeriesBase(selection, spec.kind)
  const hostDir = joinUrlSegments(base, `host_${node.metricsId}`)
  return `${hostDir}/${spec.fileName}`
}
