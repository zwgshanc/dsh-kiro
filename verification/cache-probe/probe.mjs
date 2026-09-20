/**
 * 缓存命中探针：验证 dsh-kiro 实际请求是否命中 Kiro 服务端缓存。
 *
 * 原理：
 * - 同一会话内连续发 3 轮对话，每轮带完整历史
 * - 观察 contextUsagePercentage 增量：若缓存命中，增量应明显小于从零计算
 * - 对照组：新会话（不同 conversationId）发相同内容，观察第 1 轮的基线值
 *
 * 运行：
 *   node verification/cache-probe/probe.mjs
 * （需要 DSH_HOME/storages/kiro-auth 下有有效凭据）
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── 配置 ─────────────────────────────────────────────────────────────────────

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const KIRO_AUTH_DIR = join(DSH_HOME, 'storages', 'kiro-auth')
const MODEL = process.env.KIRO_MODEL ?? 'claude-sonnet-4.5'
const REGION = process.env.KIRO_REGION ?? 'us-east-1'
const PROXY = process.env.KIRO_PROXY

// ── 凭据读取 ──────────────────────────────────────────────────────────────────

async function readToken() {
  const tokenPath = join(KIRO_AUTH_DIR, 'kiro-auth-token.json')
  const raw = JSON.parse(await readFile(tokenPath, 'utf8'))
  // IDC 账号的实际端点在 us-east-1，token 里的 region 是 SSO region 不是推理 region
  const effectiveRegion = process.env.KIRO_REGION ?? 'us-east-1'
  return {
    accessToken: raw.accessToken,
    region: effectiveRegion,
    profileArn: raw.profileArn,
    authMethod: raw.authMethod ?? 'social',
  }
}

// ── conversationId 派生（与 adapter.ts 一致）──────────────────────────────────

function conversationIdFor(sessionId) {
  const digest = createHash('sha256').update(`dsh-kiro:conversation:${sessionId}`).digest()
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Buffer.from(bytes).toString('hex')
  return [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20,32)].join('-')
}

// ── EventStream 解码 ──────────────────────────────────────────────────────────

function decodeHeaders(buf, start, end) {
  const view = new DataView(buf.buffer, buf.byteOffset)
  const dec = new TextDecoder()
  const h = {}
  let o = start
  while (o < end) {
    const nl = view.getUint8(o); o++
    const name = dec.decode(buf.subarray(o, o + nl)); o += nl
    const type = view.getUint8(o); o++
    const vl = view.getUint16(o); o += 2
    if (type === 7) h[name] = dec.decode(buf.subarray(o, o + vl))
    o += vl
  }
  return h
}

async function* decodeFrames(stream) {
  let buf = new Uint8Array(0)
  for await (const chunk of stream) {
    const next = new Uint8Array(buf.length + chunk.length)
    next.set(buf); next.set(chunk, buf.length)
    buf = next
    while (buf.length >= 12) {
      const view = new DataView(buf.buffer, buf.byteOffset)
      const total = view.getUint32(0)
      const hlen = view.getUint32(4)
      if (buf.length < total) break
      const hend = 12 + hlen
      const headers = decodeHeaders(buf, 12, hend)
      const payload = buf.subarray(hend, total - 4)
      let parsed = null
      try { parsed = JSON.parse(new TextDecoder().decode(payload)) } catch {}
      yield { headers, payload: parsed }
      buf = buf.subarray(total)
    }
  }
}

// ── 单次请求 ──────────────────────────────────────────────────────────────────

async function ask(token, conversationId, history, userContent) {
  // IDC / external_idp 认证走 codewhisperer 端点；其他走 q 端点
  const isIdc = token.authMethod === 'idc' || token.authMethod === 'external_idp'
  const url = isIdc
    ? `https://codewhisperer.${token.region}.amazonaws.com/generateAssistantResponse`
    : `https://q.${token.region}.amazonaws.com/generateAssistantResponse`
  const body = JSON.stringify({
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId,
      history,
      currentMessage: {
        userInputMessage: {
          content: userContent,
          modelId: MODEL,
          origin: 'AI_EDITOR',
        },
      },
    },
    ...(token.profileArn ? { profileArn: token.profileArn } : {}),
  })

  const headers = {
    'content-type': 'application/json',
    'accept': 'application/vnd.amazon.eventstream',
    'authorization': `Bearer ${token.accessToken}`,
    'x-amzn-kiro-agent-mode': 'vibe',
    'user-agent': 'aws-sdk-js/3.738.0 KiroIDE',
    'x-amz-user-agent': 'aws-sdk-js/3.738.0 KiroIDE',
  }
  if (isIdc) headers['x-amz-target'] = 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse'
  if (token.authMethod === 'api_key') headers['TokenType'] = 'API_KEY'
  if (token.authMethod === 'external_idp') headers['TokenType'] = 'EXTERNAL_IDP'

  const fetchOpts = { method: 'POST', headers, body }
  const resp = await fetch(url, fetchOpts)

  if (resp.status !== 200) {
    const text = await resp.text()
    return { ok: false, status: resp.status, error: text.slice(0, 300), contextPct: null, content: '', elapsedMs: 0 }
  }

  const started = Date.now()
  let contextPct = null
  let content = ''

  for await (const frame of decodeFrames(resp.body)) {
    const et = frame.headers[':event-type']
    if (et === 'contextUsageEvent' && typeof frame.payload?.contextUsagePercentage === 'number') {
      contextPct = frame.payload.contextUsagePercentage
    }
    if (et === 'assistantResponseEvent' && typeof frame.payload?.content === 'string') {
      content += frame.payload.content
    }
  }

  return { ok: true, status: 200, contextPct, content: content.slice(0, 80), elapsedMs: Date.now() - started }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── 主逻辑 ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('读取凭据...')
  const token = await readToken()
  console.log(`region: ${token.region}, model: ${MODEL}, authMethod: ${token.authMethod}`)
  console.log()

  // ── 实验 A：同一会话连续 3 轮 ─────────────────────────────────────────────
  console.log('=== 实验 A：同一会话连续 3 轮 ===')
  const sessionId = `cache-probe-${Date.now()}`
  const convId = conversationIdFor(sessionId)
  console.log(`conversationId: ${convId}`)

  const history = []
  const turns = [
    '用一句话解释什么是光合作用。',
    '用一句话解释什么是细胞呼吸。',
    '用一句话解释两者的关系。',
  ]

  let prevPct = null
  for (let i = 0; i < turns.length; i++) {
    const r = await ask(token, convId, [...history], turns[i])
    if (!r.ok) {
      console.log(`  第 ${i+1} 轮失败 HTTP ${r.status}: ${r.error}`)
      break
    }
    const delta = prevPct !== null ? `（增量 ${(r.contextPct - prevPct).toFixed(3)}%）` : '（基线）'
    console.log(`  第 ${i+1} 轮: context% = ${r.contextPct?.toFixed(3)}% ${delta}  ${r.elapsedMs}ms`)
    console.log(`         回复: ${r.content}`)
    // 把这轮加入历史
    history.push(
      { userInputMessage: { content: turns[i], modelId: MODEL, origin: 'AI_EDITOR' } },
      { assistantResponseMessage: { content: r.content } },
    )
    prevPct = r.contextPct
    if (i < turns.length - 1) await sleep(3000)
  }

  console.log()

  // ── 实验 B：3 个独立会话发相同内容（对照组）────────────────────────────────
  console.log('=== 实验 B：3 个独立会话，各发相同的第 1 轮（对照组）===')
  const baseQuestion = '用一句话解释什么是光合作用。'
  for (let i = 0; i < 3; i++) {
    await sleep(2000)
    const freshId = conversationIdFor(`cache-probe-fresh-${Date.now()}-${i}`)
    const r = await ask(token, freshId, [], baseQuestion)
    if (!r.ok) {
      console.log(`  对照 ${i+1} 失败 HTTP ${r.status}: ${r.error}`)
      continue
    }
    console.log(`  对照 ${i+1}: context% = ${r.contextPct?.toFixed(3)}%  ${r.elapsedMs}ms`)
  }

  console.log()
  console.log('结论提示：')
  console.log('  实验 A 中，第 2/3 轮的 context% 增量若远小于第 1 轮的绝对值，')
  console.log('  说明 Kiro 服务端对历史前缀有缓存效果（即使不上报 cacheReadInputTokens）。')
  console.log('  若增量接近线性增长，说明每轮都在重新计算完整 token。')
}

main().catch(e => { console.error(e); process.exit(1) })
