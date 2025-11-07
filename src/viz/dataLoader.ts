import { makeLeafSpineLayout } from './topologies/leafSpine.ts'
import type { Layout, LinkSnapshot, Snapshot, TimeSeriesDataSource } from './types.ts'
import type { ScenarioSelection } from './scenarioTypes.ts'
import {
  getHostScalarCsvPath,
  getLinkDirectionPaths,
  HOST_SCALAR_SERIES,
  type HostScalarSeriesKey,
} from './dataPaths.ts'
import hostSeriesAvailability from './hostSeriesAvailability.json' assert { type: 'json' }

const missingScalarResources = new Set<string>()

const HTML_SNIFF_RE = /^\s*<(?:!DOCTYPE\s+html|html)/i

function isHtmlPayload(contentType: string | null, body: string): boolean {
  if (contentType && contentType.toLowerCase().includes('text/html')) return true
  return HTML_SNIFF_RE.test(body)
}

function hostScalarExists(
  selection: ScenarioSelection,
  seriesKey: HostScalarSeriesKey,
  metricsId: number,
): boolean {
  const scenarioEntry = (hostSeriesAvailability as Record<string, any>)[selection.scenario]
  if (!scenarioEntry) return false
  const protocolEntry = scenarioEntry[selection.protocol]
  if (!protocolEntry) return false
  const loadEntry = protocolEntry[selection.load]
  if (!loadEntry) return false
  const hosts: unknown = loadEntry[seriesKey]
  if (!Array.isArray(hosts)) return false
  return hosts.includes(metricsId)
}

type DirectionSeries = {
  throughput: Float32Array
  queue: Float32Array
}

type LinkSeries = {
  link: Layout['links'][number]
  forward: DirectionSeries
  reverse: DirectionSeries
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

  const nodes: Record<string, { queue: number; bucket?: number; hostQueueFromScalar?: boolean }> = {}
    for (const node of this.layout.nodes) {
      const count = nodeQueueCount[node.id]
      const avg = count > 0 ? nodeQueueSum[node.id] / count : 0
      let bucketValue: number | undefined
      let hostQueueValue: number | undefined
      let hostQueueFromScalar = false
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
          hostQueueFromScalar = true
        }
      }
      const queueValue = node.type === 'host' ? Math.max(0, hostQueueValue ?? avg) : Math.max(0, avg)
      nodes[node.id] = { queue: queueValue, bucket: bucketValue, hostQueueFromScalar }
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

  const loadDirectionSeries = async (url: string): Promise<DirectionSeries> => {
    const response = await fetch(url)
    if (!response.ok) {
      if (!timestamps) {
        throw new Error(`Missing baseline CSV: ${url}`)
      }
      console.warn(`Missing CSV ${url}, substituting zeros`)
      return createZeroSeries(timestamps.length)
    }
    const text = await response.text()
    if (isHtmlPayload(response.headers.get('content-type'), text)) {
      if (!timestamps) {
        throw new Error(`CSV ${url} returned HTML instead of data`)
      }
      console.warn(`CSV ${url} returned HTML; substituting zeros`)
      return createZeroSeries(timestamps.length)
    }
    console.log('[viz] Fetched CSV bytes', { url, length: text.length })
    const parsed = parseCsv(text, timestamps)
    if (!timestamps) {
      if (!parsed.timestamps) {
        throw new Error(`CSV ${url} did not provide timestamps`)
      }
      timestamps = parsed.timestamps
      zeroBaseTimestamps(timestamps)
    } else if (parsed.throughput.length !== timestamps.length) {
      const actual = parsed.throughput.length
      const expected = timestamps.length
      const diff = actual - expected
      const mode = actual > expected ? 'truncating' : 'padding'
      console.warn(
        `[viz] CSV length mismatch for link series\n` +
        `  file: ${url}\n` +
        `  expected rows (excluding header): ${expected}\n` +
        `  actual rows: ${actual}\n` +
        `  delta: ${diff} (${mode})\n` +
        `  action: ${actual > expected ? 'extra rows removed' : 'missing rows filled with 0'}\n` +
        `  note: baseline timestamps length comes from first successfully loaded CSV.`,
      )
      if (actual > expected) {
        parsed.throughput = parsed.throughput.subarray(0, expected)
        parsed.queue = parsed.queue.subarray(0, expected)
      } else {
        // pad missing rows with zeros to align to baseline
        const paddedThroughput = new Float32Array(expected)
        paddedThroughput.set(parsed.throughput)
        parsed.throughput = paddedThroughput
        const paddedQueue = new Float32Array(expected)
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
    const { forward: forwardPath, reverse: reversePath } = getLinkDirectionPaths(selection, link)
    const [forward, reverse] = await Promise.all([
      loadDirectionSeries(forwardPath),
      loadDirectionSeries(reversePath),
    ])
    series.set(link.id, { link, forward, reverse })
  }

  if (!timestamps) {
    throw new Error('Unable to load any CSV time series (timestamps missing)')
  }
  const baselineTimestamps = timestamps

  const hostNodes = layout.nodes.filter((node) => node.type === 'host')
  const loadHostScalarSeries = async (
    seriesKey: (typeof HOST_SCALAR_SERIES)[number]['key'],
    target: Map<number, Float32Array>,
  ) => {
    await Promise.all(
      hostNodes.map(async (node) => {
        const url = getHostScalarCsvPath(selection, node, seriesKey)
        if (!url) return
        if (missingScalarResources.has(url)) return
        if (!hostScalarExists(selection, seriesKey, node.metricsId)) {
          missingScalarResources.add(url)
          return
        }
        try {
          const response = await fetch(url)
          if (!response.ok) {
            if (response.status !== 404) {
              console.info(`Host ${seriesKey} CSV missing (${response.status}): ${url}`)
            }
            missingScalarResources.add(url)
            return
          }
          const text = await response.text()
          if (isHtmlPayload(response.headers.get('content-type'), text)) {
            missingScalarResources.add(url)
            return
          }
          const parsed = parseScalarCsv(text, baselineTimestamps)
          let values = parsed.values
          if (values.length !== baselineTimestamps.length) {
            const actual = values.length
            const expected = baselineTimestamps.length
            const diff = actual - expected
            const mode = actual > expected ? 'truncating' : 'padding'
            console.warn(
              `[viz] Host scalar CSV length mismatch (${seriesKey})\n` +
              `  file: ${url}\n` +
              `  host metricsId: ${node.metricsId}\n` +
              `  expected rows: ${expected}\n` +
              `  actual rows: ${actual}\n` +
              `  delta: ${diff} (${mode})\n` +
              `  action: ${actual > expected ? 'extra rows removed' : 'missing rows filled with 0'}\n` +
              `  note: baseline derived from first link CSV timestamps.`,
            )
            if (actual > expected) {
              values = values.subarray(0, expected)
            } else {
              const padded = new Float32Array(expected)
              padded.set(values)
              values = padded
            }
          }
          target.set(node.metricsId, values)
        } catch (err) {
          console.warn(`Error loading host ${seriesKey} CSV ${url}`, err)
        }
      }),
    )
  }

  await loadHostScalarSeries('budget_bytes', hostBudgetSeries)
  await loadHostScalarSeries('credit_backlog', hostQueueSeries)

  console.log('[viz] Loaded scenario data', {
    scenario: selection.scenario,
    protocol: selection.protocol,
    load: selection.load,
    links: series.size,
  })

  return new CsvDataSource(layout, baselineTimestamps, series, hostBudgetSeries, hostQueueSeries)
}
