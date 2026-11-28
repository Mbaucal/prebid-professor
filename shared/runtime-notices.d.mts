export type RuntimeNotice = {
  readonly version: string;
  readonly runtimeSha256: string;
  /** Appended to the version in choices and saved-version lines. */
  readonly optionSuffix: string;
  /** Plain-language reason shown beside the selected version. */
  readonly warning: string;
  /** A release with the same feature and missing fixes. Omitted when this workspace offers no corrected release. */
  readonly alternative?: { readonly version: string; readonly offers: string };
  /** A known earlier source stays selectable but is not offered as the recommendation. */
  readonly excludeFromRecommendation?: boolean;
};
export const runtimeNotices: readonly RuntimeNotice[];
export function recommendedRuntimeRelease<T extends {version: string; codeSha256: string; channel: string}>(history: readonly T[]): T | undefined;
