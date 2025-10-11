import { Application, Container } from 'pixi.js'
import { buildScene } from './scene.ts'
import { MockDataSource } from './data.ts'
import { makeLeafSpineLayout } from './topologies/leafSpine.ts'
import type { NetworkEvent } from './data.ts'

export type VizOptions = {
  width: number
  height: number
  onTimeUpdate?: (t: number) => void
}

export type VizController = {
  play: () => void
  pause: () => void
  reset: () => void
  isPlaying: () => boolean
  setSpeed: (s: number) => void
  resize: (w: number, h: number) => void
}

export async function initNetworkViz(el: HTMLElement, opts: VizOptions): Promise<VizController> {
  const app = new Application()
  await app.init({ width: opts.width, height: opts.height, background: '#0e1013', antialias: true })
  el.innerHTML = ''
  el.appendChild(app.canvas)

  // Data source (mocked time series and discrete events)
  const data = new MockDataSource(30, 42, makeLeafSpineLayout())

  // Scene graph
  const world = new Container()
  app.stage.addChild(world)
  const scene = buildScene(world, data.layout)

  // Playback state
  let playing = false
  let speed = 1
  let simTime = 0
  const duration = data.duration

  // Main ticker: advance time and update visuals based on time series
  app.ticker.add(() => {
    if (!playing) return
    const dt = (app.ticker.deltaMS / 1000) * speed
    simTime = Math.min(simTime + dt, duration)
    // Drive scene from time series
    const snapshot = data.sample(simTime)
    scene.update(snapshot, dt)
    opts.onTimeUpdate?.(simTime)
    if (simTime >= duration) {
      playing = false
    }
  })

  // Discrete event stream (packets) -> very light, use app.ticker for emission
  let lastEventIndex = 0
  app.ticker.add(() => {
    const events: NetworkEvent[] = data.events
    while (lastEventIndex < events.length && events[lastEventIndex].t <= simTime) {
      const ev = events[lastEventIndex++]
      scene.emitEvent(ev)
    }
  })

  // Initial render at t=0 and fit to container, then re-render with fitted layout
  scene.update(data.sample(0), 0)
  scene.layoutResize(opts.width, opts.height)
  scene.update(data.sample(0), 0)
  opts.onTimeUpdate?.(0)

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
      lastEventIndex = 0
  scene.reset()
      // re-fit to current canvas and render initial state
      scene.layoutResize(app.renderer.width, app.renderer.height)
      scene.update(data.sample(0), 0)
      opts.onTimeUpdate?.(0)
  },
    isPlaying: () => playing,
    setSpeed: (s: number) => {
      speed = Math.max(0.1, Math.min(10, s))
    },
    resize: (w: number, h: number) => {
      app.renderer.resize(w, h)
      scene.layoutResize(w, h)
      // re-render current snapshot so paused view stays correct
      scene.update(data.sample(simTime), 0)
    },
  }
}
