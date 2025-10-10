import './style.css'
import { initNetworkViz } from './viz/app.ts'

// Boot the visualization once DOM is ready
window.addEventListener('DOMContentLoaded', async () => {
  const container = document.querySelector<HTMLDivElement>('#app')!
  const timeLabel = document.getElementById('timeLabel') as HTMLSpanElement
  const playPauseBtn = document.getElementById('playPause') as HTMLButtonElement
  const resetBtn = document.getElementById('reset') as HTMLButtonElement
  const speedInput = document.getElementById('speed') as HTMLInputElement
  const speedVal = document.getElementById('speedVal') as HTMLSpanElement

  const controller = await initNetworkViz(container, {
    width: Math.min(window.innerWidth, 1280),
    height: Math.min(window.innerHeight - 64, 800),
    onTimeUpdate: (t) => {
      timeLabel.textContent = `t = ${t.toFixed(1)}s`
    },
  })

  // UI bindings
  playPauseBtn.onclick = () => {
    if (controller.isPlaying()) {
      controller.pause()
      playPauseBtn.textContent = 'Play'
    } else {
      controller.play()
      playPauseBtn.textContent = 'Pause'
    }
  }

  resetBtn.onclick = () => {
    controller.reset()
    playPauseBtn.textContent = 'Play'
  }

  const updateSpeed = () => {
    const s = Number(speedInput.value) || 1
    controller.setSpeed(s)
    speedVal.textContent = `${s}x`
  }
  speedInput.addEventListener('input', updateSpeed)
  updateSpeed()

  // Handle resize
  window.addEventListener('resize', () => {
    controller.resize(Math.min(window.innerWidth, 1280), Math.min(window.innerHeight - 64, 800))
  })
})
