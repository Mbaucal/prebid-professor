import { xml } from "./gam-client.mjs";
import { GamError, numericId } from "../../shared/gam/plan.mjs";
import { list } from "../../shared/gam/line-items.mjs";

export const SERVICES = {
  advertiser: [
    "CompanyService",
    "getCompaniesByStatement",
    "createCompanies",
    "companies",
  ],
  order: ["OrderService", "getOrdersByStatement", "createOrders", "orders"],
  key: [
    "CustomTargetingService",
    "getCustomTargetingKeysByStatement",
    "createCustomTargetingKeys",
    "keys",
  ],
  value: [
    "CustomTargetingService",
    "getCustomTargetingValuesByStatement",
    "createCustomTargetingValues",
    "values",
  ],
  creative: [
    "CreativeService",
    "getCreativesByStatement",
    "createCreatives",
    "creatives",
  ],
  lineItem: [
    "LineItemService",
    "getLineItemsByStatement",
    "createLineItems",
    "lineItems",
  ],
  association: [
    "LineItemCreativeAssociationService",
    "getLineItemCreativeAssociationsByStatement",
    "createLineItemCreativeAssociations",
    "lineItemCreativeAssociations",
  ],
  user: ["UserService", "getUsersByStatement"],
  placement: ["PlacementService", "getPlacementsByStatement"],
  adUnit: ["InventoryService", "getAdUnitsByStatement"],
};
export function element(tag, value) {
  if (value === undefined || value === null) return "";
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(tag))
    throw new Error("Unsupported SOAP element");
  if (Array.isArray(value)) return value.map((v) => element(tag, v)).join("");
  if (typeof value !== "object") return `<${tag}>${xml(value)}</${tag}>`;
  const type = value._type;
  if (
    type &&
    ![
      "CustomCriteriaSet",
      "CustomCriteria",
      "ThirdPartyCreative",
      "TextValue",
      "NumberValue",
    ].includes(type)
  )
    throw new Error("Unsupported SOAP type");
  const attrs = type
    ? ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="${type}"`
    : "";
  return `<${tag}${attrs}>${Object.entries(value)
    .filter(([k]) => k !== "_type")
    .map(([k, v]) => element(k, v))
    .join("")}</${tag}>`;
}
export function statement(query, bindings = {}) {
  return element("filterStatement", {
    query,
    values: Object.entries(bindings).map(([key, value]) => ({
      key,
      value: {
        _type: typeof value === "number" ? "NumberValue" : "TextValue",
        value,
      },
    })),
  });
}
const pageInteger = (value) =>
  typeof value === "number"
    ? value
    : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
      ? Number(value)
      : NaN;
const validRowId = (value) =>
  (typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value))) &&
  /^[1-9][0-9]{0,19}$/.test(String(value));
export class GamTrafficClient {
  constructor(client) {
    this.client = client;
  }
  async network() {
    const n = await this.client.call("NetworkService", "getCurrentNetwork");
    if (String(n?.networkCode) !== this.client.networkCode)
      throw new GamError("Izabrana GAM mreža se ne poklapa.", 409);
    return {
      networkCode: String(n.networkCode),
      name: String(n.displayName),
      currency: String(n.currencyCode),
      timeZone: String(n.timeZone),
    };
  }
  async query(kind, where = "", bindings = {}, options = {}) {
    const [service, operation] = SERVICES[kind] || [];
    if (!service) throw new Error("Unknown entity");
    const result = [],
      limit = options.limit ?? 500,
      start = options.offset ?? 0,
      maxPages = options.maxPages ?? 20;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(maxPages) ||
      maxPages < 1
    )
      throw new GamError("Neispravna stranica GAM provere.", 422);
    // PQL predicates have a property on the left. An omitted WHERE is the
    // documented match-all form, rather than the SQL tautology `1 = 1`.
    const filter = where.trim() === "1 = 1" ? "" : where.trim();
    const seen = new Set();
    let offset = start,
      expectedTotal;
    for (let page = 0; page < maxPages; page++) {
      const value = await this.client.call(
        service,
        operation,
        statement(
          `${filter ? `WHERE ${filter} ` : ""}${kind === "association" ? "" : "ORDER BY id ASC "}LIMIT ${limit} OFFSET ${offset}`,
          bindings,
        ),
      );
      // A failed or malformed read is unknown, never proof that an entity is
      // absent. Treating a missing count as zero could authorize a duplicate.
      const total = pageInteger(value?.totalResultSetSize),
        rows = list(value?.results);
      if (
        !Number.isSafeInteger(total) ||
        total < 0 ||
        (expectedTotal !== undefined && total !== expectedTotal) ||
        rows.length > limit ||
        rows.some(
          (row) =>
            !row ||
            typeof row !== "object" ||
            Array.isArray(row) ||
            (kind === "association"
              ? !validRowId(row.lineItemId) || !validRowId(row.creativeId)
              : !validRowId(row.id)),
        ) ||
        (rows.length && offset + rows.length > total) ||
        (rows.length &&
          value.startIndex !== undefined &&
          pageInteger(value.startIndex) !== offset) ||
        (!rows.length && offset < total)
      )
        throw new GamError(
          "GAM nije vratio pouzdan kompletan rezultat provere. Ponovite proveru pre nastavka.",
          502,
        );
      expectedTotal = total;
      for (const row of rows) {
        const identity = kind === "association"
          ? `${row.lineItemId}:${row.creativeId}`
          : String(row.id);
        if (seen.has(identity))
          throw new GamError(
            "GAM provera je vratila ponovljene rezultate. Ponovite proveru pre nastavka.",
            502,
          );
        seen.add(identity);
      }
      result.push(...rows);
      if (offset + rows.length >= total)
        return { rows: result, total, more: false };
      if (options.onePage) return { rows: result, total, more: true };
      // Some services can return fewer rows than requested. Advancing by the
      // requested limit would skip uninspected entities on the next page.
      offset += rows.length;
    }
    throw new GamError(
      "GAM rezultat je prevelik. Suzite pretragu ili order.",
      422,
    );
  }
  async create(kind, payloads) {
    const [service, , operation, tag] = SERVICES[kind] || [];
    if (!operation) throw new Error("Read-only entity");
    return list(
      await this.client.call(
        service,
        operation,
        payloads.map((p) => element(tag, p)).join(""),
        { entityCount: payloads.length },
      ),
    );
  }
  async byIds(kind, ids) {
    if (!ids.length) return [];
    const field = kind === "association" ? "lineItemId" : "id";
    return (
      await this.query(kind, `${field} IN (${ids.map(numericId).join(",")})`)
    ).rows;
  }
  async byNames(kind, names, where = "", bindings = {}) {
    if (!names.length) return [];
    const b = { ...bindings };
    const terms = names.map((name, i) => {
      b["name" + i] = name;
      return ":name" + i;
    });
    return (
      await this.query(
        kind,
        `${where ? where + " AND " : ""}name IN (${terms.join(",")})`,
        b,
      )
    ).rows;
  }
}
