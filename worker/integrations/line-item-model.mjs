import { GamError, parseSizes } from "../../shared/gam/plan.mjs";
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
  return [
    ...(plan.mode === "prebid"
      ? [{ key: "hb_pb", values: plan.rows.map((r) => r.price) }]
      : []),
    ...plan.rules,
  ];
}
export const values = (plan) =>
  rules(plan).flatMap((r) => r.values.map((value) => ({ key: r.key, value })));
export const creativeCount = (plan) => plan.counts.creatives;
export function phaseCount(plan, kind) {
  return {
    advertiser: 1,
    order: plan.orders.length,
    key: plan.rules.length + (plan.mode === "prebid" ? 1 : 0),
    value: plan.rules.reduce(
      (n, r) => n + r.values.length,
      plan.mode === "prebid" ? plan.rows.length : 0,
    ),
    creative: creativeCount(plan),
    lineItem: plan.rows.length,
    association: plan.counts.associations,
  }[kind];
}
const verified = (state) => ["existing", "created"].includes(state);
const ref = (refs, key) => verified(refs[key]?.state) ? refs[key].id : undefined;
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
      payload = { name: r.key, displayName: r.key, type: "FREEFORM" };
    } else if (phase === "value") {
      const r = phaseValues[i];
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
        depends.push(keyRef, ...vs.map((v) => `value:${rule.key}:${v}`));
        return {
          _type: "CustomCriteria",
          keyId: ref(refs, keyRef),
          valueIds: vs.map((v) => ref(refs, `value:${rule.key}:${v}`)),
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
      ready: depends.every((k) => ref(refs, k)),
      blockedBy: depends.filter((k) =>
        refs[k] && !verified(refs[k].state) && refs[k].state !== "new",
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
export function compatible(entity, actual, plan) {
  const p = entity.payload,
    k = entity.kind;
  if (
    flag(actual.isArchived) ||
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
  if (k === "key") return ["FREEFORM", "PREDEFINED"].includes(actual.type);
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
  if (kind === "key") return "Postojeći key-value ključ nije podržanog tipa.";
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
      ? `${k}:ids`
      : k === "value"
        ? `${k}:${p.customTargetingKeyId}`
        : k === "lineItem"
          ? `${k}:${p.orderId}`
          : k === "creative"
            ? `${k}:${p.advertiserId}`
            : k;
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
      rows = await client.byIds(kind, items.map((e) => e.id || e.knownId));
    else if (kind === "association")
      rows = await client.byIds(kind, [
        ...new Set(items.map((e) => e.payload.lineItemId)),
      ]);
    else {
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
            : r.name === e.payload.name,
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
      const renamed = !e.id && e.knownId && kind !== "association" && row.name !== e.payload.name;
      const ok = matches.length === 1 && !renamed && compatible(e, row, plan);
      results.set(e.key, {
        state: ok ? "existing" : "conflict",
        id,
        name: row.name || id,
        status: row.status || "",
        message: ok
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
      ...rule.values.map((value) => `value:${rule.key}:${value}`),
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
    const state = value.state !== "unverified" && blockedBy.length
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
export function jobView(job, attempt) {
  const states = referenceStates(job),
    conflicts = [...states].filter(
    ([, r]) => r.state === "conflict",
  ), verificationIssues = [...states].filter(([, r]) => ["unverified", "blocked"].includes(r.state)),
    counts = totals(job, states),
    reviewed = PHASES.filter((phase) => phase !== "association").every((phase) =>
      counts[phase].new + counts[phase].done + counts[phase].conflict +
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
