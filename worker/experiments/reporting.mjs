import { runtimeReleaseHistory } from '../runtime/runtime-release-history.mjs';

const hash = /^[a-f0-9]{64}$/;
const check = (ok, message) => { if (!ok) throw Error(message); };
export function gamValue(deliverySha256, variant, key = 'tessera_ab') {
  check(hash.test(deliverySha256) && ['A','B'].includes(variant), 'Invalid reporting identity.');
  check(['tessera_ab','Varijant'].includes(key), 'Invalid reporting key.');
  if (key === 'Varijant') return variant;
  return 'd' + deliverySha256.slice(0,32) + '_' + variant.toLowerCase();
}
export function assertUniqueValues(plans) {
  const labels = new Map();
  for (const plan of plans) for (const arm of plan.arms) {
    if (!arm.value) continue;
    // A/B are intentionally reused. Private mappings retain the complete pins;
    // GAM reports must be filtered to the chosen inventory and test period.
    if (plan.key === 'Varijant') {
      check(arm.value === gamValue(plan.deliverySha256, arm.variant, plan.key), 'Invalid reporting mapping.');
      continue;
    }
    check(!labels.has(arm.value) || labels.get(arm.value) === plan.deliverySha256,
      'Reporting label collision. Keep experiments separate; do not use these values.');
    labels.set(arm.value, plan.deliverySha256);
  }
}
export function reportingPlan(item, deliverySha256, descriptors) {
  check(hash.test(deliverySha256), 'Invalid delivery identity.');
  const releases = descriptors.map(({runtime}) => runtimeReleaseHistory.find(r => r.id === runtime.runtimeId
    && r.version === runtime.runtimeVersion && r.codeSha256 === runtime.runtimeSha256));
  const keys = releases.map(r => r?.capabilities.includes('plain-variant-targeting') ? 'Varijant' : 'tessera_ab');
  const key = keys[0];
  const arms = ['A','B'].map((variant,i) => {
    const pin = i === 0 ? item.a : item.b, descriptor = descriptors[i], runtime = descriptor.runtime;
    check(descriptor.siteId === item.siteId && descriptor.packageSha256 === pin.packageSha256,
      'Reporting package differs from the saved experiment.');
    const supported = !!releases[i]?.capabilities.includes('experiment-slot-targeting') && keys[i] === key;
    return {variant, trafficPercent:i === 0 ? 100-item.trafficB : item.trafficB,
      packageSha256:pin.packageSha256, releaseId:pin.releaseId, runtimeVersion:runtime.runtimeVersion,
      supported, value:supported ? gamValue(deliverySha256,variant,key) : null};
  });
  return {schemaVersion:1, kind:'tessera-gam-reporting-plan', siteId:item.siteId,
    experimentId:item.id, revision:item.version, deliverySha256, key,
    comparison:arms[0].packageSha256 === arms[1].packageSha256 ? 'A/A' : 'A/B', arms,
    labelsReady:arms.every(a=>a.supported), revenueReady:false,
    blockers:[...arms.filter(a=>!a.supported).map(a=>'Variant '+a.variant+' has no verified measurement support.'),
      ...(keys[0]!==keys[1]?['Both variants must use the same GAM key. Choose matching script versions.']:[]),
      ...(key==='Varijant'?['Filter GAM reports to this site, inventory and test period; A/B values are shared across tests.']:[]),
      ...(arms.some(a=>a.trafficPercent===0)?['Both variants need traffic for a comparison.']:[]),
      'GAM reporting setup and actual report verification are pending.',
      item.deliveryProfile==='experiment-collected-preview-v1'?'TEST collection is enabled; real traffic coverage is not verified.':'Automatic assignment collection is not connected.'],
    scope:'private-test-preview', denominatorStatus:item.deliveryProfile==='experiment-collected-preview-v1'?'test-collection':'not-connected'};
}
export function reportingCsv(plan) {
  check(plan.labelsReady, 'Both script versions need measurement support before exporting GAM values.');
  const quote = value => '"' + String(value).replace(/"/g,'""') + '"';
  const fields=['key','value','siteId','experimentId','revision','deliverySha256','variant','trafficPercent','runtimeVersion','packageSha256'];
  const rows=plan.arms.map(a=>({...plan,...a}));
  return fields.join(',')+'\r\n'+rows.map(row=>fields.map(f=>quote(row[f])).join(',')).join('\r\n')+'\r\n';
}
