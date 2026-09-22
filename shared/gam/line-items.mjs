import { GamError, numericId, text, parseSizes } from "./plan.mjs";

export const MAX_LINE_ITEMS = 5000;
export const ORDER_BATCH = 400;
export const LINE_ITEM_TYPES = [
  "PRICE_PRIORITY",
  "STANDARD",
  "SPONSORSHIP",
  "BULK",
  "NETWORK",
  "HOUSE",
];
export const DEFAULT_LINE_SIZES =
  "1x1; 300x250; 300x600; 468x60; 728x90; 320x50; 320x100; 160x600; 120x600; 970x250; 336x280; 970x90; 300x100; 300x50";
// Match the owner's original script. Saved plans retain their own snippet.
export const PREBID_CREATIVE = `<script src="https://cdn.jsdelivr.net/npm/prebid-universal-creative@latest/dist/creative.js"></script>
<script>
    var ucTagData = {};
    ucTagData.adServerDomain = "";
    ucTagData.pubUrl = "%%PATTERN:url%%";
    ucTagData.targetingMap = %%PATTERN:TARGETINGMAP%%;
    ucTagData.hbPb = "%%PATTERN:hb_pb%%";

    try {
        ucTag.renderAd(document, ucTagData);
    } catch (e) {
        console.log(e);
    }
</script>`;
export const PREBID_DEFAULTS = Object.freeze({
  advertiserName: "Prebid",
  placementName: "Prebid placement",
  traffickerEmail: "marko.baucal@smn.rs",
  orderPrefix: "SMN - Programmatic HB - Prebid",
  currency: "EUR",
  from: "0.01",
  to: "20.00",
  step: "0.01",
  copies: 20,
  namePrefix: "HB",
  key: "hb_pb",
});
export function prebidDraft(networkCode = "") {
  const d = PREBID_DEFAULTS;
  return {
    networkCode,
    mode: "prebid",
    advertiser: { mode: "new", id: "", name: d.advertiserName },
    order: { mode: "new", id: "", name: d.orderPrefix, traffickerId: "" },
    inventory: { kind: "placements", ids: [] },
    currency: d.currency,
    sizes: DEFAULT_LINE_SIZES,
    ranges: [{ from: d.from, to: d.to, step: d.step }],
    namePrefix: d.namePrefix,
    name: "",
    lineItemType: "PRICE_PRIORITY",
    rate: "1.00",
    costType: "CPM",
    goal: 100000,
    start: "",
    end: "",
    customTargeting: "",
    allowOverbook: true,
    creative: {
      mode: "new",
      layout: "per-price",
      name: "Prebid Universal",
      copies: d.copies,
      size: "1x1",
      snippet: PREBID_CREATIVE,
      safeFrame: false,
      overrideSizes: true,
      ids: [],
    },
  };
}
const fail = (message) => {
  throw new GamError(message);
};
export function integer(value, label, min, max) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    fail(`${label}: dozvoljeno ${min}–${max}.`);
  return n;
}
export function money(value, label = "Cena", precision = 6) {
  const s = String(value).trim().replace(",", ".");
  if (!new RegExp(`^\\d{1,6}(?:\\.\\d{1,${precision}})?$`).test(s))
    fail(`${label}: unesite pozitivan broj, do ${precision} decimala.`);
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 1000000 + Number(frac.padEnd(6, "0"));
}
export const priceLabel = (micro) => (micro / 1000000).toFixed(2);
export function priceRows(ranges) {
  if (!Array.isArray(ranges) || !ranges.length || ranges.length > 10)
    fail("Dodajte 1–10 raspona cena.");
  const result = [],
    seen = new Set();
  let last = -1;
  for (const r of ranges) {
    const from = money(r.from, "Početna cena", 2),
      to = money(r.to, "Krajnja cena", 2),
      step = money(r.step, "Korak", 2);
    if (!step || to < from || from < last)
      fail(
        "Rasponi moraju biti poređani, bez preklapanja, uz korak veći od nule.",
      );
    if ((to - from) % step !== 0)
      fail("Krajnja cena mora biti dostižna zadatim korakom.");
    if ((to - from) / step + 1 > MAX_LINE_ITEMS + 1)
      fail(`Najviše ${MAX_LINE_ITEMS} line itema po poslu.`);
    for (let p = from; p <= to; p += step)
      if (!seen.has(p)) {
        seen.add(p);
        result.push({ price: priceLabel(p), microAmount: p });
        if (result.length > MAX_LINE_ITEMS)
          fail(`Najviše ${MAX_LINE_ITEMS} line itema po poslu.`);
      }
    last = to;
  }
  return result;
}
export const MAX_CREATIVES = 50000;
export const prebidLineName = (prefix, currency, price) =>
  `${prefix} ${currency === "EUR" ? "€" : currency + " "}${price}`;
