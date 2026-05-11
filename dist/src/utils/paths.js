import path from 'node:path';
export function getMyAgentDir(cwd) {
    return path.join(cwd, '.myagent');
}
export function getConfigPath(cwd) {
    return path.join(getMyAgentDir(cwd), 'config.json');
}
export function getMcpConfigPath(cwd) {
    return path.join(getMyAgentDir(cwd), 'mcp.json');
}
export function getSessionsDir(cwd) {
    return path.join(getMyAgentDir(cwd), 'sessions');
}
export function getSkillsDir(cwd) {
    return path.join(getMyAgentDir(cwd), 'skills');
}
