import { GamError, parseSizes, numericId } from "../../shared/gam/plan.mjs";
import {
  list,
  flag,
  dateTime,
  creativesPerLine,
  creativeIndexFor,
  creativeNameAt,
} from "../../shared/gam/line-items.mjs";

export const PHASES = [
  "advertiser",
  "order",
  "key",
  "value",
  "creative",
  "lineItem",
  "association",
];
export const PHASE_LABELS = {
  advertiser: "Advertiser",
  order: "Orderi",
  key: "Key-value ključevi",
  value: "Key-value vrednosti",
  creative: "Kreativi",
  lineItem: "Line itemi",
  association: "Povezivanje kreativa",
};
export function rules(plan) {
  const serving = [
    ...(plan.mode === "prebid"
      ? [{ key: "hb_pb", values: plan.rows.map((r) => r.price) }]
      : []),
    ...plan.rules,
  ];
  if (!plan.reporting) return serving;
  const merged = [], byName = new Map();
  for (const rule of [...serving, ...plan.reporting.keys]) {
    const folded = rule.key.toLowerCase(), prior = byName.get(folded);
    if (!prior) {
      const names = new Set();
      const next = { ...rule, values: rule.values.filter((value) => {
        const name = value.toLowerCase();
        if (names.has(name)) return false;
        names.add(name); return true;
      }) };
      merged.push(next); byName.set(folded, next);
    } else {
      const names = new Set(prior.values.map((value) => value.toLowerCase()));
      for (const value of rule.values) if (!names.has(value.toLowerCase())) {
        prior.values.push(value); names.add(value.toLowerCase());
      }
      if (rule.reportableType) {
        prior.reportableType = rule.reportableType;
        prior.type = rule.type;
        prior.openDomain = rule.openDomain;
      }
    }
  }
  return merged;
}
export const values = (plan) =>
  rules(plan).flatMap((r) => r.values.map((value) => ({ key: r.key, value,
    ...(r.reportableType ? { reporting: true } : {}) })));
export const creativeCount = (plan) => plan.counts.creatives;
export function phaseCount(plan, kind) {
  switch (kind) {
    case "advertiser": return plan.mode === "reporting" ? 0 : 1;
    case "order": return plan.orders.length;
    case "key": return rules(plan).length;
    case "value": return values(plan).length;
    case "creative": return creativeCount(plan);
    case "lineItem": return plan.rows.length;
    case "association": return plan.counts.associations;
  }
}
const verified = (state) => ["existing", "created"].includes(state);
// A planned reportability update still has a verified key identity. Values can
// be reviewed with that ID; the key itself is not reporting-ready/Done yet.
const ref = (refs, key) => verified(refs[key]?.state) ||
  (key.startsWith("key:") && refs[key]?.state === "update" && refs[key].verifiedId)
  ? refs[key].id : undefined;
const valueReference = (plan, key, value) => {
  // Prebid's reserved price key is canonical already; resolving one price must
  // not rebuild the complete price/reporting catalog for every line item.
  if (!plan.reporting || (plan.mode === "prebid" && key === "hb_pb"))
    return `value:${key}:${value}`;
  const rule = rules(plan).find((r) => r.key.toLowerCase() === key.toLowerCase());
  const actual = rule?.values.find((v) => v.toLowerCase() === value.toLowerCase());
  return `value:${rule?.key || key}:${actual || value}`;
};
export const sameEntityName = (kind, actual, expected) =>
  ["key", "value"].includes(kind)
    ? typeof actual === "string" && typeof expected === "string" && actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;
const sizePayload = (plan) =>
  parseSizes(plan.sizes).sizes.map((s) => ({ ...s, isAspectRatio: false }));
