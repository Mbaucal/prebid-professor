import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeCatalog, previewInput, buildArtifactCandidate} from '../../worker/test-workspace/runtime-catalog.mjs';
import {runtimeReleaseHistory} from '../../worker/runtime/runtime-release-history.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {prebidRequirements, inspectPrebidArtifact, sha256} from '../../worker/runtime/prebid-artifact-check-v2.mjs';
import {positionFixture} from '../support/position-runtime-fixture.mjs';
import {mapping} from '../support/conditional-maps-fixture.mjs';
import {configure, TS} from './artifact-fixture.mjs';
import {GROUP_RULE_FORMAT_SCRIPTS, groupRuleFormatText} from '../../src/site-workspace/group-rule-scripts.ts';

/* Unit rules help text (src/components/UnitRulesPanel.tsx) names the scripts where Default, ATF and BTF
 * conditions skip TakeOver and Outstream instead of rejecting the package. The compilers decide this per
 * version, with no capability, so the list is static and checked here against generated packages. Every
 * numeric release from 3.21.0 on must be classified: a new release fails this test until it is added to
 * GROUP_RULE_FORMAT_SCRIPTS or to REJECTS below. */
const REJECTS = ['3.21.0', '3.22.0'];
const numbers = version => version.split('.').map(Number);
const from3210 = version => { const [major, minor] = numbers(version); return major > 3 || (major === 3 && minor >= 21); };
const releases = runtimeReleaseHistory.filter(release => /^\d+\.\d+\.\d+$/.test(release.version) && from3210(release.version));

async function prebid(snapshot, descriptor) {
  const input = previewInput(snapshot, descriptor, TS), requirements = prebidRequirements(input, JSON.parse(snapshot.config.config_json));
  if (!requirements.required) return null;
  const bytes = new TextEncoder().encode(`/* prebid.js v11.34.0\nModules: ${requirements.modules.join(', ')} */\nvoid 0;`).buffer;
  const build = {id: 'b', publisher_id: snapshot.site.id, status: 'current', version: '11.34.0', file_key: `publishers/${snapshot.site.id}/prebid-builds/b/prebid.js`, modules_json: JSON.stringify(requirements.modules)};
  const object = {size: bytes.byteLength, customMetadata: {sha256: await sha256(bytes), version: '11.34.0'}, async arrayBuffer() { return bytes; }};
  return {bytes, report: await inspectPrebidArtifact({siteId: snapshot.site.id, builds: [build], requirements}, {async get() { return object; }})};
}
/** A Default or ATF country rule that reaches the TakeOver position: excluded (true) or refused (false). */
async function excludes(descriptor, scope) {
  const snapshot = configure(positionFixture(true), config => { config.runtimeControls.adPositions.Overlay.frequencyMinutes = 5; });
  snapshot.rules = [...snapshot.rules.filter(rule => rule.rule_key !== scope), {rule_key: scope, rule_json: JSON.stringify({conditionalMappings: [
    mapping({sizeMapKey: null, slotAction: 'disable', conditions: [{key: 'geo_country', operator: 'notEquals', value: 'RS'}]})]})}];
  try {
    const result = await buildArtifactCandidate({snapshot, pin: pinRuntime(descriptor, {allowPreview: true}), buildTimestamp: TS, prebid: await prebid(snapshot, descriptor)});
    const config = JSON.parse(new TextDecoder().decode(result.files['config.json']));
    const exclusions = config.conditionalRuleExclusions ?? config.core?.conditionalRuleExclusions;
    assert.deepEqual(exclusions, [{code: 'Overlay', format: 'TakeOver', scopes: [scope]}], `${descriptor.version} ${scope}`);
    return true;
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.match(error.message, /key-value rules currently support in-page Banner and Sticky positions/, `${descriptor.version} ${scope}`);
    return false;
  }
}

test('the Unit rules list of scripts that skip TakeOver for group rules matches generated packages', async () => {
  const unclassified = releases.filter(release => !GROUP_RULE_FORMAT_SCRIPTS.includes(release.version) && !REJECTS.includes(release.version)).map(release => release.version);
  assert.deepEqual(unclassified, [], 'Classify each new release for the Unit rules help text');
  for (const release of releases) {
    const descriptor = runtimeCatalog.find(entry => entry.version === release.version && entry.codeSha256 === release.codeSha256);
    assert(descriptor, release.version);
    for (const scope of ['__DEFAULT__', '__ATF__'])
      assert.equal(await excludes(descriptor, scope), GROUP_RULE_FORMAT_SCRIPTS.includes(release.version), `${release.version} ${scope}`);
  }
  assert.deepEqual([...GROUP_RULE_FORMAT_SCRIPTS], ['3.21.1', '3.21.2', '3.22.1', '3.22.2', '3.23.0', '3.24.0']);
});

test('the help text names every listed script and 3.22.0 explicitly, never "and later"', () => {
  const text = groupRuleFormatText();
  assert.equal(text, 'In scripts 3.21.1, 3.21.2, 3.22.1, 3.22.2, 3.23.0 and 3.24.0, Default, ATF and BTF conditions apply only to those formats; '
    + 'TakeOver and Outstream keep their own maps and serving behavior. Scripts before 3.21.1 and script 3.22.0 can reject packages when those group rules reach TakeOver or Outstream.');
  assert.doesNotMatch(text, /or later|and later/);
});
