import { z } from 'zod/v3'

export const todoStatusSchema = z.enum(['pending', 'in_progress', 'completed'])
export const taskUpdateStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'deleted'])

export const todoItemSchema = z.object({
  id: z.string().min(1).optional(),
  content: z.string().min(1).describe('A concise description of the todo item'),
  status: todoStatusSchema,
  activeForm: z.string().min(1).describe('Present continuous form shown when in_progress'),
}).strict()

export const todoWriteInputSchema = z.object({
  todos: z.array(todoItemSchema).describe('The complete updated todo list for the current session.'),
}).strict()

export const taskCreateInputSchema = z.object({
  subject: z.string().min(1).describe('A brief title for the task'),
  description: z.string().min(1).describe('What needs to be done'),
  activeForm: z.string().min(1).optional().describe('Present continuous form shown when in_progress'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('Arbitrary metadata to attach to the task'),
}).strict()

export const taskGetInputSchema = z.object({
  taskId: z.string().min(1).describe('The ID of the task to retrieve'),
}).strict()

export const taskUpdateInputSchema = z.object({
  taskId: z.string().min(1).describe('The ID of the task to update'),
  subject: z.string().min(1).optional().describe('New subject for the task'),
  description: z.string().min(1).optional().describe('New description for the task'),
  activeForm: z.string().min(1).optional().describe('Present continuous form shown when in_progress'),
  status: taskUpdateStatusSchema.optional().describe('New status for the task'),
  owner: z.string().optional().describe('New owner for the task'),
  addBlocks: z.array(z.string()).optional().describe('Task IDs that this task blocks'),
  addBlockedBy: z.array(z.string()).optional().describe('Task IDs that block this task'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('Metadata keys to merge into the task. Set a key to null to delete it.'),
}).strict()

export type TodoItem = z.infer<typeof todoItemSchema>
export type TaskCreateInput = z.infer<typeof taskCreateInputSchema>
export type TaskUpdateInput = z.infer<typeof taskUpdateInputSchema>
