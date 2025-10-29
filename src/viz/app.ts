import { Application, Container } from 'pixi.js'
import { buildScene } from './scene.ts'
import type { TimeSeriesDataSource } from './types.ts'

export type VizOptions = {
  width: number
  height: number
  data: TimeSeriesDataSource
  onTimeUpdate?: (t: number) => void
}

export type VizController = {
  play: () => void
  pause: () => void
  reset: () => void
  isPlaying: () => boolean
  setSpeed: (s: number) => void
  resize: (w: number, h: number) => void
  setDataSource: (data: TimeSeriesDataSource) => void
}

export async function initNetworkViz(el: HTMLElement, opts: VizOptions): Promise<VizController> {
  const app = new Application()
  await app.init({ width: opts.width, height: opts.height, background: '#0e1013', antialias: true })
  el.innerHTML = ''
  el.appendChild(app.canvas)
  const textureGC = (app.renderer as any)?.textureGC
  if (textureGC) {
    textureGC.maxIdle = 30
    textureGC.checkCountMax = 30
    console.log('[viz] texture GC tuned', { maxIdle: textureGC.maxIdle, checkCountMax: textureGC.checkCountMax })
  }
  if (!app.ticker.started) {
    app.ticker.start()
    console.log('[viz] Pixi ticker started explicitly')
  }

  let data = opts.data

  // Scene graph
  const world = new Container()
  app.stage.addChild(world)
  const scene = buildScene(world, data.layout)

  // Playback state
  let playing = false
  let speed = 1
  let simTime = 0
  let duration = data.duration
  console.log('[viz] initNetworkViz', { duration, width: opts.width, height: opts.height })

  data.reset()

  const renderSnapshot = (time: number) => {
    const snapshot = data.sample(time)
    scene.update(snapshot)
  }

  const notifyTime = (time: number) => {
    opts.onTimeUpdate?.(time)
  }

  // Main ticker: advance time and update visuals based on time series
  app.ticker.add(() => {
    if (!playing) return
    const dt = (app.ticker.deltaMS / 1000) * speed
    simTime = Math.min(simTime + dt, duration)
    renderSnapshot(simTime)
    notifyTime(simTime)
    if (simTime >= duration) {
      playing = false
    }
  })

  const debugTracker = { frames: 0 }
  app.ticker.add(() => {
    debugTracker.frames++
    if (debugTracker.frames % 120 !== 0) return
    if (textureGC && textureGC.active) {
      textureGC.run()
    }
  })

  // Initial render at t=0 and fit to container, then re-render with fitted layout
  renderSnapshot(0)
  scene.layoutResize(opts.width, opts.height)
  renderSnapshot(0)
  notifyTime(0)

  return {
    play: () => {
      playing = true
    },
    pause: () => {
      playing = false
    },
    reset: () => {
      playing = false
      simTime = 0
      data.reset()
      scene.reset()
      scene.layoutResize(app.renderer.width, app.renderer.height)
      renderSnapshot(0)
      notifyTime(0)
    },
    isPlaying: () => playing,
    setSpeed: (s: number) => {
      const minSpeed = 1e-9
      speed = Math.max(minSpeed, Math.min(10, s))
      console.log('[viz] speed updated', { input: s, clamped: speed })
    },
    resize: (w: number, h: number) => {
      app.renderer.resize(w, h)
      scene.layoutResize(w, h)
      renderSnapshot(simTime)
    },
    setDataSource: (next) => {
      playing = false
      simTime = 0
      data = next
      duration = data.duration
      data.reset()
      scene.reset()
      renderSnapshot(0)
      notifyTime(0)
      console.log('[viz] data source swapped', { duration })
    },
  }
}
