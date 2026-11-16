type Release = { version: string; channel: string; codeSha256: string; capabilities: readonly string[] };
export type ScriptNeeds = { accounts: string[]; rules: boolean; cache: boolean };
export function scriptVersionsWith<T extends Release>(capabilities: readonly string[], history?: readonly T[]): T[];
export function scriptVersionText(capabilities: readonly string[], history?: readonly Release[]): string;
export function savedScriptNeeds(snapshot: unknown): ScriptNeeds;
export function neededCapabilities(needs: ScriptNeeds): string[];
export function scriptGuidance(needs: ScriptNeeds, descriptor: unknown, history?: readonly Release[]): string | null;
export function requireSavedOptionsRuntime(snapshot: unknown, descriptor: unknown): void;
export function requireBidderRulesScript(config: unknown, descriptor: unknown): void;
