/** Runs only for this wrapper's ad units, before passing them to Prebid. */
export function tesseraDemandUnit(unit, placements) {
  var placement = unit && placements && placements[unit.code];
  if (!placement) return unit;
  var imp = unit.ortb2Imp || {};
  var ext = imp.ext || {};
  var data = ext.data || {};
  unit.ortb2Imp = Object.assign({}, imp, {ext:Object.assign({}, ext, {
    gpid: ext.gpid || placement.gpid,
    data:Object.assign({}, data, {adserver:Object.assign({}, data.adserver || {}, {
      name:'gam', adslot:placement.adslot
    })})
  })});
  return unit;
}
