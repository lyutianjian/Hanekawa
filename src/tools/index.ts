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
import { todoWriteTool } from './TodoWriteTool/TodoWriteTool.js'
import type { Tool } from '../harness/types.js'

export function getBuiltinTools(): Tool[] {
  return [grepTool, globTool, bashTool, readFileTool, writeFileTool, editFileTool, multiEditTool, deleteFileTool, enterPlanModeTool, exitPlanModeTool, askUserQuestionTool, todoWriteTool, taskCreateTool, taskListTool, taskGetTool, taskUpdateTool]
}

export async function getAllTools(): Promise<Tool[]> {
  const builtinTools = getBuiltinTools()
  return [...builtinTools, createSkillTool()]
}
