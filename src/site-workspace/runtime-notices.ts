import { runtimeLabel } from './runtime-labels';
import { runtimeNotices, type RuntimeNotice } from '../../shared/runtime-notices.mjs';

// The notice records live in shared/runtime-notices.mjs, which the TEST
// workspace Script version page also reads.
export type { RuntimeNotice };

type PinLike = { runtimeVersion?: unknown; runtimeSha256?: unknown } | null | undefined;
type Choice = { version: string; channel?: string };

export function runtimeNotice(pin: PinLike): RuntimeNotice | undefined {
  if (!pin) return undefined;
  return runtimeNotices.find(notice => notice.version === pin.runtimeVersion && notice.runtimeSha256 === pin.runtimeSha256);
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
