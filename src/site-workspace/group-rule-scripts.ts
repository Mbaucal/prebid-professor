import { versionChoice } from './runtime-labels';

// Scripts where Default, ATF and BTF conditional rules skip TakeOver and Outstream instead of
// rejecting the package. Each compiler decides this without a capability, so the list is checked
// against generated packages for every release by tests/runtime/group-rule-format-scripts.test.mjs.
// It is help text, not a feature allow-list (tests/runtime/runtime-allow-list-parity.test.mjs).
export const GROUP_RULE_FORMAT_SCRIPTS = Object.freeze(['3.21.1', '3.21.2', '3.22.1', '3.22.2', '3.23.0', '3.24.0']);
export function groupRuleFormatText() {
  return `In scripts ${versionChoice(GROUP_RULE_FORMAT_SCRIPTS, 'and')}, Default, ATF and BTF conditions apply only to those formats; `
    + 'TakeOver and Outstream keep their own maps and serving behavior. Scripts before 3.21.1 and script 3.22.0 can reject packages when those group rules reach TakeOver or Outstream.';
}
