import { grepTool } from './grep.js'
import { globTool } from './glob.js'
import { bashTool } from './bash.js'
import { readFileTool } from './readFile.js'
import { writeFileTool } from './writeFile.js'
import { editFileTool } from './editFile.js'
import { multiEditTool } from './multiEdit.js'
import { deleteFileTool } from './deleteFile.js'
import { exitPlanModeTool } from './exitPlanMode.js'
import { enterPlanModeTool } from './enterPlanMode.js'
import { askUserQuestionTool } from './askUserQuestion.js'
import { createSkillTool } from './skillTool.js'
import { taskCreateTool } from './TaskCreateTool/TaskCreateTool.js'
import { taskGetTool } from './TaskGetTool/TaskGetTool.js'
import { taskListTool } from './TaskListTool/TaskListTool.js'
import { taskUpdateTool } from './TaskUpdateTool/TaskUpdateTool.js'
import { toolSearchTool } from './ToolSearchTool/ToolSearchTool.js'
import { webFetchTool } from './webFetch.js'
import { webSearchTool } from './webSearch.js'
import { configTool } from './configTool.js'
import { notebookEditTool } from './notebookEdit.js'
import { isToolSearchEnabled, isDeferredTool } from '../utils/toolSearch.js'
import type { Tool } from '../harness/types.js'

export function getBuiltinTools(): Tool[] {
  return [grepTool, globTool, bashTool, readFileTool, writeFileTool, editFileTool, multiEditTool, deleteFileTool, enterPlanModeTool, exitPlanModeTool, askUserQuestionTool, taskCreateTool, taskListTool, taskGetTool, taskUpdateTool, webFetchTool, webSearchTool, configTool, notebookEditTool]
}

export async function getAllTools(): Promise<Tool[]> {
  const builtinTools = getBuiltinTools()
  const tools: Tool[] = [...builtinTools, createSkillTool()]

  if (isToolSearchEnabled()) {
    tools.push(toolSearchTool)
  }

  return tools
}

/**
 * Get tools that should be fully loaded (non-deferred) in the system prompt.
 * When tool search is active, this excludes MCP and shouldDefer tools.
 */
export function getActiveTools(allTools: Tool[]): Tool[] {
  if (!isToolSearchEnabled()) return allTools
  return allTools.filter(t => !isDeferredTool(t))
}

/**
 * Get tools that are deferred (require ToolSearch to load).
 */
export function getDeferredTools(allTools: Tool[]): Tool[] {
  if (!isToolSearchEnabled()) return []
  return allTools.filter(isDeferredTool)
}
