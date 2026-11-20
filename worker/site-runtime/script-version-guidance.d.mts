export { scriptVersionsWith, scriptVersionLabels, scriptVersionText, neededCapabilities } from './script-versions.mjs';
export type { ScriptNeeds } from './script-versions.mjs';
import type { Release, ScriptNeeds } from './script-versions.mjs';
export function savedScriptNeeds(snapshot: unknown): ScriptNeeds;
export function savedScriptVersionLabels(capability: string, snapshot: { config: { config_json: string }; bidders?: unknown[] }): string[];
export function scriptGuidance(needs: ScriptNeeds, descriptor: unknown, history?: readonly Release[]): string | null;
export function requireSavedOptionsRuntime(snapshot: unknown, descriptor: unknown): void;
export function requireBidderRulesScript(config: unknown, descriptor: unknown): void;
