#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

function listDirectories(dir) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
}

function buildManifest(rootDir) {
  const manifest = {}
  const scenarios = listDirectories(rootDir)
  for (const scenario of scenarios) {
    const protocolsDir = path.join(rootDir, scenario, 'data')
    const protocols = listDirectories(protocolsDir)
    const scenarioEntry = {}
    for (const protocol of protocols) {
      const loadsDir = path.join(protocolsDir, protocol)
      const loads = listDirectories(loadsDir)
      scenarioEntry[protocol] = loads
    }
    manifest[scenario] = scenarioEntry
  }
  return manifest
}

function main() {
  const repoRoot = path.resolve(__dirname, '..')
  const dataDir = path.join(repoRoot, 'data')
  const outPath = path.join(repoRoot, 'src', 'scenarioManifest.json')

  const manifest = buildManifest(dataDir)

  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')

  console.log(`Scenario manifest written to ${path.relative(repoRoot, outPath)}`)
}

main()
