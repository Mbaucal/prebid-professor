/** Public editor/compiler contract; validatePackageSettings validates unknown input. */
export type ArmSettings = Readonly<{
  refreshSeconds: number | null;
} & (
  | { mode: 'fresh-only'; maxBidAgeSeconds?: never }
  | { mode: 'auction-with-cache'; maxBidAgeSeconds: number }
)>;
export type PackageSettings = Readonly<{
  schemaVersion: 1;
  trafficBPercent: number;
  arms: Readonly<{ A: ArmSettings; B: ArmSettings }>;
}>;
export const DEFAULT_PACKAGE_SETTINGS: PackageSettings;
export function validatePackageSettings(input: unknown): PackageSettings;