export const prebidOrderName = (prefix, index, first, last, currency) =>
  `${prefix} #${index + 1} (${first}-${last} ${currency})`;
export const creativesPerLine = (plan) =>
  plan.creative.layout === "per-price"
    ? plan.creative.copies
    : plan.counts.creatives;
export const creativeIndexFor = (plan, lineIndex, copyIndex) =>
  plan.creative.layout === "per-price"
    ? lineIndex * plan.creative.copies + copyIndex
    : copyIndex;
export function creativeNameAt(plan, index) {
  if (plan.creative.mode !== "new")
    return "Postojeći kreativ " + plan.creative.ids[index];
  if (plan.creative.layout === "per-price")
    return `${plan.rows[Math.floor(index / plan.creative.copies)].name}, #${(index % plan.creative.copies) + 1}`;
  return `${plan.creative.name} #${index + 1}`;
}
// Used by the form before any network request and by the persisted review.
export function prebidNamingPreview(input) {
  const rows = priceRows(input.ranges),
    currency = input.currency || "EUR",
    prefix = input.namePrefix?.trim() || "HB",
    orderPrefix = input.order?.name?.trim() || "Prebid";
  const existing = input.order?.mode === "existing",
    orders = Array.from(
      { length: existing ? 1 : Math.ceil(rows.length / ORDER_BATCH) },
      (_, i) => {
        const chunk = existing
          ? rows
          : rows.slice(i * ORDER_BATCH, (i + 1) * ORDER_BATCH);
        return existing
          ? orderPrefix
          : prebidOrderName(
              orderPrefix,
              i,
              chunk[0].price,
              chunk.at(-1).price,
              currency,
            );
      },
    );
  const copies = integer(input.creative?.copies || 1, "Broj kopija", 1, 50),
    perPrice =
      input.creative?.mode === "new" && input.creative?.layout !== "shared";
  const indices = [
    ...new Set([0, 1, 2, rows.length - 1].filter((i) => i < rows.length)),
  ];
  return {
    orders,
    examples: indices.map((i) => {
      const r = rows[i],
        name = prebidLineName(prefix, currency, r.price);
      return {
        name,
        price: r.price,
        hbPb: r.price,
        order: orders[existing ? 0 : Math.floor(i / ORDER_BATCH)],
        creativeFirst: perPrice ? `${name}, #1` : "Postojeći / zajednički set",
        creativeLast: perPrice ? `${name}, #${copies}` : "",
      };
    }),
  };
}
const selection = (v, label) =>
  v?.mode === "existing"
    ? { mode: "existing", id: numericId(v.id) }
    : v?.mode === "new"
      ? { mode: "new", name: text(v.name, label, 180) }
      : fail(`Izaberite ${label}.`);
