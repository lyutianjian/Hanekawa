/**
 * The process boundary for a desktop shell.
 *
 * A host owns the runtime (filesystem, provider, tools, permission gate); a
 * client renders it. Everything between them is JSON, so the pair works over
 * Electron IPC, a `child_process` fork, a `MessagePort`, or nothing at all.
 * Nothing here imports Electron.
 */
export type { RuntimeChannel } from './channel.js'
export { createMemoryChannelPair } from './memoryChannel.js'
export { createNodeProcessChannel } from './nodeChannel.js'
export type { NodeIpcTarget } from './nodeChannel.js'
export { PendingRequests } from './pendingRequests.js'
export { SessionHost } from './host.js'
export type { SessionHostDeps } from './host.js'
export { toPermissionDto } from './permissionDto.js'
export type { PermissionDtoOptions } from './permissionDto.js'
export { SessionClient } from './client.js'
export type { SessionClientHandlers } from './client.js'
export { UI_REQUEST_FALLBACKS } from './wire.js'
export type {
  HostCommand,
  HostEvent,
  InterruptReason,
  PermissionRequestDto,
  UiRequest,
  UiResponse,
  WireBackgroundTasksResult,
  WireCheckpointsResult,
  WireEffortResult,
  WireHelloResult,
  WireModelInfo,
  WireModelsResult,
  WireReloadCountResult,
  WireReloadResult,
  WireReloadSettingsResult,
  WireResolveModelResult,
  WireRestoreCodeResult,
  WireRunOverrides,
  WireRunToolResult,
  WireRuntimeSnapshot,
  WireSessionSwitchResult,
  WireSessionsResult,
  WireTaskOutputResult,
  WireTaskResult,
} from './wire.js'