export function entities(plan, refs, phase, offset, limit) {
  const out = [],
    end = Math.min(offset + limit, phaseCount(plan, phase)),
    phaseValues = phase === "value" ? values(plan) : null;
  for (let i = offset; i < end; i++) {
    let key,
      payload,
      id,
      reporting = false,
      depends = [];
    const advertiserId = ref(refs, "advertiser:0");
    if (phase === "advertiser") {
      key = "advertiser:0";
      id = plan.advertiser.id;
      payload = { name: plan.advertiser.name, type: "ADVERTISER" };
    } else if (phase === "order") {
      const o = plan.orders[i];
      key = o.ref;
      id = o.id;
      depends = ["advertiser:0"];
      payload = { name: o.name, advertiserId, traffickerId: o.traffickerId };
    } else if (phase === "key") {
      const r = rules(plan)[i];
      key = `key:${r.key}`;
      payload = { name: r.key, displayName: r.key, type: r.type || "FREEFORM",
        ...(r.reportableType ? { reportableType: r.reportableType } : {}) };
      reporting = r.reportableType === "ON";
    } else if (phase === "value") {
      const r = phaseValues[i];
      reporting = r.reporting === true;
      key = `value:${r.key}:${r.value}`;
      depends = [`key:${r.key}`];
      payload = {
        customTargetingKeyId: ref(refs, depends[0]),
        name: r.value,
        displayName: r.value,
        matchType: "EXACT",
      };
    } else if (phase === "creative") {
      const c = plan.creative;
      key = `creative:${i}`;
      id = c.ids?.[i];
      depends = ["advertiser:0"];
      payload =
        c.mode === "new"
          ? {
              _type: "ThirdPartyCreative",
              advertiserId,
              name: creativeNameAt(plan, i),
              size: { ...c.size, isAspectRatio: false },
              snippet: c.snippet,
              isSafeFrameCompatible: c.safeFrame,
            }
          : { advertiserId };
    } else if (phase === "lineItem") {
      const r = plan.rows[i];
      key = `lineItem:${i}`;
      depends = [r.orderRef];
      const criteria = [
        ...(plan.mode === "prebid"
          ? [{ key: "hb_pb", values: [r.price] }]
          : []),
        ...plan.rules,
      ].map((rule) => {
        const keyRef = `key:${rule.key}`,
          vs =
            rule.key === "hb_pb" && plan.mode === "prebid"
              ? [r.price]
              : rule.values;
        const rawRefs = vs.map((v) => valueReference(plan, rule.key, v));
        const valueRefs = plan.reporting ? [...new Set(rawRefs)] : rawRefs;
        depends.push(keyRef, ...valueRefs);
        return {
          _type: "CustomCriteria",
          keyId: ref(refs, keyRef),
          valueIds: valueRefs.map((key) => ref(refs, key)),
          operator: "IS",
        };
      });
      const inventory =
        plan.inventory.kind === "adUnits"
          ? {
              targetedAdUnits: plan.inventory.ids.map((adUnitId) => ({
                adUnitId,
                includeDescendants: true,
              })),
            }
          : { targetedPlacementIds: plan.inventory.ids };
      // Field order follows v202608 LineItemSummary then LineItem (SOAP sequence).
      payload = {
        orderId: ref(refs, r.orderRef),
        name: r.name,
        startDateTime: dateTime(plan.start),
        startDateTimeType: plan.start ? "USE_START_DATE_TIME" : "IMMEDIATELY",
        endDateTime: dateTime(plan.end),
        unlimitedEndDateTime: !plan.end,
        creativeRotationType: "EVEN",
        deliveryRateType: "EVENLY",
        roadblockingType: "ONE_OR_MORE",
        lineItemType: plan.type,
        costPerUnit: {
          currencyCode: plan.currency,
          microAmount: r.microAmount,
        },
        costType: plan.costType,
        creativePlaceholders: sizePayload(plan).map((size) => ({ size })),
        environmentType: "BROWSER",
        ...(plan.allowOverbook ? { allowOverbook: true } : {}),
        primaryGoal: plan.goal,
        targeting: {
          inventoryTargeting: inventory,
          ...(criteria.length
            ? {
                customTargeting: {
                  _type: "CustomCriteriaSet",
                  logicalOperator: "AND",
                  children: criteria,
                },
              }
            : {}),
        },
      };
    } else {
      const count = creativesPerLine(plan),
        lineIndex = Math.floor(i / count),
        creativeIndex = creativeIndexFor(plan, lineIndex, i % count);
      key = `association:${lineIndex}:${creativeIndex}`;
      depends = [`lineItem:${lineIndex}`, `creative:${creativeIndex}`];
      payload = {
        lineItemId: ref(refs, depends[0]),
        creativeId: ref(refs, depends[1]),
        ...(plan.creative.overrideSizes ? { sizes: sizePayload(plan) } : {}),
      };
    }
    out.push({
      key,
      kind: phase,
      index: i,
      id,
      payload,
      depends,
      ...(reporting ? { reporting: true } : {}),
      ready: depends.every((k) => ref(refs, k)),
      blockedBy: depends.filter((k) =>
        refs[k] && !verified(refs[k].state) && !["new", "update"].includes(refs[k].state),
      ),
      ...(refs[key]?.id && (verified(refs[key].state) || refs[key].verifiedId || refs[key].createdByJob)
        ? { knownId: refs[key].id }
        : {}),
    });
  }
  return out;
}
function cleaned(value) {
  if (value == null || value === "" || value === false || value === "false")
    return undefined;
  if (Array.isArray(value)) {
    const a = value.map(cleaned).filter((v) => v !== undefined);
    return a.length ? a : undefined;
  }
  if (typeof value === "object") {
    const o = Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== "_type")
        .map(([k, v]) => [k, cleaned(v)])
        .filter(([, v]) => v !== undefined),
    );
    return Object.keys(o).length ? o : undefined;
  }
  return value === true ? "true" : String(value);
}
const sorted = (value) => list(value).map(String).sort();
const sizes = (value) =>
  list(value)
    .map(
      (s) => `${Number(s.width)}x${Number(s.height)}:${flag(s.isAspectRatio)}`,
    )
    .sort();
