type Release = { version: string; channel: string; codeSha256: string; capabilities: readonly string[] };
type Notice = { version: string; runtimeSha256: string };
export type ScriptNeeds = { accounts: string[]; rules: boolean; cache: boolean };
/** At most two releases, oldest first: the smallest step and the newest offered release. */
export function scriptVersionsWith<T extends Release>(capabilities: readonly string[], history?: readonly T[], notices?: readonly Notice[]): T[];
export function scriptVersionLabels(capabilities: readonly string[], history?: readonly Release[], notices?: readonly Notice[]): string[];
export function scriptVersionText(capabilities: readonly string[], history?: readonly Release[], notices?: readonly Notice[]): string;
export function savedScriptNeeds(snapshot: unknown): ScriptNeeds;
export function savedScriptVersionLabels(capability: string, snapshot: { config: { config_json: string }; bidders?: unknown[] }): string[];
export function neededCapabilities(needs: ScriptNeeds): string[];
export function scriptGuidance(needs: ScriptNeeds, descriptor: unknown, history?: readonly Release[]): string | null;
export function requireSavedOptionsRuntime(snapshot: unknown, descriptor: unknown): void;
export function requireBidderRulesScript(config: unknown, descriptor: unknown): void;
