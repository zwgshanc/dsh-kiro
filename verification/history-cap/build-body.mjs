/**
 * Rebuild the exact wire body this adapter would send at a chosen point in a
 * recorded DSH session, using the package's own `serializeRequest`, and report
 * its shape. Pairs with `replay-body.mjs`, which posts the result.
 *
 * Reading a session log needs two modules that ship with DSH rather than with
 * this package, so their location comes from the environment:
 *
 *   DSH_DATA     DSH home holding `profiles/node_modules` (required)
 *   SESSION      path to a `session.v3.jsonl.zstd` (required)
 *   OUT          where to write the body (default ./wire-body.json)
 *   STOP_AT      'overflow' cuts at the first "Input is too long" event,
 *                a number cuts at that event index, 'end' uses the whole log
 *                (default 'overflow')
 *
 * Usage:
 *   DSH_DATA=~/.dsh SESSION=.../session.v3.jsonl.zstd node build-body.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { serializeRequest } from '../../src/serialize.ts'

const home = process.env.DSH_DATA
const session = process.env.SESSION
if (home === undefined || session === undefined) {
  console.error('set DSH_DATA (DSH home with profiles/node_modules) and SESSION (session.v3.jsonl.zstd)')
  process.exit(2)
}
const out = process.env.OUT ?? 'wire-body.json'
const stopAt = process.env.STOP_AT ?? 'overflow'

const modules = join(home, 'profiles', 'node_modules')
const { createZstdFrameDecoder, scanZstdFrames } = await import(
  pathToFileURL(join(modules, '@deepseek-ai/dsh-session-persistence-jsonl/lib/types/zstd.js')).href)
const { deriveEventMessage } = await import(
  pathToFileURL(join(modules, '@deepseek-ai/dsh-session/lib/types/index.js')).href)

/** Decode a multi-frame zstd session log to event objects. */
async function events(path) {
  const bytes = readFileSync(path)
  const { frames } = scanZstdFrames(bytes)
  const decoder = createZstdFrameDecoder()
  try {
    const chunks = []
    for await (const chunk of decoder.decode(bytes, frames)) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString('utf8').split('\n')
      .filter(line => line.trim().length > 0)
      .flatMap((line) => {
        // A torn concurrent tail is expected; a malformed middle is not.
        try { return [JSON.parse(line)] } catch { return [] }
      })
  } finally { decoder.close() }
}

const log = await events(session)
const cut = stopAt === 'end'
  ? log.length
  : stopAt === 'overflow'
    ? (index => index < 0 ? log.length : index)(
        log.findIndex(event => JSON.stringify(event).includes('Input is too long')))
    : Number(stopAt)

let header
const messages = []
for (const event of log.slice(0, cut)) {
  if (event.type === 'request/header' && event.data?.header?.config?.provider === 'kiro') {
    header = event.data.header
  }
  // Non-surface events have no message; only surface events contribute.
  try {
    const message = deriveEventMessage(event)
    if (message !== null) messages.push(message)
  } catch { /* not a surface event */ }
}
if (header === undefined) {
  console.error('no kiro request/header in the log before the cut; was this session routed to kiro?')
  process.exit(1)
}

const request = serializeRequest(
  {
    provider: 'kiro',
    model: header.config.model,
    messages,
    tools: header.tools ?? [],
    ...header.system === undefined || header.system === '' ? {} : { system: header.system },
    ...header.config.maxTokens === undefined ? {} : { maxTokens: header.config.maxTokens },
    ...header.config.reasoningEffort === undefined ? {} : { reasoningEffort: header.config.reasoningEffort },
  },
  {},
  'verification-history-cap',
  process.env.PROFILE_ARN,
)

const body = JSON.stringify(request)
writeFileSync(out, body)

const history = request.conversationState.history ?? []
const users = history.filter(entry => 'userInputMessage' in entry).length
const issued = new Set(history.flatMap(entry =>
  'assistantResponseMessage' in entry
    ? (entry.assistantResponseMessage.toolUses ?? []).map(use => use.toolUseId)
    : []))
const orphaned = history.reduce((total, entry) => total + (
  'userInputMessage' in entry
    ? (entry.userInputMessage.userInputMessageContext?.toolResults ?? [])
      .filter(result => !issued.has(result.toolUseId)).length
    : 0), 0)

console.log(`events              : ${String(log.length)} (cut at ${String(cut)})`)
console.log(`surface messages    : ${String(messages.length)}`)
console.log(`body bytes          : ${String(body.length)}`)
console.log(`history entries     : ${String(history.length)}`)
console.log(`user messages       : ${String(users + 1)} (${String(users)} history + currentMessage)`)
console.log(`tool schemas        : ${String(request.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools?.length ?? 0)}`)
console.log(`orphaned toolResults: ${String(orphaned)}`)
console.log(`wrote               : ${out}`)
