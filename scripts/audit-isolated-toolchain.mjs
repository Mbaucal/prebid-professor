import {spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {verifyIsolation} from './verify-toolchain-isolation.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');await verifyIsolation(root);
const out=resolve(root,'.generated/toolchain-evidence');await mkdir(out,{recursive:true});const summary={};
for(const [name,cwd,args] of [['historical-full-lock',root,[]],['active-root-production',root,['--omit=dev']],['active-tools',resolve(root,'tools'),[]]]){
 const result=spawnSync('npm',['audit','--json',...args],{cwd,encoding:'utf8'});
 const payload=JSON.parse(result.stdout);assert(payload.metadata?.vulnerabilities && !payload.error,`Audit unavailable for ${name}`);
 await writeFile(resolve(out,name+'.json'),JSON.stringify(payload,null,2)+'\n');summary[name]=payload.metadata.vulnerabilities;
 if(name!=='historical-full-lock')assert.equal(payload.metadata.vulnerabilities.total,0,`Active dependency findings: ${name}`);
}
await writeFile(resolve(out,'audit-summary.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
