import { descriptorForPin, previewInput } from './runtime-catalog.mjs';
/** Data-only Prebid Download plan. Uses the same normalized input as activation. */
import { fields, params, normalizePrebidDraft } from './prebid-draft.mjs';
import { WorkspaceError } from './boundary.mjs';
import { digest } from '../runtime/preview-snapshot.mjs';
import { prebidRequirements, moduleReason } from '../runtime-demand-v1/requirements.mjs';

export const USER_IDS = Object.freeze([
  {name:'sharedId',label:'SharedID',module:'sharedIdSystem',settings:{storage:{type:'cookie',name:'_sharedid',expires:365}}},
  {name:'id5Id',label:'ID5',module:'id5IdSystem',settings:{params:{partner:0},storage:{type:'html5',name:'id5id',expires:90,refreshInSeconds:7200}}},
  {name:'teadsId',label:'Teads ID',module:'teadsIdSystem',settings:{params:{pubId:0}}},
  {name:'criteo',label:'Criteo ID',module:'criteoIdSystem',settings:{}},
  {name:'lotamePanoramaId',label:'Lotame Panorama',module:'lotamePanoramaIdSystem',settings:{params:{clientId:''}}},
]);
const fail = (message) => {throw new WorkspaceError(422,message);};
export function planOptions(config) {
  const floors=config.runtimeControls?.floors??{};
  const saved=config.testPrebidOptions?.userIds;
  const active=config.userSync?.userIds??[];
  const unsupported=active.filter(row=>!USER_IDS.some(id=>id.name===row.name));
  if(unsupported.length)fail('A saved custom User ID needs a verified mapping before editing this plan. Existing settings were retained.');
  return {floorsEnabled:floors.enabled!==false,hardFloor:floors.hardFloor??0.04,currency:floors.currency??'EUR',
    currencyConversionEnabled:config.runtimeControls?.currencyConversion?.enabled!==false,
    userIds:USER_IDS.map(id=>{
      const found=active.find(row=>row.name===id.name),retained=saved?.find(row=>row.name===id.name);
      const configured=config.userIdConfig?.modules?.find(row=>row.name===id.name);
      const configuredSettings=configured?{params:configured.params??{},...(configured.storage?{storage:configured.storage}:{})}:null;
      const {name,...settings}=found??{name:id.name,...(retained?.settings??configuredSettings??id.settings)};
      return {name:id.name,enabled:!!found,settings};
    })};
}
function normalizeOptions(input) {
  fields(input,['floorsEnabled','hardFloor','currency','currencyConversionEnabled','userIds'],'build options');
  if(typeof input.floorsEnabled!=='boolean'||typeof input.currencyConversionEnabled!=='boolean')fail('Choose explicit floor and currency options.');
  if(typeof input.hardFloor!=='number'||!Number.isFinite(input.hardFloor)||input.hardFloor<0||input.hardFloor>1000)fail('The hard floor must be between 0 and 1000.');
  if(typeof input.currency!=='string'||!/^[A-Z]{3}$/.test(input.currency))fail('Use a three-letter currency, for example EUR.');
  if(!Array.isArray(input.userIds)||input.userIds.length!==USER_IDS.length)fail('Check the supported User ID options.');
  const seen=new Set();
  const userIds=input.userIds.map(row=>{
    fields(row,['name','enabled','settings'],'User ID');
    if(!USER_IDS.some(id=>id.name===row.name)||seen.has(row.name)||typeof row.enabled!=='boolean')fail('Choose each supported User ID once.');
    seen.add(row.name);
    const settings=params(row.settings);
    if(Object.keys(settings).some(key=>!['params','storage'].includes(key)))fail('This runtime supports User ID params and storage. Other saved fields need review and are not discarded.');
    if(settings.params!==undefined)params(settings.params);
    if(settings.storage!==undefined){
      const s=params(settings.storage);
      if(!['cookie','html5','cookie&html5'].includes(s.type)||typeof s.name!=='string'||!s.name||!Number.isInteger(s.expires)||s.expires<1||s.expires>3650)fail('User ID storage needs type, name and expires (1–3650 days).');
      if(s.refreshInSeconds!==undefined&&(!Number.isInteger(s.refreshInSeconds)||s.refreshInSeconds<1||s.refreshInSeconds>31536000))fail('Check the User ID refresh interval.');
    }
    if(row.enabled){
      if(row.name==='sharedId'&&!settings.storage)fail('SharedID needs storage settings.');
      if(row.name==='id5Id'&&(!Number.isInteger(settings.params?.partner)||settings.params.partner<1))fail('Enter your ID5 Partner Number in params.partner.');
      if(row.name==='teadsId'&&(!Number.isInteger(settings.params?.pubId)||settings.params.pubId<1))fail('Enter your Teads Publisher ID in params.pubId.');
      if(row.name==='lotamePanoramaId'&&!String(settings.params?.clientId??'').trim())fail('Enter your Lotame clientId.');
    }
    return {name:row.name,enabled:row.enabled,settings};
  }).sort((a,b)=>a.name.localeCompare(b.name));
  return {...input,userIds};
}
export function applyPrebidDraft(snapshot, config, draft, options) {
  const after=structuredClone(snapshot),next=structuredClone(config);
  after.bidders=draft.bidders.map(b=>({bidder:b.bidder,params_json:JSON.stringify(b.params),enabled:b.enabled?1:0}));
  after.overrides=draft.overrides.map(o=>({bidder:o.bidder,scope_type:o.scopeType,scope_key:o.scopeKey,params_json:JSON.stringify(o.params),enabled:o.enabled?1:0}));
  next.enablePrebid=draft.enablePrebid;
  if(options){
    next.runtimeControls={...next.runtimeControls,floors:{...next.runtimeControls?.floors,enabled:options.floorsEnabled,hardFloor:options.hardFloor,currency:options.currency},currencyConversion:{...next.runtimeControls?.currencyConversion,enabled:options.currencyConversionEnabled}};
    next.userSync={...(next.userSync??{syncEnabled:false,aliasSyncEnabled:false,syncsPerBidder:0,syncDelay:0,auctionDelay:0,filterSettings:{all:{bidders:'*',filter:'include'}}}),userIds:options.userIds.filter(id=>id.enabled).map(id=>({name:id.name,...id.settings}))};
    // Retain disabled values without adding them to the generated runtime.
    next.testPrebidOptions={userIds:options.userIds};
    if(next.userIdConfig)next.userIdConfig={...next.userIdConfig,modules:[
      ...(next.userIdConfig.modules??[]).filter(row=>!USER_IDS.some(id=>id.name===row.name)),
      ...options.userIds.map(id=>({...next.userIdConfig.modules?.find(row=>row.name===id.name),name:id.name,moduleCode:USER_IDS.find(row=>row.name===id.name).module,enabled:id.enabled,params:id.settings.params??{},storage:id.settings.storage??null}))
    ]};
  }
  after.config.config_json=JSON.stringify(next);
  return {after,config:next};
}
export async function makePrebidPlan(snapshot,config,request) {
  fields(request,['draft','version','options'],'build plan');
  if(typeof request.version!=='string'||request.version.length>32||!/^\d+\.\d+\.\d+$/.test(request.version)||Number(request.version.split('.')[0])<9)fail('Choose an exact Prebid version (9 or newer), for example 11.11.0.');
  const draft=normalizePrebidDraft(request.draft,snapshot.units,{planning:true}),options=normalizeOptions(request.options);
  const applied=applyPrebidDraft(snapshot,config,draft,options);
  // Planning always derives the enabled build, even while the active mode is OFF.
  const forBuild=structuredClone(applied.after),buildConfig={...applied.config,enablePrebid:true};
  forBuild.config.config_json=JSON.stringify(buildConfig);
  const requirements=prebidRequirements(previewInput(forBuild,descriptorForPin(config.builtinRuntimeSelection.runtime),'20000101_000000'),buildConfig);
  if(requirements.issues.length)fail('An enabled bidder or User ID has no verified module mapping. Existing settings were retained.');
  // Include GPID support in newly requested builds, so upgrading an older
  // script does not require changing the saved runtime before building.
  requirements.modules=[...new Set([...requirements.modules,'gptPreAuction'])].sort();
  const configuration={version:request.version,modules:requirements.modules};
  const hash=await digest({version:request.version,options,draft:{...draft,buildId:null}});
  return {...applied,draft,version:request.version,options,configuration,hash,
    modules:requirements.modules.map(name=>({name,reason:moduleReason(name)})),
    builderUrl:'https://docs.prebid.org/download.html?'+new URLSearchParams({version:request.version,modules:configuration.modules.join(',')})};
}
export function publicPlan(plan){return {draft:plan.draft,version:plan.version,options:plan.options,configuration:plan.configuration,hash:plan.hash,modules:plan.modules,builderUrl:plan.builderUrl};}
