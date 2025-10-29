import { makeLeafSpineLayout } from './topologies/leafSpine.ts'
import type { Layout, LinkSnapshot, Snapshot, TimeSeriesDataSource } from './types.ts'

type DirectionSeries = {
  throughput: Float32Array
  queue: Float32Array
}

type LinkSeries = {
  link: Layout['links'][number]
  forward: DirectionSeries
  reverse: DirectionSeries
}

export type ScenarioSelection = {
  scenario: string
  protocol: string
  load: string
}

function encodeSegment(segment: string) {
  return encodeURIComponent(segment)
}

function joinUrlSegments(...segments: string[]) {
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

function parseCsv(
  text: string,
  reuseTimestamps?: Float64Array,
): { timestamps?: Float64Array; throughput: Float32Array; queue: Float32Array } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length <= 1) {
    throw new Error('CSV missing data rows')
  }
  const count = lines.length - 1
  const throughput = new Float32Array(count)
  const queue = new Float32Array(count)
  let timestamps: Float64Array | undefined
  if (!reuseTimestamps) {
    timestamps = new Float64Array(count)
  }

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',')
    if (parts.length < 3) continue
    if (!reuseTimestamps && timestamps) {
      timestamps[i - 1] = Number(parts[0])
    }
    throughput[i - 1] = Number(parts[1])
    queue[i - 1] = Number(parts[2])
  }
  return { timestamps, throughput, queue }
}

function createZeroSeries(length: number): DirectionSeries {
  return {
    throughput: new Float32Array(length),
    queue: new Float32Array(length),
  }
}

function zeroBaseTimestamps(ts: Float64Array) {
  if (!ts.length) return
  const offset = ts[0]
  if (!Number.isFinite(offset) || offset === 0) return
  for (let i = 0; i < ts.length; i++) {
    ts[i] -= offset
  }
}

function parseScalarCsv(
  text: string,
  reuseTimestamps?: Float64Array,
): { timestamps?: Float64Array; values: Float32Array } {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length <= 1) {
    throw new Error('Scalar CSV missing data rows')
  }
  const count = lines.length - 1
  const values = new Float32Array(count)
  let timestamps: Float64Array | undefined
  if (!reuseTimestamps) {
    timestamps = new Float64Array(count)
  }
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',')
    if (parts.length < 2) continue
    if (!reuseTimestamps && timestamps) {
      timestamps[i - 1] = Number(parts[0])
    }
    values[i - 1] = Number(parts[1])
  }
  return { timestamps, values }
}

class CsvDataSource implements TimeSeriesDataSource {
  readonly layout: Layout
  readonly events = []
  readonly duration: number

  private readonly timestamps: Float64Array
  private readonly linkSeries: Map<string, LinkSeries>
  private readonly hostBudgetSeries: Map<number, Float32Array>
  private readonly hostQueueSeries: Map<number, Float32Array>
  private lastIndex = 0
  private lastTime = 0

  constructor(
    layout: Layout,
    timestamps: Float64Array,
    series: Map<string, LinkSeries>,
    hostBudgets: Map<number, Float32Array>,
    hostQueues: Map<number, Float32Array>,
  ) {
    this.layout = layout
    this.timestamps = timestamps
    this.linkSeries = series
    this.hostBudgetSeries = hostBudgets
    this.hostQueueSeries = hostQueues
    let duration = 0
    if (timestamps.length) {
      duration = timestamps[timestamps.length - 1]
      console.log('[viz] last timestamp:', duration)
      if (!(duration > 0)) {
        for (let i = 0; i < timestamps.length; i++) {
          if (timestamps[i] > duration) duration = timestamps[i]
        }
        console.log('[viz] duration recomputed via scan', duration)
      }
    }
    this.duration = duration
  }

  reset(): void {
    this.lastIndex = 0
    this.lastTime = 0
  }

  private locateIndex(time: number): number {
    const clampedTime = Math.max(0, Math.min(time, this.duration))
    if (clampedTime < this.lastTime) {
      this.lastIndex = 0
    }
    const ts = this.timestamps
    while (this.lastIndex < ts.length - 2 && clampedTime > ts[this.lastIndex + 1]) {
      this.lastIndex++
    }
    this.lastTime = clampedTime
    return this.lastIndex
  }

