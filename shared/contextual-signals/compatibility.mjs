/** Source review is explicitly distinct from a captured request or SSP receipt. */
const reviewedVersions = ['11.11.0', '11.34.0'];
const notes = {
  connectad: '11.11 uses /v2 and sdc plus site.content.data; 11.34 uses the /v3 OpenRTB converter.',
  openx: 'The documented adapter passes segment taxonomies through. Confirm which versions your account and buyers accept.',
  pubmatic: 'The OpenRTB converter preserves content.data. A version-specific SSP acceptance list was not found.',
  ix: 'Nested content.data is retained; top-level site.cattax is not. No cat fallback is used.',
  rubicon: 'Banner requests flatten taxonomy IDs into tg_i.iab without a taxonomy marker. Do not mix versions; confirm interpretation with Magnite.',
  magnite: 'If this is a Rubicon alias, banner IDs are flattened without a taxonomy marker. Confirm the alias and taxonomy with Magnite.',
  smartadserver: 'Contextual data is forwarded as sdc. Confirm the supported taxonomy with Equativ.',
  criteo: 'The ORTB path preserves contextual segments through the 2.5 translation. Server acceptance is unconfirmed.',
  adf: 'Site data is forwarded; Adform documents FPD support as check with bidder.',
  adform: 'For the adf alias, site data is forwarded. Confirm the actual adapter and taxonomy with Adform.',
  adformOpenRTB: 'For the adf alias, site data is forwarded. Confirm the actual adapter and taxonomy with Adform.',
  rtbhouse: 'Site data is forwarded. Version-specific server acceptance is unconfirmed.',
  eskimi: 'The OpenRTB converter preserves content.data. Version-specific server acceptance is unconfirmed.',
  ogury: 'The OpenRTB converter preserves content.data, but public partner docs do not confirm contextual taxonomy acceptance.',
  teads: 'The inspected adapter has no content.data delivery route; this contextual signal is omitted. Ads continue normally.',
  richaudience: 'The inspected adapter reads user.data, not contextual content.data. Context is not sent as audience data.',
};
export function contextualCompatibility(bidder, prebidVersion) {
  const version = String(prebidVersion || '').replace(/^v/, '');
  const reviewed = reviewedVersions.includes(version) && Object.hasOwn(notes, bidder);
  const absent = reviewed && ['teads', 'richaudience'].includes(bidder);
  return {bidder, prebidVersion: version || null, reviewedVersions: reviewedVersions.slice(),
    evidence: reviewed ? 'adapter-source-review' : 'not-reviewed',
    delivery: absent ? 'not-forwarded' : reviewed ? 'source-path-found' : 'unverified',
    serverAcceptance: 'unconfirmed',
    note: reviewed ? notes[bidder] : 'This exact adapter/build has not been reviewed. Choose a taxonomy agreed with your SSP and verify the outgoing request.',
    source: reviewed ? `https://github.com/prebid/Prebid.js/blob/${version}/modules/${bidder === 'magnite' ? 'rubicon' : ['adform', 'adformOpenRTB'].includes(bidder) ? 'adf' : bidder}BidAdapter.${['adf','adform','adformOpenRTB'].includes(bidder) && version === '11.34.0' ? 'ts' : 'js'}` : null};
}
