import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_LINE_SIZES,
  PREBID_CREATIVE,
  LINE_ITEM_TYPES,
  normalizeLinePlan,
  priceRows,
} from "../../shared/gam/line-items.mjs";

type Choice = { id: string; name: string; status?: string; size?: string };
type Selection = {
  mode: "new" | "existing";
  id: string;
  name: string;
  traffickerId?: string;
};
type Creative = {
  mode: "new" | "existing" | "none";
  name: string;
  copies: number;
  size: string;
  snippet: string;
  safeFrame: boolean;
  overrideSizes: boolean;
  ids: string[];
};
type Draft = {
  mode: "prebid" | "single";
  advertiser: Selection;
  order: Selection;
  inventory: { kind: "adUnits" | "placements"; ids: string[] };
  currency: string;
  sizes: string;
  ranges: { from: string; to: string; step: string }[];
  namePrefix: string;
  name: string;
  lineItemType: string;
  rate: string;
  costType: string;
  goal: number;
  start: string;
  end: string;
  customTargeting: string;
  creative: Creative;
};
type Count = {
  total: number;
  new: number;
  existing: number;
  created: number;
  conflict: number;
};
type Job = {
  id: string;
  status: string;
  cursor: number;
  mode: string;
  network: { name: string; networkCode: string };
  phase: string;
  offset: number;
  phaseTotal: number;
  counts: Record<string, Count>;
  error: string;
  awaitingCheck: boolean;
  retryAfter: number;
  conflictCount: number;
  conflicts: { ref: string; message: string }[];
  configuration: {
    advertiser: string;
    orders: { name: string; id?: string; status?: string }[];
    inventory: Choice[];
    currency: string;
    sizes: string;
    type: string;
    costType: string;
    goal: { units?: number };
    start: string | null;
    end: string | null;
    ranges: Draft["ranges"];
    customRules: { key: string; values: string[] }[];
    creativeName: string;
    creativeSize: string;
    creativeSafeFrame: boolean;
    creativeSnippet: string;
    creativeMode: string;
    overrideSizes: boolean;
  };
  examples: { name: string; price: string; id?: string; state: string }[];
  creativeIds: string[];
  advertiserId?: string;
};
type History = {
  id: string;
  name: string;
  status: string;
  count: number;
  createdAt: string;
};
const initial = (): Draft => ({
  mode: "prebid",
  advertiser: { mode: "existing", id: "", name: "" },
  order: { mode: "new", id: "", name: "Prebid", traffickerId: "" },
  inventory: { kind: "adUnits", ids: [] },
  currency: "EUR",
  sizes: DEFAULT_LINE_SIZES,
  ranges: [{ from: "0.01", to: "20.00", step: "0.01" }],
  namePrefix: "HB",
  name: "",
  lineItemType: "PRICE_PRIORITY",
  rate: "1.00",
  costType: "CPM",
  goal: 100000,
  start: "",
  end: "",
  customTargeting: "",
  creative: {
    mode: "new",
    name: "Prebid Universal",
    copies: 20,
    size: "1x1",
    snippet: PREBID_CREATIVE,
    safeFrame: false,
    overrideSizes: true,
    ids: [],
  },
});
const labels: Record<string, string> = {
  advertiser: "Advertiser",
  order: "Orderi",
  key: "Key-value ključevi",
  value: "Key-value vrednosti",
  creative: "Kreativi",
  lineItem: "Line itemi",
  association: "Veze sa kreativima",
};
const statuses: Record<string, string> = {
  reviewing: "Provera",
  ready: "Spremno za potvrdu",
  creating: "U toku / može da se nastavi",
  completed: "Završeno",
  cancelled: "Zaustavljeno",
};
const stateNames: Record<string, string> = {
  new: "Novo",
  existing: "Postoji",
  created: "Kreirano",
  conflict: "Konflikt",
};
function Picker({
  label,
  kind,
  endpoint,
  network,
  advertiser,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  kind: string;
  endpoint: string;
  network: string;
  advertiser?: string;
  value: string;
  onChange: (item: Choice) => void;
  disabled?: boolean;
}) {
  const [items, setItems] = useState<Choice[]>([]),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0),
    [more, setMore] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const context = network + "|" + advertiser + "|" + kind;
  useEffect(() => {
    setItems([]);
    setQuery("");
    setSearch("");
    setOffset(0);
  }, [context]);
  useEffect(() => {
    let active = true;
    if (!network || (["order", "creative"].includes(kind) && !advertiser))
      return;
    setBusy(true);
    setError("");
    const qs = new URLSearchParams({
      network,
      kind,
      q: search,
      offset: String(offset),
      ...(advertiser ? { advertiser } : {}),
    });
    fetch(endpoint + "/line-items/lookups?" + qs)
      .then(async (r) => {
        const d = (await r.json()) as {
          items: Choice[];
          more: boolean;
          error?: string;
        };
        if (!r.ok) throw Error(d.error || "Lista nije dostupna.");
        if (active) {
          setItems(d.items);
          setMore(d.more);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [endpoint, context, search, offset]);
  return (
    <div className="gam-li-picker">
      <label>
        {label}
        <select
          aria-label={label}
          value={value}
          disabled={disabled || busy}
          onChange={(e) => {
            const item = items.find((x) => x.id === e.target.value);
            if (item) onChange(item);
          }}
        >
          <option value="">{busy ? "Učitavanje…" : "Izaberite…"}</option>
          {value && !items.some((i) => i.id === value) && (
            <option value={value}>Izabrano · {value}</option>
          )}
          {items.map((i) => (
            <option value={i.id} key={i.id}>
              {i.name} · {i.id}
              {i.size ? " · " + i.size : ""}
            </option>
          ))}
        </select>
      </label>
      <div className="gam-li-search">
        <input
          aria-label={`Pretraži: ${label}`}
          placeholder="Pretraga po nazivu"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              setOffset(0);
              setSearch(query);
            }
          }}
        />
        <button
          type="button"
          onClick={() => {
            setOffset(0);
            setSearch(query);
          }}
        >
          Traži
        </button>
      </div>
      {error && <small role="alert">{error}</small>}
      {(offset > 0 || more) && (
        <div className="gam-li-actions">
          <button
            type="button"
            disabled={busy || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 100))}
          >
            Prethodna
          </button>
          <button
            type="button"
            disabled={busy || !more}
            onClick={() => setOffset(offset + 100)}
          >
            Sledeća
          </button>
        </div>
      )}
    </div>
  );
}
export default function GamLineItemsPanel({
  endpoint,
  connections,
  network,
  onNetworkChange,
  onRunning,
}: {
  endpoint: string;
  connections: { networkCode: string; name: string }[];
  network: string;
  onNetworkChange: (s: string) => void;
  onRunning: (b: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial),
    [job, setJob] = useState<Job | null>(null),
    [history, setHistory] = useState<History[]>([]),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [inventory, setInventory] = useState<Choice[]>([]),
    [parent, setParent] = useState<(Choice & { parentId?: string }) | null>(
      null,
    ),
    [units, setUnits] = useState<(Choice & { parentId?: string })[]>([]);
  const alive = useRef(true),
    stop = useRef(false),
    working = useRef(false),
    generation = useRef(0);
  const running = job?.status === "creating";
  const patch = (v: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...v }));
    setJob(null);
    setConfirmed(false);
    setError("");
  };
  const creative = (v: Partial<Creative>) =>
    patch({ creative: { ...draft.creative, ...v } });
  async function api<T>(path: string, body?: unknown): Promise<T> {
    const r = await fetch(endpoint + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const d = (await r.json()) as T & { error?: string };
    if (!r.ok)
      throw Error(
        d.error || "Zahtev nije uspeo. Otvorite sačuvani posao pre nastavka.",
      );
    return d;
  }
  async function loadHistory() {
    const id = generation.current;
    const d = await api<{ jobs: History[] }>(
      "/line-items/jobs?network=" + network,
    );
    if (alive.current && id === generation.current) setHistory(d.jobs);
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stop.current = true;
    };
  }, []);
  useEffect(() => {
    generation.current++;
    let active = true;
    stop.current = true;
    setJob(null);
    setHistory([]);
    setInventory([]);
    setParent(null);
    setUnits([]);
    setDraft(initial());
    setError("");
    setConfirmed(false);
    if (network) {
      void loadHistory().catch((e) => {
        if (active) setError(e.message);
      });
      void api<{ currency: string }>("/line-items/network?network=" + network)
        .then((d) => {
          if (active) setDraft((p) => ({ ...p, currency: d.currency }));
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    }
    return () => {
      active = false;
    };
  }, [network, endpoint]);
  async function run(action: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    stop.current = false;
    setBusy(true);
    onRunning(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      working.current = false;
      if (alive.current) {
        setBusy(false);
        onRunning(false);
        void loadHistory().catch(() => {});
      }
    }
  }
  async function walk(j: Job) {
    if (alive.current) setJob(j);
    while (
      alive.current &&
      !stop.current &&
      ["reviewing", "creating"].includes(j.status) &&
      !j.awaitingCheck &&
      !j.error
    ) {
      j = await api<Job>(
        `/line-items/jobs/${j.id}/${j.status === "reviewing" ? "review" : "step"}`,
        { cursor: j.cursor },
      );
      if (alive.current) setJob(j);
    }
    return j;
  }
  async function preview() {
    await run(async () => {
      normalizeLinePlan({ ...draft, networkCode: network });
      const j = await api<Job>("/line-items/preview", {
        ...draft,
        networkCode: network,
      });
      setConfirmed(false);
      await walk(j);
    });
  }
  async function open(id: string) {
    await run(async () => {
      const j = await api<Job>("/line-items/jobs/" + id);
      if (alive.current) {
        setJob(j);
        setConfirmed(false);
      }
    });
  }
  async function resume() {
    if (!job) return;
    await run(async () => {
      let j = await api<Job>("/line-items/jobs/" + job.id);
      if (j.error && !j.awaitingCheck) j = { ...j, error: "" };
      await walk(j);
    });
  }
  async function start() {
    if (!job || !confirmed) return;
    await run(async () => {
      await walk(
        await api<Job>(`/line-items/jobs/${job.id}/start`, {
          confirm: true,
          confirmNetwork: job.network.networkCode,
        }),
      );
    });
  }
  async function check() {
    if (!job) return;
    await run(async () => {
      const j = await api<Job>(`/line-items/jobs/${job.id}/check`, {
        cursor: job.cursor,
      });
      if (alive.current) setJob(j);
    });
  }
  async function cancel() {
    if (!job) return;
    await run(async () => {
      const j = await api<Job>(`/line-items/jobs/${job.id}/cancel`, {});
      if (alive.current) setJob(j);
    });
  }
  async function browse(id?: string) {
    await run(async () => {
      const d = await api<{
        parent: Choice & { parentId?: string };
        units: Choice[];
      }>("/parents?network=" + network + (id ? "&parent=" + id : ""));
      if (alive.current) {
        setParent(d.parent);
        setUnits(d.units);
      }
    });
  }
  function addInventory(item: Choice) {
    if (inventory.some((i) => i.id === item.id)) return;
    const next = [...inventory, item];
    setInventory(next);
    patch({ inventory: { ...draft.inventory, ids: next.map((i) => i.id) } });
  }
  function mode(value: Draft["mode"]) {
    const single = value === "single";
    patch({
      mode: value,
      order: { ...draft.order, name: single ? "" : "Prebid" },
      creative: {
        ...initial().creative,
        copies: single ? 1 : 20,
        name: single ? "" : "Prebid Universal",
        snippet: single ? "" : PREBID_CREATIVE,
        mode: single ? "none" : "new",
      },
    });
  }
  const estimate = useMemo(() => {
    try {
      const count =
        draft.mode === "prebid" ? priceRows(draft.ranges).length : 1;
      const copies =
        draft.creative.mode === "new"
          ? draft.creative.copies
          : draft.creative.ids.length;
      return `${count.toLocaleString("sr-Latn")} line itema · ${draft.order.mode === "new" ? Math.ceil(count / 400) : 1} order(a) · ${draft.creative.mode === "none" ? 0 : copies} kreativa`;
    } catch {
      return "Proverite raspon i korak cena.";
    }
  }, [draft]);
  const percent = ["SPONSORSHIP", "NETWORK", "HOUSE"].includes(
      draft.lineItemType,
    ),
    dated = ["STANDARD", "BULK"].includes(draft.lineItemType);
  return (
    <div className="gam-li">
      {!connections.length && (
        <div className="gam-message info">
          Prvo dodajte konekciju u tabu GAM povezivanje.
        </div>
      )}
      {error && (
        <div className="gam-message error" role="alert">
          {error}
        </div>
      )}
      <fieldset className="gam-fields" disabled={busy || running}>
        <article className="gam-card">
          <span className="gam-step">LINE ITEMI</span>
          <h3>Šta kreiramo?</h3>
          <div className="gam-li-modes">
            <button
              type="button"
              className={draft.mode === "prebid" ? "active" : ""}
              aria-pressed={draft.mode === "prebid"}
              onClick={() => mode("prebid")}
            >
              <strong>Prebid postavka</strong>
              <small>Cene, hb_pb, zajednički kreativi i size override</small>
            </button>
            <button
              type="button"
              className={draft.mode === "single" ? "active" : ""}
              aria-pressed={draft.mode === "single"}
              onClick={() => mode("single")}
            >
              <strong>Jedan line item</strong>
              <small>Tip kampanje, cena, trajanje i kreativi po izboru</small>
            </button>
          </div>
          <p className="gam-li-estimate">{estimate}</p>
          <label>
            GAM mreža za line iteme
            <select
              aria-label="GAM mreža za line iteme"
              value={network}
              onChange={(e) => onNetworkChange(e.target.value)}
            >
              <option value="">Izaberite mrežu</option>
              {connections.map((c) => (
                <option key={c.networkCode} value={c.networkCode}>
                  {c.name} · {c.networkCode}
                </option>
              ))}
            </select>
          </label>
        </article>
        <article className="gam-card">
          <span className="gam-step">01 / ADVERTISER I ORDER</span>
          <h3>Za koga kreiramo?</h3>
          <div className="gam-li-columns">
            <div>
              <label>
                Advertiser
                <select
                  aria-label="Advertiser"
                  value={draft.advertiser.mode}
                  onChange={(e) =>
                    patch({
                      advertiser: {
                        mode: e.target.value as Selection["mode"],
                        id: "",
                        name: "",
                      },
                      order: { ...draft.order, mode: "new", id: "" },
                      creative: {
                        ...draft.creative,
                        ...(draft.creative.mode === "existing"
                          ? { mode: "new", ids: [] }
                          : {}),
                      },
                    })
                  }
                >
                  <option value="existing">Postojeći advertiser</option>
                  <option value="new">Kreiraj novi advertiser</option>
                </select>
              </label>
              {draft.advertiser.mode === "new" ? (
                <label>
                  Naziv novog advertiser-a
                  <input
                    value={draft.advertiser.name}
                    placeholder="npr. Example advertiser"
                    onChange={(e) =>
                      patch({
                        advertiser: {
                          ...draft.advertiser,
                          name: e.target.value,
                        },
                      })
                    }
                  />
                </label>
              ) : (
                <Picker
                  label="Izaberite advertiser"
                  kind="advertiser"
                  endpoint={endpoint}
                  network={network}
                  value={draft.advertiser.id}
                  onChange={(i) =>
                    patch({
                      advertiser: { ...draft.advertiser, ...i },
                      order: { ...draft.order, id: "" },
                      creative: { ...draft.creative, ids: [] },
                    })
                  }
                />
              )}
            </div>
            <div>
              <label>
                Order
                <select
                  aria-label="Order"
                  value={draft.order.mode}
                  onChange={(e) =>
                    patch({
                      order: {
                        ...draft.order,
                        mode: e.target.value as Selection["mode"],
                        id: "",
                      },
                    })
                  }
                >
                  <option value="new">Kreiraj novi order</option>
                  <option
                    value="existing"
                    disabled={draft.advertiser.mode === "new"}
                  >
                    Postojeći order
                  </option>
                </select>
              </label>
              {draft.order.mode === "new" ? (
                <>
                  <label>
                    Naziv novog order-a
                    <input
                      value={draft.order.name}
                      placeholder="npr. Example Prebid"
                      onChange={(e) =>
                        patch({
                          order: { ...draft.order, name: e.target.value },
                        })
                      }
                    />
                  </label>
                  <Picker
                    label="Trafficker"
                    kind="user"
                    endpoint={endpoint}
                    network={network}
                    value={draft.order.traffickerId || ""}
                    onChange={(i) =>
                      patch({ order: { ...draft.order, traffickerId: i.id } })
                    }
                  />
                  <small>
                    Prebid sa više od 400 line itema automatski dobija više
                    ordera.
                  </small>
                </>
              ) : (
                <Picker
                  label="Izaberite order"
                  kind="order"
                  endpoint={endpoint}
                  network={network}
                  advertiser={draft.advertiser.id}
                  value={draft.order.id}
                  onChange={(i) => patch({ order: { ...draft.order, ...i } })}
                />
              )}
            </div>
          </div>
        </article>
        <article className="gam-card">
          <span className="gam-step">02 / INVENTORY I VELIČINE</span>
          <h3>Gde će se prikazivati?</h3>
          <div className="gam-li-columns">
            <div>
              <label>
                Targetiranje inventory-ja
                <select
                  aria-label="Targetiranje inventory-ja"
                  value={draft.inventory.kind}
                  onChange={(e) => {
                    setInventory([]);
                    setParent(null);
                    setUnits([]);
                    patch({
                      inventory: {
                        kind: e.target.value as "adUnits" | "placements",
                        ids: [],
                      },
                    });
                  }}
                >
                  <option value="adUnits">
                    Ad uniti / parent sa svim potomcima
                  </option>
                  <option value="placements">Postojeći placement</option>
                </select>
              </label>
              {draft.inventory.kind === "placements" ? (
                <Picker
                  label="Dodaj placement"
                  kind="placement"
                  endpoint={endpoint}
                  network={network}
                  value=""
                  onChange={addInventory}
                />
              ) : (
                <>
                  <button
                    type="button"
                    disabled={!network}
                    onClick={() => void browse()}
                  >
                    Učitaj ad unite
                  </button>
                  {parent && (
                    <div className="gam-parent-tree">
                      <div>
                        <strong>{parent.name}</strong>
                        <button
                          type="button"
                          onClick={() => addInventory(parent)}
                        >
                          Dodaj ovaj parent
                        </button>
                        {parent.parentId && (
                          <button
                            type="button"
                            onClick={() => void browse(parent.parentId)}
                          >
                            ↑ Gore
                          </button>
                        )}
                      </div>
                      {units.map((u) => (
                        <div key={u.id}>
                          <span>{u.name}</span>
                          <button type="button" onClick={() => addInventory(u)}>
                            Dodaj
                          </button>
                          <button
                            type="button"
                            aria-label={"Otvori ad unit " + u.name}
                            onClick={() => void browse(u.id)}
                          >
                            Otvori →
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
              <div className="gam-li-chips">
                {inventory.map((i) => (
                  <button
                    type="button"
                    key={i.id}
                    aria-label={"Ukloni " + i.name}
                    onClick={() => {
                      const next = inventory.filter((x) => x.id !== i.id);
                      setInventory(next);
                      patch({
                        inventory: {
                          ...draft.inventory,
                          ids: next.map((x) => x.id),
                        },
                      });
                    }}
                  >
                    {i.name} · {i.id} ×
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label>
                Veličine line itema
                <textarea
                  aria-label="Veličine line itema"
                  rows={4}
                  value={draft.sizes}
                  onChange={(e) => patch({ sizes: e.target.value })}
                />
                <small>
                  Display dimenzije u pikselima, odvojene tačkom-zarezom. Iste
                  veličine koriste se za override na kreativima.
                </small>
              </label>
            </div>
          </div>
        </article>
        <article className="gam-card">
          <span className="gam-step">03 / LINE ITEMI</span>
          <h3>
            {draft.mode === "prebid"
              ? "Raspon cena i granularnost"
              : "Podešavanje kampanje"}
          </h3>
          <div className="gam-form-grid">
            <label>
              {draft.mode === "prebid" ? "Prefiks naziva" : "Naziv line itema"}
              <input
                value={draft.mode === "prebid" ? draft.namePrefix : draft.name}
                onChange={(e) =>
                  patch(
                    draft.mode === "prebid"
                      ? { namePrefix: e.target.value }
                      : { name: e.target.value },
                  )
                }
                placeholder="npr. Example kampanja"
              />
            </label>
            <label>
              Valuta GAM mreže
              <input value={draft.currency} readOnly />
              <small>
                Cene i Prebid bidCurrency treba da koriste ovu valutu.
              </small>
            </label>
            {draft.mode === "single" && (
              <label>
                Tip line itema
                <select
                  aria-label="Tip line itema"
                  value={draft.lineItemType}
                  onChange={(e) =>
                    patch({
                      lineItemType: e.target.value,
                      goal: ["SPONSORSHIP", "NETWORK", "HOUSE"].includes(
                        e.target.value,
                      )
                        ? 100
                        : 100000,
                      rate: e.target.value === "HOUSE" ? "0" : draft.rate,
                    })
                  }
                >
                  {LINE_ITEM_TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {draft.mode === "prebid" ? (
            <>
              <div className="gam-li-ranges">
                {draft.ranges.map((r, i) => (
                  <div className="gam-li-range" key={i}>
                    {(["from", "to", "step"] as const).map((key, k) => (
                      <label key={key}>
                        {["Od", "Do", "Korak"][k]} {i + 1}
                        <input
                          inputMode="decimal"
                          value={r[key]}
                          onChange={(e) =>
                            patch({
                              ranges: draft.ranges.map((v, j) =>
                                j === i ? { ...v, [key]: e.target.value } : v,
                              ),
                            })
                          }
                        />
                      </label>
                    ))}
                    <button
                      type="button"
                      disabled={draft.ranges.length === 1}
                      onClick={() =>
                        patch({
                          ranges: draft.ranges.filter((_, j) => j !== i),
                        })
                      }
                    >
                      Ukloni raspon
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                disabled={draft.ranges.length >= 10}
                onClick={() =>
                  patch({
                    ranges: [
                      ...draft.ranges,
                      { from: draft.ranges.at(-1)!.to, to: "", step: "0.10" },
                    ],
                  })
                }
              >
                ＋ Dodaj raspon
              </button>
              <p className="gam-help">
                Svaka cena dobija PRICE_PRIORITY / CPM line item i odgovarajuću
                hb_pb vrednost. Rasponi moraju odgovarati price granularity
                podešavanju Prebid-a na sajtu. Početak odmah, bez krajnjeg
                datuma.
              </p>
            </>
          ) : (
            <div className="gam-form-grid">
              <label>
                Cena
                <input
                  inputMode="decimal"
                  value={draft.rate}
                  onChange={(e) => patch({ rate: e.target.value })}
                />
              </label>
              <label>
                Obračun
                <select
                  aria-label="Obračun"
                  value={draft.costType}
                  onChange={(e) => patch({ costType: e.target.value })}
                >
                  <option>CPM</option>
                  <option>CPC</option>
                </select>
              </label>
              {(percent || dated) && (
                <label>
                  {percent
                    ? "Udeo prikaza (%)"
                    : draft.costType === "CPC"
                      ? "Cilj klikova"
                      : "Cilj impresija"}
                  <input
                    type="number"
                    min="1"
                    max={percent ? 100 : 1000000000}
                    value={draft.goal}
                    onChange={(e) => patch({ goal: Number(e.target.value) })}
                  />
                </label>
              )}
              <label>
                Početak (UTC)
                <input
                  aria-label="Početak (UTC)"
                  type="datetime-local"
                  value={draft.start}
                  onChange={(e) => patch({ start: e.target.value })}
                />
                <small>Prazno = odmah.</small>
              </label>
              <label>
                Završetak (UTC){dated ? " — obavezno" : ""}
                <input
                  aria-label={
                    dated ? "Završetak (UTC) — obavezno" : "Završetak (UTC)"
                  }
                  type="datetime-local"
                  value={draft.end}
                  onChange={(e) => patch({ end: e.target.value })}
                />
                <small>
                  {dated
                    ? "Standard i Bulk zahtevaju kraj."
                    : "Prazno = bez krajnjeg datuma."}
                </small>
              </label>
            </div>
          )}
          <details>
            <summary>Dodatni key-value targeting</summary>
            <label>
              Uslovi targetiranja
              <textarea
                rows={3}
                value={draft.customTargeting}
                placeholder={"section=sport|news\nformat=display"}
                onChange={(e) => patch({ customTargeting: e.target.value })}
              />
              <small>
                Jedan ključ po redu. Redovi se povezuju sa AND, vrednosti unutar
                reda sa OR. Nedostajući ključevi i vrednosti se kreiraju.
              </small>
            </label>
          </details>
        </article>
        <article className="gam-card">
          <span className="gam-step">04 / KREATIVI</span>
          <h3>
            {draft.mode === "prebid"
              ? "Prebid kreativi"
              : "Kreativi za kampanju"}
          </h3>
          <div className="gam-form-grid">
            <label>
              Dodavanje kreativa
              <select
                aria-label="Dodavanje kreativa"
                value={draft.creative.mode}
                onChange={(e) =>
                  creative({ mode: e.target.value as Creative["mode"] })
                }
              >
                <option value="new">Kreiraj nove iz HTML/JS taga</option>
                <option
                  value="existing"
                  disabled={draft.advertiser.mode === "new"}
                >
                  Izaberi postojeće
                </option>
                {draft.mode === "single" && (
                  <option value="none">Bez kreativa — dodaću kasnije</option>
                )}
              </select>
            </label>
            {draft.creative.mode === "new" && (
              <>
                <label>
                  Naziv seta kreativa
                  <input
                    value={draft.creative.name}
                    onChange={(e) => creative({ name: e.target.value })}
                  />
                </label>
                <label>
                  Broj kopija kreativa
                  <input
                    type="number"
                    min="1"
                    max="50"
                    value={draft.creative.copies}
                    onChange={(e) =>
                      creative({ copies: Number(e.target.value) })
                    }
                  />
                </label>
              </>
            )}
          </div>
          {draft.creative.mode === "new" && (
            <>
              <p className="gam-help">
                {draft.mode === "prebid"
                  ? "Isti set kopija povezuje se sa svim cenama. Broj kopija prilagodite broju pozicija koje mogu istovremeno dobiti istu cenu."
                  : "Kopije dobijaju numerisane nazive i povezuju se sa line itemom."}
              </p>
              <details open={draft.mode === "single"}>
                <summary>HTML / JavaScript kreativa</summary>
                <label>
                  Kod kreativa
                  <textarea
                    className="gam-li-code"
                    rows={11}
                    spellCheck={false}
                    value={draft.creative.snippet}
                    onChange={(e) => creative({ snippet: e.target.value })}
                  />
                </label>
                {draft.mode === "prebid" && (
                  <button
                    type="button"
                    onClick={() => creative({ snippet: PREBID_CREATIVE })}
                  >
                    Vrati Prebid Universal Creative
                  </button>
                )}
              </details>
              <div className="gam-form-grid">
                <label>
                  Početna veličina kreativa
                  <input
                    value={draft.creative.size}
                    onChange={(e) => creative({ size: e.target.value })}
                  />
                </label>
                <label className="gam-confirm">
                  <input
                    type="checkbox"
                    checked={draft.creative.safeFrame}
                    onChange={(e) => creative({ safeFrame: e.target.checked })}
                  />
                  SafeFrame kompatibilan
                </label>
              </div>
            </>
          )}
          {draft.creative.mode === "existing" && (
            <>
              <Picker
                label="Dodaj postojeći kreativ"
                kind="creative"
                endpoint={endpoint}
                network={network}
                advertiser={draft.advertiser.id}
                value=""
                onChange={(i) =>
                  creative({ ids: [...new Set([...draft.creative.ids, i.id])] })
                }
              />
              <div className="gam-li-chips">
                {draft.creative.ids.map((id) => (
                  <button
                    type="button"
                    key={id}
                    onClick={() =>
                      creative({
                        ids: draft.creative.ids.filter((x) => x !== id),
                      })
                    }
                  >
                    Kreativ {id} ×
                  </button>
                ))}
              </div>
            </>
          )}
          {draft.creative.mode !== "none" && (
            <label className="gam-confirm">
              <input
                type="checkbox"
                checked={draft.creative.overrideSizes}
                onChange={(e) => creative({ overrideSizes: e.target.checked })}
              />
              Override sizes — koristi sve veličine line itema na svakom
              povezanom kreativu
            </label>
          )}
        </article>
        <div className="gam-li-actions">
          <button
            type="button"
            className="gam-primary"
            disabled={!network}
            onClick={() => void preview()}
          >
            Proveri postavku u GAM-u
          </button>
          <span className="gam-help">
            Provera još ne kreira entitete u GAM-u.
          </span>
        </div>
      </fieldset>
      {busy && (
        <div className="gam-message info gam-inline" role="status">
          <span>
            {job
              ? `${job.phase || statuses[job.status]} · ${job.offset} / ${job.phaseTotal}`
              : "Učitavanje i provera…"}
          </span>
          <button
            type="button"
            onClick={() => {
              stop.current = true;
            }}
          >
            Pauziraj posle tekućeg koraka
          </button>
        </div>
      )}
      {job && (
        <article className="gam-card gam-li-review">
          <span className="gam-step">05 / PREGLED I REZULTAT</span>
          <h3>{statuses[job.status]}</h3>
          <div className="gam-review-summary">
            <strong>
              {job.network.name} · {job.network.networkCode}
            </strong>
            <span>
              {job.configuration.advertiser}
              {job.advertiserId ? " · " + job.advertiserId : ""}
            </span>
          </div>
          {job.error && (
            <div className="gam-message error" role="alert">
              {job.error}
            </div>
          )}
          <p>
            {job.configuration.type} · {job.configuration.costType} ·{" "}
            {job.configuration.currency} ·{" "}
            {job.configuration.start || "Početak odmah"} →{" "}
            {job.configuration.end || "Bez krajnjeg datuma"}
            {job.configuration.goal.units
              ? " · Cilj: " + job.configuration.goal.units
              : ""}
          </p>
          <p>
            <strong>Inventory:</strong>{" "}
            {job.configuration.inventory
              .map((i) => i.name + " (" + i.id + ")")
              .join(", ")}
            <br />
            <strong>Veličine:</strong> {job.configuration.sizes}
            <br />
            <strong>Size override:</strong>{" "}
            {job.configuration.overrideSizes &&
            job.configuration.creativeMode !== "none"
              ? "Da"
              : "Ne"}
          </p>
          {job.configuration.ranges.length > 0 && (
            <p>
              <strong>Prebid rasponi / hb_pb:</strong>{" "}
              {job.configuration.ranges
                .map((r) => `${r.from}–${r.to}, korak ${r.step}`)
                .join("; ")}
            </p>
          )}
          {job.configuration.customRules.length > 0 && (
            <p>
              <strong>Dodatni targeting (AND):</strong>{" "}
              {job.configuration.customRules
                .map((r) => `${r.key} = ${r.values.join(" | ")}`)
                .join("; ")}
            </p>
          )}
          {job.configuration.creativeName && (
            <p>
              <strong>Set kreativa:</strong> {job.configuration.creativeName} ·{" "}
              {job.configuration.creativeSize} · SafeFrame:{" "}
              {job.configuration.creativeSafeFrame ? "Da" : "Ne"}
            </p>
          )}
          {job.configuration.creativeSnippet && (
            <details>
              <summary>Kod kreativa iz sačuvanog pregleda</summary>
              <pre className="gam-li-saved-code">
                {job.configuration.creativeSnippet}
              </pre>
            </details>
          )}
          <div className="gam-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Entitet</th>
                  <th>Ukupno</th>
                  <th>Novo</th>
                  <th>Postoji</th>
                  <th>Kreirano</th>
                  <th>Konflikt</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(job.counts).map(([k, v]) => (
                  <tr key={k}>
                    <td>{labels[k]}</td>
                    <td>{v.total}</td>
                    <td>{v.new}</td>
                    <td>{v.existing}</td>
                    <td>{v.created}</td>
                    <td>{v.conflict}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {job.status === "ready" && (
            <p className="gam-help">
              Veze sa kreativima proveravaju se pojedinačno tokom kreiranja.
              Postojeći entiteti sa istim nazivom koriste se samo ako im se
              podešavanja poklapaju.
            </p>
          )}
          {job.conflictCount > 0 && (
            <div className="gam-message error">
              {job.conflictCount} konflikata. Ispravite izbor ili nazive i
              ponovite proveru.
              {job.conflicts.map((c) => (
                <p key={c.ref}>
                  {c.ref}: {c.message}
                </p>
              ))}
            </div>
          )}
          <details>
            <summary>Orderi i GAM ID-jevi</summary>
            {job.configuration.orders.map((o, i) => (
              <p key={i}>
                {o.name} · {o.id || "Nov order"} ·{" "}
                {o.status || "DRAFT nakon kreiranja"}
              </p>
            ))}
            {job.creativeIds.length > 0 && (
              <p>Kreativi: {job.creativeIds.join(", ")}</p>
            )}
          </details>
          <details open={job.status === "completed"}>
            <summary>Line itemi — prvih {job.examples.length}</summary>
            <div className="gam-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Naziv</th>
                    <th>Cena</th>
                    <th>GAM ID</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {job.examples.map((r, i) => (
                    <tr key={i}>
                      <td>{r.name}</td>
                      <td>
                        {r.price} {job.configuration.currency}
                      </td>
                      <td>{r.id || "—"}</td>
                      <td>{stateNames[r.state] || "Čeka proveru"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <p>
            <a href={`${endpoint}/line-items/jobs/${job.id}/export`} download>
              Preuzmi kompletnu listu i GAM ID-jeve (CSV)
            </a>
          </p>
          {job.status === "ready" && !job.conflictCount && (
            <>
              <p className="gam-message info">
                Novi orderi ostaju DRAFT; odobravanje radite u GAM-u. U
                postojećem odobrenom order-u line item može početi isporuku
                prema izabranom terminu.
              </p>
              <label className="gam-confirm">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                Potvrđujem ovu postavku u mreži {job.network.networkCode}:{" "}
                {job.counts.lineItem.total} line itema i{" "}
                {job.counts.creative.total} kreativa.
              </label>
              <button
                type="button"
                className="gam-primary"
                disabled={busy || !confirmed}
                onClick={() => void start()}
              >
                Kreiraj potvrđenu postavku
              </button>
            </>
          )}
          {job.awaitingCheck && (
            <div className="gam-message info">
              Odgovor za poslednji upis nije potvrđen. Provera ishoda samo čita
              GAM i ne ponavlja upis.
              <div className="gam-li-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void check()}
                >
                  Proveri ishod u GAM-u
                </button>
              </div>
            </div>
          )}
          {!busy &&
            ["reviewing", "creating"].includes(job.status) &&
            !job.awaitingCheck && (
              <button
                type="button"
                className="gam-primary"
                onClick={() => void resume()}
              >
                Nastavi posao
              </button>
            )}
          {!busy && !["completed", "cancelled"].includes(job.status) && (
            <details>
              <summary>Zaustavljanje posla</summary>
              <p>
                Već kreirani entiteti ostaju u GAM-u. Nakon zaustavljanja možete
                napraviti nov pregled i prepoznati postojeće entitete. Ako je
                zahtev upravo poslat, sačekajte najmanje 90 sekundi.
              </p>
              <button type="button" onClick={() => void cancel()}>
                Zaustavi ovaj posao
              </button>
            </details>
          )}
          {!busy && ["completed", "cancelled"].includes(job.status) && (
            <button
              type="button"
              onClick={() => {
                setJob(null);
                setConfirmed(false);
                setError("");
              }}
            >
              Pripremi sledeću postavku
            </button>
          )}
        </article>
      )}
      <article className="gam-card">
        <span className="gam-step">SAČUVANI POSLOVI</span>
        <h3>Nastavak i istorija line itema</h3>
        <p className="gam-help">
          Napredak se čuva posle svakog paketa. Posle zatvaranja taba otvorite
          posao ovde da proverite ishod i nastavite.
        </p>
        <button
          type="button"
          disabled={busy || !network}
          onClick={() => void run(loadHistory)}
        >
          Osveži poslove
        </button>
        {history.map((h) => (
          <div className="gam-li-history" key={h.id}>
            <span>
              <strong>{h.name || "GAM postavka"}</strong>
              <small>
                {new Date(h.createdAt).toLocaleString("sr-Latn")} · {h.count}{" "}
                line itema · {statuses[h.status]}
              </small>
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void open(h.id)}
            >
              Otvori posao
            </button>
          </div>
        ))}
      </article>
    </div>
  );
}
