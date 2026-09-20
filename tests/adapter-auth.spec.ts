import { describe, expect, it } from 'vitest'
import { kiroRequestEndpoint, kiroTokenTypeHeaders } from '../src/adapter.ts'
import type { KiroToken } from '../src/auth.ts'

function token(authMethod: KiroToken['authMethod']): KiroToken {
  return { accessToken: 'access', region: 'us-east-1', expiresAt: Date.now() + 60_000, authMethod }
}

describe('auth-specific Kiro request routing', () => {
  it('routes every token to the Kiro runtime gateway', () => {
    expect(kiroRequestEndpoint(token('idc'), 'eu-central-1'))
      .toBe('https://runtime.eu-central-1.kiro.dev/generateAssistantResponse')
    expect(kiroRequestEndpoint(token('external_idp'), 'us-east-1')).toContain('runtime.')
    expect(kiroTokenTypeHeaders(token('external_idp'))).toEqual({ TokenType: 'EXTERNAL_IDP' })
    expect(kiroRequestEndpoint(token('api_key'), 'us-west-2'))
      .toBe('https://runtime.us-west-2.kiro.dev/generateAssistantResponse')
    expect(kiroTokenTypeHeaders(token('api_key'))).toEqual({ TokenType: 'API_KEY' })
  })
})
