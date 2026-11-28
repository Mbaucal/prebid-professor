import { discoverPrebidDefaults } from "./prebid-defaults.mjs";
import { GamError, numericId } from "../../shared/gam/plan.mjs";
import {
  normalizeLinePlan,
  flag,
  creativesPerLine,
  creativeIndexFor,
  creativeNameAt,
} from "../../shared/gam/line-items.mjs";
import { GamTrafficClient } from "./gam-traffic-client.mjs";
import {
  entities,
  inspectEntities,
  recordResult,
  advance,
  jobView,
  compatible,
  phaseCount,
  sameEntityName,
  reportingReady,
  addOnlyReporting,
  reportingExecutionAllowed,
  canCloseJobPreview,
} from "./line-item-model.mjs";

const prefix = "api-integrations/gam/line-items/v1/";
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
const fail = (m, s = 409) => {
  throw new GamError(m, s);
};
const uuid = (id) =>
  typeof id === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
    ? id
    : fail("Neispravan ID posla.", 422);
const jobKey = (id) => prefix + "jobs/" + uuid(id) + ".json";
const canonicalPlan = (value) => JSON.stringify(value, function (_key, item) {
  return item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
    : item;
});
function sameActivePlan(previous, next, input) {
  if (canonicalPlan(previous) === canonicalPlan(next)) return true;
  if (previous.reporting || Object.hasOwn(input, "reportingValues") || Object.hasOwn(input,"reportingSelection")) return false;
  const withoutDefault = { ...next };
  delete withoutDefault.reporting;
  return canonicalPlan(previous) === canonicalPlan(withoutDefault);
}
const firstPhase = (plan) => plan.mode === "reporting" ? "key" : "advertiser";
const pendingWrite = (state) => ["new", "update"].includes(state);
function finishBatch(job, batch, states) {
  // Updating existing metadata and creating missing keys use separate durable
  // operations. A cursor bump makes the remaining half a new safe attempt.
  advance(job, batch.some((entity) => pendingWrite(states.get(entity.key)?.state)) ? 0 : batch.length);
}
const attemptKey = (id, cursor) =>
  prefix + `attempts/${uuid(id)}/${cursor}.json`;
