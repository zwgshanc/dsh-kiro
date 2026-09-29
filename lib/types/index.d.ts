/**
 * Register a {@link KiroAdapter} for the `kiro` provider route on `ctx.llm`,
 * with connection facts resolved per request instead of frozen at load: the
 * plugin layers its `cordis.yml` entry config under the optional `llm-kiro`
 * user-settings section (`ctx.settings`), so a changed proxy, profile, or
 * catalog reaches the very next request without restarting anything, while an
 * in-flight stream keeps the facts it started with. The one
 * registration-captured fact — the retry policy — re-registers the route in
 * place when it changes.
 *
 * Credentials are not configured here. Builder ID login writes a DSH-owned
 * credential directory; when absent, Kiro IDE/CLI's SSO cache is the fallback.
 *
 * @module dsh-kiro
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm';
import type { KiroCatalogModel, KiroConnectionOptions } from './adapter.ts';
export { DEFAULT_CONTEXT_WINDOW, DEFAULT_STREAM_IDLE_TIMEOUT_MS, KiroAdapter, httpErrorCode, } from './adapter.ts';
export type { KiroAdapterOptions, KiroCatalogModel, KiroConnectionOptions } from './adapter.ts';
export { clearTokenCache, DEFAULT_REGION, kiroAuthMethod, kiroCredentialDirectory, resolveToken, resolveTokenFromDirectories, } from './auth.ts';
export type { KiroToken, TokenSourceOptions } from './auth.ts';
export type { DirectoryTokenSourceOptions, KiroAuthMethod } from './auth.ts';
export { discoverKiroProfileArn, KiroModelDiscovery, listKiroProfiles, modelPageToken, modelSupportsThinking, parseAvailableModels, parseEffortSchema, parseMaxTokensBounds, } from './discovery.ts';
export { compareKiroModels, FileModelSettingsStore, modelSelection, modelSettingsPath, } from './model-settings.ts';
export type { KiroModelSettings } from './model-settings.ts';
export { assertMicrosoftTokenEndpoint, normalizeExternalIdpCredentials } from './external-idp.ts';
export { BUILDER_START_URL, credentialSummary, deleteDeviceCredentials, importApiKey, importExternalIdp, importRefreshToken, pollDeviceLogin, pollSocialDeviceLogin, resolveRefreshTokenOrigin, saveDeviceCredentials, saveManagedCredentials, startDeviceLogin, startSocialDeviceLogin, } from './login.ts';
export type { DeviceCredentials, DeviceLoginOptions, DeviceLoginPoll, DeviceLoginSession, ManagedCredentials, RefreshTokenOrigin, SocialDeviceLoginPoll, SocialDeviceLoginSession, } from './login.ts';
export { credentialDirectory } from './paths.ts';
export { assertKiroProfileArn, profileRegion } from './profile.ts';
export { assertKiroRegion } from './region.ts';
export { getJson, parseProxyUrl, postForm, postJson, postJsonWithHeaders } from './transport.ts';
export { buildModelRequestFields } from './serialize.ts';
export type { ModelLimits, RequestDefaults } from './serialize.ts';
export type * from './types.ts';
export declare const name = "dsh-kiro";
export declare const inject: string[];
/**
 * A config reference dsh 0.1.7 delivers in place of a plain value for a schema
 * field marked `.volatile()`: the loader and a settings scope both wrap the
 * field, and the reference is stable across settings writes. Declared
 * structurally so the plugin needs no particular `@deepseek-ai/cordis` version.
 */
