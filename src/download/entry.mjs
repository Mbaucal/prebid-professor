import {downloadStoredPackage} from './saved-package.mjs';
let busy=false;
async function run(id){if(busy)return;busy=true;let status=document.getElementById('download-status');if(!status){status=document.createElement('p');status.id='download-status';status.setAttribute('role','status');document.body.append(status);}try{await downloadStoredPackage(id,text=>status.textContent=text);}catch(e){status.textContent=e.message;}finally{busy=false;}}
document.addEventListener('click',event=>{const link=event.target.closest?.('a');if(!link)return;const url=new URL(link.href),m=url.pathname.match(/^\/test-api\/releases\/(builtin-draft-[a-f0-9]{64})\/download$/);if(url.origin===location.origin&&m){event.preventDefault();void run(m[1]);}});
const match=location.pathname.match(/^\/test-api\/releases\/(builtin-draft-[a-f0-9]{64})\/download$/);
if(match)void run(match[1]);
document.getElementById('download-retry')?.addEventListener('click',()=>match&&run(match[1]));
