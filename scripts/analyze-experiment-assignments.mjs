import { readFile } from 'node:fs/promises';
import { summarizeAssignments } from '../worker/experiments/assignments.mjs';
const [planFile,eventsFile,...extra]=process.argv.slice(2);
if(!planFile||!eventsFile||extra.length)throw Error('Usage: node scripts/analyze-experiment-assignments.mjs reporting-plan.json events.json');
const read=async path=>{const bytes=await readFile(path);if(bytes.length>16*1024*1024)throw Error('Analysis input exceeds 16 MB.');return JSON.parse(bytes.toString('utf8'));};
console.log(JSON.stringify(summarizeAssignments(await read(planFile),await read(eventsFile)),null,2));
