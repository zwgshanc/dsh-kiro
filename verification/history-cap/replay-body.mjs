/**
 * Post a saved wire body to the real service and report what came back, so a
 * recorded failure can be replayed against a candidate fix without waiting for
 * a long session to reproduce it.
 *
 * Credentials resolve through the built artifact, so refresh, the profile ARN
 * lookup and the proxy egress are the same code DSH runs. The endpoint and the
 * token-type header are derived inline because `lib` does not export them;
 * `src/adapter.ts` (`kiroRequestEndpoint`, `kiroTokenTypeHeaders`) is the source
 * of truth for both, and this must be kept in step with it.
 *
 *   BODY        path to the JSON body (default ./wire-body.json)
 *   KIRO_PROXY  proxy egress, when the deployment's Claude routes need one
 *   VARIANT     'as-is' (default) or 'drop-oldest-pair', which removes the two
 *               oldest history entries — the minimal change that takes a body
 *               one user message under the cap
 *
 * Usage:
 *   KIRO_PROXY=http://127.0.0.1:7890 node replay-body.mjs
 */
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import {
  credentialDirectory,
  discoverKiroProfileArn,
  kiroCredentialDirectory,
  postForm,
  postJson,
  profileRegion,
  resolveAdapterOptions,
  resolveTokenFromDirectories,
} from '../../lib/index.js'

const path = process.env.BODY ?? 'wire-body.json'
const variant = process.env.VARIANT ?? 'as-is'
const body = JSON.parse(readFileSync(path, 'utf8'))

if (variant === 'drop-oldest-pair') {
  body.conversationState.history = (body.conversationState.history ?? []).slice(2)
} else if (variant !== 'as-is') {
  console.error(`unknown VARIANT "${variant}"`)
  process.exit(2)
}
// A fresh id per run keeps replays from colliding in the service's own records.
body.conversationState.conversationId = randomUUID()

const connection = resolveAdapterOptions({
  region: 'us-east-1',
  ...process.env.KIRO_PROXY === undefined ? {} : { proxyUrl: process.env.KIRO_PROXY },
})
const managed = credentialDirectory()
const signal = AbortSignal.timeout(600_000)
const token = await resolveTokenFromDirectories([managed, kiroCredentialDirectory()], {
  expiryBufferMs: connection.tokenExpiryBufferMs,
  fetchJson: (url, value) => postJson(url, value, connection.proxyUrl, signal),
  fetchForm: (url, value) => postForm(url, value, connection.proxyUrl, signal),
  resolveProfileArn: (accessToken, region, authMethod) =>
    discoverKiroProfileArn(connection, { accessToken, region, authMethod, expiresAt: Date.now() + 60_000 }, signal),
  writableDirectories: [managed],
})

// Requests bill and route against the profile's region; the credential's own
// region is what token refresh uses and is deliberately left alone.
const region = token.profileArn === undefined
  ? connection.region ?? token.region
  : profileRegion(token.profileArn)
const codewhisperer = token.authMethod === 'idc' || token.authMethod === 'external_idp'
const host = codewhisperer ? `codewhisperer.${region}.amazonaws.com` : `q.${region}.amazonaws.com`
if (body.profileArn === undefined && token.profileArn !== undefined) body.profileArn = token.profileArn

const serialized = Buffer.from(JSON.stringify(body), 'utf8')
const history = body.conversationState.history ?? []
const users = history.filter(entry => 'userInputMessage' in entry).length + 1
console.log(`posting ${String(serialized.length)} bytes, ${String(history.length)} history entries, ${String(users)} user messages -> ${host}`)

/** Open a CONNECT tunnel, mirroring src/transport.ts. */
function tunnel(proxy) {
  const url = new URL(proxy)
  return new Promise((resolve, reject) => {
    const open = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = open({
      host: url.hostname,
      port: url.port.length > 0 ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
      method: 'CONNECT',
      path: `${host}:443`,
      headers: { host: `${host}:443` },
    })
    req.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`proxy refused CONNECT with HTTP ${String(response.statusCode)}`))
        return
      }
      resolve(socket)
    })
    req.once('error', reject)
    req.end()
  })
}

const socket = connection.proxyUrl === undefined ? undefined : await tunnel(connection.proxyUrl)
const response = await new Promise((resolve, reject) => {
  const req = httpsRequest({
    host,
    port: 443,
    path: '/generateAssistantResponse',
    method: 'POST',
    signal,
    ...socket === undefined
      ? {}
      : { createConnection: () => tlsConnect({ socket, servername: host }) },
    headers: {
      'content-type': 'application/json',
      accept: 'application/vnd.amazon.eventstream',
      authorization: `Bearer ${token.accessToken}`,
      ...token.authMethod === 'api_key' ? { TokenType: 'API_KEY' } : {},
      ...token.authMethod === 'external_idp' ? { TokenType: 'EXTERNAL_IDP' } : {},
      ...codewhisperer
        ? { 'x-amz-target': 'AmazonCodeWhispererStreamingService.GenerateAssistantResponse' }
        : {},
      'x-amzn-kiro-agent-mode': 'vibe',
      'user-agent': 'aws-sdk-js/3.738.0 KiroIDE',
      'x-amz-user-agent': 'aws-sdk-js/3.738.0 KiroIDE',
      'content-length': String(serialized.length),
    },
  }, (res) => {
    const chunks = []
    res.on('data', chunk => chunks.push(chunk))
    res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
  })
  req.once('error', reject)
  req.write(serialized)
  req.end()
})

const percentage = /"contextUsagePercentage":([0-9.]+)/.exec(response.text)?.[1]
console.log(`HTTP ${String(response.status)}`)
if (percentage !== undefined) console.log(`contextUsagePercentage ${percentage}`)
if (response.status !== 200) {
  console.log(response.text.replace(/[^\x20-\x7e]/g, '.').slice(0, 300))
}
process.exit(response.status === 200 ? 0 : 1)
