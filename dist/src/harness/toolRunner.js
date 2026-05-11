import { randomUUID } from 'node:crypto';
export class ToolRunner {
    tools;
    permissionGate;
    events;
    constructor(tools, permissionGate, events) {
        this.tools = tools;
        this.permissionGate = permissionGate;
        this.events = events;
    }
    async run(call, context) {
        const tool = this.tools.find((candidate) => candidate.name === call.name);
        if (!tool)
            throw new Error(`Unknown tool: ${call.name}`);
        const toolUse = {
            id: call.id,
            type: 'tool_use',
            tool: tool.name,
            input: call.input,
            riskLevel: tool.riskLevel,
            createdAt: new Date().toISOString(),
        };
        await this.events.onRecord(toolUse);
        const approved = await this.permissionGate.approve(tool, call.input);
        await this.events.onRecord(this.permissionGate.createApprovalRecord(tool, call.input, approved));
        if (!approved) {
            const denied = this.result(call, tool.name, false, `User denied permission for ${tool.name}.`);
            await this.events.onRecord(denied);
            return denied;
        }
        try {
            const result = await tool.execute(call.input, context);
            const record = this.result(call, tool.name, result.ok, result.content);
            await this.events.onRecord(record);
            return record;
        }
        catch (error) {
            const record = this.result(call, tool.name, false, error instanceof Error ? error.message : String(error));
            await this.events.onRecord(record);
            return record;
        }
    }
    result(call, tool, ok, content) {
        return {
            id: randomUUID(),
            type: 'tool_result',
            toolUseId: call.id,
            tool,
            ok,
            content,
            createdAt: new Date().toISOString(),
        };
    }
}
