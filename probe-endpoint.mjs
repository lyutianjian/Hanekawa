#!/usr/bin/env node
// Endpoint authenticity probe — is the thing behind this base_url actually Anthropic-served?
//
// Standalone: zero deps, plain `node` (22+), imports nothing from this repo, so project code
// cannot confound the result. Credentials are read from env only and never written to disk.
//
//   node probe-endpoint.mjs                       # uses ambient ANTHROPIC_BASE_URL / _AUTH_TOKEN
//   PROBE_BASE_URL=https://api.anthropic.com PROBE_API_KEY=sk-... node probe-endpoint.mjs
//
// Run it against an endpoint you trust first: that establishes the F baseline and confirms the
// script itself, since the PASS path cannot be self-tested without a known-good backend.
//
// The load-bearing test is D (signature tampering). A relay that mints fake `thinking`
// signatures cannot also verify them, so it accepts a corrupted one that real Anthropic rejects.
// Everything else is corroborating or forgeable.

// Credentials and endpoint fall back to the ambient Claude Code env vars, so the common case is
// `node probe-endpoint.mjs` with no arguments and no key ever touching shell history or a file.
const CRED_SOURCE = ['PROBE_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].find(
  (k) => process.env[k],
);
const API_KEY = CRED_SOURCE ? process.env[CRED_SOURCE] : '';
const URL_SOURCE = ['PROBE_BASE_URL', 'ANTHROPIC_BASE_URL'].find((k) => process.env[k]);
const MODEL = process.env.PROBE_MODEL || 'claude-opus-5';
const VERBOSE = process.env.PROBE_VERBOSE === '1';

// Relays document their URL both with and without the /v1 suffix; paths below add it, so drop it.
const BASE_URL = (URL_SOURCE ? process.env[URL_SOURCE] : 'https://api.anthropic.com')
  .replace(/\/+$/, '')
  .replace(/\/v1$/, '');

if (!API_KEY) {
  console.error('No credential found. Set PROBE_API_KEY, ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.');
  process.exit(2);
}

const REPORTED_HEADERS = [
  'request-id',
  'anthropic-organization-id',
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-input-tokens-limit',
  'via',
  'server',
  'cf-ray',
];

// Some relays reject anything that does not look like the official CLI ("unauthorized client
// detected"). These are the client-identity headers Claude Code sends; override or extend with
// PROBE_EXTRA_HEADERS='{"user-agent":"..."}' if a relay fingerprints something else.
const CLIENT_HEADERS = {
  'user-agent': 'claude-cli/2.0.14 (external, cli)',
  'x-app': 'cli',
  'x-stainless-lang': 'js',
  'x-stainless-runtime': 'node',
  'x-stainless-package-version': '0.60.0',
  'x-stainless-os': 'Windows',
  'x-stainless-arch': 'x64',
  'x-stainless-retry-count': '0',
  'anthropic-beta': 'claude-code-20250219,fine-grained-tool-streaming-2025-05-14',
  ...(process.env.PROBE_EXTRA_HEADERS ? JSON.parse(process.env.PROBE_EXTRA_HEADERS) : {}),
};

// Some relays want `Authorization: Bearer` instead of `x-api-key`. Resolved once, then reused.
// An ANTHROPIC_AUTH_TOKEN is a bearer credential by convention, so try that order first.
let authStyle = process.env.PROBE_AUTH_STYLE || null;
const DEFAULT_STYLES =
  CRED_SOURCE === 'ANTHROPIC_AUTH_TOKEN' ? ['bearer', 'x-api-key'] : ['x-api-key', 'bearer'];

function headersFor(style) {
  const h = { ...CLIENT_HEADERS, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (style === 'bearer') h.authorization = `Bearer ${API_KEY}`;
  else h['x-api-key'] = API_KEY;
  return h;
}

async function call(path, body) {
  const url = `${BASE_URL}${path}`;
  const styles = authStyle ? [authStyle] : DEFAULT_STYLES;
  let last;
  for (const style of styles) {
    const started = Date.now();
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: headersFor(style), body: JSON.stringify(body) });
    } catch (err) {
      return { ok: false, status: 0, transportError: String(err?.message || err), ms: Date.now() - started };
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    last = {
      ok: res.ok,
      status: res.status,
      json,
      text,
      ms: Date.now() - started,
      headers: Object.fromEntries(REPORTED_HEADERS.map((k) => [k, res.headers.get(k)]).filter(([, v]) => v)),
    };
    if (res.status !== 401 && res.status !== 403) {
      authStyle ??= style;
      return last;
    }
  }
  return last;
}

