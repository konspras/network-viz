export type DisplayOptionId =
  | 'queueLabels'
  | 'hostBuckets'
  | 'hostQueues'
  | 'torSpineQueues'
  | 'packetFlow'
  | 'spineDashboard'

export type DisplayOptions = Record<DisplayOptionId, boolean>

export type DisplayOptionDefinition = {
  id: DisplayOptionId
  label: string
  defaultValue: boolean
}

export const DISPLAY_OPTION_DEFS: readonly DisplayOptionDefinition[] = [
  { id: 'queueLabels', label: 'Queue Labels', defaultValue: true },
  { id: 'hostBuckets', label: 'Host Buckets', defaultValue: true },
  { id: 'hostQueues', label: 'Host Queues', defaultValue: true },
  { id: 'torSpineQueues', label: 'ToR <-> Spine Queues', defaultValue: true },
  { id: 'packetFlow', label: 'Packet Flow', defaultValue: true },
  { id: 'spineDashboard', label: 'Spine Dashboard', defaultValue: true },
] as const

export const DEFAULT_DISPLAY_OPTIONS: DisplayOptions = DISPLAY_OPTION_DEFS.reduce<DisplayOptions>(
  (acc, option) => {
    acc[option.id] = option.defaultValue
    return acc
  },
  {} as DisplayOptions,
)

export function normalizeDisplayOptions(overrides?: Partial<DisplayOptions>): DisplayOptions {
  return { ...DEFAULT_DISPLAY_OPTIONS, ...overrides }
}
