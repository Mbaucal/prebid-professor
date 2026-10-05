import {
  PREBID_DEFAULTS,
  prebidDraft,
  flag,
} from "../../shared/gam/line-items.mjs";

// Discovery only: never mutate GAM or choose another user's inventory by fallback.
export async function discoverPrebidDefaults(client, networkCode) {
  const d = PREBID_DEFAULTS,
    draft = prebidDraft(networkCode),
    issues = [],
    inventory = [];
  const [network, advertisers, placements, users] = await Promise.all([
    client.network(),
    client.query(
      "advertiser",
      "name = :name",
      { name: d.advertiserName },
      { limit: 2, onePage: true },
    ),
    client.query(
      "placement",
      "name = :name",
      { name: d.placementName },
      { limit: 2, onePage: true },
    ),
    client.query(
      "user",
      "email = :email",
      { email: d.traffickerEmail },
      { limit: 2, onePage: true },
    ),
  ]);
  const unique = (result) =>
    result.total === 1 && result.rows.length === 1 && !result.more;
  if (advertisers.total) {
    const a = advertisers.rows[0];
    if (unique(advertisers) && a.type === "ADVERTISER" && !flag(a.isArchived))
      draft.advertiser = { mode: "existing", id: String(a.id), name: a.name };
    else
      issues.push(
        `Advertiser „${d.advertiserName}“ nije jedinstven ili nije odgovarajućeg tipa. Izaberite ga u podešavanjima.`,
      );
  }
  const p = placements.rows[0];
  if (unique(placements) && p.status === "ACTIVE") {
    draft.inventory.ids = [String(p.id)];
    inventory.push({ id: String(p.id), name: String(p.name) });
  } else
    issues.push(
      `Potreban je aktivan placement „${d.placementName}“, kao u originalnoj skripti. Dodajte ga u GAM-u sa željenim ad unitima ili izaberite inventory u podešavanjima.`,
    );
  const u = users.rows[0];
  if (unique(users) && flag(u.isActive))
    draft.order.traffickerId = String(u.id);
  else
    issues.push(
      `Trafficker ${d.traffickerEmail} nije jedinstveno pronađen kao aktivan korisnik. Dodajte mu pristup mreži ili izaberite trafficker-a u podešavanjima.`,
    );
  if (network.currency !== draft.currency)
    issues.push(
      `Originalna skripta koristi EUR, a ova GAM mreža ${network.currency}. Uskladite valutu u podešavanjima.`,
    );
  return { draft, inventory, network, issues };
}
