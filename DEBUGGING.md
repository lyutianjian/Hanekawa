# MyAgent Tool Call 调试指南

## 工具定义验证 ✓

所有5个工具的 `inputSchema` 定义正确：
- ✓ grep (safe)
- ✓ readFile (safe)  
- ✓ writeFile (confirm)
- ✓ editFile (confirm)
- ✓ deleteFile (dangerous)

## 问题诊断

你遇到的 "400 The parameter is invalid" 错误可能来自以下几个原因：

### 1. API Key 配置问题

检查环境变量：
```bash
# 对于 Anthropic
echo $ANTHROPIC_API_KEY

# 对于 OpenAI 兼容
echo $OPENAI_API_KEY
```

### 2. 启用调试模式

设置环境变量来查看完整的 API 请求/响应：
```bash
export MYAGENT_DEBUG_PROVIDER=1
cd myagent
npm run dev -- --new
```

这会输出：
- 发送给 API 的完整 payload
- 工具定义格式
- 模型响应详情

### 3. 检查配置文件

查看 `.myagent/config.json`：
```bash
cat .myagent/config.json
```

确保：
- `defaultProvider` 存在且有效
- `defaultModel` 在 provider 的 models 列表中
- `apiKeyEnv` 环境变量已设置

### 4. 测试最小化场景

创建测试文件：
```bash
cd myagent
echo "test content" > test.txt
```

然后运行：
```bash
MYAGENT_DEBUG_PROVIDER=1 npm run dev -- --new
```

输入简单命令：
```
读取 test.txt 文件
```

### 5. 常见错误原因

| 错误 | 原因 | 解决方案 |
|------|------|---------|
| 400 Invalid parameter | API key 无效或过期 | 检查 API key |
| 400 Invalid parameter | model 名称错误 | 检查 config.json 中的 model 名称 |
| 400 Invalid parameter | baseURL 配置错误 | 确认 API endpoint |
| Tool call 失败 | inputSchema 格式问题 | 已验证 ✓ 格式正确 |

## 快速验证步骤

### 步骤 1: 验证工具定义
```bash
cd myagent
npx tsx debug-tools.mjs
```
✓ 已通过

### 步骤 2: 检查配置
```bash
cd myagent
cat .myagent/config.json 2>/dev/null || echo "配置文件不存在"
```

### 步骤 3: 测试 API 连接
```bash
# 创建简单测试脚本
cat > test-api.mjs << 'EOF'
import Anthropic from '@anthropic-ai/sdk'

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  console.error('❌ ANTHROPIC_API_KEY not set')
  process.exit(1)
}

const client = new Anthropic({ apiKey })

try {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'Say hello' }]
  })
  console.log('✓ API connection successful')
  console.log('Response:', response.content[0].text)
} catch (error) {
  console.error('❌ API error:', error.message)
  if (error.status) console.error('Status:', error.status)
}
EOF

npx tsx test-api.mjs
```

## 下一步

请运行以下命令并分享输出：

```bash
cd myagent

# 1. 检查配置
echo "=== Config ==="
cat .myagent/config.json 2>/dev/null || echo "No config file"

# 2. 检查 API key (只显示前几个字符)
echo -e "\n=== API Key Check ==="
echo "ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:0:10}..."

# 3. 运行带调试的 myagent
echo -e "\n=== Running with debug ==="
MYAGENT_DEBUG_PROVIDER=1 npm run dev -- --new
```

然后在 REPL 中输入一个简单的请求，比如：
```
列出当前目录的文件
```

这样我们就能看到完整的 API 请求和响应，找出问题所在。
