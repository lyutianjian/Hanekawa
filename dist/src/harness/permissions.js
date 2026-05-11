import { randomUUID } from 'node:crypto';
export class PermissionGate {
    prompt;
    constructor(prompt) {
        this.prompt = prompt;
    }
    async approve(tool, input) {
        if (tool.riskLevel === 'safe')
            return true;
        const reason = this.reasonFor(tool.riskLevel);
        return this.prompt({ tool, input, reason });
    }
    createApprovalRecord(tool, input, approved) {
        return {
            id: randomUUID(),
            type: 'tool_approval',
            tool: tool.name,
            input,
            approved,
            riskLevel: tool.riskLevel,
            createdAt: new Date().toISOString(),
        };
    }
    reasonFor(riskLevel) {
        if (riskLevel === 'confirm')
            return 'This action changes local state and requires confirmation.';
        return 'This is a dangerous action and requires explicit confirmation.';
    }
}
