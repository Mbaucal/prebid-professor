import type { ArmSettings } from './package-settings-v1.mjs';
export type ScriptSettings = (ArmSettings & {readonly positionOverrides?: never}) | Readonly<{
  mode: ArmSettings['mode'];
  refreshSeconds: number | null;
  maxBidAgeSeconds: number;
  positionOverrides: Record<string, boolean>;
}>;
export const SCRIPT_ID: RegExp;
export const TEST_ID: RegExp;
export const DEFAULT_SCRIPT_SETTINGS: ArmSettings;
export function displayName(value: unknown): string;
export function scriptSettings(value: unknown): ScriptSettings;
