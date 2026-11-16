import { runtimeLabel } from './runtime-labels';

// Operator notices for exact registered releases. Display only: a noticed
// version stays selectable and savable, and release records, saved pins and
// generated packages are unchanged. Match by version and source checksum so a
// notice never moves to another build.
export type RuntimeNotice = {
  version: string;
  runtimeSha256: string;
  /** Appended to the version in choices and saved-version lines. Keep it short:
   * "3.22.0 · No 3.21.1/3.21.2 fixes" measures 226 px in the admin font, inside
   * the 260 px text room of the narrowest Script setup select at 390 px. */
  optionSuffix: string;
  /** Plain-language reason shown beside the selected version. */
  warning: string;
  /** A release with the same feature and the missing fixes, named only when it is offered. */
  alternative: { version: string; offers: string };
};

type PinLike = { runtimeVersion?: unknown; runtimeSha256?: unknown } | null | undefined;
type Choice = { version: string; channel?: string };

const notices: readonly RuntimeNotice[] = Object.freeze([Object.freeze({
  version: '3.22.0',
  runtimeSha256: '1aa3c8ad0dcc1c94fddf6d50b0a7b3073a524dee4750563277fd5c6d22525268',
  optionSuffix: ' · No 3.21.1/3.21.2 fixes',
  warning: '3.22.0 adds bidder rules but is built on 3.21.0. It does not have the 3.21.1 and 3.21.2 fixes for size maps when a key-value rule does not match, contextual signals with existing Prebid RTD providers, and TakeOver frequency and debug storage before CMP consent.',
  alternative: Object.freeze({ version: '3.22.1', offers: 'bidder rules with these fixes' }),
})]);

export function runtimeNotice(pin: PinLike): RuntimeNotice | undefined {
  if (!pin) return undefined;
  return notices.find(notice => notice.version === pin.runtimeVersion && notice.runtimeSha256 === pin.runtimeSha256);
}

export function runtimeNoticeSuffix(pin: PinLike) {
  return runtimeNotice(pin)?.optionSuffix ?? '';
}

// The current version comes from the server's recommendation, never from this
// module, so a later stable release changes the text without an edit here.
export function runtimeNoticeText(notice: RuntimeNotice, choices: readonly Choice[], current?: { version: string } | null) {
  const currentLabel = current ? runtimeLabel(current.version) : undefined;
  const alternative = choices.find(item => runtimeLabel(item.version) === notice.alternative.version);
  const alternativeLabel = alternative ? runtimeLabel(alternative.version) : undefined;
  const parts = [notice.warning];
  if (alternative && alternativeLabel) {
    const status = alternativeLabel === currentLabel ? ', the current version,' : alternative.channel === 'preview' ? ' (Preview)' : '';
    parts.push(`${alternativeLabel}${status} has ${notice.alternative.offers}.`);
  }
  if (currentLabel && currentLabel !== alternativeLabel && currentLabel !== notice.version) parts.push(`${currentLabel} is the current version.`);
  return parts.join(' ');
}
