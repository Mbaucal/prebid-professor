import test from "node:test";
import assert from "node:assert/strict";
import { XMLParser } from "../../vendor/gam-xml-parser/parser.mjs";
import { GamClient } from "../../worker/integrations/gam-client.mjs";
import { GamTrafficClient } from "../../worker/integrations/gam-traffic-client.mjs";
import { GamError } from "../../shared/gam/plan.mjs";
import { trafficFixture } from "./traffic-fixture.mjs";

const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false });
const response = (operation, result = "") => new Response(
  `<Envelope><Body><${operation}Response><rval>${result}</rval></${operation}Response></Body></Envelope>`,
);
const pageClient = (page) => new GamTrafficClient({ async call() { return structuredClone(page); } });

test("numeric-literal PQL preserves the exact ID and SOAP page shape", async () => {
  const orderId = "9007199254740993", calls = [];
  const client = new GamTrafficClient(new GamClient("123456", "synthetic", async (_url, init) => {
    calls.push(init.body);
    const input = parser.parse(init.body).Envelope.Body.getLineItemsByStatement.filterStatement;
    assert.equal(input.query, `WHERE orderId = ${orderId} ORDER BY id ASC LIMIT 1 OFFSET 0`);
    assert.equal(input.values, undefined);
    return response("getLineItemsByStatement", '<totalResultSetSize>3</totalResultSetSize><startIndex>0</startIndex><results><id>41</id></results>');
  }));
  const result = await client.query("lineItem", `orderId = ${orderId}`, {}, { limit: 1, onePage: true });
  assert.deepEqual(result, { rows: [{ id: "41" }], total: 3, more: true });
  assert.equal(calls.length, 1);
});

test("names remain typed bind values with quotes, XML characters and numeric-looking names preserved", async () => {
  const names = ['Order\'s <one> & "two"', "123456"], calls = [];
  const client = new GamTrafficClient(new GamClient("123456", "synthetic", async (_url, init) => {
    calls.push(init.body);
    const input = parser.parse(init.body).Envelope.Body.getOrdersByStatement.filterStatement;
    assert.equal(input.query, "WHERE name IN (:name0,:name1) ORDER BY id ASC LIMIT 500 OFFSET 0");
    assert.deepEqual(input.values.map((v) => [v.key, v.value.value]), [["name0", names[0]], ["name1", names[1]]]);
    assert.equal((init.body.match(/xsi:type="TextValue"/g) || []).length, 2);
    assert(!input.query.includes(names[0]));
    return response("getOrdersByStatement", "<totalResultSetSize>0</totalResultSetSize>");
  }));
  assert.deepEqual(await client.byNames("order", names), []);
  assert.equal(calls.length, 1);
});

test("unconditional reads omit the unsupported literal-as-property WHERE 1 = 1", async () => {
  const queries = [];
  const client = new GamTrafficClient({ async call(_service, _operation, content) {
    queries.push(parser.parse(content).filterStatement.query);
    return { totalResultSetSize: "0" };
  } });
  await client.query("order");
  await client.query("order", "1 = 1");
  assert.deepEqual(queries, ["ORDER BY id ASC LIMIT 500 OFFSET 0", "ORDER BY id ASC LIMIT 500 OFFSET 0"]);
});

test("a partial page advances by the number actually read, so existing entities are never skipped", async () => {
  const offsets = [];
  const rows = [{ id: "1" }, { id: "2" }, { id: "3" }];
  const client = new GamTrafficClient({ async call(_service, _operation, content) {
    const query = parser.parse(content).filterStatement.query;
    const offset = Number(query.match(/OFFSET (\d+)/)[1]);
    offsets.push(offset);
    return { totalResultSetSize: "3", startIndex: String(offset), results: rows.slice(offset, offset === 0 ? 1 : offset + 2) };
  } });
  assert.deepEqual(await client.query("order", "id IN (1,2,3)", {}, { limit: 2 }), { rows, total: 3, more: false });
  assert.deepEqual(offsets, [0, 1]);
});

