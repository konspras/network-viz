import manifest from './scenarioManifest.json'

type ScenarioManifest = Record<string, Record<string, string[]>>

const scenarioManifest = manifest as ScenarioManifest

export const scenarioNames = Object.keys(scenarioManifest).sort()

export function getProtocolsForScenario(name: string): string[] {
  return scenarioManifest[name] ? Object.keys(scenarioManifest[name]).sort() : []
}

export function getLoadsForScenario(scenario: string, protocol: string): string[] {
  const loads = scenarioManifest[scenario]?.[protocol] ?? []
  return loads.slice().sort((a, b) => {
    const na = Number(a)
    const nb = Number(b)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
    return a.localeCompare(b)
  })
}
