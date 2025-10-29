import './style.css'
import { initNetworkViz, type VizController } from './viz/app.ts'
import { loadScenarioData, type ScenarioSelection } from './viz/dataLoader.ts'
import { scenarioNames, getProtocolsForScenario, getLoadsForScenario } from './scenarios.ts'

const scenarioPlaceholder = 'No scenarios found'
const protocolPlaceholder = 'No protocols available'
const loadPlaceholder = 'No loads available'

function setSelectOptions(select: HTMLSelectElement | null, options: string[], emptyLabel: string, preferred?: string): string {
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

// Boot the visualization once DOM is ready
window.addEventListener('DOMContentLoaded', async () => {
  const container = document.querySelector<HTMLDivElement>('#app')!
  const timeLabel = document.getElementById('timeLabel') as HTMLSpanElement
  const playPauseBtn = document.getElementById('playPause') as HTMLButtonElement
  const resetBtn = document.getElementById('reset') as HTMLButtonElement
  const speedInput = document.getElementById('speed') as HTMLInputElement
  const speedVal = document.getElementById('speedVal') as HTMLSpanElement
  const speedDownBtn = document.getElementById('speedDown') as HTMLButtonElement
  const speedUpBtn = document.getElementById('speedUp') as HTMLButtonElement
  const scenarioSelect = document.getElementById('scenarioSelect') as HTMLSelectElement
  const protocolSelect = document.getElementById('protocolSelect') as HTMLSelectElement
  const loadSelect = document.getElementById('loadSelect') as HTMLSelectElement

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

  const currentSelection = (): ScenarioSelection | null => {
    if (!selectedScenario || !selectedProtocol || !selectedLoad) return null
    return { scenario: selectedScenario, protocol: selectedProtocol, load: selectedLoad }
  }

  const logSelection = () => {
    console.log(`[viz] Selection -> scenario: ${selectedScenario || '—'}, protocol: ${selectedProtocol || '—'}, load: ${selectedLoad || '—'}`)
  }

  const denomMin = 1e2
  const denomMax = 1e6
  const exponentMin = Math.log10(denomMin)
  const exponentMax = Math.log10(denomMax)
  const numberFormatter = new Intl.NumberFormat('en-US')

  let currentExponent = Math.min(exponentMax, Math.max(exponentMin, Number(speedInput?.value) || 5))
  let currentDenom = 0

  const exponentToDenom = (exp: number) => {
    const raw = Math.pow(10, exp)
    const clamped = Math.max(denomMin, Math.min(denomMax, raw))
    return Math.max(denomMin, Math.min(denomMax, Math.round(clamped / 10) * 10))
  }

  const updateSpeedLabel = () => {
    speedVal.textContent = `1/${numberFormatter.format(currentDenom)}x`
  }

  const applyTimeScale = () => {
    currentDenom = exponentToDenom(currentExponent)
    if (speedInput) speedInput.value = currentExponent.toFixed(2)
    updateSpeedLabel()
    if (controller) {
      controller.setSpeed(1 / currentDenom)
    }
    console.log('[viz] Time scale set', { denom: currentDenom, factor: 1 / currentDenom })
  }

  const setControlsDisabled = (disabled: boolean) => {
    playPauseBtn.disabled = disabled
    resetBtn.disabled = disabled
    speedInput.disabled = disabled
    if (speedDownBtn) speedDownBtn.disabled = disabled
    if (speedUpBtn) speedUpBtn.disabled = disabled
  }

  let currentDuration = 0

  const updateTimeLabel = (t: number) => {
    const micros = t * 1_000_000
    const completion = currentDuration > 0 ? Math.min(100, Math.max(0, (t / currentDuration) * 100)) : 0
    timeLabel.textContent = `t = ${micros.toFixed(1)} µs (${completion.toFixed(1)}%)`
  }

  let controller: VizController | null = null
  let handlersBound = false
  let loadRequestId = 0

  const bindControllerHandlers = () => {
    if (handlersBound || !controller) return
    handlersBound = true

    playPauseBtn.onclick = () => {
      console.log('[viz] Play button pressed')
      if (!controller) return
      if (controller.isPlaying()) {
        controller.pause()
        playPauseBtn.textContent = 'Play'
        console.log('[viz] Paused')
      } else {
        controller.play()
        playPauseBtn.textContent = 'Pause'
        console.log('[viz] Playing')
      }
    }

    resetBtn.onclick = () => {
      console.log('[viz] Reset invoked')
      if (!controller) return
      controller.reset()
      playPauseBtn.textContent = 'Play'
    }

    window.addEventListener('resize', () => {
      if (!controller) return
      controller.resize(container.clientWidth, container.clientHeight)
    })

    applyTimeScale()
  }

  const setLoading = (loading: boolean) => {
    setControlsDisabled(loading || !controller)
    if (loading) {
      playPauseBtn.textContent = 'Play'
      timeLabel.textContent = 'Loading…'
    }
  }

  const loadAndApply = async (selection: ScenarioSelection, initial = false) => {
    const token = ++loadRequestId
    setLoading(true)
    try {
      const data = await loadScenarioData(selection)
      currentDuration = data.duration ?? 0
      if (token !== loadRequestId) return
      if (!controller || initial) {
        controller = await initNetworkViz(container, {
          width: container.clientWidth,
          height: container.clientHeight,
          data,
          onTimeUpdate: updateTimeLabel,
        })
        controller.resize(container.clientWidth, container.clientHeight)
        bindControllerHandlers()
      } else {
        controller.pause()
        controller.setDataSource(data)
        playPauseBtn.textContent = 'Play'
        updateTimeLabel(0)
      }
      applyTimeScale()
      logSelection()
      console.log('[viz] Data applied to controller', { duration: (data as any).duration })
    } catch (err) {
      console.error(err)
      if (token === loadRequestId) {
        timeLabel.textContent = 'Failed to load data'
      }
    } finally {
      if (token === loadRequestId) {
        setLoading(false)
      }
    }
  }

  const triggerReload = () => {
    const selection = currentSelection()
    if (!selection) return
    loadAndApply(selection)
  }

  if (scenarioSelect) {
    scenarioSelect.addEventListener('change', () => {
      selectedScenario = scenarioSelect.value
      refreshProtocolOptions()
      refreshLoadOptions()
      triggerReload()
    })
  }

  if (protocolSelect) {
    protocolSelect.addEventListener('change', () => {
      selectedProtocol = protocolSelect.value
      refreshLoadOptions()
      triggerReload()
    })
  }

  if (loadSelect) {
    loadSelect.addEventListener('change', () => {
      selectedLoad = loadSelect.value
      triggerReload()
    })
  }

  const initialSelection = currentSelection()
  if (initialSelection) {
    await loadAndApply(initialSelection, true)
  } else {
    timeLabel.textContent = 'No data available'
    setControlsDisabled(true)
  }

  if (speedInput) {
    speedInput.addEventListener('input', () => {
      currentExponent = Math.min(exponentMax, Math.max(exponentMin, Number(speedInput.value) || currentExponent))
      applyTimeScale()
    })
  }
  speedDownBtn?.addEventListener('click', () => {
    currentExponent = Math.min(exponentMax, currentExponent + 1)
    applyTimeScale()
  })
  speedUpBtn?.addEventListener('click', () => {
    currentExponent = Math.max(exponentMin, currentExponent - 1)
    applyTimeScale()
  })

  applyTimeScale()
})
