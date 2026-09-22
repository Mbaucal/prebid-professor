// Independent SOAP transport fixture. Checks v202608 sequence/type contracts,
// parses actual outgoing XML and filters PQL over in-memory synthetic entities.
import assert from "node:assert/strict";
import { XMLParser } from "../../vendor/gam-xml-parser/parser.mjs";
import { SERVICES } from "../../worker/integrations/gam-traffic-client.mjs";
import { trafficFixture } from "./traffic-fixture.mjs";
const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false,
});
const list = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const escape = (x) =>
  String(x)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const tag = (name, v) =>
  v == null
    ? ""
    : Array.isArray(v)
      ? v.map((x) => tag(name, x)).join("")
      : typeof v === "object"
        ? `<${name}>${Object.entries(v)
            .filter(([k]) => k !== "_type")
            .map(([k, x]) => tag(k, x))
            .join("")}</${name}>`
        : `<${name}>${escape(v)}</${name}>`;
const sequences = {
  advertiser: ["name", "type"],
  order: ["name", "advertiserId", "traffickerId"],
  key: ["name", "displayName", "type"],
  value: ["customTargetingKeyId", "name", "displayName", "matchType"],
  creative: [
    "advertiserId",
    "name",
    "size",
    "snippet",
    "isSafeFrameCompatible",
  ],
  association: ["lineItemId", "creativeId", "sizes"],
  lineItem: [
    "orderId",
    "name",
    "startDateTime",
    "startDateTimeType",
    "endDateTime",
    "unlimitedEndDateTime",
    "creativeRotationType",
    "deliveryRateType",
    "roadblockingType",
    "lineItemType",
    "costPerUnit",
    "costType",
    "creativePlaceholders",
    "environmentType",
    "primaryGoal",
    "targeting",
  ],
};
export function soapTrafficFixture() {
  const f = trafficFixture();
  f.db.user.push({ id: "31", name: "Inactive user", isActive: false });
  async function respond(body, path) {
    const parsed = parser.parse(body).Envelope.Body,
      [operation] = Object.keys(parsed),
      input = parsed[operation];
    const entry = Object.entries(SERVICES).find(
      ([, v]) => path.endsWith("/" + v[0]) && [v[1], v[2]].includes(operation),
    );
    assert(entry, "Unknown SOAP operation");
    const [kind, [, get, create, arrayTag]] = entry;
    let result;
    if (operation === create) {
      const payloads = list(input[arrayTag]);
      assert(payloads.length > 0);
      for (const payload of payloads) {
        assert.deepEqual(
          Object.keys(payload),
          sequences[kind].filter((k) => payload[k] !== undefined),
        );
        if (kind === "creative")
          assert(body.includes('xsi:type="ThirdPartyCreative"'));
        if (kind === "lineItem") {
          assert.equal(payload.creativeRotationType, "EVEN");
          assert.equal(payload.environmentType, "BROWSER");
          assert.deepEqual(Object.keys(payload.primaryGoal), [
            "goalType",
            "unitType",
            ...(payload.primaryGoal.units ? ["units"] : []),
          ]);
          if (payload.targeting.customTargeting) {
            assert(body.includes('xsi:type="CustomCriteriaSet"'));
            assert(body.includes('xsi:type="CustomCriteria"'));
          }
        }
      }
      result = await f.traffic.create(kind, payloads);
    } else {
      assert.equal(operation, get);
      const st = input.filterStatement,
        query = st.query;
      assert(query.startsWith("WHERE "));
      const bindings = Object.fromEntries(
        list(st.values).map((v) => [v.key, v.value.value]),
      );
      if (kind === "user")
        assert(
          !query.includes("isActive"),
          "UserService filters use status, not the User.isActive response property",
        );
      let rows = f.db[kind];
      if (kind === "user" && query.includes("status = 'ACTIVE'"))
        rows = rows.filter((r) => r.isActive === true || r.isActive === "true");
      const ids = query.match(
        /(?:^WHERE |AND )(id|lineItemId) IN \(([0-9,]+)\)/,
      );
      if (ids)
        rows = rows.filter((r) =>
          ids[2].split(",").includes(String(r[ids[1]])),
        );
      for (const match of query.matchAll(/(\w+) = :(\w+)/g))
        rows = rows.filter(
          (r) => String(r[match[1]]) === String(bindings[match[2]]),
        );
      const names = Object.entries(bindings)
        .filter(([k]) => /^name\d+$/.test(k))
        .map(([, v]) => v);
      if (names.length) rows = rows.filter((r) => names.includes(r.name));
      if (bindings.search)
        rows = rows.filter((r) =>
          r.name.includes(bindings.search.replaceAll("%", "")),
        );
      const total = rows.length,
        offset = Number(query.match(/OFFSET (\d+)/)?.[1] || 0),
        limit = Number(query.match(/LIMIT (\d+)/)?.[1] || 500);
      result = {
        totalResultSetSize: total,
        startIndex: offset,
        results: rows.slice(offset, offset + limit),
      };
    }
    return new Response(
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${operation}Response>${tag("rval", result)}</${operation}Response></soap:Body></soap:Envelope>`,
      { headers: { "content-type": "text/xml" } },
    );
  }
  return { ...f, respond };
}