function schedule(v, label, now) {
  if (!v) return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v))
    fail(`${label}: izaberite datum i vreme.`);
  const ms = Date.parse(v + "Z");
  if (
    !Number.isFinite(ms) ||
    ms <= now ||
    new Date(ms).toISOString().slice(0, 16) !== v
  )
    fail(`${label} mora biti ispravan datum u budućnosti (UTC).`);
  return v;
}
export function customRules(source) {
  if (!source) return [];
  if (typeof source !== "string" || source.length > 6000)
    fail("Key-value targeting je predugačak.");
  const keys = new Set();
  return source
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((line) => {
      if (keys.size >= 10) fail("Najviše 10 dodatnih key-value uslova.");
      const at = line.indexOf("=");
      if (at < 1)
        fail("Targeting: jedan uslov po redu, npr. section=sport|news.");
      const key = line.slice(0, at).trim();
      if (
        !/^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(key) ||
        keys.has(key.toLowerCase())
      )
        fail("Ključevi moraju biti jedinstveni, do 20 slova/cifara/_ znakova.");
      keys.add(key.toLowerCase());
      const values = [
        ...new Set(
          line
            .slice(at + 1)
            .split("|")
            .map((x) => text(x, "Key-value vrednost", 40)),
        ),
      ];
      if (values.length > 20) fail("Najviše 20 vrednosti po dodatnom ključu.");
      return { key, values };
    });
}
export function normalizeLinePlan(input, now = Date.now()) {
  if (!input || !["single", "prebid"].includes(input.mode))
    fail("Izaberite pojedinačni line item ili Prebid.");
  const mode = input.mode,
    advertiser = selection(input.advertiser, "advertiser"),
    order = selection(input.order, "order");
  if (advertiser.mode === "new" && order.mode === "existing")
    fail("Za novi advertiser kreirajte novi order.");
  if (order.mode === "new")
    order.traffickerId = numericId(input.order.traffickerId);
  const sizes = parseSizes(input.sizes);
  if (sizes.fluid)
    fail(
      "Ovaj tok kreira display kreative sa fiksnim veličinama. Unesite dimenzije u pikselima.",
    );
  const inventory = input.inventory;
  if (
    !inventory ||
    !["adUnits", "placements"].includes(inventory.kind) ||
    !Array.isArray(inventory.ids) ||
    !inventory.ids.length ||
    inventory.ids.length > 50
  )
    fail("Izaberite 1–50 ad unita ili placement-a.");
  const target = {
    kind: inventory.kind,
    ids: [...new Set(inventory.ids.map(numericId))].sort(),
  };
  const currency = text(input.currency, "Valuta", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency))
    fail("Valuta mora imati tri slova, npr. EUR.");
  const rules = customRules(input.customTargeting);
  let rows,
    rangeRules = [],
    type,
    goal,
    costType,
    start,
    end;
  if (mode === "prebid") {
    rows = priceRows(input.ranges);
    rangeRules = input.ranges.map((r) => ({
      from: priceLabel(money(r.from)),
      to: priceLabel(money(r.to)),
      step: priceLabel(money(r.step)),
    }));
    type = "PRICE_PRIORITY";
    goal = { goalType: "NONE", unitType: "IMPRESSIONS" };
    costType = "CPM";
    start = null;
    end = null;
    if (rules.some((r) => r.key.toLowerCase() === "hb_pb"))
      fail(
        "hb_pb se automatski postavlja po ceni; uklonite dodatni hb_pb uslov.",
      );
  } else {
    type = input.lineItemType;
    if (!LINE_ITEM_TYPES.includes(type))
      fail("Izaberite podržani tip line itema.");
    costType = input.costType || "CPM";
    if (!["CPM", "CPC"].includes(costType)) fail("Izaberite CPM ili CPC.");
    const microAmount = money(input.rate);
    if (type !== "HOUSE" && !microAmount) fail("Cena mora biti veća od nule.");
    rows = [
      {
        name: text(input.name, "Naziv line itema"),
        microAmount,
        price: String(microAmount / 1000000),
      },
    ];
    const percent = ["SPONSORSHIP", "NETWORK", "HOUSE"].includes(type);
    goal = percent
      ? {
          goalType: "DAILY",
          unitType: "IMPRESSIONS",
          units: integer(input.goal, "Procenat", 1, 100),
        }
      : ["STANDARD", "BULK"].includes(type)
        ? {
            goalType: "LIFETIME",
            unitType: costType === "CPC" ? "CLICKS" : "IMPRESSIONS",
            units: integer(input.goal, "Cilj", 1, 1000000000),
          }
        : {
            goalType: "NONE",
            unitType: costType === "CPC" ? "CLICKS" : "IMPRESSIONS",
          };
    start = schedule(input.start, "Početak", now);
    end = schedule(input.end, "Završetak", now);
    if (["STANDARD", "BULK"].includes(type) && !end)
      fail("Standard i Bulk zahtevaju datum završetka.");
    if (start && end && end <= start)
      fail("Završetak mora biti posle početka.");
  }
  const namePrefix =
    mode === "prebid"
      ? text(input.namePrefix || "HB", "Prefiks line itema", 180)
      : "";
  if (mode === "prebid")
    rows = rows.map((r) => ({
      ...r,
      name: prebidLineName(namePrefix, currency, r.price),
    }));
  const c = input.creative;
  if (!c || !["new", "existing", "none"].includes(c.mode))
    fail("Izaberite način dodavanja kreativa.");
  if (mode === "prebid" && c.mode === "none")
    fail("Prebid postavka zahteva kreative.");
  let creative = { mode: c.mode, overrideSizes: c.overrideSizes !== false };
  if (c.mode === "existing") {
    if (!Array.isArray(c.ids) || !c.ids.length || c.ids.length > 50)
      fail("Izaberite 1–50 postojećih kreativa.");
    creative.ids = [...new Set(c.ids.map(numericId))];
    if (advertiser.mode !== "existing")
      fail("Postojeći kreativi zahtevaju postojećeg advertiser-a.");
  }
  if (c.mode === "new") {
    const snippet = c.snippet;
    if (
      typeof snippet !== "string" ||
      !snippet.trim() ||
      snippet.length > 60000 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(snippet)
    )
      fail(
        "Dodajte ispravan HTML/JavaScript kod kreativa (do 60.000 znakova).",
      );
    const parsed = parseSizes(c.size || "1x1");
    if (parsed.fluid || parsed.sizes.length !== 1)
      fail("Kreativ mora imati jednu početnu veličinu.");
    creative = {
      ...creative,
      layout:
        mode === "prebid" && c.layout !== "shared" ? "per-price" : "shared",
      name:
        mode === "prebid" && c.layout !== "shared"
          ? namePrefix
          : text(c.name, "Naziv seta kreativa", 180),
      copies: integer(c.copies, "Broj kopija kreativa", 1, 50),
      snippet: snippet.trim(),
      size: parsed.sizes[0],
      safeFrame: c.safeFrame === true,
    };
  }
  const count =
    creative.mode === "new"
      ? creative.copies
      : creative.mode === "existing"
        ? creative.ids.length
        : 0;
  const totalCreatives =
    creative.layout === "per-price" ? rows.length * count : count;
  if (totalCreatives > MAX_CREATIVES)
    fail(
      `Najviše ${MAX_CREATIVES.toLocaleString("sr-Latn")} kreativa po poslu. Smanjite raspon ili broj kopija po ceni.`,
    );
  if (
    !creative.overrideSizes &&
    creative.mode === "new" &&
    sizes.sizes.some(
      (s) =>
        s.width !== creative.size.width || s.height !== creative.size.height,
    )
  )
    fail(
      "Uključite size override da jedan kreativ pokrije sve izabrane veličine.",
    );
  const chunks =
    order.mode === "existing"
      ? [rows]
      : Array.from({ length: Math.ceil(rows.length / ORDER_BATCH) }, (_, i) =>
          rows.slice(i * ORDER_BATCH, (i + 1) * ORDER_BATCH),
        );
  const orders = chunks.map((chunk, i) => ({
    ...order,
    ref: `order:${i}`,
    name:
      order.mode === "new"
        ? mode === "prebid"
          ? prebidOrderName(
              order.name,
              i,
              chunk[0].price,
              chunk.at(-1).price,
              currency,
            )
          : order.name
        : undefined,
  }));
  rows = chunks.flatMap((chunk, i) =>
    chunk.map((r) => ({ ...r, orderRef: `order:${i}` })),
  );
  return {
    schemaVersion: 2,
    allowOverbook: mode === "prebid" && input.allowOverbook === true,
    mode,
    networkCode: numericId(input.networkCode),
    advertiser,
    orders,
    inventory: target,
    currency,
    sizes: sizes.label,
    creative,
    rules,
    ranges: rangeRules,
    namePrefix,
    rows,
    type,
    goal,
    costType,
    start,
    end,
    counts: {
      lineItems: rows.length,
      orders: orders.length,
      creatives: totalCreatives,
      associations: rows.length * count,
    },
  };
}
export const list = (value) =>
  value == null || value === "" ? [] : Array.isArray(value) ? value : [value];
export const flag = (value) => value === true || value === "true";
export function dateTime(value) {
  if (!value) return null;
  const [date, time] = value.split("T"),
    [year, month, day] = date.split("-").map(Number),
    [hour, minute] = time.split(":").map(Number);
  return {
    date: { year, month, day },
    hour,
    minute,
    second: 0,
    timeZoneId: "UTC",
  };
}