function criteria(value) {
  if (!value) return null;
  if (value.keyId)
    return [
      "leaf",
      String(value.keyId),
      value.operator,
      sorted(value.valueIds),
    ];
  const op = value.logicalOperator,
    children = list(value.children)
      .map(criteria)
      .flatMap((c) => (c?.[0] === op ? c[1] : [c]));
  if (children.length === 1) return children[0];
  return [
    op,
    children.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ];
}
function target(value = {}) {
  const inv = value.inventoryTargeting || {},
    extra = { ...value };
  delete extra.inventoryTargeting;
  delete extra.customTargeting;
  const invExtra = { ...inv };
  delete invExtra.targetedAdUnits;
  delete invExtra.targetedPlacementIds;
  return {
    adUnits: list(inv.targetedAdUnits)
      .map((u) => `${u.adUnitId}:${flag(u.includeDescendants)}`)
      .sort(),
    placements: sorted(inv.targetedPlacementIds),
    criteria: criteria(value.customTargeting),
    extra: cleaned(extra) || null,
    invExtra: cleaned(invExtra) || null,
  };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const scalar = (a, b) => String(a ?? "") === String(b ?? "");
function sameDate(actual, expected) {
  if (!actual?.date) return false;
  // GAM can return the same instant expressed in the network's timezone.
  const date = expected.date,
    instant = new Date(
      Date.UTC(
        date.year,
        date.month - 1,
        date.day,
        expected.hour,
        expected.minute,
        expected.second || 0,
      ),
    );
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: actual.timeZoneId || "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(instant)
        .map((p) => [p.type, p.value]),
    );
    return (
      ["year", "month", "day"].every(
        (k) => Number(parts[k]) === Number(actual.date[k]),
      ) &&
      ["hour", "minute", "second"].every(
        (k) => Number(parts[k]) === Number(actual[k] || 0),
      )
    );
  } catch {
    return false;
  }
}
export const reportingReady = (value) => ["ON", "CUSTOM_DIMENSION"].includes(value);
/** Unknown explicit status cannot authorize a reporting update. */
export function reportingUpdatePayload(entity, actual) {
  if (entity.kind !== "key" || entity.payload.reportableType !== "ON" ||
      ![undefined, null, "", "OFF"].includes(actual.reportableType) ||
      !["FREEFORM", "PREDEFINED"].includes(actual.type) ||
      flag(actual.isArchived) || ![undefined, null, "", "ACTIVE"].includes(actual.status)) return null;
  return {
    id: String(actual.id), name: actual.name,
    ...(actual.displayName !== undefined && actual.displayName !== null ? { displayName: actual.displayName } : {}),
    type: actual.type, reportableType: "ON",
  };
}
export function compatible(entity, actual, plan) {
  const p = entity.payload,
    k = entity.kind;
  if (
    flag(actual.isArchived) ||
    (entity.reporting && ["key", "value"].includes(k) &&
      ![undefined, null, "", "ACTIVE"].includes(actual.status)) ||
    actual.status === "ARCHIVED" ||
    (actual.status === "INACTIVE" &&
      ["key", "value", "association"].includes(k))
  )
    return false;
  if (k === "advertiser") return actual.type === "ADVERTISER";
  if (k === "order")
    return (
      scalar(actual.advertiserId, p.advertiserId) &&
      (!p.traffickerId || scalar(actual.traffickerId, p.traffickerId)) &&
      !flag(actual.isProgrammatic) &&
      !["CANCELED", "DELETED"].includes(actual.status)
    );
  if (k === "key") return ["FREEFORM", "PREDEFINED"].includes(actual.type) &&
    (!p.reportableType || reportingReady(actual.reportableType));
  if (k === "value")
    return (
      scalar(actual.customTargetingKeyId, p.customTargetingKeyId) &&
      actual.matchType === "EXACT"
    );
  if (k === "creative") {
    if (!scalar(actual.advertiserId, p.advertiserId)) return false;
    if (entity.id)
      return (
        plan.creative.overrideSizes ||
        parseSizes(plan.sizes).sizes.every((s) =>
          same(sizes(s), sizes(actual.size)),
        )
      );
    return (
      actual.snippet === p.snippet &&
      same(sizes(actual.size), sizes(p.size)) &&
      flag(actual.isSafeFrameCompatible) === p.isSafeFrameCompatible
    );
  }
  if (k === "association")
    return (
      scalar(actual.lineItemId, p.lineItemId) &&
      scalar(actual.creativeId, p.creativeId) &&
      same(sizes(actual.sizes), sizes(p.sizes))
    );
  const aGoal = actual.primaryGoal || {},
    goal = p.primaryGoal;
  const placeholders = list(actual.creativePlaceholders);
  return (
    scalar(actual.orderId, p.orderId) &&
    actual.lineItemType === p.lineItemType &&
    actual.costType === p.costType &&
    actual.costPerUnit?.currencyCode === p.costPerUnit.currencyCode &&
    Number(actual.costPerUnit?.microAmount) === p.costPerUnit.microAmount &&
    aGoal.goalType === goal.goalType &&
    aGoal.unitType === goal.unitType &&
    Number(aGoal.units || 0) === Number(goal.units || 0) &&
    flag(actual.unlimitedEndDateTime) === p.unlimitedEndDateTime &&
    (!p.endDateTime || sameDate(actual.endDateTime, p.endDateTime)) &&
    (!p.startDateTime || sameDate(actual.startDateTime, p.startDateTime)) &&
    actual.deliveryRateType === p.deliveryRateType &&
    actual.creativeRotationType === p.creativeRotationType &&
    ["ONE_OR_MORE", "AS_MANY_AS_POSSIBLE"].includes(actual.roadblockingType) &&
    (!actual.environmentType || actual.environmentType === "BROWSER") &&
    same(
      sizes(placeholders.map((x) => x.size)),
      sizes(p.creativePlaceholders.map((x) => x.size)),
    ) &&
    !placeholders.some(
      (x) =>
        x.targetingName || list(x.companions).length || x.creativeTemplateId,
    ) &&
    !list(actual.creativeTargetings).length &&
    !list(actual.frequencyCaps).length &&
    !list(actual.secondaryGoals).length &&
    same(target(actual.targeting), target(p.targeting))
  );
}
function incompatibilityReason(entity, actual, plan) {
  const p = entity.payload, kind = entity.kind;
  if (flag(actual.isArchived) || actual.status === "ARCHIVED" ||
      (actual.status === "INACTIVE" && ["key", "value", "association"].includes(kind)))
    return "Postojeći entitet nije aktivan ili je arhiviran.";
  if (kind === "advertiser") return "Izabrana kompanija nije advertiser.";
  if (kind === "order") {
    if (!scalar(actual.advertiserId, p.advertiserId)) return "Order pripada drugom advertiser-u.";
    if (p.traffickerId && !scalar(actual.traffickerId, p.traffickerId)) return "Order ima drugog trafficker-a.";
    return "Order nije dostupan za ovaj plan (programmatic, otkazan ili obrisan).";
  }
  if (kind === "key") return !["FREEFORM", "PREDEFINED"].includes(actual.type)
    ? "Postojeći key-value ključ nije podržanog tipa."
    : "GAM nije vratio poznato podržano reporting podešavanje ključa. Ponovite proveru ili pregledajte ključ u GAM-u.";
  if (kind === "value") return "Key-value vrednost pripada drugom ključu ili nema EXACT poklapanje.";
  if (kind === "creative") {
    if (!scalar(actual.advertiserId, p.advertiserId)) return "Kreativ pripada drugom advertiser-u.";
    if (entity.id) return "Veličina izabranog kreativa ne odgovara planu.";
    if (actual.snippet !== p.snippet) return "Postojeći kreativ ima drugačiji kod.";
    if (!same(sizes(actual.size), sizes(p.size))) return "Postojeći kreativ ima drugu veličinu.";
    return "Postojeći kreativ ima drugačije SafeFrame podešavanje.";
  }
  if (kind === "association") return "Postojeća veza kreativa i line itema ima drugačije veličine ili identitet.";
  if (!scalar(actual.orderId, p.orderId)) return "Line item pripada drugom order-u.";
  if (actual.lineItemType !== p.lineItemType) return "Line item ima drugi tip isporuke.";
  if (actual.costType !== p.costType || actual.costPerUnit?.currencyCode !== p.costPerUnit.currencyCode ||
      Number(actual.costPerUnit?.microAmount) !== p.costPerUnit.microAmount)
    return "Line item ima drugačiju cenu, valutu ili način obračuna.";
  const goal = actual.primaryGoal || {};
  if (goal.goalType !== p.primaryGoal.goalType || goal.unitType !== p.primaryGoal.unitType ||
      Number(goal.units || 0) !== Number(p.primaryGoal.units || 0))
    return "Line item ima drugačiji cilj isporuke.";
  if (flag(actual.unlimitedEndDateTime) !== p.unlimitedEndDateTime ||
      (p.endDateTime && !sameDate(actual.endDateTime, p.endDateTime)) ||
      (p.startDateTime && !sameDate(actual.startDateTime, p.startDateTime)))
    return "Line item ima drugačiji početak ili završetak isporuke.";
  if (actual.deliveryRateType !== p.deliveryRateType || actual.creativeRotationType !== p.creativeRotationType ||
      !["ONE_OR_MORE", "AS_MANY_AS_POSSIBLE"].includes(actual.roadblockingType) ||
      (actual.environmentType && actual.environmentType !== "BROWSER"))
    return "Line item ima drugačiji tempo isporuke, rotaciju ili okruženje.";
  const placeholders = list(actual.creativePlaceholders);
  if (!same(sizes(placeholders.map((x) => x.size)), sizes(p.creativePlaceholders.map((x) => x.size))))
    return "Line item ima drugačije veličine kreativa.";
  if (placeholders.some((x) => x.targetingName || list(x.companions).length || x.creativeTemplateId) ||
      list(actual.creativeTargetings).length || list(actual.frequencyCaps).length || list(actual.secondaryGoals).length)
    return "Line item ima dodatna ograničenja kreativa, učestalosti ili ciljeva.";
  return "Line item ima drugačiji inventory ili custom targeting.";
}
export async function inspectEntities(client, batch, plan) {
  const results = new Map(),
    groups = new Map();
  for (const e of batch) {
    if (!e.ready) {
      results.set(e.key, e.blockedBy?.length
        ? { state: "blocked", blockedBy: e.blockedBy,
            message: "Prethodni korak nije pouzdano proveren. Ponovite proveru istog posla." }
        : { state: "new" });
      continue;
    }
    const k = e.kind,
      p = e.payload;
    const group = e.id || e.knownId
      ? `${k}:ids${k === "value" ? ":" + p.customTargetingKeyId : ""}`
      : k === "value"
        ? `${k}:${p.customTargetingKeyId}`
        : k === "lineItem"
          ? `${k}:${p.orderId}`
          : k === "creative"
            ? `${k}:${p.advertiserId}`
            : k + (e.reporting ? ":reporting" : "");
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(e);
  }
  for (const items of groups.values()) {
    const first = items[0],
      kind = first.kind,
      p = first.payload;
    let rows;
    try {
    if (first.id || first.knownId)
      rows = await client.byIds(kind, items.map((e) => e.id || e.knownId),
        kind === "value" ? { parentId: p.customTargetingKeyId } : {});
    else if (kind === "association")
      rows = await client.byIds(kind, [
        ...new Set(items.map((e) => e.payload.lineItemId)),
      ]);
    else if (first.reporting) {
      const scope = kind === "value" ? `customTargetingKeyId = ${numericId(String(p.customTargetingKeyId))}` : "";
      const result = await client.query(kind, scope, {}, { limit: 500, maxPages: 20 });
      if (!result || !Array.isArray(result.rows) || !Number.isSafeInteger(result.total) ||
          result.total < 0 || result.more !== false || result.rows.length !== result.total)
        throw new GamError("GAM reporting provera nije vratila ceo traženi opseg. Ponovite proveru.", 502);
      rows = result.rows;
    } else {
      const field =
        kind === "value"
          ? "customTargetingKeyId"
          : kind === "lineItem"
            ? "orderId"
            : kind === "creative"
              ? "advertiserId"
              : null;
      rows = await client.byNames(
        kind,
        items.map((e) => e.payload.name),
        field ? `${field} = :parent` : "",
        field ? { parent: p[field] } : {},
      );
    }
    if (!Array.isArray(rows)) throw new GamError("GAM provera nije vratila pouzdanu listu entiteta.", 502);
    if (["key", "value"].includes(kind) && rows.some((row) =>
      !row || typeof row.name !== "string" || !row.name || !/^[1-9][0-9]{0,19}$/.test(String(row.id))))
      throw new GamError("GAM provera je vratila nepotpun identitet ključa ili vrednosti. Ponovite proveru.", 502);
    if (kind === "value" && rows.some((row) => !scalar(row?.customTargetingKeyId, p.customTargetingKeyId)))
      throw new GamError("GAM je vratio vrednosti izvan traženog ključa. Ponovite proveru.", 502);
    } catch (error) {
      const message = error instanceof GamError ? error.message
        : "GAM provera nije uspela. Ponovite proveru istog posla; upis nije pokrenut.";
      for (const e of items) results.set(e.key, { state: "unverified", message });
      continue;
    }
    for (const e of items) {
      const matches = rows.filter((r) =>
        e.id || e.knownId
          ? scalar(r.id, e.id || e.knownId)
          : kind === "association"
            ? scalar(r.lineItemId, e.payload.lineItemId) &&
              scalar(r.creativeId, e.payload.creativeId)
            : sameEntityName(kind, r.name, e.payload.name),
      );
      if (matches.length === 0) {
        results.set(e.key, {
          state: e.id || e.knownId ? "conflict" : "new",
          message: e.id || e.knownId ? "Ranije potvrđeni entitet više nije dostupan. Nije ponovo kreiran." : undefined,
        });
        continue;
      }
      const row = matches[0],
        id =
          kind === "association"
            ? `${row.lineItemId}:${row.creativeId}`
            : String(row.id);
      if ((kind === "key" && (typeof row.type !== "string" || !row.type)) ||
          (kind === "value" && (typeof row.matchType !== "string" || !row.matchType))) {
        results.set(e.key, { state: "unverified", id,
          message: "GAM nije vratio potpuna podešavanja ključa ili vrednosti. Ponovite proveru." });
        continue;
      }
      const renamed = !e.id && e.knownId && kind !== "association" && !sameEntityName(kind, row.name, e.payload.name);
      const ok = matches.length === 1 && !renamed && compatible(e, row, plan);
      const updatePayload = matches.length === 1 && !renamed ? reportingUpdatePayload(e, row) : null;
      results.set(e.key, {
        state: ok ? "existing" : updatePayload ? "update" : "conflict",
        id,
        name: row.name || id,
        status: row.status || "",
        ...(kind === "key" ? { reportableType: row.reportableType || "OFF" } : {}),
        ...(updatePayload ? { updatePayload, verifiedId: true } : {}),
        message: updatePayload ? "Postojeći ključ treba uključiti u reporting; njegov ID, naziv i tip ostaju sačuvani." : ok
          ? undefined
          : matches.length !== 1 ? "Naziv nije jedinstven u izabranom GAM opsegu."
            : renamed ? "Ranije potvrđeni entitet sada ima drugi naziv."
              : incompatibilityReason(e, row, plan),
      });
    }
  }
  return results;
}
export function recordResult(job, batch, states, created = false) {
  for (const e of batch) {
    const s = states.get(e.key), prior = job.refs[e.key];
    if (!s) throw new Error("Incomplete GAM verification result");
    if (e.kind === "association") {
      job.associationCounts ||= { existing: 0, created: 0 };
      job.associationCounts[s.state] =
        (job.associationCounts[s.state] || 0) + 1;
    } else {
      const confirmedBefore = prior?.id && (verified(prior.state) || prior.verifiedId || prior.createdByJob),
        createdByJob = prior?.createdByJob || prior?.state === "created" || s.state === "created" || created,
        state = (created && verified(s.state)) ||
          (s.state === "existing" && createdByJob && prior?.id === s.id)
          ? "created" : s.state;
      job.refs[e.key] = {
        ...(e.kind === "creative" ? {
          state, ...(s.id ? { id: s.id } : {}),
          ...(s.message ? { message: s.message } : {}),
          ...(s.blockedBy ? { blockedBy: s.blockedBy } : {}),
        } : { ...s, state }),
        ...(!s.id && confirmedBefore ? { id: prior.id } : {}),
        ...(!verified(state) && confirmedBefore ? { verifiedId: true } : {}),
        ...(createdByJob && state !== "created" ? { createdByJob: true } : {}),
        ...((s.reportingUpdated || (prior?.reportingUpdated && (!s.id || s.id === prior.id)))
          ? {reportingUpdated:true} : {}),
        ...((s.reportingReconciled || (prior?.reportingReconciled && (!s.id || s.id === prior.id)))
          ? {reportingReconciled:true,reconciliationMessage:s.reconciliationMessage || prior.reconciliationMessage} : {}),
      };
    }
  }
}
export function advance(job, count) {
  job.offset += count;
  job.cursor++;
  if (job.offset >= phaseCount(job.plan, job.phase)) {
    job.phase = PHASES[PHASES.indexOf(job.phase) + 1];
    job.offset = 0;
  }
  while (job.phase && phaseCount(job.plan, job.phase) === 0)
    job.phase = PHASES[PHASES.indexOf(job.phase) + 1];
  if (job.status === "reviewing" && job.phase === "association")
    job.phase = undefined;
  if (!job.phase) {
    if (job.status === "reviewing") {
      job.status = "ready";
      job.expiresAt = Date.now() + 15 * 60 * 1000;
    } else job.status = "completed";
  }
}
function referenceDependencies(plan, key) {
  const [kind, index] = key.split(":");
  if (["order", "creative"].includes(kind)) return ["advertiser:0"];
  if (kind === "value") return [`key:${index}`];
  if (kind === "lineItem") {
    const row = plan.rows[Number(index)];
    if (!row) return [];
    return [row.orderRef,
      ...(plan.mode === "prebid" ? ["key:hb_pb", `value:hb_pb:${row.price}`] : []),
      ...plan.rules.flatMap((rule) => [
      `key:${rule.key}`,
      ...rule.values.map((value) => valueReference(plan, rule.key, value)),
    ])];
  }
  return [];
}
function referenceStates(job) {
  const result = new Map(), refs = job.verificationResults
    ? { ...job.refs, ...job.verificationResults } : job.refs;
  const resolve = (key) => {
    if (result.has(key)) return result.get(key);
    const value = refs[key];
    if (!value) return undefined;
    const blockedBy = referenceDependencies(job.plan, key).filter((dependency) => {
      const parent = resolve(dependency);
      return !parent || (["unverified", "blocked", "conflict"].includes(parent.state) &&
        !(parent.state !== "blocked" && parent.verification === "capacity" && parent.verifiedId));
    });
    const state = blockedBy.length && (value.state !== "unverified" || value.verification === "capacity")
      ? { ...value, state: "blocked", blockedBy,
          message: "Prethodni korak nije pouzdano proveren. Ponovite proveru istog posla." }
      : value;
    result.set(key, state);
    return state;
  };
  for (const key of Object.keys(refs)) resolve(key);
  return result;
}
export function totals(job, states = referenceStates(job)) {
  const counts = Object.fromEntries(
    PHASES.map((p) => [
      p,
      {
        new: 0,
        existing: 0,
        created: 0,
        conflict: 0,
        unverified: 0,
        blocked: 0,
        update: 0,
        total: phaseCount(job.plan, p),
      },
    ]),
  );
  for (const [key, v] of states) {
    const kind = key.split(":")[0];
    if (counts[kind] && Object.hasOwn(counts[kind], v.state))
      counts[kind][v.state]++;
  }
  Object.assign(counts.association, job.associationCounts || {});
  for (const count of Object.values(counts)) count.done = count.existing + count.created;
  return counts;
}
function reportingResults(job, states) {
  const indexed=new Map();
  for(const [key,value] of states)if(key.startsWith('key:')||key.startsWith('value:'))
    indexed.set(key.toLowerCase(),value);
  const result=(ref)=>{
    const value=indexed.get(ref.toLowerCase()),state=value?.state || 'pending';
    const outcome=state==='created'?'created':state==='existing'
      ? value.reportingUpdated?'updated':'existing'
      : ['new','update','unverified','blocked','conflict'].includes(state)?state:'pending';
    return {state,outcome,...(value?.id?{id:value.id}:{}),
      ...(value?.reportingReconciled?{reconciled:true}:{}),
      ...((value?.message||value?.reconciliationMessage)?{message:value.message||value.reconciliationMessage}:{})};
  };
  const results=job.plan.reporting.keys.map(spec=>({key:spec.key,...result(`key:${spec.key}`),
    values:spec.values.map(name=>({name,...result(`value:${spec.key}:${name}`)}))}));
  const summarize=items=>{
    const counts={created:0,existing:0,updated:0,new:0,update:0,unverified:0,blocked:0,conflict:0,pending:0,total:items.length};
    for(const item of items)counts[item.outcome]++;
    return counts;
  };
  return {results,outcomes:{keys:summarize(results),values:summarize(results.flatMap(key=>key.values))}};
}
export function jobView(job, attempt) {
  const states = referenceStates(job),
    conflicts = [...states].filter(
    ([, r]) => r.state === "conflict",
  ), verificationIssues = [...states].filter(([, r]) => ["unverified", "blocked"].includes(r.state)),
    counts = totals(job, states),
    reviewed = PHASES.filter((phase) => phase !== "association").every((phase) =>
      counts[phase].new + counts[phase].update + counts[phase].done + counts[phase].conflict +
      counts[phase].unverified + counts[phase].blocked === counts[phase].total,
    );
  return {
    id: job.id,
    status: job.status,
    cursor: job.cursor,
    network: job.network,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    mode: job.plan.mode,
    phase: PHASE_LABELS[job.phase] || "",
    offset: job.offset,
    phaseTotal: job.phase ? phaseCount(job.plan, job.phase) : 0,
    counts,
    pendingUpdateCount: [...states.values()].filter((value) => value.state === "update").length,
    updates: [...states].filter(([, value]) => value.state === "update").slice(0, 30).map(([ref, value]) => ({
      ref, id: value.id, name: value.name, message: value.message,
      reportableType: value.reportableType, requiredReportableType: "ON",
    })),
    ...(job.plan.reporting ? { reporting: {
      profile: job.plan.reporting.profile,
      keys: job.plan.reporting.keys.map((key) => ({ key: key.key, type: key.type, valueCount: key.values.length, openDomain: key.openDomain === true })),
      keyCount: job.plan.reporting.keys.length,
      valueCount: job.plan.reporting.keys.reduce((count, key) => count + key.values.length, 0),
      openKeys: job.plan.reporting.keys.filter((key) => key.openDomain).map((key) => key.key),
      needsUpdate: counts.key.update,
      ...reportingResults(job,states),
    } } : {}),
    error: job.error || "",
    awaitingCheck: Boolean(attempt) && job.status === "creating",
    retryAfter: attempt
      ? Math.max(0, Math.ceil((attempt.startedAt + 90000 - Date.now()) / 1000))
      : 0,
    conflicts: conflicts.slice(0, 30).map(([ref, r]) => ({ ref, ...r })),
    conflictCount: conflicts.length,
    verificationIssues: verificationIssues.slice(0, 30).map(([ref, r]) => ({ ref, ...r })),
    verificationCount: verificationIssues.length,
    unverifiedCount: verificationIssues.filter(([, r]) => r.state === "unverified").length,
    blockedCount: verificationIssues.filter(([, r]) => r.state === "blocked").length,
    canStart: job.status === "ready" && reviewed && conflicts.length === 0 && verificationIssues.length === 0 && job.expiresAt >= Date.now(),
    configuration: {
      advertiser: job.labels.advertiser || job.plan.advertiser.name,
      orders: job.plan.orders.map((o, i) => ({
        name: job.labels[o.ref] || o.name,
        id: job.refs[o.ref]?.id,
        status: job.refs[o.ref]?.status,
      })),
      inventory: job.labels.inventory,
      currency: job.plan.currency,
      sizes: job.plan.sizes,
      type: job.plan.type,
      costType: job.plan.costType,
      goal: job.plan.goal,
      start: job.plan.start,
      end: job.plan.end,
      ranges: job.plan.ranges,
      customRules: job.plan.rules,
      creativeName: job.plan.creative.name || "",
      creativeSize: job.plan.creative.size
        ? `${job.plan.creative.size.width}x${job.plan.creative.size.height}`
        : "",
      creativeSafeFrame: job.plan.creative.safeFrame === true,
      creativeSnippet:
        job.status === "ready" ? job.plan.creative.snippet || "" : "",
      creativeLayout: job.plan.creative.layout || "shared",
      creativesPerLine: creativesPerLine(job.plan),
      creativeMode: job.plan.creative.mode,
      overrideSizes: job.plan.creative.overrideSizes,
    },
    examples: job.plan.rows.slice(0, 25).map((r, i) => ({
      name: r.name,
      price: r.price,
      id: job.refs[`lineItem:${i}`]?.id,
      state: states.get(`lineItem:${i}`)?.state,
      hbPb: job.plan.mode === "prebid" ? r.price : null,
      orderName:
        job.labels[r.orderRef] ||
        job.plan.orders.find((o) => o.ref === r.orderRef)?.name,
      creativeFirst: creativesPerLine(job.plan)
        ? creativeNameAt(job.plan, creativeIndexFor(job.plan, i, 0))
        : null,
      creativeLast: creativesPerLine(job.plan)
        ? creativeNameAt(
            job.plan,
            creativeIndexFor(job.plan, i, creativesPerLine(job.plan) - 1),
          )
        : null,
    })),
    advertiserId: job.refs["advertiser:0"]?.id,
    creativeIds: Array.from(
      { length: Math.min(50, creativeCount(job.plan)) },
      (_, i) => job.refs[`creative:${i}`]?.id,
    ).filter(Boolean),
  };
}
