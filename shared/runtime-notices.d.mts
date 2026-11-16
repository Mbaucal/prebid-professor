export type RuntimeNotice = {
  readonly version: string;
  readonly runtimeSha256: string;
  /** Appended to the version in choices and saved-version lines. */
  readonly optionSuffix: string;
  /** Plain-language reason shown beside the selected version. */
  readonly warning: string;
  /** A release with the same feature and the missing fixes, named only when it is offered. */
  readonly alternative: { readonly version: string; readonly offers: string };
};
export const runtimeNotices: readonly RuntimeNotice[];
