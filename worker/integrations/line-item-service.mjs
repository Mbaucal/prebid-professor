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
  const lock = await read(bucket, lockKey(job.plan.networkCode));
  if (lock?.value.owner === job.id)
    await put(
      bucket,
      lockKey(job.plan.networkCode),
      { owner: null },
      { etagMatches: lock.etag },
    );
}
async function claim(bucket, job) {
  const key = lockKey(job.plan.networkCode),
    lock = await read(bucket, key);
  if (lock?.value.owner && lock.value.owner !== job.id) {
    const previous = (await read(bucket, jobKey(lock.value.owner)))?.value;
    if (!previous || !["completed", "cancelled"].includes(previous.status))
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
  return (await read(bucket, attemptKey(job.id, job.cursor)))?.value;
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
        (e.kind === "key" && e.payload.reportableType && matched[0].type !== e.payload.type))
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
      { client, connection } = await clientFor(plan.networkCode);
    const owner = (await read(bucket, lockKey(plan.networkCode)))?.value.owner;
    if (owner) {
      const active = (await read(bucket, jobKey(owner)))?.value;
      if (!active || !["completed", "cancelled"].includes(active.status)) {
        if (active?.actor === actor && active.origin === origin) {
          if (active.status === "creating" && active.connectionRevision === connection.revision &&
              sameActivePlan(active.plan, plan, previewInput))
            return json({ ...jobView(active, await currentAttempt(bucket, active)), resumed: true });
          return json({
            error: "Postojeći posao za ovu mrežu nije završen. Otvorite ga i proverite napredak pre novog plana.",
            activeJobId: active.id,
          }, 409);
        }
        fail("Drugi posao za line iteme je u toku u ovoj mreži. Nije pokrenut novi posao.");
      }
    }
    const { network, labels } = await selectionChecks(client, plan),
      now = new Date().toISOString();
    const job = {
      id: crypto.randomUUID(),
      actor,
      origin,
      connectionRevision: connection.revision,
      network,
      plan,
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
    return json(jobView(job), 201);
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
    // Keep an older active job reachable even after 100 subsequent previews.
    const owner = (await read(bucket, lockKey(network)))?.value.owner;
    if (owner) {
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
    /^\/line-items\/jobs\/([a-f0-9-]+)(?:\/(review|start|step|check|cancel|export))?$/,
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
  if (!action && request.method === "GET") return json(jobView(job, attempt));
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
  if (action === "cancel") {
    if (attempt && Date.now() < attempt.startedAt + 90000)
      fail(
        "GAM zahtev možda još traje. Sačekajte 90 sekundi od početka koraka.",
      );
    if (job.status === "completed") return json(jobView(job));
    job.status = "cancelled";
    job.error =
      "Posao je zaustavljen. Već kreirani GAM entiteti ostaju sačuvani.";
    await save(bucket, job, stored.etag);
    await release(bucket, job);
    return json(jobView(job));
  }
  if (
    ["step", "review", "check"].includes(action) &&
    input.cursor !== job.cursor
  )
    return json(jobView(job, attempt));
  const { client, connection } = await clientFor(job.plan.networkCode);
  if (connection.revision !== job.connectionRevision)
    fail(
      "GAM konekcija je promenjena. Zaustavite posao i napravite novi pregled.",
    );
  if (action === "start") {
    if (input.confirmNetwork !== job.plan.networkCode || input.confirm !== true)
      fail("Potvrdite prikazanu mrežu i plan.", 422);
    if (job.status === "creating" || job.status === "completed")
      return json(jobView(job, attempt));
    if (job.status !== "ready" || job.expiresAt < Date.now())
      fail("Pregled nije spreman ili je istekao. Napravite novi pregled.");
    if (!jobView(job).canStart)
      fail("Proverite nepotvrđene stavke i stvarne konflikte pre kreiranja.");
    await selectionChecks(client, job.plan);
    await claim(bucket, job);
    job.status = "creating";
    job.phase = firstPhase(job.plan);
    job.offset = 0;
    job.cursor++;
    job.error = "";
    try {
      await save(bucket, job, stored.etag);
    } catch (error) {
      /* Keep the claim for the winner of a concurrent start. */ throw error;
    }
    return json(jobView(job));
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
    if (job.status !== "reviewing") return json(jobView(job));
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
      return json(jobView(job));
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
    return json(jobView(job));
  }
  if (!["step", "check"].includes(action))
    return json({ error: "Operacija nije pronađena." }, 404);
  if (job.status !== "creating") return json(jobView(job, attempt));
  const lock = await read(bucket, lockKey(job.plan.networkCode));
  if (lock?.value.owner !== job.id)
    fail("Posao nema aktivnu rezervaciju za ovu mrežu.");
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
    if (!attempt) return json(jobView(job));
    if (!await parentsVerified()) return json(jobView(job, attempt));
    const states = await inspectEntities(client, batch, job.plan);
    if ([...states.values()].some((r) => ["unverified", "blocked"].includes(r.state))) {
      job.verificationResults = Object.fromEntries(states);
      job.error = "Provera GAM-a nije završena. Nepotvrđeni upis nije ponovljen; ponovite proveru istog posla.";
      await save(bucket, job, stored.etag);
      return json(jobView(job, attempt));
    }
    if (!await existingVerified(states)) return json(jobView(job, attempt));
    if (!Array.isArray(attempt.keys) || !attempt.keys.length ||
        attempt.keys.some((key) => typeof key !== "string") || new Set(attempt.keys).size !== attempt.keys.length)
      fail("Sačuvani pokušaj nema pouzdan spisak entiteta. Upis nije ponovljen.");
    const attempted = new Set(attempt.keys);
    const attemptedBatch = batch.filter((entity) => attempted.has(entity.key));
    if (attemptedBatch.length !== attempted.size)
      fail("Sačuvani pokušaj se ne poklapa sa ovim korakom. Upis nije ponovljen.");
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
      await save(bucket, job, stored.etag);
      if (job.status === "completed") await release(bucket, job);
      return json(jobView(job));
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
      await save(bucket, job, stored.etag);
      return json(jobView(job));
    }
    if (job.phase !== "association")
      recordResult(job, batch.filter((e) => states.get(e.key)?.state === "existing"), states);
    job.verificationResults = Object.fromEntries([...states].map(([key, value]) => [key,
      attempted.has(key) && pendingWrite(value.state) ? { ...value, state: "unverified", message: "GAM još nije potvrdio ishod ranijeg upisa. Upis nije ponovljen." } : value,
    ]));
    await save(bucket, job, stored.etag);
    return json({
      ...jobView(job, attempt),
      error:
        "GAM još nije potvrdio sve entitete iz ovog koraka. Nema automatskog ponavljanja upisa. Proverite ponovo ili zaustavite posao, pa napravite nov pregled postojećeg stanja.",
    });
  }
  if (attempt) return json(jobView(job, attempt));
  try {
    if (!await parentsVerified()) return json(jobView(job));
    const states = await inspectEntities(client, batch, job.plan);
    if ([...states.values()].some((r) => ["unverified", "blocked"].includes(r.state))) {
      job.verificationResults = Object.fromEntries(states);
      job.error = "Provera GAM-a nije završena. Nije pokrenut upis; ponovite proveru istog posla.";
      await save(bucket, job, stored.etag);
      return json(jobView(job));
    }
    if (!await existingVerified(states)) return json(jobView(job));
    delete job.verificationResults;
    const missing = batch.filter((e) => states.get(e.key).state === "new"),
      updates = batch.filter((e) => states.get(e.key).state === "update");
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
      if (
        !(await put(
          bucket,
          attemptKey(job.id, job.cursor),
          { startedAt: Date.now(), keys: writeBatch.map((e) => e.key), operation },
          { etagDoesNotMatch: "*" },
        ))
      )
        return json(jobView(job, await currentAttempt(bucket, job)));
      // Reserve the job ETag as well: cancellation that started before the
      // attempt record must lose its CAS, or this reservation loses and no
      // Google write occurs. This closes the cancel/read/create race.
      stored.etag = await save(bucket, job, stored.etag);
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
    return json(jobView(job));
  } catch (error) {
    // The attempt is durable before any Google mutation. Never re-send it blindly.
    const latest = await read(bucket, jobKey(id));
    if (
      latest?.value.cursor !== input.cursor ||
      latest?.value.status !== "creating"
    )
      return json(
        jobView(latest.value, await currentAttempt(bucket, latest.value)),
      );
    latest.value.error =
      error instanceof GamError
        ? error.message
        : "Korak nije potvrđen. Proverite ishod u GAM-u pre nastavka.";
    await save(bucket, latest.value, latest.etag);
    return json(
      jobView(latest.value, await currentAttempt(bucket, latest.value)),
    );
  }
}
