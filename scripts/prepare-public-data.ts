#!/usr/bin/env tsx

import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { makeLeafSpineLayout } from '../src/viz/topologies/leafSpine.ts'
import {
  getHostScalarCsvPath,
  getLinkDirectionPaths,
  HOST_SCALAR_SERIES,
  PUBLIC_DATA_ROOT,
} from '../src/viz/dataPaths.ts'
import type { ScenarioSelection } from '../src/viz/scenarioTypes.ts'

type ScenarioManifest = Record<string, Record<string, string[]>>

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const sourceRoot = path.join(repoRoot, 'data')
const publicRoot = path.join(repoRoot, PUBLIC_DATA_ROOT)

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function listDirectories(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
}

async function buildManifest(rootDir: string): Promise<ScenarioManifest> {
  const manifest: ScenarioManifest = {}
  const scenarios = await listDirectories(rootDir)
  for (const scenario of scenarios) {
    const protocolsDir = path.join(rootDir, scenario, 'data')
    const protocols = (await pathExists(protocolsDir)) ? await listDirectories(protocolsDir) : []
    const scenarioEntry: Record<string, string[]> = {}
    for (const protocol of protocols) {
      const loadsDir = path.join(protocolsDir, protocol)
      const loads = (await pathExists(loadsDir)) ? await listDirectories(loadsDir) : []
      scenarioEntry[protocol] = loads
    }
    manifest[scenario] = scenarioEntry
  }
  return manifest
}

function selectionFromParts(scenario: string, protocol: string, load: string): ScenarioSelection {
  return { scenario, protocol, load }
}

function asPosixSegments(filePath: string): string[] {
  return filePath.split('/').filter(Boolean)
}

async function copyFiles(filePaths: Iterable<string>) {
  let copied = 0
  let missingCount = 0
  const missingSamples: string[] = []
  for (const relativePath of filePaths) {
    const segments = asPosixSegments(relativePath)
    if (segments.length === 0) continue

    const destPath = path.join(repoRoot, ...segments)
    const srcSegments = [...segments]
    srcSegments[0] = 'data'
    const srcPath = path.join(repoRoot, ...srcSegments)

    if (!(await pathExists(srcPath))) {
      missingCount += 1
      if (missingSamples.length < 10) {
        missingSamples.push(path.relative(repoRoot, srcPath))
      }
      continue
    }

    await fs.mkdir(path.dirname(destPath), { recursive: true })
    await fs.copyFile(srcPath, destPath)
    copied += 1
  }
  if (missingCount > 0) {
    console.warn(
      `[prepare-public-data] ${missingCount} source file(s) were missing. Sample:`,
      missingSamples.join(', '),
    )
  }
  return copied
}

async function main() {
  if (!(await pathExists(sourceRoot))) {
    console.log('[prepare-public-data] No raw data directory found; skipping regeneration.')
    return
  }

  const manifest = await buildManifest(sourceRoot)
  const layout = makeLeafSpineLayout()
  const requiredFiles = new Set<string>()

  for (const [scenario, protocols] of Object.entries(manifest)) {
    for (const [protocol, loads] of Object.entries(protocols)) {
      for (const load of loads) {
        const selection = selectionFromParts(scenario, protocol, load)
        for (const link of layout.links) {
          const { forward, reverse } = getLinkDirectionPaths(selection, link)
          requiredFiles.add(forward)
          requiredFiles.add(reverse)
        }
        for (const node of layout.nodes) {
          for (const spec of HOST_SCALAR_SERIES) {
            const pathName = getHostScalarCsvPath(selection, node, spec.key)
            if (pathName) {
              requiredFiles.add(pathName)
            }
          }
        }
      }
    }
  }

  if (requiredFiles.size === 0) {
    console.log('[prepare-public-data] No files detected for copying; skipping.')
    return
  }

  await fs.rm(publicRoot, { recursive: true, force: true })
  await fs.mkdir(publicRoot, { recursive: true })

  const copied = await copyFiles(requiredFiles)
  console.log(`[prepare-public-data] Copied ${copied} file(s) into ${PUBLIC_DATA_ROOT}`)
}

main().catch((err) => {
  console.error('[prepare-public-data] Failed to build public data', err)
  process.exitCode = 1
})
