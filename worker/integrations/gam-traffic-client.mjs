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
  async query(kind, where = "1 = 1", bindings = {}, options = {}) {
    const [service, operation] = SERVICES[kind] || [];
    if (!service) throw new Error("Unknown entity");
    const result = [],
      limit = options.limit || 500,
      start = options.offset || 0,
      maxPages = options.maxPages || 20;
    for (let page = 0; page < maxPages; page++) {
      const offset = start + page * limit;
      const value = await this.client.call(
        service,
        operation,
        statement(
          `WHERE ${where}${kind === "association" ? "" : " ORDER BY id ASC"} LIMIT ${limit} OFFSET ${offset}`,
          bindings,
        ),
      );
      const rows = list(value?.results);
      result.push(...rows);
      const total = Number(value?.totalResultSetSize || 0);
      if (offset + rows.length >= total)
        return { rows: result, total, more: false };
      if (options.onePage) return { rows: result, total, more: true };
      if (!rows.length)
        throw new GamError(
          "GAM nije vratio kompletnu listu. Suzite izbor.",
          502,
        );
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
