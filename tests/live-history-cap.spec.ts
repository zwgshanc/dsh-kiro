/**
 * Live probe: Kiro serves at most 100 user messages per request, counting
 * `currentMessage`, and refuses the 101st as `Input is too long.` with
 * `CONTENT_LENGTH_EXCEEDS_THRESHOLD`. The name is misleading — the limit counts
 * messages, not size — so this pins the boundary against the real service.
 *
 * A conversation that grows past the cap needs two different responses
 * (`tests/serialize.spec.ts` covers both as pure unit tests; this proves the
 * one that reaches the network actually works against the live service): an
 * ordinary turn throws instead of building a request, so the harness's
 * existing overflow recovery runs a real summarization rather than the same
 * span being silently re-dropped on every later turn; the compaction
 * summarizer's own request is the one caller allowed past the cap, by
 * truncating with a tombstone. Runs with KIRO_LIVE=1.
 */
import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { conversationIdFor, kiroRequestEndpoint, kiroTokenTypeHeaders } from '../src/adapter.ts'
import { kiroCredentialDirectory, resolveTokenFromDirectories } from '../src/auth.ts'
import { discoverKiroProfileArn } from '../src/discovery.ts'
import { resolveAdapterOptions } from '../src/index.ts'
import { credentialDirectory } from '../src/paths.ts'
import { profileRegion } from '../src/profile.ts'
import { serializeRequest } from '../src/serialize.ts'
import { post, postForm, postJson } from '../src/transport.ts'
import type { KiroToken } from '../src/auth.ts'
import type { WireHistoryEntry, WireRequest } from '../src/types.ts'

const MODEL = 'claude-sonnet-4.6'
const SOURCE = { kind: 'plugin' as const, plugin: 'live-history-cap' }

describe.runIf(process.env.KIRO_LIVE === '1')('live Kiro history user-message cap', () => {
  it('serves 100 user messages, refuses 101, and the serializer stays inside', async () => {
    const connection = resolveAdapterOptions({
      region: 'us-east-1',
      // Kiro authorizes Claude routes by egress, so a deployment that needs a
      // permitted exit supplies it the same way the adapter's config does.
      ...process.env.KIRO_PROXY === undefined ? {} : { proxyUrl: process.env.KIRO_PROXY },
    })
    const managed = credentialDirectory()
    const signal = AbortSignal.timeout(600_000)
    const token: KiroToken = await resolveTokenFromDirectories([managed, kiroCredentialDirectory()], {
      expiryBufferMs: connection.tokenExpiryBufferMs,
      fetchJson: (url: string, value: unknown) => postJson(url, value, connection.proxyUrl, signal),
      fetchForm: (url: string, value: URLSearchParams) => postForm(url, value, connection.proxyUrl, signal),
      resolveProfileArn: (accessToken: string, region: string, authMethod: never) =>
        discoverKiroProfileArn(connection, {
          accessToken,
          region,
          authMethod,
          expiresAt: Date.now() + 60_000,
        }, signal),
      writableDirectories: [managed],
    })

    // The adapter bills and routes against the profile's own region, so the
    // endpoint follows the ARN rather than the credential's home region.
    const region = token.profileArn === undefined
      ? connection.region ?? token.region
      : profileRegion(token.profileArn)

    /** Post one body and report the status plus the overflow marker. */
    async function attempt(label: string, body: WireRequest) {
      const response = await post({
        url: kiroRequestEndpoint(token, region),
        headers: {
          'content-type': 'application/json',
          accept: 'application/vnd.amazon.eventstream',
          authorization: `Bearer ${token.accessToken}`,
          ...kiroTokenTypeHeaders(token),
          'x-amzn-kiro-agent-mode': 'vibe',
          'user-agent': 'aws-sdk-js/3.738.0 KiroIDE',
          'x-amz-user-agent': 'aws-sdk-js/3.738.0 KiroIDE',
        },
        body: JSON.stringify(body),
        signal,
        ...connection.proxyUrl === undefined ? {} : { proxyUrl: connection.proxyUrl },
      })
      const chunks: Uint8Array[] = []
      for await (const chunk of response.body) chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('utf8')
      const users = (body.conversationState.history ?? [])
        .filter(entry => 'userInputMessage' in entry).length + 1
      const overflow = text.includes('CONTENT_LENGTH_EXCEEDS_THRESHOLD')
      console.log(`${label}: users=${users} bytes=${JSON.stringify(body).length} HTTP ${response.status} overflow=${overflow}`)
      return { status: response.status, overflow }
    }

    /** `n` complete exchanges, deliberately tiny so size can never be the cause. */
    function exchanges(n: number): Message[] {
      const messages: Message[] = []
      for (let index = 0; index < n; index += 1) {
        messages.push(
          createUserMessage({ content: [{ type: 'text', text: `ask ${String(index)}` }], source: SOURCE }),
          createAssistantMessage({
            content: [{ type: 'text', text: `answer ${String(index)}` }],
            source: { provider: 'kiro', model: MODEL },
          }),
        )
      }
      return messages
    }

    const build = (turns: number, purpose?: GenerateOptions['purpose']): WireRequest => serializeRequest(
      {
        provider: 'kiro',
        model: MODEL,
        messages: [
          ...exchanges(turns),
          createUserMessage({ content: [{ type: 'text', text: 'Reply with only: ok' }], source: SOURCE }),
        ],
        ...purpose === undefined ? {} : { purpose },
      },
      {},
      conversationIdFor(`history-cap-${String(turns)}`),
      token.profileArn,
    )

    // 99 history user turns plus currentMessage is the whole budget.
    const atCap = build(99)
    expect(atCap.conversationState.history).toHaveLength(198)
    const served = await attempt('at cap (100 user messages)', atCap)
    expect(served.status).toBe(200)

    // One more, spliced past the serializer, is the refusal this cap exists for.
    const overCap: WireRequest = {
      ...atCap,
      conversationState: {
        ...atCap.conversationState,
        conversationId: conversationIdFor('history-cap-over'),
        history: [
          { userInputMessage: { content: 'ask extra', modelId: MODEL, origin: 'AI_EDITOR' } },
          { assistantResponseMessage: { content: 'answer extra' } },
          ...atCap.conversationState.history as WireHistoryEntry[],
        ],
      },
    }
    const refused = await attempt('over cap (101 user messages)', overCap)
    expect(refused.status).toBe(400)
    expect(refused.overflow).toBe(true)

    // An ordinary turn (no purpose) this far past the cap must not build a
    // request at all — see tests/serialize.spec.ts for the exhaustive version
    // of this assertion; this just confirms the live build path agrees.
    expect(() => build(400)).toThrowError(expect.objectContaining({ code: 'CONTEXT_WINDOW_EXCEEDED' }))

    // The compaction summarizer's own request, this far past the cap, is the
    // one caller allowed through by truncating, and it must still serialize.
    const capped = build(400, 'compaction')
    expect(capped.conversationState.history).toHaveLength(198)
    const cappedServed = await attempt('compaction request, serializer-capped (400 turns in)', capped)
    expect(cappedServed.status).toBe(200)
  }, 600_000)
})
