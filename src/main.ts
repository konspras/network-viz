import './style.css'
import { initNetworkViz } from './viz/app.ts'
import { scenarioNames, getProtocolsForScenario, getLoadsForScenario } from './scenarios.ts'

// Boot the visualization once DOM is ready
window.addEventListener('DOMContentLoaded', async () => {
  const container = document.querySelector<HTMLDivElement>('#app')!
  const timeLabel = document.getElementById('timeLabel') as HTMLSpanElement
  const playPauseBtn = document.getElementById('playPause') as HTMLButtonElement
  const resetBtn = document.getElementById('reset') as HTMLButtonElement
  const speedInput = document.getElementById('speed') as HTMLInputElement
  const speedVal = document.getElementById('speedVal') as HTMLSpanElement
  const scenarioSelect = document.getElementById('scenarioSelect') as HTMLSelectElement
  const protocolSelect = document.getElementById('protocolSelect') as HTMLSelectElement
  const loadSelect = document.getElementById('loadSelect') as HTMLSelectElement

  const setSelectOptions = (select: HTMLSelectElement | null, options: string[], emptyLabel: string, preferred?: string) => {
    if (!select) return ''
    select.innerHTML = ''
    if (options.length === 0) {
      const option = document.createElement('option')
      option.value = ''
      option.textContent = emptyLabel
      select.appendChild(option)
      select.disabled = true
      return ''
    }
    select.disabled = false
    const normalizedPreferred = preferred && options.includes(preferred) ? preferred : options[0]
    for (const value of options) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = value
      if (value === normalizedPreferred) option.selected = true
      select.appendChild(option)
    }
    select.value = normalizedPreferred
    return normalizedPreferred
  }

  const scenarioPlaceholder = 'No scenarios found'
  const protocolPlaceholder = 'No protocols available'
  const loadPlaceholder = 'No loads available'

  let selectedScenario = setSelectOptions(scenarioSelect, scenarioNames, scenarioPlaceholder)
  let selectedProtocol = ''
  let selectedLoad = ''

  const refreshProtocolOptions = (preferred?: string) => {
    const protocols = selectedScenario ? getProtocolsForScenario(selectedScenario) : []
    selectedProtocol = setSelectOptions(protocolSelect, protocols, protocolPlaceholder, preferred)
  }

  const refreshLoadOptions = (preferred?: string) => {
    const loads = selectedScenario && selectedProtocol ? getLoadsForScenario(selectedScenario, selectedProtocol) : []
    selectedLoad = setSelectOptions(loadSelect, loads, loadPlaceholder, preferred)
  }

  refreshProtocolOptions()
  refreshLoadOptions()

  const logSelection = () => {
    console.log(`Selected scenario: ${selectedScenario || '—'}, protocol: ${selectedProtocol || '—'}, load: ${selectedLoad || '—'}`)
  }
  logSelection()

  const controller = await initNetworkViz(container, {
    width: container.clientWidth,
    height: container.clientHeight,
    onTimeUpdate: (t) => {
      timeLabel.textContent = `t = ${t.toFixed(1)}s`
    },
  })

  // Force a layout sizing pass after styles settle
  controller.resize(container.clientWidth, container.clientHeight)

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

  if (scenarioSelect) {
    scenarioSelect.addEventListener('change', () => {
      selectedScenario = scenarioSelect.value
      refreshProtocolOptions()
      refreshLoadOptions()
      controller.pause()
      controller.reset()
      playPauseBtn.textContent = 'Play'
      logSelection()
    })
  }

  if (protocolSelect) {
    protocolSelect.addEventListener('change', () => {
      selectedProtocol = protocolSelect.value
      refreshLoadOptions()
      controller.pause()
      controller.reset()
      playPauseBtn.textContent = 'Play'
      logSelection()
    })
  }

  if (loadSelect) {
    loadSelect.addEventListener('change', () => {
      selectedLoad = loadSelect.value
      controller.pause()
      controller.reset()
      playPauseBtn.textContent = 'Play'
      logSelection()
    })
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
    controller.resize(container.clientWidth, container.clientHeight)
  })
})
