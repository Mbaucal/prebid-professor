// Reviewed, immutable source identities. These are deployed files, not generator runtime pins.
// Add a new entry for a different source; never change an existing identity.
export const ORIGINAL_PAIR='politika-20261117';
export const ORIGINAL_SOURCES=Object.freeze([
  Object.freeze({site:'politika',pair:ORIGINAL_PAIR,side:'A',name:'A — original, cache off · build 20260813_125447',
    build:'20260813_125447',runtimeVersion:null,cache:false,
    url:'https://politika.pages.dev/releases/politika-20261117-a-4cd44c2fb51e/ads.js',
    sha256:'4cd44c2fb51e614be765b55dc2735b4eacd91aa18edf55d00ea1c516c279eb3b',bytes:85798}),
  Object.freeze({site:'politika',pair:ORIGINAL_PAIR,side:'B',name:'B — 3.25.0, cache on · build 20261117_111338',
    build:'20261117_111338',runtimeVersion:'3.25.0',cache:true,
    url:'https://politika.pages.dev/releases/politika-20261117-b-d45ed2bc5009/ads.js',
    sha256:'d45ed2bc5009fd04b8fccd43f76089e26f8bb081b9704f8b867092a8fcf42b26',bytes:231287}),
]);
export const originalId=source=>'original-source-'+source.sha256;
export const originalSource=(site,id)=>ORIGINAL_SOURCES.find(s=>s.site===site&&originalId(s)===id)??null;
export const originalRuntimeLabel=source=>source.runtimeVersion??'build '+source.build;
