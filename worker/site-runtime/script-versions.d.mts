export type Release = { version: string; channel: string; codeSha256: string; capabilities: readonly string[] };
export type Notice = { version: string; runtimeSha256: string };
export type ScriptNeeds = { accounts: string[]; rules: boolean; cache: boolean };
export function releaseLabel(release: { version: string; channel: string }): string;
export function versionList(items: readonly string[], word: string): string;
/** At most two releases, oldest first: the smallest step and the newest offered release. */
export function scriptVersionsWith<T extends Release>(capabilities: readonly string[], history?: readonly T[], notices?: readonly Notice[]): T[];
export function scriptVersionLabels(capabilities: readonly string[], history?: readonly Release[], notices?: readonly Notice[]): string[];
export function scriptVersionText(capabilities: readonly string[], history?: readonly Release[], notices?: readonly Notice[]): string;
export function accountsNeeding(config: Record<string, unknown>, snapshot: { bidders?: unknown[] }): string[];
export function rulesNeeded(config: unknown): boolean;
export function neededCapabilities(needs: ScriptNeeds): string[];
export const CAPABILITY_NAMES: Readonly<Record<string, string>>;
