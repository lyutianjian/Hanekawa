#!/usr/bin/env node
/**
 * Debug script to verify tool definitions and API payload
 */

import { getBuiltinTools } from './src/tools/index.js'
import { buildAnthropicTools, buildOpenAITools } from './src/config/providers.js'

console.log('=== MyAgent Tool Definitions Debug ===\n')

const tools = getBuiltinTools()

console.log(`Found ${tools.length} builtin tools:\n`)

tools.forEach((tool, index) => {
  console.log(`${index + 1}. ${tool.name} (${tool.riskLevel})`)
  console.log(`   Description: ${tool.description}`)
  console.log(`   Input Schema:`)
  console.log(JSON.stringify(tool.inputSchema, null, 4))
  console.log()
})

console.log('\n=== Anthropic API Format ===\n')
const anthropicTools = buildAnthropicTools(tools)
console.log(JSON.stringify(anthropicTools, null, 2))

console.log('\n=== OpenAI API Format ===\n')
const openaiTools = buildOpenAITools(tools)
console.log(JSON.stringify(openaiTools, null, 2))

console.log('\n=== Test Tool Execution ===\n')

// Test readFile tool
const readFileTool = tools.find(t => t.name === 'readFile')
if (readFileTool) {
  console.log('Testing readFile tool with valid input...')
  const testInput = { filePath: 'package.json' }
  console.log('Input:', JSON.stringify(testInput))

  try {
    const result = await readFileTool.execute(testInput, {
      cwd: process.cwd(),
      sessionId: 'debug',
      readFiles: new Set()
    })
    console.log('Result:', result.ok ? '✓ Success' : '✗ Failed')
    console.log('Content preview:', result.content.slice(0, 100) + '...')
  } catch (error) {
    console.error('Error:', error.message)
  }
}

console.log('\n=== Validation Complete ===')
