import { WorkspaceError } from './boundary.mjs';
const check=(ok)=>{if(!ok)throw new WorkspaceError(403,'Invalid or expired TEST assignment ticket.');};
const encode=bytes=>btoa(String.fromCharCode(...bytes)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const decode=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const text=new TextEncoder();
const lifetime=60*60*1000;
async function key(secret) {
  check(typeof secret==='string'&&secret.length>=32);
  return crypto.subtle.importKey('raw',text.encode('tessera-test-assignments-v1:'+secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
export async function issueAssignmentTicket(context,secret,now=Date.now()) {
  const claims={version:1,experimentId:context.experimentId,siteId:context.siteId,deliverySha256:context.deliverySha256,
    packageSha256:context.packageSha256,variant:context.variant,assignmentId:crypto.randomUUID().replace(/-/g,''),
    assignedAt:new Date(now).toISOString(),expiresAt:now+lifetime};
  const payload=encode(text.encode(JSON.stringify(claims)));
  return payload+'.'+encode(new Uint8Array(await crypto.subtle.sign('HMAC',await key(secret),text.encode(payload))));
}
export async function verifyAssignmentTicket(ticket,secret,now=Date.now()) {
  try {
    check(typeof ticket==='string'&&ticket.length<=2048&&/^[\w-]+\.[\w-]+$/.test(ticket));
    const [payload,signature]=ticket.split('.');
    check(await crypto.subtle.verify('HMAC',await key(secret),decode(signature),text.encode(payload)));
    const c=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decode(payload)));
    check(c.version===1&&/^[a-f0-9]{32}$/.test(c.assignmentId)&&/^[a-f0-9]{64}$/.test(c.deliverySha256)
      &&/^[a-f0-9]{64}$/.test(c.packageSha256)&&['A','B'].includes(c.variant)
      &&['test-site','tanjug-test'].includes(c.siteId)&&/^experiment-[a-f0-9-]{36}$/.test(c.experimentId));
    const issued=Date.parse(c.assignedAt);
    check(Number.isFinite(issued)&&new Date(issued).toISOString()===c.assignedAt&&issued<=now+30000
      &&Number.isSafeInteger(c.expiresAt)&&c.expiresAt===issued+lifetime&&c.expiresAt>now);
    return c;
  }catch {throw new WorkspaceError(403,'Invalid or expired TEST assignment ticket.');}
}
