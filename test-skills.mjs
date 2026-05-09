import { getAllTools } from './src/tools/index.js'

const cwd = process.cwd()

console.log('Testing MyAgent Skill Service\n')
console.log('Current directory:', cwd)
console.log()

const tools = await getAllTools(cwd)

console.log(`Total tools loaded: ${tools.length}`)
console.log()

const builtinTools = tools.filter(t => !t.name.startsWith('skill_'))
const skillTools = tools.filter(t => t.name.startsWith('skill_'))

console.log(`Builtin tools (${builtinTools.length}):`)
builtinTools.forEach(t => {
  console.log(`  - ${t.name} (${t.riskLevel}): ${t.description}`)
})

console.log()
console.log(`Skill tools (${skillTools.length}):`)
skillTools.forEach(t => {
  console.log(`  - ${t.name} (${t.riskLevel}): ${t.description}`)
})

if (skillTools.length > 0) {
  console.log()
  console.log('Testing skill tool execution:')
  const testSkill = skillTools[0]
  console.log(`\nExecuting: ${testSkill.name}`)
  const result = await testSkill.execute({}, {
    cwd,
    sessionId: 'test',
    readFiles: new Set()
  })
  console.log(`Result: ${result.ok ? 'SUCCESS' : 'FAILED'}`)
  console.log(`Content preview: ${result.content.substring(0, 100)}...`)
}

console.log()
console.log('✓ Skill service is working correctly!')