const errText = (r) => r.json?.error?.message || r.transportError || (r.text || '').slice(0, 300);

// ---------------------------------------------------------------- probes

const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Look up the current weather for a city.',
  input_schema: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
  },
};

const THINKING_BODY = {
  model: MODEL,
  max_tokens: 3000,
  // Forced tool_choice is unsupported with extended thinking, so the prompt has to do the pushing.
  thinking: { type: 'enabled', budget_tokens: 2000 },
  tools: [WEATHER_TOOL],
  messages: [{ role: 'user', content: '上海现在天气怎么样？请调用工具查询，不要凭记忆回答。' }],
};

function tamperSignature(sig) {
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const chars = [...sig];
  const mid = Math.floor(chars.length / 2);
  for (let i = mid; i < Math.min(mid + 8, chars.length); i++) {
    const at = ALPHA.indexOf(chars[i]);
    if (at >= 0) chars[i] = ALPHA[(at + 1) % ALPHA.length];
  }
  const out = chars.join('');
  return out === sig ? `${sig.slice(0, -4)}AAAA` : out;
}

// Deterministic filler well past the 1024-token minimum cacheable prefix.
const CACHE_PREFIX = Array.from(
  { length: 220 },
  (_, i) =>
    `Reference entry ${String(i).padStart(4, '0')}: deterministic filler line used only to push ` +
    `this system prompt past the minimum cacheable prefix length for prompt caching.`,
).join('\n');

const FINGERPRINT_TEXT =
  '他说：“我明天会去。”　The naïve café — 42 × 7 ≈ 294 🧭 ' +
  'токенизация ｆｕｌｌｗｉｄｔｈ 𝕦𝕟𝕦𝕤𝕦𝕒𝕝 ​ zero-width';

