// Offline aggregation contract. No browser collector, network or storage writes.
// Coverage is unknown until an independently verified collector supplies events.
export function summarizeAssignments(plan, events) {
  const check=(ok,message)=>{if(!ok)throw Error(message);};
  check(plan?.kind==='tessera-gam-reporting-plan'&&/^[a-f0-9]{64}$/.test(plan.deliverySha256)
    &&plan.arms?.length===2,'A prepared reporting plan is required.');
  check(Array.isArray(events)&&events.length<=50000,'Use at most 50,000 events per analysis.');
  const pages=new Map();let duplicates=0;
  const keys=['assignedAt','assignmentId','deliverySha256','packageSha256','type','variant'].sort().join(',');
  for(const event of events) {
    check(event&&Object.keys(event).sort().join(',')===keys,'Unexpected assignment fields.');
    check(typeof event.assignmentId==='string'&&/^[a-f0-9]{32}$/.test(event.assignmentId),'A random page-scoped assignment ID is required.');
    check(event.deliverySha256===plan.deliverySha256,'Do not mix deliveries or revisions in one analysis.');
    const arm=plan.arms.find(a=>a.variant===event.variant);
    check(arm&&event.packageSha256===arm.packageSha256,'Assignment package or variant differs from its reporting plan.');
    check(['assigned','script-loaded','load-error','conflict'].includes(event.type),'Unsupported assignment event.');
    check(typeof event.assignedAt==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.assignedAt)
      &&Number.isFinite(Date.parse(event.assignedAt))&&new Date(event.assignedAt).toISOString()===event.assignedAt,'Use the original assignment time in UTC.');
    let page=pages.get(event.assignmentId);
    if(!page){page={variant:event.variant,assignedAt:event.assignedAt,types:new Set()};pages.set(event.assignmentId,page);}
    check(page.variant===event.variant&&page.assignedAt===event.assignedAt,'Conflicting identity for the same page assignment.');
    if(page.types.has(event.type))duplicates++;else page.types.add(event.type);
  }
  const empty=()=>({assigned:0,scriptLoaded:0,loadError:0,conflict:0,pending:0,ambiguous:0});
  const totals={A:empty(),B:empty()}, days=new Map();let orphanAssignments=0;
  for(const page of pages.values()) {
    if(!page.types.has('assigned')){orphanAssignments++;continue;}
    const date=page.assignedAt.slice(0,10);
    if(!days.has(date))days.set(date,{date,A:empty(),B:empty()});
    const outcomes=[...page.types].filter(t=>t!=='assigned');
    const field=outcomes.length>1?'ambiguous':outcomes.length===0?'pending':
      {'script-loaded':'scriptLoaded','load-error':'loadError',conflict:'conflict'}[outcomes[0]];
    for(const target of [totals[page.variant],days.get(date)[page.variant]]){target.assigned++;target[field]++;}
  }
  const count=totals.A.assigned+totals.B.assigned;
  return {schemaVersion:1,kind:'tessera-assignment-analysis',deliverySha256:plan.deliverySha256,
    timeZone:'UTC',coverage:'unknown',revenueReady:false,totals,
    daily:[...days.values()].sort((a,b)=>a.date.localeCompare(b.date)),
    duplicatesIgnored:duplicates,orphanAssignments,
    allocation:{expectedBPercent:plan.arms.find(a=>a.variant==='B').trafficPercent,
      observedBPercent:count?100*totals.B.assigned/count:null},
    notes:['Counts describe only the supplied events; collection completeness is unknown.',
      'Assigned pages remain in the denominator after load errors, conflicts or no recorded outcome.',
      'Script loaded is not an impression or revenue. Match the GAM reporting time zone before comparison.']};
}
