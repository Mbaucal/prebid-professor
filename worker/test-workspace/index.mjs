import {inventoryImportResponse} from './inventory-imports.mjs';
import {creativeTemplatesResponse} from './creative-templates.mjs';
import { layoutPreviewResponse } from './layout-preview.mjs';
import {testIntegrationsResponse} from './api-integrations.mjs';
import { prebidPage, prebidScript } from './prebid-page.mjs';
import { getPrebidSettings, savePrebidSettings, prebidSnapshot, prebidStore, previewBuildPlan, saveBuildPlan } from './prebid-settings.mjs';
import { readPrebidUpload, storePrebidFile } from './prebid-files.mjs';
import { prebidVersions } from './prebid-versions.mjs';
import { assertWorkspaceSiteScope } from './site-draft.mjs';
import { getSiteDraft, saveSiteDraft } from './site-draft-service.mjs';
import { siteDraftPage, siteDraftScript } from './site-draft-page.mjs';
import { zipSync } from 'fflate';
import { downloadScript } from '../../.generated/download.mjs';
import { getAuthenticatedUser, handleLogin, handleLogout } from '../auth.ts';
import { readPreviewSnapshot } from '../runtime/builtin-preview-service.mjs';
import { digest } from '../runtime/preview-snapshot.mjs';
import { RuntimeSelectionError } from '../runtime/site-runtime-selection.mjs';
import { SelectionWriteError } from './selection-transaction.mjs';
import { readRuntimeSelectionSettings, saveRuntimeSelectionSettings, selectedWorkspaceRuntime } from './runtime-selection.mjs';
import { runtimeSelectionPage, runtimeSelectionScript } from './runtime-selection-page.mjs';
import { runtimeDescriptor, runtimeCatalog, descriptorForPin, buildArtifactCandidate } from './runtime-catalog.mjs';
import { describeCandidate, saveDraftRelease, readDraftRelease, readDraftReleaseIndex, readDraftReleaseFile } from '../runtime/draft-release-store.mjs';
import { WorkspaceError, workspaceBoundary, sameOrigin, boundedText, jsonBody, TEST_SITE } from './boundary.mjs';
import { inspectTestSchema, initializeTestSchema } from './schema.mjs';
import { issueReceipt, verifyReceipt } from './receipt.mjs';
import { loginPage, workspacePage, workspaceScript } from './page.mjs';
import { takeOverForBuild } from './takeover-settings.mjs';
import { tanjugPilotResponse } from './tanjug-pilot.mjs';
import { deploymentResponse, runnerPath, runnerResponse } from './deployments.mjs';
import { adsVersionsPreviewResponse } from './ads-versions-preview.mjs';
import { siteWorkspaceResponse } from './site-workspace.mjs';

// HTML form navigation under no-referrer sends Origin:null. same-origin keeps
// legitimate form Origin while still suppressing cross-origin referrers.
// The mutation guard continues to reject missing/null/foreign Origin values.
const headers = { 'x-tessera-test-feature':'creative-templates-v1', 'cache-control':'private, no-store', 'referrer-policy':'same-origin',
  'x-content-type-options':'nosniff', 'x-robots-tag':'noindex, nofollow, noarchive',
  'content-security-policy':"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" };
