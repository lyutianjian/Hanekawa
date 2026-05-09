import { grepTool } from './grep.js'
import { readFileTool } from './readFile.js'
import { writeFileTool } from './writeFile.js'
import { editFileTool } from './editFile.js'
import { deleteFileTool } from './deleteFile.js'
import { SkillsService } from '../services/skills/skillsService.js'
import { createSkillTool } from './skillTool.js'
import type { Tool } from '../harness/types.js'

export function getBuiltinTools(): Tool[] {
  return [grepTool, readFileTool, writeFileTool, editFileTool, deleteFileTool]
}

export async function getAllTools(cwd: string): Promise<Tool[]> {
  const builtinTools = getBuiltinTools()
  const service = new SkillsService(cwd)
  const skills = await service.list()
  const skillTools = skills.map(createSkillTool)
  return [...builtinTools, ...skillTools]
}
