import type { Tool } from '../harness/types.js'
import type { CoordinationHost } from '../runtime/protocol/coordinationHost.js'
import { createAskCoordinatorTool } from './AskCoordinatorTool/AskCoordinatorTool.js'
import { createFetchThreadTool } from './FetchThreadTool/FetchThreadTool.js'
import { createListThreadsTool } from './ListThreadsTool/ListThreadsTool.js'
import { createMessageThreadTool } from './MessageThreadTool/MessageThreadTool.js'
import { createResolveThreadTool } from './ResolveThreadTool/ResolveThreadTool.js'
import { createStartThreadTool } from './StartThreadTool/StartThreadTool.js'
import { createStopThreadTool } from './StopThreadTool/StopThreadTool.js'

/**
 * The seven coordination tools, bound to a host. Not part of the shared
 * registry: a shell injects them through `BootstrapOptions.extraTools`, and the
 * `sessionRoles` filter keeps each to the role it is for.
 */
export function createCoordinationTools(host: CoordinationHost): Tool[] {
  return [
    createStartThreadTool(host),
    createMessageThreadTool(host),
    createStopThreadTool(host),
    createResolveThreadTool(host),
    createListThreadsTool(host),
    createFetchThreadTool(host),
    createAskCoordinatorTool(host),
  ]
}