test("invalid or incomplete lookup pages never become successful absence", async (t) => {
  const cases = [
    ["missing result", undefined], ["null result", null], ["empty result", ""],
    ["missing total", {}], ["missing total with row", { results: { id: "1" } }],
    ["invalid total", { totalResultSetSize: "invalid" }],
    ["negative total", { totalResultSetSize: -1 }],
    ["fractional total", { totalResultSetSize: 1.5 }],
    ["unsafe total", { totalResultSetSize: "9007199254740993" }],
    ["non-object row", { totalResultSetSize: 1, results: "invalid" }],
    ["row without identity", { totalResultSetSize: 1, results: { name: "Unknown" } }],
    ["inconsistent total", { totalResultSetSize: 0, results: { id: "1" } }],
    ["empty incomplete page", { totalResultSetSize: 2, results: [] }],
    ["wrong page start", { totalResultSetSize: 2, startIndex: 1, results: { id: "1" } }],
    ["null page start", { totalResultSetSize: 1, startIndex: null, results: { id: "1" } }],
    ["blank page start", { totalResultSetSize: 1, startIndex: "", results: { id: "1" } }],
    ["boolean page start", { totalResultSetSize: 1, startIndex: false, results: { id: "1" } }],
    ["unsafe numeric identity", { totalResultSetSize: 1, results: { id: 9007199254740992 } }],
  ];
  for (const [name, page] of cases) await t.test(name, async () => {
    await assert.rejects(pageClient(page).query("order", "id IN (1,2)"), (error) => error instanceof GamError && error.status === 502);
  });
});

test("valid zero results and an empty page beyond the last result are complete reads", async () => {
  assert.deepEqual(await pageClient({ totalResultSetSize: "0" }).query("order", "name = :name", { name: "Missing" }), { rows: [], total: 0, more: false });
  assert.deepEqual(await pageClient({ totalResultSetSize: "3", startIndex: "20" }).query("order", "id IN (1,2,3)", {}, { offset: 20 }), { rows: [], total: 3, more: false });
});

test("association lookup validates both entity IDs without requiring a nonexistent association id", async () => {
  const row = { lineItemId: "41", creativeId: "81" };
  assert.deepEqual(await pageClient({ totalResultSetSize: "1", results: row }).byIds("association", ["41"]), [row]);
  await assert.rejects(pageClient({ totalResultSetSize: "1", results: { lineItemId: "41" } }).byIds("association", ["41"]), GamError);
});

test("invalid local pagination options fail before making a Google request", async () => {
  let calls = 0;
  const client = new GamTrafficClient({ async call() { calls++; return { totalResultSetSize: 0 }; } });
  for (const options of [{ limit: 0 }, { limit: -1 }, { limit: 1.5 }, { offset: -1 }, { offset: 0.5 }, { maxPages: 0 }, { maxPages: Infinity }]) {
    await assert.rejects(client.query("order", "id = 1", {}, options), GamError);
  }
  assert.equal(calls, 0);
});

test("an explicit GAM PQL rejection stays unverified and is never retried as an empty query", async () => {
  let calls = 0;
  const client = new GamTrafficClient(new GamClient("123456", "synthetic", async () => {
    calls++;
    return new Response('<Envelope><Body><Fault><detail><ApiExceptionFault><errors><reason>UNPARSABLE</reason></errors></ApiExceptionFault></detail></Fault></Body></Envelope>', { status: 500 });
  }));
  await assert.rejects(client.query("lineItem", "orderId = 20", {}, { limit: 1, onePage: true }), /UNPARSABLE/);
  assert.equal(calls, 1);
});

test("synthetic query fixtures honor the validated numeric capacity filter per order", async () => {
  const f = trafficFixture();
  f.db.lineItem.push({ id: "100", orderId: "20" }, { id: "101", orderId: "21" });
  assert.deepEqual((await f.traffic.query("lineItem", "orderId = 20", {}, { limit: 1, onePage: true })), {
    rows: [{ id: "100", orderId: "20" }], total: 1, more: false,
  });
});
