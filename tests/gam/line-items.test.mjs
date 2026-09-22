import test from "node:test";
import assert from "node:assert/strict";
import { gamResponse } from "../../worker/integrations/gam-service.mjs";
import {
  normalizeLinePlan,
  priceRows,
  prebidNamingPreview,
} from "../../shared/gam/line-items.mjs";
import { trafficFixture, prebidPlan } from "./traffic-fixture.mjs";
const origin = "https://fixture.invalid",
  base = "/api/integrations/gam";
async function req(
  f,
  path,
  body,
  actor = "fixture@example.invalid",
  source = origin,
) {
  const r = await gamResponse(
    new Request(origin + base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin: source, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    f.env,
    actor,
    { clientFactory: () => f.client, trafficFactory: () => f.traffic },
  );
  const data = r.headers.get("content-type").includes("json")
    ? await r.json()
    : await r.text();
  return { status: r.status, data };
}
async function setup() {
  const f = trafficFixture();
  const r = await req(f, "/connect", {
    networkCode: "123456",
    credentials: {
      type: "service_account",
      client_email: "fixture@fixture.iam.gserviceaccount.com",
      private_key:
        "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----",
    },
  });
  assert.equal(r.status, 201);
  return f;
}
async function act(f, j, action, body = {}) {
  const r = await req(f, `/line-items/jobs/${j.id}/${action}`, {
    cursor: j.cursor,
    ...body,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
async function review(f, plan = prebidPlan()) {
  let r = await req(f, "/line-items/preview", plan);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  let j = r.data;
  for (let i = 0; j.status === "reviewing" && i < 2000; i++)
    j = await act(f, j, "review");
  assert.equal(j.status, "ready");
  return j;
}
async function start(f, j) {
  return act(f, j, "start", { confirm: true, confirmNetwork: "123456" });
}
async function finish(f, j) {
  for (let i = 0; j.status === "creating" && i < 2000; i++) {
    j = await act(f, j, "step");
    assert.equal(j.error, "");
    assert.equal(j.awaitingCheck, false);
  }
  assert.equal(j.status, "completed");
  return j;
}
test("exact price granularity, order split and validation", () => {
  const p = normalizeLinePlan({
    ...prebidPlan(),
    order: { mode: "new", name: "Prebid", traffickerId: "30" },
    ranges: [{ from: "0.01", to: "20.00", step: "0.01" }],
  });
  assert.equal(p.rows.length, 2000);
  assert.equal(p.orders.length, 5);
  assert.equal(p.rows.at(-1).microAmount, 20000000);
  assert.equal(p.counts.creatives, 2);
  assert.equal(
    priceRows([
      { from: "0", to: "1", step: "0.1" },
      { from: "1", to: "2", step: "0.5" },
    ]).length,
    13,
  );
  for (const ranges of [
    [{ from: "1", to: "0", step: "1" }],
    [{ from: "0", to: "1", step: "0" }],
    [{ from: "0", to: "1", step: ".3" }],
  ])
    assert.throws(() => priceRows(ranges));
  assert.throws(() =>
    normalizeLinePlan({ ...prebidPlan(), creative: { mode: "none" } }),
  );
  assert.throws(() =>
    normalizeLinePlan({
      ...prebidPlan(),
      advertiser: { mode: "new", name: "New" },
    }),
  );
});
test("visible naming preview matches all script orders and server prices, with bounded creative volume", () => {
  const input = {
    ...prebidPlan(),
    order: {
      mode: "new",
      name: "SMN - Programmatic HB - Prebid",
      traffickerId: "30",
    },
    ranges: [{ from: "0.01", to: "20.00", step: "0.01" }],
    creative: { ...prebidPlan().creative, layout: "per-price", copies: 20 },
  };
  const preview = prebidNamingPreview(input),
    plan = normalizeLinePlan(input);
  assert.deepEqual(preview.orders, [
    "SMN - Programmatic HB - Prebid #1 (0.01-4.00 EUR)",
    "SMN - Programmatic HB - Prebid #2 (4.01-8.00 EUR)",
    "SMN - Programmatic HB - Prebid #3 (8.01-12.00 EUR)",
    "SMN - Programmatic HB - Prebid #4 (12.01-16.00 EUR)",
    "SMN - Programmatic HB - Prebid #5 (16.01-20.00 EUR)",
  ]);
  assert.deepEqual(
    preview.orders,
    plan.orders.map((o) => o.name),
  );
  assert.equal(preview.examples.at(-1).name, plan.rows.at(-1).name);
  assert.equal(preview.examples.at(-1).hbPb, plan.rows.at(-1).price);
  assert.equal(preview.examples.at(-1).creativeLast, "HB €20.00, #20");
  assert.throws(
    () =>
      normalizeLinePlan({
        ...input,
        creative: { ...input.creative, copies: 50 },
      }),
    /50.000/,
  );
  assert.equal(
    normalizeLinePlan({ ...input, currency: "USD" }).rows[0].name,
    "HB USD 0.01",
  );
});

test("review is read only; Prebid creates values, shared creative pool, targeting, sizes and links; replay reuses", async () => {
  const f = await setup(),
    j = await review(f);
  assert.equal(f.calls.length, 0);
  assert.equal(j.counts.lineItem.total, 3);
  const done = await finish(f, await start(f, j));
  assert.equal(f.db.key.length, 1);
  assert.equal(f.db.value.length, 3);
  assert.equal(f.db.creative.length, 2);
  assert.equal(f.db.lineItem.length, 3);
  assert.equal(f.db.association.length, 6);
  assert.deepEqual(
    f.db.value.map((r) => r.name),
    ["0.01", "0.02", "0.03"],
  );
  assert.deepEqual(
    f.db.lineItem.map((r) => r.costPerUnit.microAmount),
    [10000, 20000, 30000],
  );
  assert.deepEqual(
    f.db.lineItem.map(
      (r) => r.targeting.customTargeting.children[0].valueIds[0],
    ),
    f.db.value.map((r) => r.id),
  );
  assert(f.db.association.every((r) => r.sizes.length === 2));
  assert.equal(done.counts.association.created, 6);
  const n = f.calls.length,
    again = await review(f);
  assert.equal(again.counts.lineItem.existing, 3);
  await finish(f, await start(f, again));
  assert.equal(f.calls.length, n);
  const csv = await req(f, `/line-items/jobs/${done.id}/export`);
  assert(csv.data.includes(done.examples[0].id));
});
test("new advertiser and order, ordinary Standard goal/dates, no creatives", async () => {
  const f = await setup(),
    p = {
      ...prebidPlan(),
      mode: "single",
      name: "Example campaign",
      advertiser: { mode: "new", name: "New advertiser" },
      order: { mode: "new", name: "New order", traffickerId: "30" },
      lineItemType: "STANDARD",
      rate: "1.234567",
      costType: "CPM",
      goal: 100000,
      end: "2099-01-01T12:00",
      creative: { mode: "none" },
      customTargeting: "section=sport|news",
    };
  const done = await finish(f, await start(f, await review(f, p)));
  const li = f.db.lineItem[0];
  assert.equal(li.lineItemType, "STANDARD");
  assert.equal(li.primaryGoal.units, 100000);
  assert.equal(li.costPerUnit.microAmount, 1234567);
  assert.equal(li.unlimitedEndDateTime, false);
  assert.equal(f.db.creative.length, 0);
  assert.equal(done.counts.association.total, 0);
  assert.equal(f.db.order.at(-1).advertiserId, f.db.advertiser.at(-1).id);
  assert.equal(f.db.value.length, 2);
});
test("lost response reconciles existing entities without a second mutation; missing response never blindly retries", async () => {
  const f = await setup();
  let j = await start(f, await review(f));
  while (j.phase !== "Kreativi") j = await act(f, j, "step");
  f.failNext("creative");
  j = await act(f, j, "step");
  assert(j.awaitingCheck);
  const n = f.calls.length;
  j = await act(f, j, "step");
  assert.equal(f.calls.length, n);
  j = await act(f, j, "check");
  assert(!j.awaitingCheck);
  await finish(f, j);
  assert.equal(f.db.creative.length, 2);
  const g = await setup();
  j = await start(g, await review(g));
  while (j.phase !== "Kreativi") j = await act(g, j, "step");
  g.failNext("creative", false);
  j = await act(g, j, "step");
  const m = g.calls.length;
  j = await act(g, j, "check");
  assert(j.awaitingCheck);
  assert.equal(g.calls.length, m);
  assert.equal(
    (await req(g, `/line-items/jobs/${j.id}/cancel`, {})).status,
    409,
  );
});
test("concurrent step, stale cursor and network lock permit one creation sequence", async () => {
  const f = await setup(),
    other = await review(f);
  let j = await start(f, await review(f));
  assert.equal(
    (
      await req(f, `/line-items/jobs/${other.id}/start`, {
        confirm: true,
        confirmNetwork: "123456",
      })
    ).status,
    409,
  );
  while (j.phase !== "Key-value ključevi") j = await act(f, j, "step");
  await Promise.all([
    req(f, `/line-items/jobs/${j.id}/step`, { cursor: j.cursor }),
    req(f, `/line-items/jobs/${j.id}/step`, { cursor: j.cursor }),
  ]);
  assert.equal(f.calls.filter((c) => c.kind === "key").length, 1);
  const current = (await req(f, `/line-items/jobs/${j.id}`)).data;
  await act(f, j, "step");
  assert.equal(f.calls.filter((c) => c.kind === "key").length, 1);
  await finish(f, current);
});
test("conflicts and changed parents cannot write, ownership/origin/review confirmation are enforced", async () => {
  const f = await setup(),
    j = await review(f);
  const path = `/line-items/jobs/${j.id}`;
  assert.equal(
    (await req(f, path, undefined, "other@example.invalid")).status,
    404,
  );
  assert.equal(
    (
      await req(
        f,
        path + "/start",
        { confirm: true, confirmNetwork: "123456" },
        undefined,
        "https://evil.invalid",
      )
    ).status,
    403,
  );
  assert.equal(
    (await req(f, path + "/start", { confirmNetwork: "123456" })).status,
    422,
  );
  f.db.order[0].advertiserId = "99";
  const running = await start(f, j),
    next = await act(f, await act(f, running, "step"), "step");
  assert(next.error);
  assert.equal(f.calls.length, 0);
  await act(f, next, "cancel");
  const conflict = await review(f);
  assert(conflict.conflictCount > 0);
  assert.equal(
    (
      await req(f, `/line-items/jobs/${conflict.id}/start`, {
        confirm: true,
        confirmNetwork: "123456",
      })
    ).status,
    409,
  );
});
test("changed creative and line item are rejected before attaching, existing order capacity checked", async () => {
  const f = await setup();
  let j = await start(f, await review(f));
  while (j.phase !== "Povezivanje kreativa") j = await act(f, j, "step");
  f.db.creative[0].snippet = "changed";
  j = await act(f, j, "step");
  assert(j.error.includes("Kreativ"));
  assert.equal(f.db.association.length, 0);
  const g = await setup();
  for (let i = 0; i < 449; i++)
    g.db.lineItem.push({
      id: String(i + 1000),
      name: "Unrelated " + i,
      orderId: "20",
    });
  const r = await review(g);
  assert(r.conflictCount > 0);
  assert.equal(g.calls.length, 0);
});
test("wrong currency and inactive inventory fail before preview; existing creative can be attached", async () => {
  const f = await setup();
  assert.equal(
    (await req(f, "/line-items/preview", { ...prebidPlan(), currency: "USD" }))
      .status,
    422,
  );
  f.db.adUnit[0].status = "INACTIVE";
  assert.equal((await req(f, "/line-items/preview", prebidPlan())).status, 409);
  f.db.adUnit[0].status = "ACTIVE";
  f.db.creative.push({
    id: "50",
    advertiserId: "10",
    name: "Existing",
    size: { width: 1, height: 1 },
  });
  await finish(
    f,
    await start(
      f,
      await review(f, {
        ...prebidPlan(),
        creative: { mode: "existing", ids: ["50"], overrideSizes: true },
      }),
    ),
  );
  assert.equal(f.db.creative.length, 1);
  assert.equal(f.db.association.length, 3);
});

test("full source-script range creates 2000 prices in 5 orders, 40000 CPM-named creatives and 40000 links", async () => {
  const f = await setup(),
    p = {
      ...prebidPlan(),
      order: { mode: "new", name: "Full Prebid", traffickerId: "30" },
      ranges: [{ from: "0.01", to: "20.00", step: "0.01" }],
      creative: { ...prebidPlan().creative, layout: "per-price", copies: 20 },
    };
  const done = await finish(f, await start(f, await review(f, p)));
  assert.equal(f.db.lineItem.length, 2000);
  assert.equal(f.db.creative.length, 40000);
  assert.equal(f.db.creative[0].name, "HB €0.01, #1");
  assert.equal(f.db.creative.at(-1).name, "HB €20.00, #20");
  assert.equal(f.db.order[1].name, "Full Prebid #1 (0.01-4.00 EUR)");
  assert.equal(f.db.order.at(-1).name, "Full Prebid #5 (16.01-20.00 EUR)");
  const creativeById = new Map(f.db.creative.map((c) => [c.id, c])),
    lineById = new Map(f.db.lineItem.map((l) => [l.id, l]));
  for (const link of f.db.association)
    assert(
      creativeById
        .get(link.creativeId)
        .name.startsWith(lineById.get(link.lineItemId).name + ", #"),
    );
  assert.equal(new Set(f.db.association.map((a) => a.creativeId)).size, 40000);
  assert.equal(f.db.association.length, 40000);
  assert.equal(done.counts.association.created, 40000);
  const sizes = f.db.order
    .slice(1)
    .map((o) => f.db.lineItem.filter((l) => l.orderId === o.id).length);
  assert.deepEqual(sizes, [400, 400, 400, 400, 400]);
  const history = await req(f, "/line-items/jobs?network=123456");
  assert.equal(history.data.jobs[0].id, done.id);
  assert.equal(history.data.jobs[0].status, "completed");
  const stored = await (
    await f.env.BUILDS.get(
      "api-integrations/gam/line-items/v1/jobs/" + done.id + ".json",
    )
  ).json();
  assert(
    Object.keys(stored.refs).length < 45000,
    "Link progress is compact, not one stored object per association",
  );
});

test("cancellation racing a pre-write lookup wins without a later Google mutation", async () => {
  const f = await setup();
  let j = await start(f, await review(f));
  while (j.phase !== "Key-value ključevi") j = await act(f, j, "step");
  let reached, unblock;
  const waiting = new Promise((r) => {
      reached = r;
    }),
    gate = new Promise((r) => {
      unblock = r;
    });
  const original = f.traffic.byNames;
  f.traffic.byNames = async (...args) => {
    if (args[0] === "key") {
      reached();
      await gate;
    }
    return original(...args);
  };
  const step = req(f, `/line-items/jobs/${j.id}/step`, { cursor: j.cursor });
  await waiting;
  const stopped = await act(f, j, "cancel");
  assert.equal(stopped.status, "cancelled");
  unblock();
  await step;
  assert.equal(f.calls.length, 0);
  assert.equal(
    (await req(f, `/line-items/jobs/${j.id}`)).data.status,
    "cancelled",
  );
});

test("default new Prebid plan matches script names, CPM and hb_pb, including a single order", async () => {
  const f = await setup(),
    creative = { ...prebidPlan().creative };
  delete creative.layout;
  const p = {
    ...prebidPlan(),
    creative,
    ranges: [{ from: "18.01", to: "18.03", step: "0.01" }],
    order: { mode: "new", name: "Example Prebid", traffickerId: "30" },
  };
  let j = await review(f, p);
  assert.equal(j.counts.creative.total, 6);
  assert.equal(j.examples[2].name, "HB €18.03");
  assert.equal(j.examples[2].price, "18.03");
  assert.equal(j.examples[2].hbPb, "18.03");
  assert.equal(j.examples[2].creativeFirst, "HB €18.03, #1");
  assert.equal(
    j.configuration.orders[0].name,
    "Example Prebid #1 (18.01-18.03 EUR)",
  );
  assert.equal(f.calls.length, 0);
  j = await start(f, j);
  while (j.phase !== "Kreativi") j = await act(f, j, "step");
  f.failNext("creative");
  j = await act(f, j, "step");
  assert(j.awaitingCheck);
  j = await act(f, j, "check");
  assert(!j.awaitingCheck);
  j = await finish(f, j);
  assert.equal(f.db.creative.length, 6);
  assert.equal(f.db.lineItem[2].costPerUnit.microAmount, 18030000);
  assert.equal(
    f.db.value.find(
      (v) =>
        v.id ===
        f.db.lineItem[2].targeting.customTargeting.children[0].valueIds[0],
    ).name,
    "18.03",
  );
  const csv = (await req(f, `/line-items/jobs/${j.id}/export`)).data;
  assert(csv.includes("HB €18.03, #2"));
  assert(csv.includes("hb_pb"));
  const n = f.calls.length;
  await finish(f, await start(f, await review(f, p)));
  assert.equal(f.calls.length, n);
});
test("saved v1 shared-creative job and uncertain five-creative batch retain their mapping", async () => {
  const f = await setup(),
    p = { ...prebidPlan(), creative: { ...prebidPlan().creative, copies: 6 } };
  let j = await review(f, p);
  const key = "api-integrations/gam/line-items/v1/jobs/" + j.id + ".json",
    stored = await (await f.env.BUILDS.get(key)).json();
  delete stored.plan.schemaVersion;
  delete stored.plan.creative.layout;
  stored.plan.rows.forEach((r) => {
    r.name = "HB EUR " + r.price;
  });
  await f.env.BUILDS.put(key, JSON.stringify(stored));
  j = await start(f, j);
  while (j.phase !== "Kreativi") j = await act(f, j, "step");
  f.failNext("creative");
  j = await act(f, j, "step");
  assert.equal(f.db.creative.length, 5);
  j = await act(f, j, "check");
  assert(!j.awaitingCheck);
  await finish(f, j);
  assert.equal(f.db.creative.length, 6);
  assert.equal(f.db.association.length, 18);
  assert.equal(f.db.lineItem[0].name, "HB EUR 0.01");
  assert.equal(f.db.creative[0].name, "Prebid Universal #1");
});
