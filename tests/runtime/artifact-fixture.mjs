import { runtimeDescriptor } from '../../worker/runtime/builtin-preview-service.mjs';
import { pinRuntime } from '../../worker/runtime/version-pin.mjs';
import { previewInput } from '../../worker/runtime/preview-snapshot.mjs';
import { prebidRequirements, inspectPrebidArtifact, sha256 } from '../../worker/runtime/prebid-artifact-check.mjs';
export const TS = '20260911_120000';
export function fixture() {
  return {
    site: { id: 'test-site', name: 'Offline fixture', domain: 'example.invalid', gam_path: '/123/test/' },
    config: { config_json: JSON.stringify({ enablePrebid: true,
      userSync: { syncEnabled: false, syncsPerBidder: 0, syncDelay: 0, auctionDelay: 0, userIds: [] },
      runtimeControls: { sticky: { bottomAdUnitId: 'Sticky', topAdUnitId: '' }, floors: { enabled: false }, output: { cleanComments: true } } }) },
    units: [
      { code: 'Billboard', type: 'ATF', media_type: 'banner', enabled: 1, size_map_key: 'display' },
      { code: 'P1', type: 'BTF', media_type: 'banner', enabled: 1, size_map_key: 'rectangle' },
      { code: 'Sticky', type: 'ATF', media_type: 'banner', enabled: 1, size_map_key: 'sticky' },
    ],
    bidders: [{ bidder: 'ix', enabled: 1, params_json: '{"siteId":"global"}' }],
    overrides: [{ bidder: 'ix', scope_type: 'adunit', scope_key: 'Billboard', enabled: 1, params_json: '{"siteId":"exact"}' }],
    maps: [
      { name: 'display', map_json: '[{"minViewPort":[0,0],"sizes":[[300,250]]},{"minViewPort":[1024,0],"sizes":[[970,250]]}]' },
      { name: 'rectangle', map_json: '[{"minViewPort":[0,0],"sizes":[[300,250]]}]' },
      { name: 'sticky', map_json: '[{"minViewPort":[0,0],"sizes":[[320,100]]}]' },
    ], rules: [],
  };
}
export function configure(snapshot, mutate) {
  const config = JSON.parse(snapshot.config.config_json); mutate(config);
  snapshot.config.config_json = JSON.stringify(config); return snapshot;
}
export const takeOver = () => ({ enabled: true, adUnitCode: 'TakeOver', desktopSize: [800, 600], mobileSize: [300, 250], desktopMinWidth: 1024,
  codelessAdUnitPath: '/123/test/Interstitial', autoCloseDesktopSec: 10, autoCloseMobileSec: 5 });
export const pin = () => pinRuntime(runtimeDescriptor, { allowPreview: true });
export async function checkedFixture(snapshot) {
  const input = previewInput(snapshot, runtimeDescriptor, TS, takeOver());
  const requirements = prebidRequirements(input, JSON.parse(snapshot.config.config_json));
  if (!requirements.required) return null;
  const bytes = new TextEncoder().encode(`/* prebid.js v11.11.0\nModules: ${requirements.modules.join(', ')} */\nvoid 0;`).buffer;
  const build = { id: 'fixture-build', publisher_id: snapshot.site.id, status: 'current', version: '11.11.0',
    file_key: `publishers/${snapshot.site.id}/prebid-builds/fixture-build/prebid.js`, modules_json: JSON.stringify(requirements.modules) };
  const object = { size: bytes.byteLength, customMetadata: { sha256: await sha256(bytes), version: '11.11.0' }, async arrayBuffer() { return bytes; } };
  const bucket = { async get() { return object; } };
  const report = await inspectPrebidArtifact({ siteId: snapshot.site.id, builds: [build], requirements }, bucket);
  return { bytes, report, build, object };
}
