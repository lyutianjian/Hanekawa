function getTasks(context) {
    if (!context.taskState) {
        context.taskState = new Map();
    }
    return context.taskState;
}
let nextId = 1;
function nextTaskId() {
    return String(nextId++);
}
export const taskCreateTool = {
    name: 'TaskCreate',
    description: 'Create a structured task for the current coding session.',
    inputSchema: {
        type: 'object',
        properties: {
            subject: { type: 'string', description: 'A brief title for the task' },
            description: { type: 'string', description: 'What needs to be done' },
            activeForm: { type: 'string', description: 'Present continuous form shown when in_progress' },
            metadata: { type: 'object', description: 'Arbitrary metadata to attach' },
        },
        required: ['subject', 'description'],
        additionalProperties: false,
    },
    riskLevel: 'safe',
    async execute(input, context) {
        const { subject, description, activeForm, metadata } = input;
        const tasks = getTasks(context);
        const id = nextTaskId();
        const task = {
            id,
            status: 'pending',
            subject,
            description,
            activeForm,
            metadata,
            blockedBy: [],
            blocks: [],
        };
        tasks.set(id, task);
        return { ok: true, content: `Task created: [${id}] ${subject}` };
    },
};
export const taskUpdateTool = {
    name: 'TaskUpdate',
    description: 'Update a task in the task list.',
    inputSchema: {
        type: 'object',
        properties: {
            taskId: { type: 'string', description: 'The ID of the task to update' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] },
            subject: { type: 'string' },
            description: { type: 'string' },
            activeForm: { type: 'string' },
            metadata: { type: 'object' },
            addBlockedBy: { type: 'array', items: { type: 'string' } },
            addBlocks: { type: 'array', items: { type: 'string' } },
        },
        required: ['taskId'],
        additionalProperties: false,
    },
    riskLevel: 'safe',
    async execute(input, context) {
        const { taskId, status, subject, description, activeForm, metadata, addBlockedBy, addBlocks } = input;
        const tasks = getTasks(context);
        const task = tasks.get(taskId);
        if (!task) {
            return { ok: false, content: `Task not found: ${taskId}` };
        }
        if (status)
            task.status = status;
        if (subject !== undefined)
            task.subject = subject;
        if (description !== undefined)
            task.description = description;
        if (activeForm !== undefined)
            task.activeForm = activeForm;
        if (metadata !== undefined) {
            if (metadata === null) {
                task.metadata = undefined;
            }
            else {
                task.metadata = { ...task.metadata, ...metadata };
                for (const key of Object.keys(metadata)) {
                    if (metadata[key] === null)
                        delete task.metadata[key];
                }
            }
        }
        if (addBlockedBy) {
            for (const id of addBlockedBy) {
                if (!task.blockedBy.includes(id))
                    task.blockedBy.push(id);
            }
        }
        if (addBlocks) {
            for (const id of addBlocks) {
                if (!task.blocks.includes(id))
                    task.blocks.push(id);
            }
        }
        return { ok: true, content: `Task updated: [${taskId}] ${task.subject}` };
    },
};
export const taskListTool = {
    name: 'TaskList',
    description: 'List all tasks in the current session.',
    inputSchema: {
        type: 'object',
        properties: {
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] },
        },
        additionalProperties: false,
    },
    riskLevel: 'safe',
    async execute(input, context) {
        const { status: filterStatus } = (input ?? {});
        const tasks = getTasks(context);
        const entries = [...tasks.values()]
            .filter((task) => task.status !== 'deleted')
            .filter((task) => !filterStatus || task.status === filterStatus)
            .sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
        if (entries.length === 0) {
            return { ok: true, content: 'No tasks.' };
        }
        const lines = entries.map((task) => {
            const blocked = task.blockedBy.length > 0 ? ` [blocked by: ${task.blockedBy.join(', ')}]` : '';
            return `[${task.id}] ${task.status}: ${task.subject}${blocked}`;
        });
        return { ok: true, content: lines.join('\n') };
    },
};
export const taskGetTool = {
    name: 'TaskGet',
    description: 'Get a specific task by ID.',
    inputSchema: {
        type: 'object',
        properties: {
            taskId: { type: 'string', description: 'The ID of the task to retrieve' },
        },
        required: ['taskId'],
        additionalProperties: false,
    },
    riskLevel: 'safe',
    async execute(input, context) {
        const { taskId } = input;
        const tasks = getTasks(context);
        const task = tasks.get(taskId);
        if (!task) {
            return { ok: false, content: `Task not found: ${taskId}` };
        }
        const lines = [
            `Task: ${task.subject}`,
            `ID: ${task.id}`,
            `Status: ${task.status}`,
            `Description: ${task.description}`,
        ];
        if (task.activeForm)
            lines.push(`Active form: ${task.activeForm}`);
        if (task.blockedBy.length > 0)
            lines.push(`Blocked by: ${task.blockedBy.join(', ')}`);
        if (task.blocks.length > 0)
            lines.push(`Blocks: ${task.blocks.join(', ')}`);
        return { ok: true, content: lines.join('\n') };
    },
};
