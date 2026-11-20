import { PREBID_DEFAULTS } from "../../shared/gam/line-items.mjs";
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
    email: PREBID_DEFAULTS.traffickerEmail,
  });
  db.adUnit.push({ id: "1", name: "Root", status: "ACTIVE" });
  db.placement.push({
    id: "40",
    name: PREBID_DEFAULTS.placementName,
    status: "ACTIVE",
  });
  let nextId = 100,
    failKind = "",
    persistFailure = true,
    failUpdateKind = "",
    persistUpdateFailure = true;
  const traffic = {
    async network() {
      return { ...f.network, currency: "EUR", timeZone: "Europe/Belgrade" };
    },
    async byIds(kind, ids, options = {}) {
      if(kind==='value'&&!options.parentId)throw Error('Custom targeting value ID reads require a parent key');
      const wanted = new Set(ids);
      return structuredClone(
        db[kind].filter((r) =>
          wanted.has(String(r[kind === "association" ? "lineItemId" : "id"])) &&
          (kind!=='value'||String(r.customTargetingKeyId)===String(options.parentId)),
        ),
      );
    },
    async byNames(kind, names, where, bindings) {
      const field = where?.split(" ")[0],
        wanted = new Set(names);
      return structuredClone(
        db[kind].filter(
          (r) =>
            (['key','value'].includes(kind)
              ? [...wanted].some(name => name.toLowerCase() === String(r.name).toLowerCase())
              : wanted.has(r.name)) &&
            (!field || String(r[field]) === String(bindings.parent)),
        ),
      );
    },
    async query(kind, where, bindings = {}, options = {}) {
      const orderId = where?.match(/^orderId = ([1-9][0-9]*)$/)?.[1];
      const keyId = where?.match(/customTargetingKeyId = ([1-9][0-9]*)/)?.[1];
      const ids = where?.match(/(?:^|AND )(?:id|lineItemId) IN \(([0-9,]+)\)/)?.[1].split(',');
      const rows = db[kind].filter(
        (r) =>
          (!bindings.name || r.name === bindings.name) &&
          (!bindings.email || r.email === bindings.email) &&
          (!bindings.advertiser || r.advertiserId === bindings.advertiser) &&
          (!bindings.order || r.orderId === bindings.order) &&
          (!orderId || String(r.orderId) === orderId) &&
          (!keyId || String(r.customTargetingKeyId) === keyId) &&
          (!ids || ids.includes(String(r[kind==='association'?'lineItemId':'id']))) &&
          (!bindings.parent || String(r[kind === 'value' ? 'customTargetingKeyId' : 'advertiserId']) === String(bindings.parent)) &&
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
        ...(['key','value'].includes(kind) ? {status:'ACTIVE'} : {}),
        ...(kind === 'key' && !p.reportableType ? {reportableType:'OFF'} : {}),
      }));
      if (failKind !== kind || persistFailure) db[kind].push(...rows);
      if (failKind === kind) {
        failKind = "";
        throw Error("Synthetic lost response");
      }
      return structuredClone(rows);
    },
    async update(kind, payloads) {
      if(kind !== 'key')throw Error('Only reporting key metadata can be updated');
      calls.push({kind,operation:'update',payloads:structuredClone(payloads)});
      const rows=payloads.map(payload=>{
        const current=db.key.find(row=>String(row.id)===String(payload.id));
        if(!current)throw Error('Synthetic key disappeared before update');
        if(payload.name!==current.name||payload.type!==current.type||payload.displayName!==current.displayName||Object.hasOwn(payload,'status'))throw Error('Reporting update changed unrelated key fields');
        const result={...current,reportableType:payload.reportableType};
        if(failUpdateKind!==kind||persistUpdateFailure)Object.assign(current,result);
        return result;
      });
      if(failUpdateKind===kind){failUpdateKind='';throw Error('Synthetic lost update response');}
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
    failNextUpdate: (kind, persist = true) => {
      failUpdateKind=kind;
      persistUpdateFailure=persist;
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
