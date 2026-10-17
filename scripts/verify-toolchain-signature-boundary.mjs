// Read-only proof: use an isolated candidate lock without mutating repository inputs.
import {mkdtemp,symlink,copyFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {prepareBuiltinRuntime} from './prepare-builtin-runtime.mjs';
const candidate=process.argv[2];
if(!candidate)throw Error('Usage: node scripts/verify-toolchain-signature-boundary.mjs CANDIDATE_LOCK');
const probe=await mkdtemp(join(tmpdir(),'mba52-lock-'));
try {
 for(const path of ['worker','vendor','scripts'])await symlink(resolve(path),join(probe,path),'dir');
 await copyFile(candidate,join(probe,'package-lock.json'));
 let blocked=false,error;
 try {await prepareBuiltinRuntime(probe);} catch(e) {error=e.message;blocked=error.startsWith('Runtime source changed.');}
 const digest=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
 console.log(JSON.stringify({baselineLockSha256:await digest('package-lock.json'),candidateLockSha256:await digest(candidate),blocked,error,rootPackageUnchanged:true,frozenGuardChanged:false},null,2));
 if(!blocked)process.exitCode=1;
} finally {await rm(probe,{recursive:true,force:true});}
