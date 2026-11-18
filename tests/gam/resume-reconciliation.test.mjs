import test from "node:test";
import assert from "node:assert/strict";
import { gamResponse } from "../../worker/integrations/gam-service.mjs";
import { GamError } from "../../shared/gam/plan.mjs";
import { MemoryBucket } from "./fixture.mjs";
import { trafficFixture, prebidPlan } from "./traffic-fixture.mjs";

// Public-handler tests deliberately seed externally created GAM-shaped rows.
// They do not copy entities() payloads into the response as the normal fake does.
const origin = "https://resume-qa.invalid";
const base = "/api/integrations/gam";
const jobPrefix = "api-integrations/gam/line-items/v1/jobs/";

async function request(f, path, body) {
  const response = await gamResponse(
    new Request(origin + base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    f.env,
    "resume-qa@example.invalid",
    { clientFactory: () => f.client, trafficFactory: () => f.traffic },
  );
  return { status: response.status, data: await response.json() };
}

async function setup() {
  const f = trafficFixture();
  const connected = await request(f, "/connect", {
    networkCode: "123456",
    credentials: {
      type: "service_account",
      client_email: "resume-qa@fixture.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----",
    },
  });
  assert.equal(connected.status, 201);
  return f;
}

async function action(f, job, name, extra = {}) {
  const response = await request(f, `/line-items/jobs/${job.id}/${name}`, {
    cursor: job.cursor,
    ...extra,
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}

async function preview(f, input = prebidPlan()) {
  const response = await request(f, "/line-items/preview", input);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data;
}

async function finishReview(f, job) {
  for (let step = 0; job.status === "reviewing" && !job.error && step < 1100; step++)
    job = await action(f, job, "review");
  return job;
}

async function start(f, job) {
  return action(f, job, "start", { confirm: true, confirmNetwork: "123456" });
}

async function finish(f, job) {
  for (let step = 0; job.status === "creating" && step < 1100; step++) {
    job = await action(f, job, "step");
    assert.equal(job.error, "", JSON.stringify(job));
    assert.equal(job.awaitingCheck, false);
  }
  assert.equal(job.status, "completed");
  return job;
}

function restartStorage(f) {
  const replacement = new MemoryBucket();
  replacement.data = new Map(
    [...f.env.BUILDS.data].map(([key, value]) => [key, structuredClone(value)]),
  );
  return { ...f, env: { ...f.env, BUILDS: replacement } };
}

const actualSizes = () => [
  { width: "728", height: "90", isAspectRatio: "false" },
  { width: "300", height: "250", isAspectRatio: "false" },
];

function seedExternal(f, { prices = 3, splitOrders = false } = {}) {
  f.db.order = [];
  const orderCount = splitOrders ? Math.ceil(prices / 400) : 1;
  for (let group = 0; group < orderCount; group++) {
    const first = (group * 400 + 1) / 100;
    const last = Math.min(prices, (group + 1) * 400) / 100;
    f.db.order.push({
      id: String(20 + group),
      name: splitOrders
        ? `Resume #${group + 1} (${first.toFixed(2)}-${last.toFixed(2)} EUR)`
        : "Example order",
      advertiserId: "10",
      traffickerId: "30",
      status: "APPROVED",
      isArchived: "false",
      isProgrammatic: "false",
    });
  }
  f.db.key.push({ id: "1000", name: "hb_pb", type: "FREEFORM", status: "ACTIVE" });
  f.db.creative.push(
    ...[0, 1].map((index) => ({
      id: String(2000 + index),
      advertiserId: "10",
      name: `Prebid Universal #${index + 1}`,
      size: { width: "1", height: "1", isAspectRatio: "false" },
      snippet: "<script>example();</script>",
      isSafeFrameCompatible: "false",
      isArchived: "false",
    })),
  );
  for (let index = 0; index < prices; index++) {
    const price = ((index + 1) / 100).toFixed(2);
    const valueId = String(1001 + index);
    const lineItemId = String(5000 + index);
    f.db.value.push({
      id: valueId,
      name: price,
      customTargetingKeyId: "1000",
      matchType: "EXACT",
      status: "ACTIVE",
    });
    f.db.lineItem.push({
      id: lineItemId,
      orderId: String(20 + (splitOrders ? Math.floor(index / 400) : 0)),
      name: `HB €${price}`,
      lineItemType: "PRICE_PRIORITY",
      costType: "CPM",
      costPerUnit: { currencyCode: "EUR", microAmount: String((index + 1) * 10000) },
      primaryGoal: { goalType: "NONE", unitType: "IMPRESSIONS", units: "0" },
      startDateTimeType: "USE_START_DATE_TIME",
      startDateTime: { date: { year: "2026", month: "11", day: "17" }, hour: "12", minute: "0", second: "0", timeZoneId: "Europe/Belgrade" },
      endDateTime: { date: { year: "2037", month: "12", day: "31" }, hour: "23", minute: "59", second: "0", timeZoneId: "Europe/Belgrade" },
      unlimitedEndDateTime: "true",
      deliveryRateType: "EVENLY",
      creativeRotationType: "EVEN",
      roadblockingType: "ONE_OR_MORE",
      environmentType: "BROWSER",
      creativePlaceholders: actualSizes().map((size) => ({ size, companions: [], targetingName: "" })),
      targeting: {
        inventoryTargeting: {
          targetedAdUnits: [{ adUnitId: "1", includeDescendants: "true" }],
          targetedPlacementIds: [],
          excludedAdUnits: [],
        },
        customTargeting: {
          logicalOperator: "OR",
          children: [{
            logicalOperator: "AND",
            children: [{ keyId: "1000", operator: "IS", valueIds: valueId }],
          }],
        },
        technologyTargeting: {},
      },
      frequencyCaps: [],
      secondaryGoals: [],
      creativeTargetings: [],
      status: "READY",
      isArchived: "false",
    });
    for (let creative = 0; creative < 2; creative++)
      f.db.association.push({
        lineItemId,
        creativeId: String(2000 + creative),
        sizes: actualSizes(),
        status: "ACTIVE",
      });
  }
}

test("externally completed GAM-normalized plan is recognized, survives storage restart and sends zero creates", async () => {
  let f = await setup();
  seedExternal(f);
  let job = await finishReview(f, await preview(f));
  assert.equal(job.status, "ready");
  assert.equal(job.conflictCount, 0);
  assert.equal(job.counts.lineItem.existing, 3);
  assert.equal(job.counts.creative.existing, 2);
  assert.equal(job.counts.lineItem.done, 3);
  assert.equal(job.canStart, true);
  f = restartStorage(f);
  job = (await request(f, `/line-items/jobs/${job.id}`)).data;
  const done = await finish(f, await start(f, job));
  assert.equal(done.counts.lineItem.done, 3);
  assert.equal(done.counts.association.existing, 6);
  assert.equal(f.calls.length, 0);
  const replay = await start(f, done);
  assert.equal(replay.id, done.id);
  assert.equal(replay.status, "completed");
  assert.equal(f.calls.length, 0);
});

test("partly completed external plan creates only the absent creative, line item and links, then reruns without writes", async () => {
  let f = await setup();
  seedExternal(f);
  f.db.creative = f.db.creative.filter((row) => row.id !== "2001");
  f.db.lineItem = f.db.lineItem.filter((row) => row.id !== "5002");
  f.db.association = f.db.association.filter((row) => row.creativeId !== "2001" && row.lineItemId !== "5002");
  const reviewed = await finishReview(f, await preview(f));
  assert.equal(reviewed.conflictCount, 0);
  assert.equal(reviewed.counts.lineItem.existing, 2);
  assert.equal(reviewed.counts.lineItem.new, 1);
  assert.equal(reviewed.counts.creative.existing, 1);
  f = restartStorage(f);
  const done = await finish(f, await start(f, reviewed));
  assert.deepEqual(f.calls.map((call) => [call.kind, call.payloads.length]), [
    ["creative", 1], ["lineItem", 1], ["association", 4],
  ]);
  assert.equal(done.counts.lineItem.done, 3);
  assert.equal(done.counts.creative.done, 2);
  assert.equal(f.db.lineItem.length, 3);
  assert.equal(new Set(f.db.lineItem.map((row) => row.name)).size, 3);
  assert.equal(f.db.association.length, 6);
  const before = f.calls.length;
  f = restartStorage(f);
  await finish(f, await start(f, await finishReview(f, await preview(f))));
  assert.equal(f.calls.length, before);
});

test("an unavailable order lookup is unverified, does not become 2005 conflicts and retries the same saved job", async () => {
  const f = await setup();
  seedExternal(f, { prices: 2000, splitOrders: true });
  const input = {
    ...prebidPlan(),
    order: { mode: "new", name: "Resume", traffickerId: "30" },
    ranges: [{ from: "0.01", to: "20.00", step: "0.01" }],
  };
  const byNames = f.traffic.byNames;
  let unavailable = true;
  f.traffic.byNames = async (...args) => {
    if (unavailable && args[0] === "order")
      throw new GamError("GAM je odbio zahtev: UNPARSABLE.", 502);
    return byNames(...args);
  };
  let job = await preview(f, input);
  job = await action(f, job, "review");
  const before = job.cursor;
  job = await action(f, job, "review");
  assert.equal(job.cursor, before, "failed lookup must not advance the verification cursor");
  assert.equal(job.status, "reviewing");
  assert.equal(job.conflictCount, 0);
  assert.equal(job.unverifiedCount, 5);
  assert.equal(job.counts.lineItem.conflict, 0);
  assert.equal(job.canStart, false);
  assert.match(job.verificationIssues.map((issue) => issue.message).join("\n"), /UNPARSABLE/);
  assert.equal(f.calls.length, 0);
  const denied = await request(f, `/line-items/jobs/${job.id}/start`, { confirm: true, confirmNetwork: "123456" });
  assert.equal(denied.status, 409);
  unavailable = false;
  const id = job.id;
  job = await action(f, job, "review");
  job = await finishReview(f, job);
  assert.equal(job.id, id);
  assert.equal(job.status, "ready");
  assert.equal(job.error, "");
  assert.equal(job.conflictCount, 0);
  assert.equal(job.unverifiedCount, 0);
  assert.equal(job.counts.order.existing, 5);
  assert.equal(job.counts.lineItem.existing, 2000);
  assert.equal(job.canStart, true);
  assert.equal(f.calls.length, 0);
});

test("2000 already completed line items do not require an irrelevant capacity query", async () => {
  const f = await setup();
  seedExternal(f, { prices: 2000, splitOrders: true });
  const input = {
    ...prebidPlan(),
    order: { mode: "new", name: "Resume", traffickerId: "30" },
    ranges: [{ from: "0.01", to: "20.00", step: "0.01" }],
  };
  const query = f.traffic.query;
  let capacityCalls = 0;
  f.traffic.query = async (...args) => {
    if (args[0] === "lineItem" && args[3]?.limit === 1) {
      capacityCalls++;
      throw new GamError("GAM je odbio zahtev: UNPARSABLE.", 502);
    }
    return query(...args);
  };
  const job = await finishReview(f, await preview(f, input));
  assert.equal(job.status, "ready");
  assert.equal(job.conflictCount, 0);
  assert.equal(job.unverifiedCount, 0);
  assert.equal(job.counts.lineItem.existing, 2000);
  assert.equal(job.canStart, true);
  assert.equal(capacityCalls, 0);
  assert.equal(f.calls.length, 0);
});

test("five capacity UNPARSABLE errors preserve 1995 verified line items and retry only the five missing ones", async () => {
  const f = await setup();
  seedExternal(f, { prices: 2000, splitOrders: true });
  const input = {
    ...prebidPlan(),
    order: { mode: "new", name: "Resume", traffickerId: "30" },
    ranges: [{ from: "0.01", to: "20.00", step: "0.01" }],
  };
  const missingIds = new Set([5399, 5799, 6199, 6599, 6999].map(String));
  f.db.lineItem = f.db.lineItem.filter((row) => !missingIds.has(row.id));
  f.db.association = f.db.association.filter((row) => !missingIds.has(row.lineItemId));
  const query = f.traffic.query;
  const capacityQueries = [];
  let unavailable = true;
  f.traffic.query = async (...args) => {
    if (args[0] === "lineItem" && args[3]?.limit === 1) {
      capacityQueries.push({ where: args[1], bindings: args[2], options: args[3] });
      if (unavailable) throw new GamError("GAM je odbio zahtev: UNPARSABLE.", 502);
    }
    return query(...args);
  };
  let job = await finishReview(f, await preview(f, input));
  assert.equal(job.conflictCount, 0);
  assert.equal(job.unverifiedCount, 5);
  assert.equal(job.canStart, false);
  assert.equal(job.counts.lineItem.existing, 1995);
  assert.equal(job.counts.lineItem.new, 5);
  assert.equal(job.counts.lineItem.conflict, 0);
  assert.deepEqual(capacityQueries, [20, 21, 22, 23, 24].map((id) => ({
    where: `orderId = ${id}`,
    bindings: {},
    options: { limit: 1, onePage: true },
  })), "handler capacity checks use a validated numeric literal and preserve count-only pagination");
  assert.equal(f.calls.length, 0);
  unavailable = false;
  const id = job.id;
  job = await action(f, job, "review", { retry: true });
  job = await finishReview(f, job);
  assert.equal(job.id, id);
  assert.equal(job.conflictCount, 0);
  assert.equal(job.unverifiedCount, 0);
  assert.equal(job.canStart, true);
  assert.equal(f.calls.length, 0);
});

test("real targeting, CPM, size, ownership and duplicate-name differences still block writes", async (t) => {
  const cases = [
    ["different CPM", (f) => { f.db.lineItem[0].costPerUnit.microAmount = "999999"; }, /cenu|valutu|obračuna/],
    ["multiple OR alternatives", (f) => { f.db.lineItem[0].targeting.customTargeting.children.push({ logicalOperator: "AND", children: [{ keyId: "1000", operator: "IS", valueIds: "1002" }] }); }, /inventory|targeting/],
    ["different inventory", (f) => { f.db.lineItem[0].targeting.inventoryTargeting.targetedAdUnits[0].adUnitId = "99"; }, /inventory|targeting/],
    ["different sizes", (f) => { f.db.lineItem[0].creativePlaceholders[0].size.width = "999"; }, /veličine/],
    ["changed advertiser ownership", (f) => { f.db.order[0].advertiserId = "99"; }],
    ["duplicate matching name", (f) => { f.db.lineItem.push({ ...structuredClone(f.db.lineItem[0]), id: "9999" }); }, /jedinstven/],
  ];
  for (const [name, mutate, reason] of cases)
    await t.test(name, async () => {
      const f = await setup();
      seedExternal(f);
      mutate(f);
      const job = await finishReview(f, await preview(f));
      assert(job.conflictCount > 0);
      assert.equal(job.canStart, false);
      if (reason) assert.match(job.conflicts[0].message, reason);
      const denied = await request(f, `/line-items/jobs/${job.id}/start`, { confirm: true, confirmNetwork: "123456" });
      assert.equal(denied.status, 409);
      assert.equal(f.calls.length, 0);
    });
});

test("a creating read failure before a durable attempt does not advance and safely retries the same step", async () => {
  const f = await setup();
  seedExternal(f);
  let job = await start(f, await finishReview(f, await preview(f)));
  while (job.phase !== "Key-value ključevi") job = await action(f, job, "step");
  const cursor = job.cursor;
  const byNames = f.traffic.byNames;
  const byIds = f.traffic.byIds;
  let unavailable = true;
  f.traffic.byNames = async (...args) => {
    if (unavailable && args[0] === "key")
      throw new GamError("GAM je odbio zahtev: UNPARSABLE.", 502);
    return byNames(...args);
  };
  f.traffic.byIds = async (...args) => {
    if (unavailable && args[0] === "key")
      throw new GamError("GAM je odbio zahtev: UNPARSABLE.", 502);
    return byIds(...args);
  };
  job = await action(f, job, "step");
  assert.equal(job.status, "creating");
  assert.equal(job.cursor, cursor);
  assert.equal(job.phase, "Key-value ključevi");
  assert.equal(job.awaitingCheck, false);
  assert(job.verificationCount > 0);
  assert.match(job.verificationIssues.map((issue) => issue.message).join("\n"), /UNPARSABLE/);
  assert.equal(f.calls.length, 0);
  unavailable = false;
  job = await action(f, job, "step");
  assert.equal(job.cursor, cursor + 1);
  assert.equal(job.error, "");
  assert.equal(job.verificationCount, 0);
  await finish(f, job);
  assert.equal(f.calls.length, 0);
});

test("a corrected actual conflict can be rechecked in the same ready job", async () => {
  const f = await setup();
  seedExternal(f);
  f.db.lineItem[0].costPerUnit.microAmount = "999999";
  let job = await finishReview(f, await preview(f));
  assert.equal(job.conflictCount, 1);
  const id = job.id;
  f.db.lineItem[0].costPerUnit.microAmount = "10000";
  job = await action(f, job, "review", { retry: true });
  job = await finishReview(f, job);
  assert.equal(job.id, id);
  assert.equal(job.conflictCount, 0);
  assert.equal(job.canStart, true);
  const stored = await (await f.env.BUILDS.get(jobPrefix + id + ".json")).json();
  assert.equal(stored.refs["lineItem:0"].id, "5000");
  await finish(f, await start(f, job));
  assert.equal(f.calls.length, 0);
});

test("confirmed identity survives conflicts, retry and storage restart instead of creating a replacement", async (t) => {
  for (const provenance of ["existing", "created"])
    for (const change of ["renamed", "deleted"])
      await t.test(`${provenance} entity ${change}`, async () => {
        let f = await setup();
        seedExternal(f);
        let job = await finishReview(f, await preview(f));
        const key = jobPrefix + job.id + ".json";
        if (provenance === "created") {
          // A saved older job may retain confirmed-created provenance. The
          // retry must retain that identity just as it retains existing IDs.
          const stored = await (await f.env.BUILDS.get(key)).json();
          stored.refs["lineItem:0"].state = "created";
          await f.env.BUILDS.put(key, JSON.stringify(stored));
          job = (await request(f, `/line-items/jobs/${job.id}`)).data;
        }
        const original = structuredClone(f.db.lineItem[0]);
        if (change === "renamed") f.db.lineItem[0].name = "Externally renamed item";
        else f.db.lineItem = f.db.lineItem.filter((row) => row.id !== "5000");
        for (let attempt = 0; attempt < 2; attempt++) {
          job = await action(f, job, "review", { retry: true });
          job = await finishReview(f, job);
          assert.equal(job.conflictCount, 1);
          assert.equal(job.canStart, false);
          const stored = await (await f.env.BUILDS.get(key)).json();
          assert.equal(stored.refs["lineItem:0"].id, "5000");
          assert.equal(stored.refs["lineItem:0"].verifiedId, true);
          const denied = await request(f, `/line-items/jobs/${job.id}/start`, { confirm: true, confirmNetwork: "123456" });
          assert.equal(denied.status, 409);
          assert.equal(f.calls.length, 0);
          f = restartStorage(f);
          job = (await request(f, `/line-items/jobs/${job.id}`)).data;
        }
        if (change === "renamed") f.db.lineItem.find((row) => row.id === "5000").name = original.name;
        else f.db.lineItem.unshift(original);
        job = await action(f, job, "review", { retry: true });
        job = await finishReview(f, job);
        assert.equal(job.conflictCount, 0);
        assert.equal(job.canStart, true);
        assert.equal(job.counts.lineItem[provenance], provenance === "created" ? 1 : 3);
        await finish(f, await start(f, job));
        assert.equal(f.calls.length, 0);
      });
});

test("a lost create response survives storage restart and is checked before any further mutation", async () => {
  let f = await setup();
  seedExternal(f);
  f.db.creative = f.db.creative.filter((row) => row.id !== "2001");
  f.db.association = f.db.association.filter((row) => row.creativeId !== "2001");
  let job = await start(f, await finishReview(f, await preview(f)));
  while (job.phase !== "Kreativi") job = await action(f, job, "step");
  f.failNext("creative");
  job = await action(f, job, "step");
  assert.equal(job.awaitingCheck, true);
  assert.equal(f.db.creative.length, 2);
  const creates = f.calls.length;
  const id = job.id;
  f = restartStorage(f);
  job = (await request(f, `/line-items/jobs/${id}`)).data;
  job = await action(f, job, "step");
  assert.equal(f.calls.length, creates);
  assert.equal(job.awaitingCheck, true);
  job = await action(f, job, "check");
  assert.equal(job.id, id);
  assert.equal(job.awaitingCheck, false);
  assert.equal(f.calls.length, creates, "check reads GAM without replaying create");
  await finish(f, job);
  assert.equal(f.calls.filter((call) => call.kind === "creative").length, 1);
  assert.equal(f.db.creative.length, 2);
  assert.equal(f.db.association.length, 6);
});

test("previewing the same active plan reopens its pending attempt without a duplicate job or write", async () => {
  const f = await setup();
  seedExternal(f);
  f.db.creative = f.db.creative.filter((row) => row.id !== "2001");
  f.db.association = f.db.association.filter((row) => row.creativeId !== "2001");
  const input = prebidPlan();
  let job = await start(f, await finishReview(f, await preview(f, input)));
  while (job.phase !== "Kreativi") job = await action(f, job, "step");
  f.failNext("creative");
  job = await action(f, job, "step");
  assert.equal(job.awaitingCheck, true);
  const before = new Map([...f.env.BUILDS.data].map(([key, value]) => [key, structuredClone(value)]));
  const creates = f.calls.length;
  const same = await request(f, "/line-items/preview", input);
  assert.equal(same.status, 200);
  assert.equal(same.data.resumed, true);
  assert.equal(same.data.id, job.id);
  assert.equal(same.data.cursor, job.cursor);
  assert.equal(same.data.awaitingCheck, true);
  assert.deepEqual(f.env.BUILDS.data, before, "preview reuse preserves the job, lock and durable attempt exactly");
  assert.equal(f.calls.length, creates);
  const different = await request(f, "/line-items/preview", { ...input, namePrefix: "Other campaign" });
  assert.equal(different.status, 409);
  assert.equal(different.data.activeJobId, job.id);
  assert.deepEqual(f.env.BUILDS.data, before);
  assert.equal(f.calls.length, creates);
  job = await action(f, same.data, "check");
  assert.equal(job.awaitingCheck, false);
  assert.equal(f.calls.length, creates);
  await finish(f, job);
  assert.equal(f.db.creative.length, 2);
  assert.equal(f.db.association.length, 6);
});

test("a capacity-only exception cannot conceal an unverified upstream advertiser", async () => {
  const f = await setup();
  seedExternal(f);
  f.db.lineItem = f.db.lineItem.filter((row) => row.id !== "5002");
  const query = f.traffic.query;
  f.traffic.query = async (...args) => {
    if (args[0] === "lineItem" && args[3]?.limit === 1)
      throw new GamError("Capacity is temporarily unavailable.", 502);
    return query(...args);
  };
  let job = await finishReview(f, await preview(f));
  assert.equal(job.unverifiedCount, 1);
  assert.equal(job.counts.lineItem.done, 2, "capacity-only failure preserves completed entities");
  const byIds = f.traffic.byIds;
  f.traffic.byIds = async (...args) => {
    if (args[0] === "advertiser")
      throw new GamError("Advertiser verification is temporarily unavailable.", 502);
    return byIds(...args);
  };
  job = await action(f, job, "review", { retry: true });
  assert.equal(job.status, "reviewing");
  assert.equal(job.canStart, false);
  assert.equal(job.counts.lineItem.done, 0, "capacity does not exempt unknown advertiser ownership");
  assert.equal(job.counts.lineItem.blocked, 2, "the two previously verified rows are now blocked");
  assert.equal(job.counts.lineItem.new, 0, "the old missing result is not reused before a fresh read");
  assert.equal(job.counts.lineItem.total - job.counts.lineItem.done - job.counts.lineItem.new - job.counts.lineItem.conflict, 3,
    "all three planned rows are waiting: two blocked plus one not yet re-inspected");
  assert.equal(f.calls.length, 0);
});