const lockKey = (network) => prefix + "locks/" + numericId(network) + ".json";
const reportingLockKey = network => prefix + 'reporting-locks/' + numericId(network) + '.json';
const targetingLockKey = network => prefix + 'targeting-locks/' + numericId(network) + '.json';
const independentReporting = job => job.executionLane === 'reporting_add_only_v1' && addOnlyReporting(job.plan);
const executionLockKey = job => independentReporting(job) ? reportingLockKey(job.plan.networkCode) : lockKey(job.plan.networkCode);
const postTargetingPhase = phase => ['creative','lineItem','association'].includes(phase);
const validJobReference = value => typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
async function read(bucket, key) {
  const o = await bucket.get(key);
  return o ? { value: await o.json(), etag: o.etag } : null;
}
async function put(bucket, key, value, onlyIf) {
  return bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
    ...(onlyIf ? { onlyIf } : {}),
  });
}
const summary = (j) => ({
  id: j.id,
  status: j.status,
  mode: j.plan.mode,
  network: j.network,
  createdAt: j.createdAt,
  updatedAt: j.updatedAt,
  name: j.plan.mode === "reporting" ? "GAM reporting" : j.plan.orders[0]?.name || j.labels["order:0"] || "",
  count: j.plan.rows.length,
});
async function historyPrefix(actor, origin, network) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([actor, origin])),
  );
  return (
    prefix +
    "history/" +
    Array.from(new Uint8Array(hash), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("") +
    "/" +
    network +
    "/"
  );
}
async function indexJob(bucket, job) {
  const key =
    (await historyPrefix(job.actor, job.origin, job.plan.networkCode)) +
    (9999999999999 - Date.parse(job.createdAt)) +
    "-" +
    job.id +
    ".json";
  await put(bucket, key, summary(job));
}
async function save(bucket, job, etag) {
  job.updatedAt = new Date().toISOString();
  const saved = await put(bucket, jobKey(job.id), job, { etagMatches: etag });
  if (!saved)
    fail("Napredak je već ažuriran u drugom zahtevu. Osvežite posao.");
  await indexJob(bucket, job);
  return saved.etag;
}
async function release(bucket, job) {
  const key=executionLockKey(job),lock = await read(bucket,key);
  if (lock?.value.owner === job.id)
    await put(
      bucket,
      key,
      { owner: null },
      { etagMatches: lock.etag },
    );
  await releaseTargetingIfSafe(bucket,job);
}
async function claim(bucket, job) {
  const key = executionLockKey(job),
    lock = await read(bucket, key);
  if(lock&&lock.value?.owner!==null&&!validJobReference(lock.value?.owner))
    fail('Rezervacija posla nije pouzdana. Nije pokrenut upis.');
  if (lock?.value.owner && lock.value.owner !== job.id) {
    const previous = (await read(bucket, jobKey(lock.value.owner)))?.value;
    if (!previous || !["completed", "cancelled"].includes(previous.status) || await targetingRisk(bucket,previous))
      fail(
        "Drugi posao za line iteme je u toku u ovoj mreži. Otvorite istoriju i nastavite ili završite taj posao.",
      );
  }
  if (lock?.value.owner === job.id) return;
  if (
    !(await put(
      bucket,
      key,
      { owner: job.id, actor: job.actor, createdAt: Date.now() },
      lock ? { etagMatches: lock.etag } : { etagDoesNotMatch: "*" },
    ))
  )
    fail("Drugi posao je upravo pokrenut. Osvežite istoriju.");
}
function limitFor(phase, review, plan) {
  if (
    plan?.schemaVersion === 2 &&
    ["creative", "association"].includes(phase)
  ) {
    const bytes = new TextEncoder().encode(
      plan?.creative?.snippet || "",
    ).length;
    return Math.max(1, Math.min(100, Math.floor(1500000 / (bytes * 6 + 3000))));
  }
  return review
    ? 100
    : phase === "creative"
      ? 5
      : phase === "lineItem"
        ? 20
        : phase === "association"
          ? 100
          : 50;
}
async function selectionChecks(client, plan) {
  const network = await client.network();
  if (plan.mode === "reporting") return { network, labels: { inventory: [], advertiser: "" } };
  if (network.currency !== plan.currency)
    fail(
      `Izabrana valuta ${plan.currency} ne odgovara valuti GAM mreže (${network.currency}). Uskladite cenu i Prebid valutu.`,
      422,
    );
  const labels = {};
  const kind = plan.inventory.kind === "adUnits" ? "adUnit" : "placement",
    inventory = await client.byIds(kind, plan.inventory.ids);
  if (
    inventory.length !== plan.inventory.ids.length ||
    inventory.some((r) => r.status !== "ACTIVE")
  )
    fail(
      "Inventory izbor nije dostupan ili nije aktivan. Ponovo izaberite ad unite / placement.",
    );
  labels.inventory = inventory.map((r) => ({
    id: String(r.id),
    name: String(r.name),
  }));
  for (const id of [
    ...new Set(
      plan.orders.filter((o) => o.mode === "new").map((o) => o.traffickerId),
    ),
  ]) {
    const users = await client.byIds("user", [id]);
    if (users.length !== 1 || !flag(users[0].isActive))
      fail("Izabrani trafficker nije aktivan.");
  }
  return { network, labels };
}
class OrderCapacityConflict extends GamError {}
async function capacity(client, orderId, pending) {
  if (!pending) return;
  const result = await client.query(
    "lineItem",
    `orderId = ${numericId(orderId)}`,
    {},
    { limit: 1, onePage: true },
  );
  if (!Number.isSafeInteger(result.total) || result.total < 0)
    fail("Kapacitet order-a nije pouzdano proveren. Ponovite proveru istog posla.", 502);
  if (result.total + pending > 450)
    throw new OrderCapacityConflict(
      "Order bi prešao 450 line itema. Izaberite novi order; Prebid će ga automatski podeliti na grupe od 400.",
      409,
    );
}
function rememberLabels(job, batch, states) {
  for (const e of batch) {
    const r = states.get(e.key);
    if (r.name && ["advertiser", "order"].includes(e.kind))
      job.labels[e.kind === "advertiser" ? "advertiser" : e.key] = r.name;
  }
}
async function currentAttempt(bucket, job) {
  const stored=await read(bucket,attemptKey(job.id,job.cursor));
  if(!stored)return null;
  return stored.value&&typeof stored.value==='object'&&!Array.isArray(stored.value)
    ? stored.value : {invalid:true};
}
function abortedBeforeDispatch(attempt) {
  return attempt?.preDispatchAborted===true&&validJobReference(attempt.dispatchToken)&&
    Number.isFinite(attempt.startedAt)&&Number.isFinite(attempt.abortedAt)&&attempt.abortedAt>=attempt.startedAt&&
    ['create','update'].includes(attempt.operation)&&Array.isArray(attempt.keys)&&attempt.keys.length>0&&
    new Set(attempt.keys).size===attempt.keys.length&&attempt.keys.every(key=>typeof key==='string');
}
function disjointAttempt(job,attempt) {
  if(!attempt)return true;
  if(abortedBeforeDispatch(attempt))return true;
  if(!['advertiser','order','creative','lineItem','association'].includes(job.phase)||
    !Number.isFinite(attempt.startedAt)||attempt.startedAt<0||
    ![undefined,'create'].includes(attempt.operation)||!Array.isArray(attempt.keys)||!attempt.keys.length||
    new Set(attempt.keys).size!==attempt.keys.length||attempt.keys.some(key=>typeof key!=='string'))return false;
  try{
    const batch=new Set(entities(job.plan,job.refs,job.phase,job.offset,limitFor(job.phase,false,job.plan)).map(entity=>entity.key));
    return attempt.keys.every(key=>batch.has(key));
  }catch{return false;}
}
async function targetingRisk(bucket,job) {
  return !disjointAttempt(job,await currentAttempt(bucket,job));
}
async function canReleaseTargeting(bucket,job) {
  return (['completed','cancelled'].includes(job.status)||
    (job.status==='creating'&&postTargetingPhase(job.phase)))&&!await targetingRisk(bucket,job);
}
async function releaseTargetingIfSafe(bucket,job,token=job.targetingToken) {
  const key=targetingLockKey(job.plan.networkCode),lease=await read(bucket,key);
  if(lease?.value.owner!==job.id||!validJobReference(lease.value.token)||(token&&lease.value.token!==token))return;
  const fresh=(await read(bucket,jobKey(job.id)))?.value;
  if(!fresh||!await canReleaseTargeting(bucket,fresh))return;
  await put(bucket,key,{owner:null},{etagMatches:lease.etag});
}
async function targetingClaim(bucket,job,firstStart=false) {
  const key=targetingLockKey(job.plan.networkCode),lease=await read(bucket,key);
  if(lease&&lease.value?.owner!==null&&!validJobReference(lease.value?.owner))
    fail('Rezervacija key-values nije pouzdana. Nije pokrenut upis.');
  if(lease?.value.owner){
    if(!validJobReference(lease.value.token))
      fail('Rezervacija key-values nema pouzdan identitet. Nije pokrenut upis.');
    if(lease.value.owner===job.id){
      // A ready first start is never reentrant: another handler must not turn
      // a failing admission's unchanged reservation into a live KV segment.
      if(firstStart||job.status!=='creating')return {blocked:job};
      if(job.targetingToken&&job.targetingToken!==lease.value.token)
        fail('Rezervacija key-values je promenjena. Osvežite posao.');
      job.targetingToken=lease.value.token;
      return {token:lease.value.token,fresh:false};
    }
    let previous;
    try{previous=(await read(bucket,jobKey(lease.value.owner)))?.value;}catch{}
    if(!previous||!await canReleaseTargeting(bucket,previous))return {blocked:previous||true};
  }
  const token=crypto.randomUUID();
  if(!await put(bucket,key,{owner:job.id,token,createdAt:Date.now()},
    lease?{etagMatches:lease.etag}:{etagDoesNotMatch:'*'}))return {blocked:true};
  job.targetingToken=token;
  return {token,fresh:true};
}
async function targetingOwned(bucket,job) {
  const lease=await read(bucket,targetingLockKey(job.plan.networkCode));
  if(lease?.value.owner!==job.id||lease.value.token!==job.targetingToken)
    fail('Posao više nema rezervaciju za key-values. Nije pokrenut upis.');
}
async function failedStartCleanup(bucket,job,reservation) {
  if(!reservation?.fresh)return;
  const fresh=(await read(bucket,jobKey(job.id)))?.value;
  if(!fresh||fresh.status==='creating'||fresh.executionStartedAt||await currentAttempt(bucket,fresh))return;
  // Only this first-start invocation could use this token while ready. A
  // successful start is durably creating and retains the reservation instead.
  const own=await read(bucket,executionLockKey(job));
  if(own?.value.owner===job.id)
    await put(bucket,executionLockKey(job),{owner:null},{etagMatches:own.etag});
  const lease=await read(bucket,targetingLockKey(job.plan.networkCode));
  if(lease?.value.owner===job.id&&lease.value.token===reservation.token)
    await put(bucket,targetingLockKey(job.plan.networkCode),{owner:null},{etagMatches:lease.etag});
}
async function admission(bucket,job) {
  const keys=independentReporting(job)
    ? [reportingLockKey(job.plan.networkCode),lockKey(job.plan.networkCode)]
    : [lockKey(job.plan.networkCode)];
  let related;
  for(const key of keys){
    const lease=await read(bucket,key);
    if(!lease||lease.value?.owner===null)continue;
    const owner=lease.value?.owner;
    if(!validJobReference(owner))return {blocked:true};
    if(owner===job.id)continue;
    let active;
    try{active=(await read(bucket,jobKey(owner)))?.value;}catch{}
    if(!active)return {blocked:true};
    const risk=await targetingRisk(bucket,active);
    if(['completed','cancelled'].includes(active.status)&&!risk)continue;
    if(key===lockKey(job.plan.networkCode)&&independentReporting(job)&&
      ['prebid','single'].includes(active.plan?.mode)&&active.status==='creating'&&
      postTargetingPhase(active.phase)&&!risk){related=active;continue;}
    return {blocked:active};
  }
  return {related};
}
function checkExisting(job, batch, states) {
  for (const e of batch) {
    const found = states.get(e.key),
      prior = job.refs[e.key];
    if (found?.state === "conflict")
      fail(`${e.payload.name || e.key}: ${found.message}`);
    if (!found || !["new", "existing", "update"].includes(found.state))
      fail(found?.message || "Korak nije pouzdano proveren. Ponovite proveru istog posla.");
    if (prior?.id && (found.id !== prior.id || found.state === "new"))
      fail(
        "Entitet iz pregleda je promenjen ili uklonjen. Zaustavite posao i napravite novi pregled.",
      );
    if (!e.ready)
      fail("Prethodni korak nije potvrđen. Proverite sačuvani napredak.");
  }
}
class ReportingParentsChanged extends GamError {}
async function verifyParents(client, job, batch, recovering = false) {
  const plan = job.plan,
    first = batch[0];
  if (!first) return;
  if (first.kind === "value") {
    const needed = new Set(batch.flatMap((entity) => entity.depends));
    const parents = entities(plan, job.refs, "key", 0, phaseCount(plan, "key"))
      .filter((entity) => needed.has(entity.key));
    const states = await inspectEntities(client, parents, plan);
    recordResult(job, parents, states);
    if (parents.some((entity) => !["existing", "update"].includes(states.get(entity.key)?.state)))
      fail("Roditeljski GAM ključ nije pouzdano dostupan. Ponovite proveru istog posla.");
    if (parents.some((entity) => states.get(entity.key)?.state === "update")) {
      if (recovering) return true;
      throw new ReportingParentsChanged("Reporting podešavanje ključa je promenjeno. Isti posao se vraća na proveru i dopunu ključeva pre nastavka vrednosti.");
    }
  }
  if (["order", "creative"].includes(first.kind)) {
    const a = await client.byIds("advertiser", [job.refs["advertiser:0"].id]);
    if (a.length !== 1 || a[0].type !== "ADVERTISER")
      fail("Advertiser više nije dostupan.");
  }
  if (first.kind === "lineItem") {
    const ids = [...new Set(batch.map((e) => e.payload.orderId))],
      orders = await client.byIds("order", ids);
    if (
      orders.length !== ids.length ||
      orders.some(
        (o) =>
          String(o.advertiserId) !== job.refs["advertiser:0"].id ||
          flag(o.isArchived) ||
          ["CANCELED", "DELETED"].includes(o.status),
      )
    )
      fail("Order ili njegov advertiser je promenjen. Ponovite pregled.");
  }
  if (first.kind === "association") {
    const cs = await client.byIds("creative", [
      ...new Set(batch.map((e) => e.payload.creativeId)),
    ]);
    if (
      cs.some((c) => String(c.advertiserId) !== job.refs["advertiser:0"].id) ||
      cs.length !== new Set(batch.map((e) => e.payload.creativeId)).size
    )
      fail("Kreativi više ne pripadaju izabranom advertiser-u.");
    for (const index of [
      ...new Set(batch.map((e) => Number(e.key.split(":")[2]))),
    ]) {
      const expected = entities(plan, job.refs, "creative", index, 1)[0],
        actual = cs.find((c) => String(c.id) === job.refs[expected.key].id);
      if (!actual || !compatible(expected, actual, plan))
        fail("Kreativ je promenjen pre povezivanja. Ponovite pregled.");
    }
    const indices = [...new Set(batch.map((e) => Number(e.key.split(":")[1])))];
    const lis = await client.byIds(
      "lineItem",
      indices.map((i) => job.refs[`lineItem:${i}`].id),
    );
    for (const index of indices) {
      const expected = entities(plan, job.refs, "lineItem", index, 1)[0],
        actual = lis.find((r) => String(r.id) === job.refs[expected.key].id);
      if (!actual || !compatible(expected, actual, plan))
        fail(
          "Line item je promenjen pre povezivanja kreativa. Ponovite pregled.",
        );
    }
  }
}
function validateCreated(batch, rows, plan) {
  if (!Array.isArray(rows) || rows.length !== batch.length)
    fail("GAM nije potvrdio ceo paket. Proverite ishod pre nastavka.", 502);
  const states = new Map(),
    ids = new Set();
  for (const e of batch) {
    const matched = rows.filter((r) =>
      e.kind === "association"
        ? String(r.lineItemId) === e.payload.lineItemId &&
          String(r.creativeId) === e.payload.creativeId
        : sameEntityName(e.kind, r.name, e.payload.name) &&
          (e.kind !== "value" || String(r.customTargetingKeyId) === e.payload.customTargetingKeyId),
    );
    if (matched.length !== 1 || !compatible(e, matched[0], plan) ||
        (e.kind === "key" && e.payload.reportableType && matched[0].type !== e.payload.type) ||
        (e.kind === 'key' && addOnlyReporting(plan) && matched[0].reportableType !== 'ON'))
      fail(
        "GAM odgovor se razlikuje od potvrđenog zahteva. Proverite ishod.",
        502,
      );
    const row = matched[0],
      id =
        e.kind === "association"
          ? `${numericId(String(row.lineItemId))}:${numericId(String(row.creativeId))}`
          : numericId(String(row.id));
    if (ids.has(id)) fail("GAM je vratio dupliran ID. Proverite ishod.", 502);
    ids.add(id);
    states.set(e.key, {
      state: "created",
      id,
      name: row.name || id,
      status: row.status || "",
      ...(e.kind==='key'?{reportableType:row.reportableType||'OFF'}:{}),
    });
  }
  return states;
}
function validateUpdated(batch, rows, plan) {
  if (!Array.isArray(rows) || rows.length !== batch.length)
    fail("GAM nije potvrdio sve dopune reporting ključeva. Proverite ishod.", 502);
  const states = new Map(), seen = new Set();
  for (const entity of batch) {
    const payload = entity.updatePayload;
    const matches = rows.filter((row) => String(row.id) === payload.id);
    if (matches.length !== 1 || seen.has(payload.id))
      fail("GAM odgovor ne potvrđuje iste ID-jeve reporting ključeva. Proverite ishod.", 502);
    const actual = matches[0];
    if (!sameEntityName("key", actual.name, payload.name) || actual.type !== payload.type ||
        String(actual.displayName ?? "") !== String(payload.displayName ?? "") ||
        !reportingReady(actual.reportableType) || !compatible(entity, actual, plan))
      fail("GAM nije potvrdio reporting dopunu uz očuvane podatke ključa. Proverite ishod.", 502);
    seen.add(payload.id);
    states.set(entity.key, { state: "existing", id: numericId(payload.id), name: actual.name,
      status: actual.status || "", reportableType: actual.reportableType, reportingUpdated: true });
  }
  return states;
}

