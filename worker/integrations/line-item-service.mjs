import { GamError, numericId } from "../../shared/gam/plan.mjs";
import { normalizeLinePlan, flag } from "../../shared/gam/line-items.mjs";
import { GamTrafficClient } from "./gam-traffic-client.mjs";
import {
  entities,
  inspectEntities,
  recordResult,
  advance,
  jobView,
  compatible,
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
  name: j.plan.orders[0].name || j.labels["order:0"],
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
function limitFor(phase, review) {
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
async function capacity(client, orderId, pending) {
  const result = await client.query(
    "lineItem",
    "orderId = :order",
    { order: orderId },
    { limit: 1, onePage: true },
  );
  if (result.total + pending > 450)
    fail(
      "Order bi prešao 450 line itema. Izaberite novi order; Prebid će ga automatski podeliti na grupe od 400.",
    );
}
function rememberLabels(job, batch, states) {
  for (const e of batch) {
    const r = states.get(e.key);
    if (r.name)
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
    if (found.state === "conflict")
      fail(`${e.payload.name || e.key}: ${found.message}`);
    if (prior?.id && (found.id !== prior.id || found.state === "new"))
      fail(
        "Entitet iz pregleda je promenjen ili uklonjen. Zaustavite posao i napravite novi pregled.",
      );
    if (!e.ready)
      fail("Prethodni korak nije potvrđen. Proverite sačuvani napredak.");
  }
}
async function verifyParents(client, job, batch) {
  const plan = job.plan,
    first = batch[0];
  if (!first) return;
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
  if (rows.length !== batch.length)
    fail("GAM nije potvrdio ceo paket. Proverite ishod pre nastavka.", 502);
  const states = new Map(),
    ids = new Set();
  for (const e of batch) {
    const matched = rows.filter((r) =>
      e.kind === "association"
        ? String(r.lineItemId) === e.payload.lineItemId &&
          String(r.creativeId) === e.payload.creativeId
        : r.name === e.payload.name,
    );
    if (matched.length !== 1 || !compatible(e, matched[0], plan))
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
    if (kind === "user") clauses.push("isActive = true");
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
    const plan = normalizeLinePlan(await body(request)),
      { client, connection } = await clientFor(plan.networkCode);
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
      phase: "advertiser",
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
      ],
      ...job.plan.rows.map((r, i) => [
        job.plan.networkCode,
        job.refs[r.orderRef]?.id,
        r.name,
        job.refs[`lineItem:${i}`]?.id,
        r.price,
        job.plan.currency,
        job.refs[`lineItem:${i}`]?.state,
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
    if (Object.values(job.refs).some((r) => r.state === "conflict"))
      fail("Ispravite konflikte pre kreiranja.");
    await selectionChecks(client, job.plan);
    await claim(bucket, job);
    job.status = "creating";
    job.phase = "advertiser";
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
    if (job.status !== "reviewing") return json(jobView(job));
    const batch = entities(
        job.plan,
        job.refs,
        job.phase,
        job.offset,
        limitFor(job.phase, true),
      ),
      states = await inspectEntities(client, batch, job.plan);
    recordResult(job, batch, states);
    rememberLabels(job, batch, states);
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
            job.refs[order.ref] = {
              ...job.refs[order.ref],
              state: "conflict",
              message: e.message,
            };
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
    limitFor(job.phase, false),
  );
  if (action === "check") {
    if (!attempt) return json(jobView(job));
    await verifyParents(client, job, batch);
    const states = await inspectEntities(client, batch, job.plan);
    checkExisting(job, batch, states);
    if (batch.every((e) => states.get(e.key)?.state === "existing")) {
      recordResult(job, batch, states);
      rememberLabels(job, batch, states);
      job.error = "";
      advance(job, batch.length);
      await save(bucket, job, stored.etag);
      if (job.status === "completed") await release(bucket, job);
      return json(jobView(job));
    }
    return json({
      ...jobView(job, attempt),
      error:
        "GAM još nije potvrdio sve entitete iz ovog koraka. Nema automatskog ponavljanja upisa. Proverite ponovo ili zaustavite posao, pa napravite nov pregled postojećeg stanja.",
    });
  }
  if (attempt) return json(jobView(job, attempt));
  try {
    await verifyParents(client, job, batch);
    const states = await inspectEntities(client, batch, job.plan);
    checkExisting(job, batch, states);
    const missing = batch.filter((e) => states.get(e.key).state === "new");
    if (job.phase === "lineItem")
      for (const orderId of [...new Set(missing.map((e) => e.payload.orderId))])
        await capacity(
          client,
          orderId,
          missing.filter((e) => e.payload.orderId === orderId).length,
        );
    if (missing.length) {
      if (
        !(await put(
          bucket,
          attemptKey(job.id, job.cursor),
          { startedAt: Date.now(), keys: missing.map((e) => e.key) },
          { etagDoesNotMatch: "*" },
        ))
      )
        return json(jobView(job, await currentAttempt(bucket, job)));
      // Reserve the job ETag as well: cancellation that started before the
      // attempt record must lose its CAS, or this reservation loses and no
      // Google write occurs. This closes the cancel/read/create race.
      stored.etag = await save(bucket, job, stored.etag);
      const created = validateCreated(
        missing,
        await client.create(
          job.phase,
          missing.map((e) => e.payload),
        ),
        job.plan,
      );
      for (const [key, value] of created) states.set(key, value);
    }
    recordResult(job, batch, states);
    rememberLabels(job, batch, states);
    job.error = "";
    advance(job, batch.length);
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
