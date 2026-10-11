import test from 'node:test';
import assert from 'node:assert/strict';
import {renderLoginPage} from '../../worker/auth.ts';
import {brandTesseraHtmlResponse} from '../../worker/tessera-html-branding.ts';
import {isUnconfiguredLogin,loginDiagnostic} from '../../scripts/local-server-response.mjs';
async function actual(env={}){
 const response=await brandTesseraHtmlResponse(renderLoginPage(new Request('http://127.0.0.1:5173/login'),env));
 return {status:response.status,contentType:response.headers.get('content-type'),text:await response.text()};
}
test('actual credential-free branded login is 503 with setup error and disabled form',async()=>{
 const response=await actual();assert.equal(response.status,503);assert(isUnconfiguredLogin(response));
 const configured=await actual({ADMIN_EMAIL:'fixture@example.invalid',ADMIN_PASSWORD:'synthetic-password-only',SESSION_SECRET:'synthetic-local-fixture-secret-not-used-to-login'});
 assert.equal(configured.status,200);assert(!isUnconfiguredLogin(configured),'This smoke does not claim configured or authenticated usability');
});
test('generic errors, wrong routes, missing branding or enabled form cannot pass readiness',async()=>{
 const response=await actual();
 for(const changed of [
  {...response,status:200},{...response,status:404},{...response,contentType:'text/plain'},
  {...response,text:'<html>Tessera unavailable</html>'},
  {...response,text:response.text.replaceAll('Tessera','Other')},
  {...response,text:response.text.replace('ADMIN_EMAIL is not configured.','Unknown error')},
  {...response,text:response.text.replace('action="/api/auth/login"','action="/other"')},
  {...response,text:response.text.replace('type="submit" disabled','type="submit"')},
 ])assert(!isUnconfiguredLogin(changed));
});
test('failure diagnostics expose status/type and bound the returned HTML snippet',()=>{
 const result=loginDiagnostic({status:503,contentType:'text/html',text:'x'.repeat(5000)});assert.equal(result.status,503);assert.equal(result.contentType,'text/html');assert.equal(result.bodySnippet.length,600);
});
