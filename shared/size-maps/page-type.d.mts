export type PageTypeUnit = { code: string; base: string | null };
export type PageTypeUse = { base: string; pageType: string; map: string; codes: string[] };
export type PageTypeChange = { pageType: string; base: string; codes: string[]; from: string | null; to: string | null };
export function pageTypeOf(name: string, base: string): string | null;
export function pageTypeRenames(names: Iterable<string>, from: string, to: string, unitBases?: Set<string>): Map<string, string>;
export function compactCodes(codes: string[]): string;
export function pageTypeUse(names: string[], units: PageTypeUnit[]): PageTypeUse[];
export function pageTypeChanges(input: {
  names: string[];
  units: PageTypeUnit[];
  renames?: Map<string, string>;
  deleted?: Set<string>;
}): PageTypeChange[];
export function comparePageTypeChanges(a: { base: string; pageType: string }, b: { base: string; pageType: string }): number;
export function describePageTypeChange(change: PageTypeChange): string;