const json = (value,status=200) => new Response(JSON.stringify(value),{status,headers:{...headers,'content-type':'application/json; charset=utf-8'}});
const html = (value,status=200) => new Response(value,{status,headers:{...headers,'content-type':'text/html; charset=utf-8'}});
const ID = /^builtin-draft-[a-f0-9]{64}$/;
const timestamp = () => new Date().toISOString().replace(/[-:]/g,'').replace('T','_').slice(0,15);
function store(env) {
  if (!env.DB || !env.BUILDS) throw new WorkspaceError(503,'The isolated test storage is not connected.');
  return {isolation:'explicit-test-store',db:env.DB,bucket:env.BUILDS};
}
async function snapshot(env) {
  const value = await readPreviewSnapshot(env.DB.withSession('first-primary'),TEST_SITE,{includePrebid:true});
  assertWorkspaceSiteScope(value);
  return value;
}
async function candidate(settings, buildTimestamp, takeOverEnabled, bucket) {
  // The reference bridge deliberately requires an explicit interstitial fallback.
  // Use the saved TEST-copy GAM path. No production configuration is imported.
  const resolved=await selectedWorkspaceRuntime(settings,bucket);
  const {prebidBuilds,...configuration}=settings;
  return buildArtifactCandidate({snapshot:configuration,pin:resolved.pin,
    buildTimestamp,takeOver:takeOverForBuild(settings,takeOverEnabled),prebid:resolved.prebid});
}
async function list(env) {
  const result=await env.DB.withSession('first-primary').prepare('SELECT release_id,package_sha256,state,created_at,note,descriptor_json FROM builtin_draft_uploads WHERE publisher_id=? ORDER BY created_at DESC,release_id LIMIT 20').bind(TEST_SITE).all();
  return result.results.map((row)=>{
    const descriptor=JSON.parse(row.descriptor_json);
    if (!ID.test(row.release_id) || descriptor.siteId!==TEST_SITE || descriptor.packageSha256!==row.package_sha256) throw new WorkspaceError(409,'Stored test release metadata is inconsistent.');
    return {id:row.release_id,packageSha256:row.package_sha256,storageState:row.state,createdAt:row.created_at,note:row.note,
      runtimeVersion:descriptor.runtime.runtimeVersion,fileCount:descriptor.files.length,publishable:false};
  });
}
async function route(request,env) {
  const {origin,auth}=workspaceBoundary(request,env);
  if (!['GET','POST'].includes(request.method)) throw new WorkspaceError(405,'Method not allowed.');
  if (runnerPath(new URL(request.url).pathname)) return runnerResponse(request,env,headers);
  sameOrigin(request,origin);
  const url=new URL(request.url), path=url.pathname;
  if (path==='/login' && request.method==='GET') return html(loginPage());
  if (path==='/api/auth/login' && request.method==='POST') {
    const text=await boundedText(request);
    if ((request.headers.get('content-type')||'').split(';')[0]!=='application/x-www-form-urlencoded') throw new WorkspaceError(415,'Submit the test login form.');
    const form=new URLSearchParams(text);
    if ([...form.keys()].some((k)=>!['email','password'].includes(k)) || form.getAll('email').length!==1 || form.getAll('password').length!==1) throw new WorkspaceError(400,'Invalid login form.');
    const response=await handleLogin(new Request(new URL('/api/auth/login',origin),{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({email:form.get('email'),password:form.get('password'),next:'/'})}),auth);
    if (response.status!==303) return html(loginPage('Email or test password is incorrect.'),response.status);
    return new Response(null,{status:303,headers:{...headers,location:'/', 'set-cookie':response.headers.get('set-cookie')}});
  }
  const actor=await getAuthenticatedUser(request,auth);
  if (!actor) return path.startsWith('/test-api/')||path.startsWith('/api/') ? json({error:'Test sign-in required.'},401)
    : new Response(null,{status:303,headers:{...headers,location:'/login'}});
  if (path==='/api/auth/logout' && request.method==='POST') return handleLogout(request);
  const inventoryImport=await inventoryImportResponse(request,env,headers);
  if(inventoryImport)return inventoryImport;
  const creativeTemplates=await creativeTemplatesResponse(request,env,actor,headers);
  if(creativeTemplates)return creativeTemplates;
  const layoutPreview = layoutPreviewResponse(request, headers);
  if (layoutPreview) return layoutPreview;
  const integrations=await testIntegrationsResponse(request,env,actor,headers);
  if(integrations)return integrations;
  const siteWorkspace=await siteWorkspaceResponse(request,env,actor,headers);
  if(siteWorkspace)return siteWorkspace;
  const uiReview = adsVersionsPreviewResponse(request, headers);
  if (uiReview) return uiReview;
  const deployment = await deploymentResponse(request,env,actor,headers);
  if (deployment) return deployment;
  const pilot = tanjugPilotResponse(request, headers);
  if (pilot) return pilot;
  if (path==='/' && request.method==='GET') return html(workspacePage(actor.email).replace('</body>','<script src="/download.js" defer></script></body>'));
  if(path==='/download.js'&&request.method==='GET'&&!url.search)return new Response(downloadScript,{headers:{...headers,'content-type':'application/javascript'}});
  if (path==='/workspace.js' && request.method==='GET') return new Response(workspaceScript,{headers:{...headers,'content-type':'application/javascript; charset=utf-8'}});
  if (path==='/runtime-selection' && request.method==='GET' && !url.search) return html(runtimeSelectionPage());
  if (path==='/runtime-selection.js' && request.method==='GET' && !url.search) return new Response(runtimeSelectionScript,{headers:{...headers,'content-type':'application/javascript; charset=utf-8'}});
  if (path==='/site-settings' && request.method==='GET' && !url.search) return html(siteDraftPage());
  if (path==='/site-settings.js' && request.method==='GET' && !url.search) return new Response(siteDraftScript,{headers:{...headers,'content-type':'application/javascript; charset=utf-8'}});
  if(path==='/prebid-settings'&&request.method==='GET'&&!url.search){
    const response=html(prebidPage());
    // Data-only CORS fallback when the server cannot reach the public catalog.
    // No external scripts, ad requests, credentials, or caller-provided URLs.
    response.headers.set('content-security-policy',headers['content-security-policy'].replace("connect-src 'self'","connect-src 'self' https://js-download.prebid.org/versions"));
    return response;
  }
  if(path==='/prebid-settings.js'&&request.method==='GET'&&!url.search)return new Response(prebidScript,{headers:{...headers,'content-type':'application/javascript; charset=utf-8'}});
  if(path==='/test-api/prebid/versions'&&request.method==='GET'&&!url.search)return json(await prebidVersions());
  // No legacy fallback: publish, CMS, Gmail, deletion, arbitrary sites and public CDN routes do not exist.
  const fileMatch=path.match(/^\/test-api\/releases\/(builtin-draft-[a-f0-9]{64})(\/download|\/index|\/files\/[A-Za-z0-9.-]+)?$/);
  const known=(request.method==='GET' && ['/test-api/status','/test-api/releases','/test-api/runtime-selection','/test-api/site-settings','/test-api/prebid-settings'].includes(path)) || (request.method==='GET' && fileMatch)
    || (request.method==='POST' && ['/test-api/setup','/test-api/generate','/test-api/save','/test-api/runtime-selection','/test-api/site-settings','/test-api/prebid-settings','/test-api/prebid/upload','/test-api/prebid/plan','/test-api/prebid/plan/save'].includes(path));
  if (!known || url.search) throw new WorkspaceError(404,'This operation is not available in the test workspace.');
  if (path==='/test-api/status') {
    const schema=await inspectTestSchema(env.DB);
    const settings=schema.ready?await snapshot(env):null;
    const pin=settings?JSON.parse(settings.config.config_json).builtinRuntimeSelection?.runtime:null;
    let selected=null,validationIssue=null;
    try { selected=pin?descriptorForPin(pin):runtimeCatalog[1]; }
    catch { validationIssue='The saved script version is unavailable or has changed. Open Script version and choose an available version. Your settings and saved packages are unchanged.'; }
    return json({...schema,runtime:selected?{version:selected.version,sha256:selected.codeSha256}:null,validationIssue,
      ...(settings?{takeOver:takeOverForBuild(settings)}:{}),publishable:false});
  }
  if (path==='/test-api/setup') {
    const body=await jsonBody(request,['confirm']);
    if(body.confirm!=='prepare-empty-test-database')throw new WorkspaceError(422,'Confirm preparation of the empty test database.');
    return json(await initializeTestSchema(env.DB,actor.email));
  }
  if (!(await inspectTestSchema(env.DB)).ready) throw new WorkspaceError(409,'Prepare test data first.');
  if(path==='/test-api/prebid/upload'){
    await prebidSnapshot(env);
    return json(await storePrebidFile(prebidStore(env),await readPrebidUpload(request),actor.email));
  }
  if(path==='/test-api/prebid-settings'){
    if(request.method==='GET')return json(await getPrebidSettings(env));
    return json(await savePrebidSettings(env,actor.email,await jsonBody(request,['expectedRevision','acknowledge','draft','version','options'],262144)));
  }
  if(path==='/test-api/prebid/plan')return json(await previewBuildPlan(env,await jsonBody(request,['expectedRevision','draft','version','options'],262144)));
  if(path==='/test-api/prebid/plan/save')return json(await saveBuildPlan(env,actor.email,await jsonBody(request,['expectedRevision','acknowledge','draft','version','options'],262144)));
  if (path==='/test-api/site-settings') {
    if(request.method==='GET')return json(await getSiteDraft(env));
    return json(await saveSiteDraft(env,actor.email,await jsonBody(request,['expectedRevision','acknowledge','draft'],262144)));
  }
  if (path==='/test-api/runtime-selection') {
    if (request.method==='GET') return json(await readRuntimeSelectionSettings(env));
    const body=await jsonBody(request,['expectedRevision','selection']);
    return json(await saveRuntimeSelectionSettings(env,actor.email,body));
  }
  if (path==='/test-api/releases') return json({releases:await list(env)});
  if (fileMatch) {
    if(fileMatch[2]==='/download'&&request.headers.get('accept')?.includes('text/html')){
      const index=await readDraftReleaseIndex(store(env),{siteId:TEST_SITE,releaseId:fileMatch[1]});
      if(!index)throw new WorkspaceError(404,'Saved test release not found.');
      return html('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Download saved package</title><body><h1>Download saved package</h1><p id="download-status" role="status">Preparing your saved files…</p><button id="download-retry">Retry download</button><p><a href="/">Back to saved packages</a></p><script src="/download.js" defer></script></body></html>');
    }
    if(fileMatch[2]==='/index'){
      const index=await readDraftReleaseIndex(store(env),{siteId:TEST_SITE,releaseId:fileMatch[1]});
      if(!index)throw new WorkspaceError(404,'Saved test release not found.');
      return json(index);
    }
    if(fileMatch[2]?.startsWith('/files/')){
      const file=await readDraftReleaseFile(store(env),{siteId:TEST_SITE,releaseId:fileMatch[1],name:fileMatch[2].slice(7)});
      if(!file)throw new WorkspaceError(404,'Saved test release not found.');
      return new Response(file.bytes,{headers:{...headers,'content-type':'application/octet-stream','x-tessera-file-sha256':file.entry.sha256}});
    }
    const saved=await readDraftRelease(store(env),{siteId:TEST_SITE,releaseId:fileMatch[1]});
    if(!saved)throw new WorkspaceError(404,'Saved test release not found.');
    if(!fileMatch[2])return json({draft:saved.draft,files:(await describeCandidate(TEST_SITE,saved)).descriptor.files,verified:true});
    const files=Object.fromEntries(Object.entries(saved.files).map(([name,bytes])=>[name,[bytes,{level:0,mtime:new Date('1980-01-01T00:00:00Z')}]]));
    return new Response(zipSync(files,{level:0}),{headers:{...headers,'content-type':'application/zip','content-disposition':`attachment; filename="${fileMatch[1]}.zip"`,'x-tessera-package-sha256':saved.draft.packageSha256}});

  }
  if (path==='/test-api/generate') {
    const body=await jsonBody(request,['acknowledge','takeOverEnabled']);
    if(body.acknowledge!==true || (body.takeOverEnabled!==undefined&&typeof body.takeOverEnabled!=='boolean'))throw new WorkspaceError(422,'Confirm this is a test package. TakeOver uses the saved site settings.');
    const settings=await snapshot(env), buildTimestamp=timestamp();
    const takeOver=takeOverForBuild(settings,body.takeOverEnabled);
    const generated=await candidate(settings,buildTimestamp,body.takeOverEnabled,env.BUILDS);
    const {descriptor,files}=await describeCandidate(TEST_SITE,generated);
    if(await digest(await snapshot(env))!==await digest(settings))throw new WorkspaceError(409,'Test settings changed. Generate again.');
    const receipt=await issueReceipt({audience:origin,actor:actor.email,configHash:await digest(settings),runtimeHash:descriptor.runtime.runtimeSha256,
      buildTimestamp,takeOverEnabled:takeOver.enabled,packageHash:descriptor.packageSha256},env.TEST_SESSION_SECRET);
    return json({descriptor,receipt,adsJs:new TextDecoder().decode(files['ads.js']),takeOver,publishable:false});
  }
  const body=await jsonBody(request,['receipt','acknowledge','note']);
  if(body.acknowledge!==true || typeof body.note!=='string' || body.note.length>160)throw new WorkspaceError(422,'Review the test package and keep the note within 160 characters.');
  const review=await verifyReceipt(body.receipt,env.TEST_SESSION_SECRET,{actor:actor.email,origin});
  if(!runtimeCatalog.some(r=>r.codeSha256===review.runtimeHash))throw new WorkspaceError(409,'Runtime changed. Generate a new test package.');
  const settings=await snapshot(env);
  if(await digest(settings)!==review.configHash)throw new WorkspaceError(409,'Test configuration changed since review. Generate again.');
  const generated=await candidate(settings,review.buildTimestamp,review.takeOverEnabled,env.BUILDS);
  if((await describeCandidate(TEST_SITE,generated)).descriptor.packageSha256!==review.packageHash)throw new WorkspaceError(409,'Package changed since review. Nothing was saved.');
  if(await digest(await snapshot(env))!==review.configHash)throw new WorkspaceError(409,'Test settings changed during preparation. Generate again.');
  return json(await saveDraftRelease(store(env),{siteId:TEST_SITE,candidate:generated,actor:actor.email,note:body.note}));
}
export default {
  async fetch(request,env) {
    try { return await route(request,env); }
    catch(error) {
      if(error instanceof WorkspaceError || error instanceof RuntimeSelectionError || error instanceof SelectionWriteError)return json({error:error.message},error.status);
      if(String(error?.message).includes('TEST_DRAFT_QUOTA'))return json({error:'The test workspace has reached its 20-package limit. Existing files are retained.'},409);
      if (new URL(request.url).pathname.startsWith('/test-api/deployment')) return json({error:'Status radnje nije potvrđen. Osveži istoriju i proveri GitHub pre sledeće objave.'},503);
      return json({error:'The test operation could not be verified. Nothing was published. Retry the same reviewed package after checking test storage.'},503);
    }
  },
};