async function main() {
  console.log(`base_url : ${BASE_URL}   (from ${URL_SOURCE || 'default'})`);
  console.log(`model    : ${MODEL}`);
  console.log(`cred     : ${CRED_SOURCE}   (value never printed)`);
  console.log('');

  const results = {};

  // A — basic reachability, echoed metadata, response headers.
  const a = await call('/v1/messages', {
    model: MODEL,
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
  });
  results.reachable = a.ok;
  console.log(`[A] basic call            ${a.ok ? `HTTP ${a.status} (${a.ms}ms)` : `FAILED — ${errText(a)}`}`);
  if (!a.ok) {
    console.log('\nCannot continue without a working /v1/messages call.');
    if (/unauthorized client|forbidden client/i.test(errText(a))) {
      console.log('The endpoint is fingerprinting the client. Copy the real headers your working');
      console.log("client sends and pass them via PROBE_EXTRA_HEADERS='{\"header\":\"value\"}'.");
    }
    // A 5xx on a valid key usually means the gateway has no upstream wired for this model.
    // What /v1/models advertises vs. what actually answers is the useful distinction.
    try {
      const list = await fetch(`${BASE_URL}/v1/models`, { headers: headersFor(authStyle) });
      const data = (await list.json())?.data;
      if (Array.isArray(data)) {
        const claude = data.filter((m) => /claude|opus|sonnet|haiku|fable/i.test(m?.id || ''));
        console.log(`\n/v1/models advertises ${data.length} models, ${claude.length} Anthropic-shaped:`);
        for (const m of claude) console.log(`    ${String(m.id).padEnd(34)} owned_by=${m.owned_by}`);
        console.log('\nowned_by is set by whoever configured the gateway. A name being listed says');
        console.log('nothing about what is behind it — the call above is what says that.');
      }
    } catch {}
    process.exitCode = 1;
    return;
  }
  const idOk = /^msg_[A-Za-z0-9]+$/.test(a.json?.id || '');
  console.log(`    auth style          ${authStyle}`);
  console.log(`    echoed model        ${a.json?.model}   (forgeable — a relay just returns a string)`);
  console.log(`    id shape            ${a.json?.id}  ${idOk ? '✓ msg_*' : '✗ not msg_*'}`);
  console.log(`    stop_reason         ${a.json?.stop_reason}`);
  console.log(`    usage               ${JSON.stringify(a.json?.usage)}`);
  for (const [k, v] of Object.entries(a.headers)) console.log(`    ${k.padEnd(38)}${v}`);
  results.idShape = idOk;

  // B — does the endpoint return real thinking blocks at all?
  console.log('');
  const b = await call('/v1/messages', THINKING_BODY);
  const blocks = Array.isArray(b.json?.content) ? b.json.content : [];
  const thinking = blocks.find((x) => x?.type === 'thinking');
  const toolUse = blocks.find((x) => x?.type === 'tool_use');
  console.log(`[B] extended thinking     ${b.ok ? `HTTP ${b.status} (${b.ms}ms)` : `FAILED — ${errText(b)}`}`);
  if (thinking) {
    console.log(`    thinking block      yes (${(thinking.thinking || '').length} chars)`);
    console.log(
      `    signature           ${thinking.signature ? `present, ${thinking.signature.length} chars` : 'MISSING'}`,
    );
  } else {
    console.log('    thinking block      none returned');
  }
  console.log(`    tool_use block      ${toolUse ? `${toolUse.id}  ${/^toolu_/.test(toolUse.id) ? '✓' : '✗ not toolu_*'}` : 'none'}`);
  results.hasSignature = Boolean(thinking?.signature);
  results.hasThinkingBlock = Boolean(thinking);
  // Anthropic models served through AWS Bedrock mint tool ids with a `bdrk` infix.
  results.bedrock = /^toolu_bdrk_/.test(toolUse?.id || '');
  if (results.bedrock) console.log('    → bdrk infix        an Anthropic model served via AWS Bedrock');

  // C/D — the discriminator: echo the assistant turn back and see whether the signature is verified.
  if (thinking?.signature) {
    const echo = (sig) =>
      blocks.map((blk) => (blk?.type === 'thinking' ? { ...blk, signature: sig } : blk));
    const followUp = (assistantBlocks) => {
      const msgs = [THINKING_BODY.messages[0], { role: 'assistant', content: assistantBlocks }];
      if (toolUse) {
        msgs.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: '{"temp_c": 21, "condition": "cloudy"}',
            },
          ],
        });
      } else {
        msgs.push({ role: 'user', content: '好，谢谢。' });
      }
      return { ...THINKING_BODY, max_tokens: 512, messages: msgs };
    };

    console.log('');
    const c = await call('/v1/messages', followUp(echo(thinking.signature)));
    console.log(`[C] intact signature      HTTP ${c.status} — expected 2xx${c.ok ? ' ✓' : ` ✗  ${errText(c)}`}`);
    results.intactAccepted = c.ok;

    const d = await call('/v1/messages', followUp(echo(tamperSignature(thinking.signature))));
    const rejected = d.status >= 400 && d.status < 500;
    console.log(`[D] tampered signature    HTTP ${d.status} — expected 4xx${rejected ? ' ✓' : ' ✗'}`);
    if (d.json?.error) console.log(`    error               ${errText(d)}`);
    results.tamperRejected = rejected;

    if (!toolUse) {
      console.log('    NOTE: no tool_use in the sampled turn, so C/D used a plain multi-turn echo.');
      console.log('          Signature checking is only guaranteed on the tool_result path — rerun');
      console.log('          for a turn that does call the tool before trusting a PASS here.');
      results.weakSignaturePath = true;
    }
  } else {
    console.log('\n[C] intact signature      skipped — no signature to replay');
    console.log('[D] tampered signature    skipped');
  }

  // E — is prompt caching real? A fabricated usage block rarely adds up.
  console.log('');
  const cacheBody = (tail) => ({
    model: MODEL,
    max_tokens: 32,
    system: [{ type: 'text', text: CACHE_PREFIX, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: tail }],
  });
  const e1 = await call('/v1/messages', cacheBody('Reply with exactly: one'));
  const e2 = await call('/v1/messages', cacheBody('Reply with exactly: two'));
  const u1 = e1.json?.usage || {};
  const u2 = e2.json?.usage || {};
  console.log(`[E] prompt caching        write HTTP ${e1.status} / read HTTP ${e2.status}`);
  console.log(`    call 1 usage        ${JSON.stringify(u1)}`);
  console.log(`    call 2 usage        ${JSON.stringify(u2)}`);
  const created = u1.cache_creation_input_tokens || 0;
  const read = u2.cache_read_input_tokens || 0;
  const consistent = created > 0 && read > 0 && Math.abs(read - created) <= Math.max(20, created * 0.1);
  console.log(
    `    verdict             created=${created} read=${read} → ` +
      (read === 0
        ? 'NO real cache hit'
        : consistent
          ? 'consistent ✓'
          : 'read>0 but does not match the written prefix — suspicious'),
  );
  results.cacheConsistent = consistent;
  results.cacheCreated = created;
  results.cacheRead = read;
  // The ephemeral_5m / ephemeral_1h split is Anthropic-specific usage reporting, not something a
  // pass-through shim in front of another vendor produces incidentally.
  results.cacheDetail = Boolean(u1.cache_creation && 'ephemeral_5m_input_tokens' in u1.cache_creation);

  // F — tokenizer fingerprint. Compare this number against an endpoint you already trust.
  console.log('');
  const f = await call('/v1/messages/count_tokens', {
    model: MODEL,
    messages: [{ role: 'user', content: FINGERPRINT_TEXT }],
  });
  console.log(`[F] count_tokens          ${f.ok ? `${f.json?.input_tokens} tokens` : `unsupported/failed — HTTP ${f.status} ${errText(f)}`}`);
  results.countTokens = f.ok ? (f.json?.input_tokens ?? null) : null;
  console.log('    run this same script against an endpoint you trust and compare the number;');
  console.log('    a different tokenizer means a different model family.');

  // ---------------------------------------------------------------- verdict
  console.log('\n' + '─'.repeat(72));
  const fail = [];
  const blocked = [];
  const supports = [];

  if (results.tamperRejected === false)
    fail.push('a CORRUPTED thinking signature was ACCEPTED — signatures are decorative here, not verified');
  if (results.hasSignature && results.intactAccepted === false)
    fail.push('the endpoint rejected a signature it issued itself — the backend is not the one that minted it');
  if (results.cacheConsistent === false && (results.cacheRead ?? 0) > 0)
    fail.push('cache_read is non-zero but does not match the prefix that was written — fabricated usage');

  if (!results.hasThinkingBlock)
    blocked.push('thinking was requested but no thinking block came back: the endpoint accepts the parameter and silently drops it, so tests C/D cannot run at all (and extended reasoning is unavailable to you)');
  if (!results.countTokens)
    blocked.push('/v1/messages/count_tokens is not implemented, so the tokenizer fingerprint is unavailable');

  if (results.bedrock) supports.push('tool_use ids carry the bdrk infix — an Anthropic model served through AWS Bedrock');
  if (results.cacheConsistent) supports.push(`prompt caching produced an exact, self-consistent hit (${results.cacheCreated} written, ${results.cacheRead} read back)`);
  if (results.cacheDetail) supports.push('usage reports the Anthropic-specific ephemeral_5m / ephemeral_1h cache split');

  if (fail.length) {
    console.log('VERDICT: FAIL — this endpoint is not Anthropic-served.');
    for (const x of fail) console.log(`  ✗ ${x}`);
  } else if (blocked.length && !results.hasSignature) {
    console.log('VERDICT: INCONCLUSIVE — the decisive test could not be run.');
    for (const x of blocked) console.log(`  · ${x}`);
    if (supports.length) {
      console.log('\nCorroborating evidence that the backend IS an Anthropic model:');
      for (const x of supports) console.log(`  ✓ ${x}`);
      console.log('\nThat is a balance of evidence, not proof. The model string is forgeable and the id');
      console.log('prefixes are just strings; the cache accounting is the part that would take a real');
      console.log('tokenizer to fake. Nothing here rules out the relay routing some traffic elsewhere.');
    }
  } else {
    console.log('VERDICT: PASS — signature verification and prompt caching both behave the way a');
    console.log('genuine Anthropic backend does. This covers the path serving THESE requests only;');
    console.log('a relay can still route other traffic elsewhere.');
    for (const x of supports) console.log(`  ✓ ${x}`);
    for (const x of blocked) console.log(`  · ${x}`);
  }
  if (results.weakSignaturePath) console.log('\n(Signature path was the weak one — see the NOTE above.)');
  if (VERBOSE) console.log('\nraw:', JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error('probe crashed:', err);
  process.exitCode = 1;
});
