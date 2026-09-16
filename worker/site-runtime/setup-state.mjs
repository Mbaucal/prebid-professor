/** Read-only setup guidance. A current row is not a verified artifact: saving
 * the version and generating still check the original file and its modules. */
export function siteSetupState(saved) {
 const config=JSON.parse(saved.config.config_json),current=saved.prebidBuilds;
 const prebid=config.enablePrebid!==true
  ? {status:'off',message:'Prebid is off. This site uses GAM / AdX only.'}
  : current.length===1
   ? {status:'current',id:current[0].id,version:current[0].version,message:`Current Prebid file: ${current[0].version}. Its contents are checked when saving the script version and generating a package.`}
   : {status:current.length?'ambiguous':'missing',message:current.length
     ? 'More than one Prebid file is marked current. Open Prebid.js and set one file as current.'
     : 'No current Prebid file is selected for this site. Open Prebid.js, upload the site’s prebid.js or use Set current on an existing file, then return here.'};
 const needsPrebid=prebid.status==='missing'||prebid.status==='ambiguous';
 return {
  prebid,
  releaseWorkflow:config.builtinRuntimeSelection?.runtime||!(typeof config.generatorProfileId==='string'&&config.generatorProfileId.trim())?'builtin':'legacy',
  nextStep:needsPrebid?'prebid':!config.builtinRuntimeSelection?.runtime?'versions':null,
  setupMessage:needsPrebid?prebid.message:!config.builtinRuntimeSelection?.runtime?'Choose and save an ads.js version. Tessera generates the script from your saved settings; no template is needed.':null,
 };
}
