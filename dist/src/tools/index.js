import { grepTool } from './grep.js';
import { globTool } from './glob.js';
import { bashTool } from './bash.js';
import { readFileTool } from './readFile.js';
import { writeFileTool } from './writeFile.js';
import { editFileTool } from './editFile.js';
import { deleteFileTool } from './deleteFile.js';
import { createSkillTool } from './skillTool.js';
import { taskCreateTool, taskUpdateTool, taskListTool, taskGetTool } from './taskTools.js';
export function getBuiltinTools() {
    return [grepTool, globTool, bashTool, readFileTool, writeFileTool, editFileTool, deleteFileTool, taskCreateTool, taskUpdateTool, taskListTool, taskGetTool];
}
export async function getAllTools(cwd) {
    const builtinTools = getBuiltinTools();
    void cwd;
    return [...builtinTools, createSkillTool()];
}
