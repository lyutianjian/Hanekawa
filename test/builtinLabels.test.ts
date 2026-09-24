import test from 'node:test'
import assert from 'node:assert/strict'
import { CommandRegistry, registerBuiltinCommands } from '../src/commands/index.js'
import { BUILT_IN_AGENT_DEFINITIONS } from '../src/tools/AgentTool/AgentTool.js'
import { buildAgentToolDescription } from '../src/tools/AgentTool/prompt.js'
import {
  AGENT_DESCRIPTIONS,
  COMMAND_DESCRIPTIONS,
  agentDescription,
  commandDescription,
  localizeCommands,
} from '../src/desktop/renderer/model/builtinLabels.js'

test('every built-in command has a caption whose English matches its source', () => {
  const registry = new CommandRegistry()
  registerBuiltinCommands(registry)
  const commands = registry.list()
  assert.deepEqual(commands.map((c) => c.name).sort(), Object.keys(COMMAND_DESCRIPTIONS).sort())
  for (const command of commands) {
    assert.equal(COMMAND_DESCRIPTIONS[command.name]?.en, command.description, command.name)
  }
})

test('every built-in agent has a caption whose English matches its source', () => {
  assert.deepEqual(BUILT_IN_AGENT_DEFINITIONS.map((d) => d.type).sort(), Object.keys(AGENT_DESCRIPTIONS).sort())
  for (const definition of BUILT_IN_AGENT_DEFINITIONS) {
    assert.equal(AGENT_DESCRIPTIONS[definition.type]?.en, definition.description, definition.type)
  }
})

test('the model still reads the English agent descriptions', () => {
  const prompt = buildAgentToolDescription(BUILT_IN_AGENT_DEFINITIONS)
  for (const caption of Object.values(AGENT_DESCRIPTIONS)) {
    assert.ok(prompt.includes(caption.en))
    assert.ok(!prompt.includes(caption.zh))
  }
})

test('built-ins show Chinese; skills and custom agents keep their own text', () => {
  assert.equal(commandDescription({ name: 'clear', description: 'Clear conversation history' }), '清空当前对话')
  // A skill registered under a built-in name carries its own description.
  assert.equal(commandDescription({ name: 'plan', description: 'My planning skill' }), 'My planning skill')
  assert.equal(commandDescription({ name: 'deploy', description: 'Ship it' }), 'Ship it')
  assert.deepEqual(localizeCommands([{ name: 'help', description: 'Show available commands', aliases: ['h'] }]), [
    { name: 'help', description: '列出可用命令', aliases: ['h'] },
  ])

  const general = AGENT_DESCRIPTIONS.general!
  assert.equal(agentDescription({ type: 'general', builtIn: true, description: general.en }), general.zh)
  assert.equal(agentDescription({ type: 'general', builtIn: false, description: general.en }), general.en)
  assert.equal(agentDescription({ type: 'toString', builtIn: true, description: 'x' }), 'x')
})