interface VolatileRef<T> {
    /** @returns the current plain value, or undefined when absent. */
    get(): T;
}
/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-kiro` settings-section shape. Every field is optional in yml: an
 * absent Kiro sign-in fails at the first request with `MISSING_CREDENTIAL`
 * rather than at plugin load, and an omitted region follows the token file.
 */
export interface Config {
    /**
     * Proxy egress for every Kiro request as `scheme://[user:pass@]host:port`
     * (`http://` or `https://`). Kiro authorizes Claude models by request
     * egress: a deployment whose own egress is unauthorized reaches the
     * `claude-*` models only through a permitted proxy, while the open-weight
     * models answer without one. An invalid value fails plugin loading.
     */
    proxyUrl?: string;
    /** Region selecting the endpoint; omitted follows the signed-in token file. */
    region?: string;
    /**
     * CodeWhisperer profile ARN; omitted uses the account default.
     *
     * Declared volatile so the Kiro settings page can switch profiles: dsh 0.1.7
     * refuses a settings write to a plugin entry that declares no volatile field,
     * and a volatile field reaches the plugin as a {@link VolatileRef} reference
     * instead of a plain value (see {@link readConfigField}).
     */
    profileArn?: VolatileRef<string | undefined> | string;
    /** Deployment thinking policy; `disabled` suppresses model reasoning. */
    thinking?: 'enabled' | 'disabled';
    /** Optional provider-wide override; omission follows each model's live default. */
    reasoningEffort?: 'none' | 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    /** Positive context capacity used when the selected model has no exact value (default 200,000). */
    defaultContextWindow?: number;
    /** Advisory models shown by discovery consumers; defaults to the verified account tier. */
    models?: KiroCatalogModel[];
    /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
    streamIdleTimeoutMs?: number;
    /** Refresh the access token this long before expiry (default five minutes). */
    tokenExpiryBufferMs?: number;
    /** Provider-owned model-request retry policy; omission uses normal defaults. */
    retryPolicy?: RetryPolicyConfig;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    proxyUrl: z<string, string, "plain">;
    region: z<string, string, "plain">;
    profileArn: z<string, string, "volatile">;
    thinking: z<"enabled" | "disabled", "enabled" | "disabled", "plain">;
    reasoningEffort: z<"off" | "low" | "medium" | "high" | "none" | "xhigh" | "max", "off" | "low" | "medium" | "high" | "none" | "xhigh" | "max", "plain">;
    defaultContextWindow: z<number, number, "defined">;
    models: z<KiroCatalogModel[], KiroCatalogModel[], "defined">;
    streamIdleTimeoutMs: z<number, number, "defined">;
    tokenExpiryBufferMs: z<number, number, "defined">;
    retryPolicy: z<RetryPolicyConfig>;
}>>, Schemastery.ObjectT<NoInfer<{
    proxyUrl: z<string, string, "plain">;
    region: z<string, string, "plain">;
    profileArn: z<string, string, "volatile">;
    thinking: z<"enabled" | "disabled", "enabled" | "disabled", "plain">;
    reasoningEffort: z<"off" | "low" | "medium" | "high" | "none" | "xhigh" | "max", "off" | "low" | "medium" | "high" | "none" | "xhigh" | "max", "plain">;
    defaultContextWindow: z<number, number, "defined">;
    models: z<KiroCatalogModel[], KiroCatalogModel[], "defined">;
    streamIdleTimeoutMs: z<number, number, "defined">;
    tokenExpiryBufferMs: z<number, number, "defined">;
    retryPolicy: z<RetryPolicyConfig>;
}>>, "plain">;
/**
 * One resolution's complete request facts. Connection, proxy, and token-policy
 * facts are one value on purpose: a snapshot the resolver rejects keeps the
 * whole previous generation, so a request can never pair a stale endpoint with
 * a newer egress.
 */
export type ResolvedKiroOptions = KiroConnectionOptions;
/**
 * The one explicit resolve step from raw config to validated connection facts.
 * Programmatic construction may bypass Schemastery normalization, so every
 * default and bound is re-judged here — for the composition entry at load
 * (fail loud) and for each settings snapshot at its first use.
 * @param config - raw plugin config or resolved settings snapshot.
 * @returns validated connection facts.
 * @throws when a field is present but unusable (a malformed proxy URL, a
 *   duplicate catalog id, an out-of-range timeout).
 */
export declare function resolveAdapterOptions(config: Config): ResolvedKiroOptions;
export declare function apply(ctx: Context, config: Config): void;
