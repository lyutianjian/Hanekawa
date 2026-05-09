import path from 'node:path'

export function getMyAgentDir(cwd: string): string {
  return path.join(cwd, '.myagent')
}

export function getConfigPath(cwd: string): string {
  return path.join(getMyAgentDir(cwd), 'config.json')
}

export function getMcpConfigPath(cwd: string): string {
  return path.join(getMyAgentDir(cwd), 'mcp.json')
}

export function getSessionsDir(cwd: string): string {
  return path.join(getMyAgentDir(cwd), 'sessions')
}

export function getSkillsDir(cwd: string): string {
  return path.join(getMyAgentDir(cwd), 'skills')
}