export async function lineItemResponse(
  request,
  path,
  { bucket, actor, body, connected, makeClient, trafficFactory },
) {
  if (!bucket) fail("Skladište integracija nije povezano.", 503);
  const url = new URL(request.url),
    origin = url.origin;
  const view=async(value,pending)=>{
    let noWriteAttempts=false;
    if(canCloseJobPreview(value,pending,true)){
      try{
        const attempts=await bucket.list({prefix:prefix+'attempts/'+uuid(value.id)+'/',limit:1});
        noWriteAttempts=Array.isArray(attempts?.objects)&&attempts.objects.length===0&&attempts.truncated===false;
      }catch{ /* A missing proof never authorizes closing a preview. */ }
    }
    let relatedAdJob;
    if(independentReporting(value)&&value.relatedAdJobId){
      const related=(await read(bucket,jobKey(value.relatedAdJobId)))?.value;
      if(related?.actor===actor&&related.origin===origin&&['prebid','single'].includes(related.plan?.mode)){
        const relatedView=jobView(related,await currentAttempt(bucket,related));
        relatedAdJob=Object.fromEntries(['id','cursor','mode','status','phase','network','counts','awaitingCheck']
          .map(key=>[key,relatedView[key]]));
        relatedAdJob.canClosePreview=false;
      }
    }
    return {...jobView(value,pending,{noWriteAttempts,relatedAdJob}),
      canCancel: value.status === 'creating' && (!pending ||
        (disjointAttempt(value,pending) && (abortedBeforeDispatch(pending) ||
          Date.now() >= pending.startedAt + 90000)))};
  };
  const blockedResponse=async(active,message='Drugi posao trenutno koristi key-values. Nije pokrenut novi upis.')=>{
    if(active!==true&&active?.actor===actor&&active.origin===origin){
      const activeView=await view(active,await currentAttempt(bucket,active));
      const activeJob=Object.fromEntries(['id','cursor','mode','status','phase','network','counts','awaitingCheck','canClosePreview']
        .map(key=>[key,activeView[key]]));
      return json({error:message,activeJobId:active.id,activeJob},409);
    }
    return json({error:message},409);
  };
  const clientFor = async (network) => {
    const connection = await connected(network);
    return {
      connection,
      client: trafficFactory
        ? await trafficFactory(connection)
        : new GamTrafficClient(await makeClient(connection)),
    };
  };
  if (path === "/line-items/network" && request.method === "GET") {
    const { client } = await clientFor(
      numericId(url.searchParams.get("network")),
    );
    return json(await client.network());
  }
  if (path === "/line-items/defaults" && request.method === "GET") {
    const networkCode = numericId(url.searchParams.get("network"));
    const { client } = await clientFor(networkCode);
    return json(await discoverPrebidDefaults(client, networkCode));
  }
  if (path === "/line-items/lookups" && request.method === "GET") {
    const { client } = await clientFor(
        numericId(url.searchParams.get("network")),
      ),
      kind = url.searchParams.get("kind");
    if (
      !["advertiser", "order", "creative", "user", "placement"].includes(kind)
    )
      fail("Nepoznata lista.", 422);
    const search = (url.searchParams.get("q") || "").trim();
    if (search.length > 100) fail("Pretraga je predugačka.", 422);
    const offset = Number(url.searchParams.get("offset") || 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
      fail("Neispravna stranica.", 422);
    const clauses = [],
      bindings = {};
    if (kind === "advertiser") clauses.push("type = 'ADVERTISER'");
    if (kind === "order" || kind === "creative") {
      bindings.advertiser = numericId(url.searchParams.get("advertiser"));
      clauses.push("advertiserId = :advertiser");
    }
    if (kind === "user") clauses.push("status = 'ACTIVE'");
    if (kind === "placement") clauses.push("status = 'ACTIVE'");
    if (search) {
      clauses.push("name LIKE :search");
      bindings.search = "%" + search + "%";
    }
    const data = await client.query(
      kind,
      clauses.join(" AND ") || "1 = 1",
      bindings,
      { offset, limit: 100, onePage: true },
    );
    return json({
      items: data.rows.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        email: r.email || "",
        status: r.status || "",
        size: r.size ? `${r.size.width}x${r.size.height}` : "",
        advertiserId: r.advertiserId ? String(r.advertiserId) : undefined,
      })),
      more: data.more,
      nextOffset: offset + data.rows.length,
    });
  }
  if (path === "/line-items/preview" && request.method === "POST") {
    const previewInput = await body(request), plan = normalizeLinePlan(previewInput),
      connection = await connected(plan.networkCode);
    const lane=addOnlyReporting(plan)?'reporting_add_only_v1':undefined;
    const gate=await admission(bucket,{plan,executionLane:lane});
    if(gate.blocked){
      const active=gate.blocked;
      if(active!==true&&active.actor===actor&&active.origin===origin&&active.status==='creating'&&
        active.connectionRevision===connection.revision&&sameActivePlan(active.plan,plan,previewInput))
        return json({...await view(active,await currentAttempt(bucket,active)),resumed:true});
      return blockedResponse(active,'Postojeći posao još koristi ovu oblast GAM mreže. Otvorite ga i proverite napredak pre novog plana.');
    }
    // A blocked or resumed saved job is an R2-only operation. Resolve Google
    // credentials only after the shared network lease permits a new preview.
    const client = trafficFactory
      ? await trafficFactory(connection)
      : new GamTrafficClient(await makeClient(connection));
    const { network, labels } = await selectionChecks(client, plan),
      now = new Date().toISOString();
    const job = {
      id: crypto.randomUUID(),
      actor,
      origin,
      connectionRevision: connection.revision,
      network,
      plan,
      ...(lane?{executionLane:lane}:{}),
      ...(gate.related?.actor===actor&&gate.related.origin===origin?{relatedAdJobId:gate.related.id}:{}),
      labels,
      refs: {},
      status: "reviewing",
      phase: firstPhase(plan),
      offset: 0,
      cursor: 0,
      createdAt: now,
      updatedAt: now,
    };
    await put(bucket, jobKey(job.id), job, { etagDoesNotMatch: "*" });
    await indexJob(bucket, job);
    return json(await view(job), 201);
  }
  if (path === "/line-items/jobs" && request.method === "GET") {
    const network = numericId(url.searchParams.get("network"));
    const items = await bucket.list({
        prefix: await historyPrefix(actor, origin, network),
        limit: 100,
      }),
      jobs = [];
    for (const object of items.objects) {
      const j = (await read(bucket, object.key))?.value;
      if (j) jobs.push(j);
    }
    // Keep both execution lanes reachable after the bounded history page.
    for(const key of [lockKey(network),reportingLockKey(network)]){
      const owner = (await read(bucket,key))?.value?.owner;
      if(!validJobReference(owner))continue;
      const active = (await read(bucket, jobKey(owner)))?.value;
      if (active?.actor === actor && active.origin === origin) {
        const i = jobs.findIndex((j) => j.id === owner);
        if (i >= 0) jobs.splice(i, 1);
        jobs.unshift(summary(active));
      }
    }
    return json({ jobs, truncated: Boolean(items.truncated) });
  }
  const route = path.match(
    /^\/line-items\/jobs\/([a-f0-9-]+)(?:\/(review|start|step|check|cancel|close-preview|export))?$/,
  );
  if (!route)
    return json({ error: "Line item operacija nije pronađena." }, 404);
  const id = uuid(route[1]),
    action = route[2],
    stored = await read(bucket, jobKey(id));
  if (!stored || stored.value.actor !== actor || stored.value.origin !== origin)
    fail("Posao nije pronađen.", 404);
  const job = stored.value,
    attempt = await currentAttempt(bucket, job);
  if (!action && request.method === "GET") return json(await view(job, attempt));
  if (action === "export" && request.method === "GET") {
    const cell = (v) => '"' + String(v ?? "").replaceAll('"', '""') + '"';
    const rows = [
      [
        "Network",
        "Order ID",
        "Line item",
        "Line item ID",
        "Price",
        "Currency",
        "State",
        "hb_pb",
        "Creative first",
        "Creative last",
        "Creative IDs",
      ],
      ...job.plan.rows.map((r, i) => [
        job.plan.networkCode,
        job.refs[r.orderRef]?.id,
        r.name,
        job.refs[`lineItem:${i}`]?.id,
        r.price,
        job.plan.currency,
        job.refs[`lineItem:${i}`]?.state,
        job.plan.mode === "prebid" ? r.price : "",
        creativesPerLine(job.plan)
          ? creativeNameAt(job.plan, creativeIndexFor(job.plan, i, 0))
          : "",
        creativesPerLine(job.plan)
          ? creativeNameAt(
              job.plan,
              creativeIndexFor(job.plan, i, creativesPerLine(job.plan) - 1),
            )
          : "",
        Array.from(
          { length: creativesPerLine(job.plan) },
          (_, copy) =>
            job.refs[`creative:${creativeIndexFor(job.plan, i, copy)}`]?.id ||
            "",
        )
          .filter(Boolean)
          .join(";"),
      ]),
    ];
    // Prefix spreadsheet formulas in user-entered fields without changing GAM names.
    const csv =
      "\ufeff" +
      rows
        .map((r) =>
          r
            .map((v) =>
              cell(/^[=+\-@\t\r]/.test(String(v ?? "")) ? "'" + v : v),
            )
            .join(","),
        )
        .join("\r\n");
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="gam-line-items-${id}.csv"`,
        "cache-control": "private, no-store",
      },
    });
  }
  if (request.method !== "POST")
    return json({ error: "Method not allowed." }, 405);
  const input = await body(request);
  if(action==='close-preview'){
    if(input.confirm!==true||input.confirmNetwork!==job.plan.networkCode)
      fail('Potvrdite mrežu i zatvaranje neizvršenog pregleda.',422);
    if(input.cursor!==job.cursor)fail('Pregled je u međuvremenu promenjen. Osvežite ga pre zatvaranja.');
    if(!canCloseJobPreview(job,attempt,true))
      fail('Može se zatvoriti samo neizvršen pregled bez ranijih upisa ili aktivnih pokušaja.');
    const attempts=await bucket.list({prefix:prefix+'attempts/'+uuid(job.id)+'/',limit:1});
    if(!Array.isArray(attempts?.objects)||attempts.objects.length||attempts.truncated!==false)
      fail('Postoji raniji pokušaj upisa ili nije potvrđeno da ga nema. Pregled nije zatvoren.');
    job.status='cancelled';
    job.closedPreviewAt=new Date().toISOString();
    job.error='Pregled je zatvoren. Nije izvršen upis u GAM.';
    await save(bucket,job,stored.etag);
    await release(bucket,job);
    return json(await view(job));
  }
  if(['start','step'].includes(action)&&!reportingExecutionAllowed(job.plan)){
    const readOnly=await view(job,attempt);
    return json({...readOnly,error:readOnly.readOnlyReason},409);
  }
  if (action === "cancel") {
    if (input.cursor !== undefined && input.cursor !== job.cursor)
      fail('Posao je u međuvremenu promenjen. Osvežite stanje pre zaustavljanja.');
    if ((Object.hasOwn(input,'confirm') || Object.hasOwn(input,'confirmNetwork')) &&
        (input.confirm !== true || input.confirmNetwork !== job.plan.networkCode || input.cursor !== job.cursor))
      fail('Potvrdite prikazanu mrežu i trenutno stanje posla pre zaustavljanja.',422);
    if(attempt&&!disjointAttempt(job,attempt))
      fail('Ishod ranijeg key-values upisa nije potvrđen. Najpre proverite ishod; posao i rezervacija nisu zaustavljeni.');
    if (attempt && !abortedBeforeDispatch(attempt) && Date.now() < attempt.startedAt + 90000)
      fail(
        "GAM zahtev možda još traje. Sačekajte 90 sekundi od početka koraka.",
      );
    if (job.status === "completed") return json(await view(job));
    job.status = "cancelled";
    job.error =
      "Posao je zaustavljen. Već kreirani GAM entiteti ostaju sačuvani.";
    await save(bucket, job, stored.etag);
    await release(bucket, job);
    return json(await view(job));
  }
  if (
    ["step", "review", "check"].includes(action) &&
    input.cursor !== job.cursor
  )
    return json(await view(job, attempt));
  if(action==='start'){
    if(input.confirmNetwork!==job.plan.networkCode||input.confirm!==true)
      fail('Potvrdite prikazanu mrežu i plan.',422);
    if(job.status==='creating'||job.status==='completed')return json(await view(job,attempt));
    const gate=await admission(bucket,job);
    if(gate.blocked)return blockedResponse(gate.blocked);
  }
  const { client, connection } = await clientFor(job.plan.networkCode);
  const readOnlyTargetingCheck = action === 'check' && ['key','value'].includes(job.phase);
  if (connection.revision !== job.connectionRevision && !readOnlyTargetingCheck)
    fail(
      "GAM konekcija je promenjena. Zaustavite posao i napravite novi pregled.",
    );
  if (readOnlyTargetingCheck) {
    const network = await client.network();
    if (String(network?.networkCode) !== job.plan.networkCode)
      fail('GAM provera ne potvrđuje istu mrežu. Ishod nije potvrđen; upis nije ponovljen.');
  }
  if (action === "start") {
    if (input.confirmNetwork !== job.plan.networkCode || input.confirm !== true)
      fail("Potvrdite prikazanu mrežu i plan.", 422);
    if (job.status === "creating" || job.status === "completed")
      return json(await view(job, attempt));
    if (job.status !== "ready" || job.expiresAt < Date.now())
      fail("Pregled nije spreman ili je istekao. Napravite novi pregled.");
    if (!jobView(job).canStart)
      fail("Proverite nepotvrđene stavke i stvarne konflikte pre kreiranja.");
    await selectionChecks(client, job.plan);
    let reservation;
    try {
      reservation=await targetingClaim(bucket,job,true);
      if(reservation.blocked)return blockedResponse(reservation.blocked);
      const gate=await admission(bucket,job);
      if(gate.blocked){
        await failedStartCleanup(bucket,job,reservation);
        return blockedResponse(gate.blocked);
      }
      await claim(bucket, job);
      job.status = "creating";
      job.executionStartedAt = new Date().toISOString();
      job.phase = firstPhase(job.plan);
      job.offset = 0;
      job.cursor++;
      job.error = "";
      await save(bucket, job, stored.etag);
    } catch (error) {
      await failedStartCleanup(bucket,job,reservation);
      throw error;
    }
    return json(await view(job));
  }
  if (action === "review") {
    if (input.retry === true && (job.status === "ready" ||
        (job.status === "reviewing" && jobView(job).conflictCount > 0))) {
      job.status = "reviewing";
      job.phase = firstPhase(job.plan);
      job.offset = 0;
      job.cursor++;
      delete job.expiresAt;
      delete job.verificationResults;
      for (const [key, value] of Object.entries(job.refs)) {
        if (!["existing", "created", "unverified"].includes(value.state)) {
          if (value.verifiedId || value.createdByJob) job.refs[key] = { ...value, state: "unverified" };
          else delete job.refs[key];
        }
      }
    }
    if (job.status !== "reviewing") return json(await view(job));
    const batch = entities(
        job.plan,
        job.refs,
        job.phase,
        job.offset,
        limitFor(job.phase, true, job.plan),
      ),
      states = await inspectEntities(client, batch, job.plan);
    recordResult(job, batch, states);
    rememberLabels(job, batch, states);
    if ([...states.values()].some((r) => r.state === "unverified")) {
      const detail = [...states.values()].find((r) => r.state === "unverified")?.message;
      job.error = `Provera GAM-a nije završena${detail ? ": " + detail : "."} Sačuvani posao je očuvan; ponovite proveru.`;
      await save(bucket, job, stored.etag);
      return json(await view(job));
    }
    job.error = "";
    advance(job, batch.length);
    if (job.status === "ready") {
      for (const order of job.plan.orders) {
        const orderId = job.refs[order.ref]?.id;
        if (orderId) {
          const missing = job.plan.rows.filter(
            (r, i) =>
              r.orderRef === order.ref &&
              job.refs[`lineItem:${i}`]?.state === "new",
          ).length;
          try {
            await capacity(client, orderId, missing);
          } catch (e) {
            const before = job.refs[order.ref];
            job.refs[order.ref] = {
              ...before,
              state: e instanceof OrderCapacityConflict ? "conflict" : "unverified",
              verification: "capacity",
              ...(before.id ? { verifiedId: true } : {}),
              ...(before.state === "created" || before.createdByJob ? { createdByJob: true } : {}),
              message: e instanceof GamError ? e.message : "Kapacitet order-a nije pouzdano proveren. Ponovite proveru istog posla.",
            };
            job.error = e instanceof OrderCapacityConflict
              ? "Plan ima konflikt sa kapacitetom order-a. Nije pokrenut upis."
              : `Provera kapaciteta order-a nije završena: ${job.refs[order.ref].message} Nije pokrenut upis.`;
          }
        }
      }
    }
    await save(bucket, job, stored.etag);
    return json(await view(job));
  }
  if (!["step", "check"].includes(action))
    return json({ error: "Operacija nije pronađena." }, 404);
  if (job.status !== "creating") return json(await view(job, attempt));
  const lock = await read(bucket, executionLockKey(job));
  if (lock?.value.owner !== job.id)
    fail("Posao nema aktivnu rezervaciju za ovu mrežu.");
  const targetingPhase=['key','value'].includes(job.phase);
  if(targetingPhase&&(action!=='check'||attempt)){
    if(independentReporting(job)){
      const gate=await admission(bucket,job);
      if(gate.blocked)return blockedResponse(gate.blocked);
    }
    const reservation=await targetingClaim(bucket,job);
    if(reservation.blocked)return blockedResponse(reservation.blocked);
  }
  const batch = entities(
    job.plan,
    job.refs,
    job.phase,
    job.offset,
    limitFor(job.phase, false, job.plan),
  );
  let reportingParentsNeedUpdate = false;
  const parentsVerified = async () => {
    try {
      reportingParentsNeedUpdate = await verifyParents(client, job, batch, action === "check") === true;
      return true;
    } catch (error) {
      const message = error instanceof GamError ? error.message
        : "Prethodni korak nije pouzdano proveren. Ponovite proveru istog posla.";
      if (error instanceof ReportingParentsChanged && !attempt) {
        job.phase = "key";
        job.offset = 0;
        job.cursor++;
        delete job.verificationResults;
      } else job.verificationResults = Object.fromEntries(batch.map((e) => [e.key, { state: "unverified", message }]));
      job.error = message;
      await save(bucket, job, stored.etag);
      return false;
    }
  };
  const existingVerified = async (states) => {
    try {
      checkExisting(job, batch, states);
      return true;
    } catch (error) {
      job.verificationResults = Object.fromEntries(states);
      job.error = error instanceof GamError ? error.message : "Korak nije pouzdano proveren. Ponovite proveru istog posla.";
      await save(bucket, job, stored.etag);
      return false;
    }
  };
  if (action === "check") {
    if (!attempt) return json(await view(job));
    if(abortedBeforeDispatch(attempt)){
      // Only the handler that reserved this attempt can journal this proof.
      // Close its cursor explicitly; a later step performs a fresh inspection.
      delete job.verificationResults;
      job.error='';
      advance(job,0);
      await save(bucket,job,stored.etag);
      if(targetingPhase)await releaseTargetingIfSafe(bucket,job);
      return json(await view(job));
    }
    if (!Number.isSafeInteger(attempt.startedAt) || attempt.startedAt < 0 || attempt.startedAt > Date.now() ||
        ![undefined,'create','update'].includes(attempt.operation) ||
        (attempt.operation === 'update' && job.phase !== 'key'))
      fail('Sačuvani pokušaj nema pouzdano vreme ili vrstu upisa. Upis nije ponovljen.');
    if (!await parentsVerified()) return json(await view(job, attempt));
    const states = await inspectEntities(client, batch, job.plan, { completeTargetingScope: targetingPhase });
    if ([...states.values()].some((r) => ["unverified", "blocked"].includes(r.state))) {
      job.verificationResults = Object.fromEntries(states);
      job.error = "Provera GAM-a nije završena. Nepotvrđeni upis nije ponovljen; ponovite proveru istog posla.";
      await save(bucket, job, stored.etag);
      return json(await view(job, attempt));
    }
    if (!await existingVerified(states)) return json(await view(job, attempt));
    if (!Array.isArray(attempt.keys) || !attempt.keys.length ||
        attempt.keys.some((key) => typeof key !== "string") || new Set(attempt.keys).size !== attempt.keys.length)
      fail("Sačuvani pokušaj nema pouzdan spisak entiteta. Upis nije ponovljen.");
    const attempted = new Set(attempt.keys);
    const attemptedBatch = batch.filter((entity) => attempted.has(entity.key));
    if (attemptedBatch.length !== attempted.size)
      fail("Sačuvani pokušaj se ne poklapa sa ovim korakom. Upis nije ponovljen.");
    // A read-only Check can use refreshed credentials to unblock a failed
    // old job, including a connection changed during the read itself. Never
    // migrate its immutable plan/revision or authorize Step with new credentials.
    const requiresNewPreview = readOnlyTargetingCheck &&
      (connection.revision !== job.connectionRevision ||
        (await connected(job.plan.networkCode)).revision !== job.connectionRevision);
    const recoveryNotice = message => {
      job.recovery = {cursor:job.cursor,message:message+(requiresNewPreview
        ? ' GAM konekcija je promenjena. Zaustavite ovaj posao i napravite novi pregled; sačuvani plan nije promenjen.' : ''),requiresNewPreview};
    };
    for(const entity of attemptedBatch){
      const state=states.get(entity.key);
      if(!entity.reporting||state?.state!=='existing')continue;
      if(attempt.operation==='update')states.set(entity.key,{...state,reportingUpdated:true,
        reportingReconciled:true,reconciliationMessage:'Reporting je uključen; potvrđeno proverom posle prekinutog odgovora.'});
      else if(attempt.operation==='create')states.set(entity.key,{...state,reportingReconciled:true,
        reconciliationMessage:'Potvrđeno u GAM-u posle prekinutog odgovora; odgovor kreiranja nije primljen.'});
    }
    if (attemptedBatch.every((e) => states.get(e.key)?.state === "existing")) {
      delete job.verificationResults;
      recordResult(job, batch, states);
      rememberLabels(job, batch, states);
      job.error = "";
      if (reportingParentsNeedUpdate) {
        job.phase = "key"; job.offset = 0; job.cursor++;
      } else finishBatch(job, batch, states);
      if (requiresNewPreview) recoveryNotice('Ishod prethodnog pokušaja je potvrđen.');
      await save(bucket, job, stored.etag);
      if (job.status === "completed") await release(bucket, job);
      else if(targetingPhase)await releaseTargetingIfSafe(bucket,job);
      return json(await view(job));
    }
    if (attempt.operation === "update" && Date.now() >= attempt.startedAt + 90000 &&
        attemptedBatch.every((entity) => ["existing", "update"].includes(states.get(entity.key)?.state))) {
      // A completed wait plus a fresh owned-ID read proves which idempotent
      // set-ON updates remain. Close this attempt; a later explicit step may
      // update those same IDs using their freshly read metadata, never create.
      recordResult(job, batch, states);
      delete job.verificationResults;
      job.error = "";
      advance(job, 0);
      if (requiresNewPreview) recoveryNotice('Ishod prethodnog pokušaja je proveren. Nije ponovljen upis.');
      await save(bucket, job, stored.etag);
      return json(await view(job));
    }
    // Pre-operation-field journals represented creates only. They still need
    // the same saved phase, exact batch keyset, complete read and deadline.
    if (targetingPhase && [undefined, "create"].includes(attempt.operation) &&
        Number.isSafeInteger(attempt.startedAt) && attempt.startedAt >= 0 &&
        Date.now() >= attempt.startedAt + 90000 &&
        attemptedBatch.every((entity) => ["existing", "new", "update"].includes(states.get(entity.key)?.state))) {
      // The bounded write window has elapsed and a complete, fresh name-scope
      // read proved exactly what exists. Keep the targeting lease and retire
      // this cursor with CAS. A later explicit step rereads all names and only
      // creates what is still absent; a late conflicting GAM create is rejected
      // by GAM's unique-name constraint and reconciled, never blindly repeated.
      recordResult(job, batch, states);
      delete job.verificationResults;
      job.error = "";
      advance(job, 0);
      const existing = attemptedBatch.filter((entity) => states.get(entity.key)?.state !== "new").length;
      recoveryNotice(`Ishod prethodnog pokušaja je proveren. ${existing} stavki već postoji; ${attemptedBatch.length-existing} nedostaje. Nije ponovljen upis.`+
        (requiresNewPreview?'':' Možete nastaviti preostale stavke ili zaustaviti posao.'));
      await save(bucket, job, stored.etag);
      return json(await view(job));
    }
    if (job.phase !== "association")
      recordResult(job, batch.filter((e) => states.get(e.key)?.state === "existing"), states);
    job.verificationResults = Object.fromEntries([...states].map(([key, value]) => [key,
      attempted.has(key) && pendingWrite(value.state) ? { ...value, state: "unverified", message: "GAM još nije potvrdio ishod ranijeg upisa. Upis nije ponovljen." } : value,
    ]));
    await save(bucket, job, stored.etag);
    return json({
      ...await view(job, attempt),
      error:
        "GAM još nije potvrdio sve entitete iz ovog koraka. Nema automatskog ponavljanja upisa. Proverite ponovo ili zaustavite posao, pa napravite nov pregled postojećeg stanja.",
    });
  }
  if (attempt) return json(await view(job, attempt));
  let ownedAttempt,googleInvoked=false;
  try {
    if (!await parentsVerified()) return json(await view(job));
    const states = await inspectEntities(client, batch, job.plan);
    if ([...states.values()].some((r) => ["unverified", "blocked"].includes(r.state))) {
      job.verificationResults = Object.fromEntries(states);
      job.error = "Provera GAM-a nije završena. Nije pokrenut upis; ponovite proveru istog posla.";
      await save(bucket, job, stored.etag);
      return json(await view(job));
    }
    if (!await existingVerified(states)) return json(await view(job));
    delete job.verificationResults;
    const missing = batch.filter((e) => states.get(e.key).state === "new"),
      updates = batch.filter((e) => states.get(e.key).state === "update");
    if(addOnlyReporting(job.plan)&&updates.length)
      fail('Režim samo dodavanja ne dozvoljava izmenu postojećeg ključa.');
    const operation = updates.length ? "update" : "create";
    const writeBatch = updates.length
      ? updates.map((entity) => ({ ...entity, updatePayload: states.get(entity.key).updatePayload }))
      : missing;
    if (job.phase === "lineItem")
      for (const orderId of [...new Set(missing.map((e) => e.payload.orderId))])
        await capacity(
          client,
          orderId,
          missing.filter((e) => e.payload.orderId === orderId).length,
        );
    if (writeBatch.length) {
      if(targetingPhase)await targetingOwned(bucket,job);
      const attemptValue={startedAt:Date.now(),keys:writeBatch.map(entity=>entity.key),operation,dispatchToken:crypto.randomUUID()};
      const attemptPath=attemptKey(job.id,job.cursor);
      const reserved=await put(bucket,attemptPath,attemptValue,{etagDoesNotMatch:'*'});
      if(!reserved)
        return json(await view(job, await currentAttempt(bucket, job)));
      ownedAttempt={path:attemptPath,value:attemptValue,etag:reserved.etag};
      // Reserve the job ETag as well: cancellation that started before the
      // attempt record must lose its CAS, or this reservation loses and no
      // Google write occurs. This closes the cancel/read/create race.
      stored.etag = await save(bucket, job, stored.etag);
      if(targetingPhase)await targetingOwned(bucket,job);
      googleInvoked=true;
      const confirmed = operation === "update"
        ? validateUpdated(writeBatch, await client.update("key", writeBatch.map((entity) => entity.updatePayload)), job.plan)
        : validateCreated(writeBatch, await client.create(job.phase, writeBatch.map((entity) => entity.payload)), job.plan);
      for (const [key, value] of confirmed) states.set(key, value);
    }
    recordResult(job, batch, states);
    rememberLabels(job, batch, states);
    job.error = "";
    finishBatch(job, batch, states);
    await save(bucket, job, stored.etag);
    if (job.status === "completed") await release(bucket, job);
    else if(targetingPhase)await releaseTargetingIfSafe(bucket,job);
    return json(await view(job));
  } catch (error) {
    // The attempt is durable before any Google mutation. Never re-send it blindly.
    if(ownedAttempt&&!googleInvoked){
      await put(bucket,ownedAttempt.path,{...ownedAttempt.value,preDispatchAborted:true,abortedAt:Date.now()},
        {etagMatches:ownedAttempt.etag});
    }
    const latest = await read(bucket, jobKey(id));
    if(latest&&['completed','cancelled'].includes(latest.value.status))
      await releaseTargetingIfSafe(bucket,latest.value,job.targetingToken);
    if (
      latest?.value.cursor !== input.cursor ||
      latest?.value.status !== "creating"
    )
      return json(
        await view(latest.value, await currentAttempt(bucket, latest.value)),
      );
    latest.value.error =
      error instanceof GamError
        ? error.message
        : "Korak nije potvrđen. Proverite ishod u GAM-u pre nastavka.";
    await save(bucket, latest.value, latest.etag);
    return json(
      await view(latest.value, await currentAttempt(bucket, latest.value)),
    );
  }
}
