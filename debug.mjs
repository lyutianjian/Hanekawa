import process from 'node:process'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const cwd = process.cwd()
const rootUrl = pathToFileURL(`${cwd}${path.sep}`)

function ensureTsxLoader() {
  if (process.env.MYAGENT_DEBUG_TSX_READY === '1') return

  const args = [
    '--import',
    'tsx',
    path.resolve(cwd, 'debug.mjs'),
    ...process.argv.slice(2),
  ]

  console.error('[debug] This script needs the tsx loader to import project TypeScript files.')
  console.error('[debug] Re-launching with: node --import tsx debug.mjs')

  const { spawnSync } = require('node:child_process')
  const result = spawnSync(process.execPath, args, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      MYAGENT_DEBUG_TSX_READY: '1',
    },
  })

  if (result.error) {
    throw result.error
  }

  process.exit(result.status ?? 0)
}

async function importProjectModule(relativePath) {
  return import(new URL(relativePath, rootUrl).href)
}

function maskToken(value) {
  if (!value) return '(missing)'
  if (value.length <= 8) return `${value.slice(0, 2)}***`
  return `${value.slice(0, 4)}***${value.slice(-4)}`
}

function divider(label) {
  console.log(`\n=== ${label} ===`)
}

async function readConfigFromDisk(configPath) {
  try {
    const raw = await readFile(configPath, 'utf8')
    return JSON.parse(raw)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

async function main() {
  ensureTsxLoader()

  const prompt = process.argv.slice(2).join(' ').trim() || '请读取文件 src/config/providers.ts'
  const [{ ConfigService }, { createProvider }, { getConfigPath }, { getBuiltinTools }] = await Promise.all([
    importProjectModule('src/config/service.ts'),
    importProjectModule('src/config/providers.ts'),
    importProjectModule('src/utils/paths.ts'),
    importProjectModule('src/tools/index.ts'),
  ])

  const configPath = getConfigPath(cwd)
  const rawConfig = await readConfigFromDisk(configPath)
  const configService = new ConfigService(cwd)
  await configService.load()

  const config = configService.get()
  const defaultModelName = config.defaultModel
  const modelConfig = configService.getDefaultModel()

  divider('Runtime config')
  console.log(`cwd: ${cwd}`)
  console.log(`configPath: ${configPath}`)
  console.log(`configFileExists: ${rawConfig ? 'yes' : 'no'}`)
  console.log(`configFileDefaultModel: ${rawConfig?.defaultModel ?? '(missing file or unset)'}`)
  console.log(`defaultModel: ${defaultModelName ?? '(unset)'}`)
  console.log(`availableModels: ${Object.keys(config.models).join(', ') || '(none)'}`)

  if (!modelConfig) {
    console.error('No default model configured.')
    process.exitCode = 1
    return
  }

  const provider = createProvider(modelConfig)
  if (!provider) {
    console.error(`Failed to create provider for: ${modelConfig.provider}`)
    process.exitCode = 1
    return
  }

  const tools = getBuiltinTools()

  divider('Effective model selection')
  console.log(`providerConfig: ${modelConfig.provider}`)
  console.log(`providerRuntime: ${provider.name}`)
  console.log(`model: ${modelConfig.model}`)
  console.log(`baseUrl: ${modelConfig.baseUrl ?? '(default)'}`)
  console.log(`apiKeyPresent: ${modelConfig.apiKey ? 'yes' : 'no'}`)
  console.log(`apiKeyPreview: ${maskToken(modelConfig.apiKey)}`)
  console.log(`tools: ${tools.map((tool) => tool.name).join(', ') || '(none)'}`)
  console.log(`debugEnv.MYAGENT_DEBUG_PROVIDER: ${process.env.MYAGENT_DEBUG_PROVIDER ?? '(unset)'}`)

  divider('Prompt')
  console.log(prompt)

  const response = await provider.createMessage({
    model: modelConfig.model,
    maxTokens: config.agent.maxTokens ?? 4096,
    system: config.agent.system,
    messages: [
      {
        id: 'debug-user-1',
        role: 'user',
        content: prompt,
        createdAt: new Date().toISOString(),
      },
    ],
    tools,
  })

  divider('Provider response summary')
  console.log(`textLength: ${response.content.length}`)
  console.log(`toolCalls: ${response.toolCalls.length}`)
  if (response.toolCalls.length > 0) {
    for (const call of response.toolCalls) {
      console.log(`- ${call.name} (${call.id}) input=${JSON.stringify(call.input)}`)
    }
  }

  divider('Assistant text')
  console.log(response.content || '(empty)')
}

main().catch((error) => {
  console.error('\n[debug] Fatal error')
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