  private interpolate(series: Float32Array, idx: number, nextIdx: number, frac: number): number {
    const v0 = series[idx] ?? 0
    const v1 = series[nextIdx] ?? v0
    return v0 + (v1 - v0) * frac
  }

  sample(time: number): Snapshot {
    if (this.timestamps.length === 0) {
      return { t: 0, links: {}, nodes: {} }
    }
    const clamped = Math.max(0, Math.min(time, this.duration))
    const idx = this.locateIndex(clamped)
    const nextIdx = Math.min(idx + 1, this.timestamps.length - 1)
    const t0 = this.timestamps[idx]
    const t1 = this.timestamps[nextIdx]
    const span = t1 > t0 ? t1 - t0 : 1
    const frac = span > 0 ? Math.min(1, Math.max(0, (clamped - t0) / span)) : 0

    const links: Record<string, LinkSnapshot> = {}
    const nodeQueueSum: Record<string, number> = {}
    const nodeQueueCount: Record<string, number> = {}

    for (const node of this.layout.nodes) {
      nodeQueueSum[node.id] = 0
      nodeQueueCount[node.id] = 0
    }

    for (const link of this.layout.links) {
      const data = this.linkSeries.get(link.id)
      if (!data) continue
      const forwardSeries = data.forward
      const reverseSeries = data.reverse

      const aToB = this.interpolate(forwardSeries.throughput, idx, nextIdx, frac)
      const bToA = this.interpolate(reverseSeries.throughput, idx, nextIdx, frac)
      const queueA = Math.max(0, this.interpolate(forwardSeries.queue, idx, nextIdx, frac))
      const queueB = Math.max(0, this.interpolate(reverseSeries.queue, idx, nextIdx, frac))

      const forwardValue = Math.max(0, aToB)
      const reverseValue = Math.max(0, bToA)

      links[link.id] = {
        aToB: forwardValue,
        bToA: reverseValue,
        queueA,
        queueB,
      }

      nodeQueueSum[link.a] += queueA
      nodeQueueCount[link.a] += 1

      nodeQueueSum[link.b] += queueB
      nodeQueueCount[link.b] += 1
    }

    const nodes: Record<string, { queue: number; bucket?: number }> = {}
    for (const node of this.layout.nodes) {
      const count = nodeQueueCount[node.id]
      const avg = count > 0 ? nodeQueueSum[node.id] / count : 0
      let bucketValue: number | undefined
      let hostQueueValue: number | undefined
      if (node.type === 'host') {
        const budgetSeries = this.hostBudgetSeries.get(node.metricsId)
        if (budgetSeries) {
          const interpolated = this.interpolate(budgetSeries, idx, nextIdx, frac)
          bucketValue = Math.max(0, interpolated)
        }
        const queueSeries = this.hostQueueSeries.get(node.metricsId)
        if (queueSeries) {
          const interpolatedQueue = this.interpolate(queueSeries, idx, nextIdx, frac)
          hostQueueValue = Math.max(0, interpolatedQueue)
        }
      }
      const queueValue = node.type === 'host' ? Math.max(0, hostQueueValue ?? avg) : Math.max(0, avg)
      nodes[node.id] = { queue: queueValue, bucket: bucketValue }
    }

    return { t: clamped, links, nodes }
  }
}

