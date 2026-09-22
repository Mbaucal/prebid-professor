import { fixture } from "./fixture.mjs";
import { SERVICES } from "../../worker/integrations/gam-traffic-client.mjs";
export function trafficFixture() {
  const f = fixture(),
    db = Object.fromEntries(Object.keys(SERVICES).map((k) => [k, []])),
    calls = [];
  db.advertiser.push({
    id: "10",
    name: "Example advertiser",
    type: "ADVERTISER",
  });
  db.order.push({
    id: "20",
    name: "Example order",
    advertiserId: "10",
    traffickerId: "30",
    status: "DRAFT",
  });
  db.user.push({
    id: "30",
    name: "Example trafficker",
    isActive: true,
    email: "fixture@example.invalid",
  });
  db.adUnit.push({ id: "1", name: "Root", status: "ACTIVE" });
  db.placement.push({ id: "40", name: "Example placement", status: "ACTIVE" });
  let nextId = 100,
    failKind = "",
    persistFailure = true;
  const traffic = {
    async network() {
      return { ...f.network, currency: "EUR", timeZone: "Europe/Belgrade" };
    },
    async byIds(kind, ids) {
      const wanted = new Set(ids);
      return structuredClone(
        db[kind].filter((r) =>
          wanted.has(String(r[kind === "association" ? "lineItemId" : "id"])),
        ),
      );
    },
    async byNames(kind, names, where, bindings) {
      const field = where?.split(" ")[0],
        wanted = new Set(names);
      return structuredClone(
        db[kind].filter(
          (r) =>
            wanted.has(r.name) &&
            (!field || String(r[field]) === String(bindings.parent)),
        ),
      );
    },
    async query(kind, where, bindings = {}, options = {}) {
      const rows = db[kind].filter(
        (r) =>
          (!bindings.advertiser || r.advertiserId === bindings.advertiser) &&
          (!bindings.order || r.orderId === bindings.order) &&
          (!bindings.search ||
            r.name.includes(bindings.search.replaceAll("%", ""))),
      );
      const from = options.offset || 0,
        limit = options.limit || 500;
      return {
        rows: structuredClone(rows.slice(from, from + limit)),
        total: rows.length,
        more: rows.length > from + limit,
      };
    },
    async create(kind, payloads) {
      calls.push({ kind, payloads: structuredClone(payloads) });
      const rows = payloads.map((p) => ({
        ...structuredClone(p),
        ...(kind === "association" ? {} : { id: String(nextId++) }),
        ...(kind === "order" ? { status: "DRAFT" } : {}),
      }));
      if (failKind !== kind || persistFailure) db[kind].push(...rows);
      if (failKind === kind) {
        failKind = "";
        throw Error("Synthetic lost response");
      }
      return structuredClone(rows);
    },
  };
  return {
    ...f,
    traffic,
    db,
    calls,
    failNext: (kind, persist = true) => {
      failKind = kind;
      persistFailure = persist;
    },
  };
}
export const prebidPlan = () => ({
  mode: "prebid",
  networkCode: "123456",
  advertiser: { mode: "existing", id: "10" },
  order: { mode: "existing", id: "20" },
  inventory: { kind: "adUnits", ids: ["1"] },
  currency: "EUR",
  sizes: "300x250;728x90",
  ranges: [{ from: "0.01", to: "0.03", step: "0.01" }],
  namePrefix: "HB",
  creative: {
    mode: "new",
    layout: "shared",
    name: "Prebid Universal",
    copies: 2,
    size: "1x1",
    snippet: "<script>example();</script>",
    safeFrame: false,
    overrideSizes: true,
  },
});
