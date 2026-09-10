/**
 * An offline Anthropic Messages fixture, not a renderer mock.
 * Real SSE enters the provider, agent loop, tools, RecordStream and bridge.
 * No request bodies, prompts, headers or credentials are retained.
 */
import { createServer } from 'node:http'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { sleep } from './cdp.mjs'

export async function startMotionFixture(project) {
  writeFileSync(join(project.root, 'motion.txt'),
    Array.from({ length: 90 }, (_, i) => 'Line ' + (i + 1) + ': stable file content for the desktop motion check.').join('\n'))
  const events = []
  let round = 0
  let turn = 0
  const stamp = (phase) => { events.push({ at: Date.now(), turn, round, phase }) }
  const server = createServer(async (req, res) => {
    try {
      const buffers = []
      for await (const part of req) buffers.push(part)
      const request = JSON.parse(Buffer.concat(buffers).toString('utf8'))
      if (req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":3000}')
        return
      }
      const main = request.tools?.some((tool) => tool.name === 'Read')
      const index = main ? round++ : -1
      const id = 'motion-' + turn + '-' + index
      const message = {
        id, type: 'message', role: 'assistant', model: 'motion-fixture', content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 3000, output_tokens: 0 },
      }
      if (!request.stream) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          ...message, content: [{ type: 'text', text: 'Desktop motion acceptance' }], stop_reason: 'end_turn',
        }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const send = (type, fields = {}) => {
        if (!res.destroyed) res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...fields }) + '\n\n')
      }
      let block = 0
      send('message_start', { message })
      const stream = async (type, text, delay = 55, size = 9) => {
        const current = block++
        send('content_block_start', { index: current, content_block: type === 'thinking'
          ? { type, thinking: '', signature: '' } : { type, text: '' } })
        for (let i = 0; i < text.length && !res.destroyed; i += size) {
          send('content_block_delta', { index: current, delta: type === 'thinking'
            ? { type: 'thinking_delta', thinking: text.slice(i, i + size) }
            : { type: 'text_delta', text: text.slice(i, i + size) } })
          if (i > 0 && i % (size * 8) === 0) {
            // A live thought with no changed content, long enough for clock/snapshot paints.
            send('ping')
            await sleep(220)
          }
          await sleep(delay)
        }
        if (type === 'thinking') send('content_block_delta', {
          index: current, delta: { type: 'signature_delta', signature: 'offline-motion-fixture' },
        })
        send('content_block_stop', { index: current })
      }
      const tool = (name, input) => {
        const current = block++
        send('content_block_start', {
          index: current, content_block: { type: 'tool_use', id: id + '-' + current, name, input: {} },
        })
        send('content_block_delta', { index: current, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
        send('content_block_stop', { index: current })
      }
      if (main) { stamp('gap'); await sleep(700); stamp('output') }
      if (index === 0) {
        await stream('thinking', '我正在检查动效的状态连续性。'.repeat(16) + '先读取文件并创建任务，思考标题、正文和状态线应保持原来的节点。', 65)
        tool('TaskCreate', { subject: '核对交接', description: '读取文件，检查工具间歇中的回合状态', activeForm: '正在核对交接' })
        tool('TaskCreate', { subject: '核对正文', description: '连续输出段落、代码和公式', activeForm: '正在核对正文' })
        tool('Read', { filePath: join(project.root, 'motion.txt'), limit: 18 })
      } else if (index === 1) {
        await stream('thinking', '文件已返回，回合继续。'.repeat(13) + '先前打开的内容保留，接下来检索文件。', 65)
        tool('TaskUpdate', { taskId: '1', status: 'in_progress' })
        tool('Glob', { pattern: '*.txt', path: project.root })
      } else if (index === 2) {
        await stream('thinking', '检索结果已返回，正在检查阅读位置。'.repeat(11), 65)
        tool('TaskUpdate', { taskId: '1', status: 'completed' })
        tool('TaskUpdate', { taskId: '2', status: 'in_progress' })
        tool('Read', { filePath: join(project.root, 'motion.txt'), offset: 20, limit: 22 })
      } else if (index === 3) {
        const text = '稳定首段：后续文字到达时，这一段应持续保留，选择范围与阅读位置不变。\n\n'
          + '~~~ts\nconst motion = { duration: 300, curve: "standard" }\nconsole.log(motion.duration)\n~~~\n\n'
          + '公式保持清晰：$E = mc^2$。\n\n$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$\n\n'
          + Array.from({ length: 24 }, (_, i) => '段落 ' + (i + 1) + '：流式输出继续追加。已经读过的段落、代码块和公式保持稳定；向上阅读时，视口应保留当前位置，结束整理也不抢走阅读位置。').join('\n\n')
          + '\n\n| 状态 | 行为 |\n| --- | --- |\n| 运行 | 保持详情 |\n| 完成 | 保护阅读 |\n\n'
          + '- 连续状态\n- 清晰焦点\n- 稳定正文\n\n'
        await stream('text', text, 45, 12)
        tool('TaskUpdate', { taskId: '2', status: 'completed' })
      } else {
        await stream('text', main ? '检查完成。正文和操作保持可用。' : 'Desktop motion acceptance', 45)
      }
      stamp('return')
      send('message_delta', { delta: { stop_reason: main && index < 4 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1600 } })
      send('message_stop')
      res.end()
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'fixture_error', message: String(error) } }))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = 'http://127.0.0.1:' + server.address().port
  return {
    events,
    config: {
      defaultModel: 'motion-fixture',
      endpoints: { motion: { provider: 'anthropic', baseUrl, apiKey: 'offline-fixture', promptCaching: 'off' } },
      models: { 'motion-fixture': { endpoint: 'motion', model: 'motion-fixture', contextWindow: 200000, maxOutputTokens: 8192, thinking: { type: 'enabled', budgetTokens: 1024 } } },
      routing: { main: 'motion-fixture', plan: 'motion-fixture', compact: 'motion-fixture', subagent: { general: 'motion-fixture' } },
    },
    arm() { round = 0; turn++; return turn },
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) },
  }
}