export async function loadScenarioData(selection: ScenarioSelection): Promise<TimeSeriesDataSource> {
  const layout = makeLeafSpineLayout()
  const series = new Map<string, LinkSeries>()
  const hostBudgetSeries = new Map<number, Float32Array>()
  const hostQueueSeries = new Map<number, Float32Array>()
  let timestamps: Float64Array | undefined

  const basePath = joinUrlSegments(
    'data',
    selection.scenario,
    'data',
    selection.protocol,
    selection.load,
    'output',
    'qts',
  )

  const ensureDirection = async (
    startKind: string,
    startId: number,
    endKind: string,
    endId: number,
  ): Promise<DirectionSeries> => {
    const dirPath = joinUrlSegments(basePath, startKind)
    const fileName = `qts_${startKind}_${startId}_${endKind}_${endId}.csv`
    const url = `${dirPath}/${fileName}`
    const response = await fetch(url)
    if (!response.ok) {
      if (!timestamps) {
        throw new Error(`Missing baseline CSV: ${url}`)
      }
      console.warn(`Missing CSV ${url}, substituting zeros`)
      return createZeroSeries(timestamps.length)
    }
    const text = await response.text()
    console.log('[viz] Fetched CSV bytes', { url, length: text.length })
    const parsed = parseCsv(text, timestamps)
    if (!timestamps) {
      if (!parsed.timestamps) {
        throw new Error(`CSV ${url} did not provide timestamps`)
      }
      timestamps = parsed.timestamps
      zeroBaseTimestamps(timestamps)
    } else if (parsed.throughput.length !== timestamps.length) {
      console.warn(`CSV ${url} has mismatched length; truncating to baseline`)
      if (parsed.throughput.length > timestamps.length) {
        parsed.throughput = parsed.throughput.subarray(0, timestamps.length)
        parsed.queue = parsed.queue.subarray(0, timestamps.length)
      } else {
        // pad
        const paddedThroughput = new Float32Array(timestamps.length)
        paddedThroughput.set(parsed.throughput)
        parsed.throughput = paddedThroughput
        const paddedQueue = new Float32Array(timestamps.length)
        paddedQueue.set(parsed.queue)
        parsed.queue = paddedQueue
      }
    }
    return {
      throughput: parsed.throughput,
      queue: parsed.queue,
    }
  }

  for (const link of layout.links) {
    const forwardPromise = ensureDirection(
      link.metrics.fromKind,
      link.metrics.fromId,
      link.metrics.toKind,
      link.metrics.toId,
    )
    const reversePromise = ensureDirection(
      link.metrics.toKind,
      link.metrics.toId,
      link.metrics.fromKind,
      link.metrics.fromId,
    )
    const [forward, reverse] = await Promise.all([forwardPromise, reversePromise])
    series.set(link.id, { link, forward, reverse })
  }

  if (!timestamps) {
    throw new Error('Unable to load any CSV time series (timestamps missing)')
  }
  const baselineTimestamps = timestamps

  const hostNodes = layout.nodes.filter((node) => node.type === 'host')
  const loadHostScalarSeries = async (
    basePath: string,
    fileStem: string,
    target: Map<number, Float32Array>,
  ) => {
    await Promise.all(
      hostNodes.map(async (node) => {
        const hostPath = joinUrlSegments(basePath, `host_${node.metricsId}`)
        const url = `${hostPath}/${fileStem}.csv`
        try {
          const response = await fetch(url)
          if (!response.ok) {
            if (response.status !== 404) {
              console.warn(`Unable to fetch host ${fileStem} CSV (${response.status}): ${url}`)
            }
            return
          }
          const text = await response.text()
          const parsed = parseScalarCsv(text, baselineTimestamps)
          let values = parsed.values
          if (values.length !== baselineTimestamps.length) {
            console.warn(`Host ${fileStem} CSV length mismatch, adjusting to baseline: ${url}`)
            if (values.length > baselineTimestamps.length) {
              values = values.subarray(0, baselineTimestamps.length)
            } else {
              const padded = new Float32Array(baselineTimestamps.length)
              padded.set(values)
              values = padded
            }
          }
          target.set(node.metricsId, values)
        } catch (err) {
          console.warn(`Error loading host ${fileStem} CSV ${url}`, err)
        }
      }),
    )
  }

  const budgetBasePath = joinUrlSegments(
    'data',
    selection.scenario,
    'data',
    selection.protocol,
    selection.load,
    'output',
    'cc',
    'budget_bytes',
    `load_${selection.load}`,
  )
  await loadHostScalarSeries(budgetBasePath, 'budget_bytes', hostBudgetSeries)

  const creditBasePath = joinUrlSegments(
    'data',
    selection.scenario,
    'data',
    selection.protocol,
    selection.load,
    'output',
    'cc',
    'credit_backlog',
    `load_${selection.load}`,
  )
  await loadHostScalarSeries(creditBasePath, 'credit_backlog', hostQueueSeries)

  console.log('[viz] Loaded scenario data', {
    scenario: selection.scenario,
    protocol: selection.protocol,
    load: selection.load,
    links: series.size,
  })

  return new CsvDataSource(layout, baselineTimestamps, series, hostBudgetSeries, hostQueueSeries)
}
