/** DSH Web API for multi-method Kiro login, credential import, and model discovery. */
import type { Context } from '@deepseek-ai/cordis';
import '@deepseek-ai/dsh-host-webserver';
import type { KiroConnectionOptions } from './adapter.ts';
import type { KiroToken } from './auth.ts';
import type { KiroModelDiscovery } from './discovery.ts';
import type { FileModelSettingsStore } from './model-settings.ts';
interface WebDependencies {
    managedDirectory: string;
    options: () => KiroConnectionOptions;
    discovery: KiroModelDiscovery;
    modelSettings: FileModelSettingsStore;
    resolveToken: (connection: KiroConnectionOptions, signal: AbortSignal) => Promise<KiroToken>;
    /** Write a new profileArn into the llm-kiro settings (undefined clears it). */
    setProfileArn: (arn: string | undefined) => Promise<void>;
}
/** Register the optional DSH Web management API. */
export declare function registerWebApi(ctx: Context, dependencies: WebDependencies): void;
export {};
