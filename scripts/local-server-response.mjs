/** Readiness for the credential-free local Worker; never treats arbitrary 503s as success. */
export function isUnconfiguredLogin(response){
 return response.status===503
  && /^text\/html(?:;|$)/i.test(response.contentType??'')
  && /<html(?:\s|>)/i.test(response.text)
  && /Tessera/.test(response.text)
  && /ADMIN_EMAIL is not configured\./.test(response.text)
  && /<form\b[^>]*\baction=["']\/api\/auth\/login["'][^>]*>/i.test(response.text)
  && /<button\b[^>]*\btype=["']submit["'][^>]*\sdisabled(?:\s|>)/i.test(response.text);
}
export function loginDiagnostic(response){
 return {status:response.status,contentType:response.contentType??'',bodySnippet:String(response.text??'').slice(0,600)};
}
