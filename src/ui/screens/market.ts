/**
 * Market screen: the device's shared auction house (src/ui/marketStore.ts). Four tabs:
 *  - Browse: filters (item kind, seller kind) and live lot cards - seller chip, price, buyout, promo
 *    badge with its own countdown, Bid (next minimum prefilled) and Buyout;
 *  - Sell: a Genemon outside the team, or an item held at the market; start price, duration, buyout;
 *  - My listings: open lots (Cancel while unbid), lots you lead, recent settlements;
 *  - History: price chart + statistics per traded item, and the house books.
 * Countdowns (elements with data-ends) tick every second; the market steps every 5 s while open.
 */
import type { App } from "../app.ts";
import { type ElementId, ELEMENTS } from "../../data/elements.ts";
import { isGenemonItem, ITEM_KINDS, type ItemDef, type ItemKind, type Rarity } from "../../economy/items.ts";
import type { Listing, ListingFilter, SellerKind } from "../../economy/market.ts";
import { phenotypeOf } from "../../genome/genemon.ts";
import { lineChart } from "../charts.ts";
import { fmt, h, hex, section, select, toast } from "../dom.ts";
import {
  formatCountdown,
  getMarket,
  LIVE_MS,
  marketErrorText,
  type MarketStore,
  ROUND_MS,
  SALE_DURATIONS,
} from "../marketStore.ts";
import type { Profile } from "../profile.ts";
import { elChip, genemonCard } from "../widgets.ts";

type Tab = "browse" | "sell" | "mine" | "history";
const TABS: readonly { id: Tab; label: string }[] = [
  { id: "browse", label: "Browse" },
  { id: "sell", label: "Sell" },
  { id: "mine", label: "My listings" },
  { id: "history", label: "History" },
];
const KIND_LABEL: Record<ItemKind, string> = {
  food: "Food",
  potion: "Potion",
  lure: "Lure",
  egg: "Egg",
  stone: "Stone",
  cosmetic: "Cosmetic",
  territoryFlag: "Flag",
  incubator: "Incubator",
  ticket: "Ticket",
  map: "Map",
  genemon: "Genemon",
};
const RARITY_COLOR: Record<Rarity, string> = {
  common: "#7d8597",
  uncommon: "#2a9d8f",
  rare: "#0096c7",
  epic: "#9b5de5",
  legendary: "#e76f51",
};
const PROMO_COLOR = "#ff3d77";
const MAX_CARDS = 60;

// ------------------------------------------------------------------ screen state (survives re-renders)
let tab: Tab = "browse";
let kindFilter: ItemKind | "all" = "all";
let sellerFilter: SellerKind | "all" = "all";
let sellMode: "genemon" | "item" = "genemon";
let sellGenemonId: string | null = null;
let sellItemId: string | null = null;
let sellQty = 1;
/** null = use the suggested price. */
let sellStart: number | null = null;
let sellBuyout: number | null = null;
let sellDuration = SALE_DURATIONS[1].ms;
let historyItem: string | null = null;
let liveTimer: ReturnType<typeof setInterval> | undefined;
let refreshPending = false;
let awayNote = "";

export function renderMarket(app: App): HTMLElement {
  const m = getMarket(app);
  const p = app.profile;
  const now = Date.now();
  if (liveTimer === undefined) awayNote = "";
  try {
    const r = m.visit(p, now);
    if (r.opened !== null) {
      toast(
        r.opened > 0
          ? `Your ${fmt(r.opened)} credits moved into the market bank.`
          : "Your market wallet is open.",
      );
    }
    if (r.rounds > 0) {
      awayNote = `While nobody watched, the market ran ${r.rounds} round${r.rounds > 1 ? "s" : ""}` +
        `${r.skipped > 0 ? ` (${fmt(r.skipped)} older ones skipped)` : ""}: ${r.settled} lot${
          r.settled === 1 ? "" : "s"
        } settled.`;
    }
  } catch (e) {
    console.warn("market: visit failed", e);
  }
  ensureLive(app);
  let body: HTMLElement[];
  if (tab === "sell") body = [sellTab(app, m)];
  else if (tab === "mine") body = mineTab(app, m, now);
  else if (tab === "history") body = historyTab(app, m, now);
  else body = [browseTab(app, m, now)];
  const root = h(
    "div",
    {},
    h("h1", {}, "Market"),
    h(
      "p",
      {},
      "A real auction house shared by every profile on this device: timed lots, bids (+5 % minimum), buyouts, " +
        "anti-sniping (+30 s), company flash promotions and NPC traders. It keeps living while you are away.",
    ),
    walletBar(m, p),
    awayNote ? h("p", { class: "muted" }, awayNote) : null,
    m.saveError ? h("p", { class: "muted" }, `⚠ The market could not be saved (${m.saveError}).`) : null,
    h(
      "div",
      { class: "row" },
      ...TABS.map((t) =>
        h("button", {
          class: `btn small ${tab === t.id ? "on" : ""}`,
          onclick: () => {
            tab = t.id;
            app.render();
          },
        }, t.label)
      ),
    ),
    ...body,
  );
  startCountdowns(root);
  return root;
}

// ------------------------------------------------------------------ header
function walletBar(m: MarketStore, p: Profile): HTMLElement {
  const listed = m.house.listings({ sellerId: p.id, status: "open" }).length;
  const items = Object.values(m.inventory(p.id)).reduce((s, q) => s + q, 0);
  return h(
    "div",
    { class: "row" },
    h(
      "span",
      { class: "chip", title: "Available credits: the house is the bank" },
      `💰 ${fmt(m.balance(p.id))} credits`,
    ),
    h(
      "span",
      { class: "chip", title: "Credits locked as your leading bids (refunded if outbid)" },
      `🔒 ${fmt(m.escrowed(p.id))} in bids`,
    ),
    h("span", { class: "chip", title: "Your open lots" }, `📦 ${listed} listed`),
    h("span", { class: "chip", title: "Items you hold at the market" }, `🎒 ${fmt(items)} items`),
  );
}

// ------------------------------------------------------------------ browse
function browseTab(app: App, m: MarketStore, now: number): HTMLElement {
  const filter: ListingFilter = { status: "open" };
  if (kindFilter !== "all") filter.kind = kindFilter;
  if (sellerFilter !== "all") filter.sellerKind = sellerFilter;
  const open = m.house.listings(filter).filter((l) => l.endsAt > now);
  open.sort((a, b) => promoLive(b, now) - promoLive(a, now) || a.endsAt - b.endsAt);
  const kinds: { value: ItemKind | "all"; label: string }[] = [
    { value: "all", label: "All kinds" },
    ...ITEM_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] })),
  ];
  const sellers: { value: SellerKind | "all"; label: string }[] = [
    { value: "all", label: "All sellers" },
    { value: "company", label: "Companies" },
    { value: "npc", label: "NPC traders" },
    { value: "player", label: "Players" },
  ];
  return section(
    `Open lots · ${open.length}`,
    h(
      "div",
      { class: "grid2" },
      h(
        "label",
        { class: "field" },
        "Item kind",
        select<ItemKind | "all">(kinds, kindFilter, (v) => {
          kindFilter = v;
          app.render();
        }),
      ),
      h(
        "label",
        { class: "field" },
        "Seller",
        select<SellerKind | "all">(sellers, sellerFilter, (v) => {
          sellerFilter = v;
          app.render();
        }),
      ),
    ),
    open.length > 0
      ? h("div", { class: "cards" }, ...open.slice(0, MAX_CARDS).map((l) => lotCard(app, m, l, now)))
      : h(
        "p",
        { class: "muted" },
        "Nothing on sale with these filters right now. Companies restock every 5 minutes.",
      ),
    open.length > MAX_CARDS
      ? h(
        "p",
        { class: "muted" },
        `Showing ${MAX_CARDS} of ${open.length}: narrow the filters to see the rest.`,
      )
      : null,
  );
}

function lotCard(app: App, m: MarketStore, l: Listing, now: number): HTMLElement {
  const p = app.profile;
  const def = m.describe(l.itemId);
  const q = m.house.quote(l.id, now);
  const name = lotName(l, def);
  const seller = m.party(l.sellerId);
  const mine = l.sellerId === p.id;
  const leading = l.bidderId === p.id;
  const minBid = q?.minBid ?? l.startPrice;
  const buyNow = q?.buyout ?? null;
  const amount = creditsInput({
    value: minBid,
    title: "Your bid for the whole lot (the minimum is prefilled)",
    "aria-label": `Bid on ${name}`,
  });
  const bid = () =>
    act(app, () => {
      const v = Number(amount.value);
      if (!Number.isInteger(v) || v < 1) throw new Error("Enter a whole number of credits.");
      const after = m.bid(p, l.id, v, Date.now());
      if (after.status === "sold") {
        return `Bought ${name} for ${fmt(after.finalPrice ?? v)} credits: your bid reached the buyout.${
          joinNote(l)
        }`;
      }
      return `You lead ${name} with ${fmt(v)} credits${
        after.extensions > l.extensions ? " (+30 s anti-sniping)" : ""
      }.`;
    });
  const buy = () =>
    act(app, () => {
      const after = m.buyout(p, l.id, Date.now());
      return `Bought ${name} for ${fmt(after.finalPrice ?? 0)} credits.${joinNote(l)}`;
    });
  return h(
    "div",
    { class: `gcard ${leading ? "sel" : ""}`, title: def?.note ?? "" },
    h("span", { class: "swatch", vars: { sw: swatchOf(m, l.itemId, def) } }),
    h("span", { class: "name" }, name),
    tagRow(m, l.itemId, def),
    h("span", { class: "chip", title: seller.note }, `${seller.icon} ${seller.name}${mine ? " (you)" : ""}`),
    h(
      "span",
      { class: "mono" },
      l.currentBid !== null
        ? `Bid ${fmt(l.currentBid)} · ${l.bidCount} bid${l.bidCount > 1 ? "s" : ""}`
        : `Start ${fmt(l.startPrice)}`,
    ),
    buyNow !== null
      ? h(
        "span",
        { class: "mono" },
        `Buyout ${fmt(buyNow)}${q?.promoActive && l.buyout !== null ? ` (was ${fmt(l.buyout)})` : ""}`,
      )
      : h("span", { class: "muted" }, "Auction only (no buyout)"),
    h("span", { class: "muted" }, "⏱ ", countdown(l.endsAt, now), ` · fair ${fmt(q?.fair ?? 0)}`),
    promoBadge(l, now),
    leading ? h("span", { class: "muted" }, "★ You lead") : null,
    mine ? h("span", { class: "muted" }, "Your lot: manage it in My listings") : h(
      "span",
      { class: "row" },
      amount,
      h("button", { class: "btn small", onclick: bid }, "Bid"),
      buyNow !== null
        ? h("button", { class: "btn small primary", onclick: buy }, `Buy ${fmt(buyNow)}`)
        : null,
    ),
  );
}

function promoBadge(l: Listing, now: number): HTMLElement | null {
  const pr = l.promo;
  if (!pr || l.buyout === null || now >= pr.endsAt) return null;
  const pct = `-${Math.round(pr.discount * 100)}%`;
  return h(
    "span",
    { class: "el", vars: { el: PROMO_COLOR }, title: `${pct} on the buyout while the promotion runs` },
    `🔥 ${pr.label.includes("%") ? pr.label : `${pr.label} ${pct}`} · `,
    countdown(pr.endsAt, now, "over"),
  );
}

// ------------------------------------------------------------------ sell
function sellTab(app: App, m: MarketStore): HTMLElement {
  const p = app.profile;
  let pick: HTMLElement;
  let suggestion: number | null = null;
  let post: (() => string) | null = null;
  if (sellMode === "genemon") {
    const free = p.collection.filter((g) => !p.team.includes(g.id));
    const g = free.find((x) => x.id === sellGenemonId) ?? null;
    if (!g) sellGenemonId = null;
    pick = free.length > 0
      ? h(
        "div",
        { class: "cards" },
        ...free.map((x) =>
          genemonCard(x, {
            selected: x.id === sellGenemonId,
            onClick: () => {
              sellGenemonId = x.id;
              sellStart = null;
              app.render();
            },
          })
        ),
      )
      : h(
        "p",
        { class: "muted" },
        "Every Genemon you own is in your team. Remove one in the Team screen to sell it.",
      ); // team members are never listed
    if (g) {
      suggestion = m.appraise(g);
      post = () => {
        const l = m.sellGenemon(p, g.id, sellStart ?? suggestion ?? 0, sellBuyout, sellDuration, Date.now());
        sellGenemonId = null;
        return `${g.name} is on the market (${l.id}) for ${
          durationLabel(sellDuration)
        }; it waits in escrow until the lot closes.`;
      };
    }
  } else {
    const held = Object.entries(m.inventory(p.id)).filter(([id]) => !isGenemonItem(id));
    if (held.length === 0) {
      sellItemId = null;
      pick = h(
        "p",
        { class: "muted" },
        "You hold no items at the market yet. Buy some in Browse, then resell them here.",
      );
    } else {
      if (!sellItemId || !held.some(([id]) => id === sellItemId)) {
        sellItemId = held[0][0];
        sellQty = 1;
        sellStart = null;
      }
      const itemId = sellItemId;
      const have = held.find(([id]) => id === itemId)?.[1] ?? 1;
      const def = m.describe(itemId);
      sellQty = def?.stackable ? Math.max(1, Math.min(have, sellQty)) : 1;
      pick = h(
        "div",
        { class: "grid2" },
        h(
          "label",
          { class: "field" },
          "Item",
          select(
            held.map(([id, n]) => ({ value: id, label: `${m.describe(id)?.name ?? id} × ${n}` })),
            itemId,
            (v) => {
              sellItemId = v;
              sellQty = 1;
              sellStart = null;
              app.render();
            },
          ),
        ),
        h(
          "label",
          { class: "field" },
          `Quantity (you hold ${have})`,
          creditsInput({
            value: sellQty,
            disabled: !def?.stackable,
            title: def?.stackable
              ? "Units in the lot: every price is for the whole lot"
              : "Sold one unit at a time",
            onchange: (e: Event) => {
              sellQty = wholeOrNull((e.target as HTMLInputElement).value) ?? 1;
              sellStart = null;
              app.render();
            },
          }),
        ),
      );
      suggestion = m.suggestStart(itemId, sellQty);
      post = () => {
        const qty = sellQty;
        const l = m.sellItem(
          p,
          itemId,
          qty,
          sellStart ?? suggestion ?? 0,
          sellBuyout,
          sellDuration,
          Date.now(),
        );
        return `Listed ${qty > 1 ? `${qty} × ` : ""}${def?.name ?? itemId} (${l.id}) for ${
          durationLabel(sellDuration)
        }.`;
      };
    }
  }
  const doPost = post;
  const fee = Math.round(m.house.feeRate * 100);
  return section(
    "Sell",
    h(
      "div",
      { class: "row" },
      modeButton(app, "genemon", "A Genemon"),
      modeButton(app, "item", "An item"),
    ),
    sellMode === "genemon"
      ? h(
        "p",
        { class: "muted" },
        "Only Genemon outside your team can be sold. While listed it leaves your collection: sold to another " +
          "profile it joins theirs, sold to an NPC trader it leaves this device, unsold or cancelled it comes back.",
      )
      : null,
    pick,
    h(
      "div",
      { class: "grid3" },
      h(
        "label",
        { class: "field" },
        "Start price",
        creditsInput({
          value: sellStart ?? suggestion ?? "",
          title: sellMode === "genemon" ? "Prefilled with the appraisal" : "Prefilled with the market median",
          oninput: (e: Event) => {
            sellStart = wholeOrNull((e.target as HTMLInputElement).value);
          },
        }),
      ),
      h(
        "label",
        { class: "field" },
        "Buyout (optional)",
        creditsInput({
          value: sellBuyout ?? "",
          placeholder: suggestion ? `e.g. ${Math.round(suggestion * 1.5)}` : "none",
          oninput: (e: Event) => {
            sellBuyout = wholeOrNull((e.target as HTMLInputElement).value);
          },
        }),
      ),
      h(
        "label",
        { class: "field" },
        "Duration",
        select(
          SALE_DURATIONS.map((d) => ({ value: String(d.ms), label: d.label })),
          String(sellDuration),
          (v) => {
            sellDuration = Number(v);
          },
        ),
      ),
    ),
    suggestion !== null
      ? h(
        "p",
        { class: "muted" },
        `Suggested start: ${
          fmt(suggestion)
        } credits. The house keeps ${fee} % (rounded up) of the sale price.`,
      )
      : null,
    h("button", {
      class: "btn primary",
      disabled: !doPost,
      onclick: doPost
        ? () =>
          act(app, () => {
            const msg = doPost();
            sellStart = null;
            sellBuyout = null;
            tab = "mine";
            return msg;
          })
        : undefined,
    }, "Post listing"),
  );
}

function modeButton(app: App, mode: "genemon" | "item", label: string): HTMLElement {
  return h("button", {
    class: `btn small ${sellMode === mode ? "on" : ""}`,
    onclick: () => {
      sellMode = mode;
      sellStart = null;
      app.render();
    },
  }, label);
}

// ------------------------------------------------------------------ my listings
function mineTab(app: App, m: MarketStore, now: number): HTMLElement[] {
  const me = app.profile.id;
  const all = m.house.listings();
  const mine = all.filter((l) => l.sellerId === me && l.status === "open");
  const leading = all.filter((l) => l.status === "open" && l.bidderId === me);
  const closed = all
    .filter((l) => l.status !== "open" && (l.sellerId === me || l.buyerId === me))
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    .slice(0, 15);
  const waiting = m.escrowedGenemon(me).length;
  return [
    section(
      `Your open lots · ${mine.length}`,
      waiting > 0 ? h("p", { class: "muted" }, `${waiting} of your Genemon wait in escrow.`) : null,
      mine.length > 0
        ? h("div", { class: "cards" }, ...mine.map((l) => myLotCard(app, m, l, now)))
        : h("p", { class: "muted" }, "Nothing listed. Use the Sell tab."),
    ),
    section(
      `Lots you lead · ${leading.length}`,
      leading.length > 0
        ? h(
          "table",
          { class: "t" },
          h("tr", {}, h("th", {}, "Lot"), h("th", {}, "Your bid"), h("th", {}, "Ends in")),
          ...leading.map((l) =>
            h(
              "tr",
              {},
              h("td", {}, lotName(l, m.describe(l.itemId))),
              h("td", { class: "mono" }, fmt(l.currentBid ?? 0)),
              h("td", {}, countdown(l.endsAt, now)),
            )
          ),
        )
        : h(
          "p",
          { class: "muted" },
          "You lead no auction. Your credits in bids are refunded at once if someone outbids you.",
        ),
    ),
    section(
      "Recent settlements",
      closed.length > 0
        ? h(
          "table",
          { class: "t" },
          h(
            "tr",
            {},
            h("th", {}, "When"),
            h("th", {}, "Lot"),
            h("th", {}, "Outcome"),
            h("th", {}, "Credits"),
          ),
          ...closed.map((l) => settlementRow(m, l, me)),
        )
        : h("p", { class: "muted" }, "No settled lot yet."),
    ),
  ];
}

function myLotCard(app: App, m: MarketStore, l: Listing, now: number): HTMLElement {
  const def = m.describe(l.itemId);
  const q = m.house.quote(l.id, now);
  const name = lotName(l, def);
  const hasBids = l.currentBid !== null;
  const cancel = () =>
    act(app, () => {
      m.cancel(app.profile, l.id, Date.now());
      return `${name}: lot withdrawn, ${
        isGenemonItem(l.itemId) ? "the Genemon is back in your collection" : "back in your market bag"
      }.`;
    });
  return h(
    "div",
    { class: "gcard" },
    h("span", { class: "swatch", vars: { sw: swatchOf(m, l.itemId, def) } }),
    h("span", { class: "name" }, name),
    tagRow(m, l.itemId, def),
    h(
      "span",
      { class: "mono" },
      hasBids
        ? `Bid ${fmt(l.currentBid ?? 0)} by ${m.party(l.bidderId ?? "").name} · ${l.bidCount} bid${
          l.bidCount > 1 ? "s" : ""
        }`
        : `Start ${fmt(l.startPrice)} · no bid yet`,
    ),
    q?.buyout != null ? h("span", { class: "mono" }, `Buyout ${fmt(q.buyout)}`) : null,
    h(
      "span",
      { class: "muted" },
      "⏱ ",
      countdown(l.endsAt, now),
      l.extensions > 0 ? ` · extended ${l.extensions}× by late bids` : "",
    ),
    h("button", {
      class: "btn small",
      disabled: hasBids,
      title: hasBids ? "A lot with bids cannot be cancelled" : "Withdraw this lot",
      onclick: cancel,
    }, "Cancel"),
  );
}

function settlementRow(m: MarketStore, l: Listing, me: string): HTMLElement {
  const name = lotName(l, m.describe(l.itemId));
  const price = l.finalPrice ?? 0;
  let outcome = "Cancelled", credits = "0";
  if (l.status === "sold" && l.sellerId === me) {
    outcome = `Sold to ${m.party(l.buyerId ?? "").name}`;
    credits = `+${fmt(m.proceeds(price))}`;
  } else if (l.status === "sold") {
    outcome = `Bought from ${m.party(l.sellerId).name}`;
    credits = `−${fmt(price)}`;
  } else if (l.status === "expired") {
    outcome = "Expired: returned";
  }
  return h(
    "tr",
    {},
    h("td", { class: "mono" }, l.closedAt !== null ? whenLabel(l.closedAt) : "-"),
    h("td", {}, name),
    h("td", {}, outcome),
    h("td", { class: "mono" }, credits),
  );
}

// ------------------------------------------------------------------ history
function historyTab(app: App, m: MarketStore, now: number): HTMLElement[] {
  const ids = m.tradedItems();
  const books = booksSection(m, now);
  if (ids.length === 0) {
    return [
      section(
        "Price history",
        h("p", { class: "muted" }, "No lot has sold yet: prices appear with the first sale."),
      ),
      books,
    ];
  }
  if (!historyItem || !ids.includes(historyItem)) historyItem = ids[0];
  const id = historyItem;
  const def = m.describe(id);
  const pts = m.house.priceHistory(id);
  const st = m.house.stats(id);
  const canvas = h("canvas", { class: "chart" });
  queueMicrotask(() =>
    requestAnimationFrame(() => {
      if (!canvas.isConnected) return;
      const values = pts.map((x) => x.price);
      // The median always lies inside the price range (a list-price line would sit on the frame).
      const mid = st.median ?? values[0];
      lineChart(canvas, [
        { values, color: "#f15bb5", label: "unit price" },
        { values: values.map(() => mid), color: "#8d99ae", label: "median" },
      ]);
    })
  );
  const money = (v: number | null) => (v === null ? "-" : fmt(v, Number.isInteger(v) ? 0 : 2));
  return [
    section(
      "Price history",
      h(
        "label",
        { class: "field" },
        "Item",
        select(
          ids.map((x) => ({
            value: x,
            label: `${m.describe(x)?.name ?? x} · ${m.house.priceHistory(x).length} trades`,
          })),
          id,
          (v) => {
            historyItem = v;
            app.render();
          },
        ),
      ),
      canvas,
      h(
        "p",
        { class: "muted" },
        pts.length < 2
          ? "A single trade so far: the line starts with the second."
          : `${pts.length} trades, ${whenLabel(pts[0].t)} → ${
            whenLabel(pts[pts.length - 1].t)
          } (unit prices).`,
      ),
      h(
        "dl",
        { class: "kv" },
        ...kv("Median", money(st.median), "Per unit, robust to outliers"),
        ...kv(
          "Volatility",
          `${(st.volatility * 100).toFixed(1)} %`,
          "RMS of log returns between consecutive trades",
        ),
        ...kv("Volume", `${fmt(st.volume)} units`),
        ...kv("Last", money(st.last)),
        ...kv("Mean", money(st.mean)),
        ...kv("Trades", fmt(st.trades)),
        ...kv("Fair value", fmt(m.house.fairValue(id)), "What NPC traders value one unit at"),
        ...kv("List price", def ? fmt(def.basePrice) : "-"),
      ),
    ),
    books,
  ];
}

function booksSection(m: MarketStore, now: number): HTMLElement {
  const s = m.house.moneySupply();
  const open = m.house.listings({ status: "open" });
  const promos = open.filter((l) => l.promo && now < l.promo.endsAt).length;
  return section(
    "House books",
    h(
      "dl",
      { class: "kv" },
      ...kv("Open lots", `${open.length} (${promos} on promotion)`),
      ...kv("Credits in wallets", fmt(s.wallets)),
      ...kv("Locked in bids", fmt(s.escrow)),
      ...kv("Treasury (fees)", fmt(s.treasury)),
      ...kv("Minted / withdrawn", `${fmt(s.minted)} / ${fmt(s.withdrawn)}`),
      ...kv(
        "Conservation",
        s.balanced ? "balanced ✓" : "UNBALANCED ✗",
        "wallets + escrow + treasury = minted - withdrawn",
      ),
      ...kv(
        "Next round",
        formatCountdown(m.lastRound + ROUND_MS - now, "due"),
        "Restock + NPC traders every 5 minutes",
      ),
    ),
  );
}

// ------------------------------------------------------------------ shared bits
function lotName(l: Listing, def: ItemDef | undefined): string {
  return `${l.qty > 1 ? `${l.qty} × ` : ""}${def?.name ?? l.itemId}`;
}

function tagRow(m: MarketStore, itemId: string, def: ItemDef | undefined): HTMLElement {
  return h(
    "span",
    { class: "row" },
    h("span", { class: "size" }, def ? KIND_LABEL[def.kind] : "?"),
    def ? h("span", { class: "el", vars: { el: RARITY_COLOR[def.rarity] } }, def.rarity) : null,
    ...genemonBits(m, itemId),
  );
}

const isElement = (x: unknown): x is ElementId => typeof x === "string" && Object.hasOwn(ELEMENTS, x);

/** Element chips + level of a Genemon lot (from the escrowed creature, else the appraisal facts). */
function genemonBits(m: MarketStore, itemId: string): HTMLElement[] {
  if (!isGenemonItem(itemId)) return [];
  const e = m.escrowEntry(itemId);
  if (e) {
    const ph = phenotypeOf(e.genemon);
    return [
      elChip(ph.elements.primary),
      ...(ph.elements.secondary ? [elChip(ph.elements.secondary)] : []),
      h("span", { class: "muted" }, `Lv ${ph.level}`),
    ];
  }
  const fx = m.describe(itemId)?.effects ?? {};
  const out: HTMLElement[] = [];
  if (isElement(fx.primary)) out.push(elChip(fx.primary));
  if (isElement(fx.secondary)) out.push(elChip(fx.secondary));
  if (typeof fx.level === "number") out.push(h("span", { class: "muted" }, `Lv ${fx.level}`));
  return out;
}

function swatchOf(m: MarketStore, itemId: string, def: ItemDef | undefined): string {
  const e = isGenemonItem(itemId) ? m.escrowEntry(itemId) : undefined;
  if (e) return hex(phenotypeOf(e.genemon).palette.base);
  return def ? RARITY_COLOR[def.rarity] : "#888888";
}

function joinNote(l: Listing): string {
  return isGenemonItem(l.itemId) ? " It joined your collection." : " It is in your market bag.";
}

function kv(k: string, v: string, title = ""): HTMLElement[] {
  return [h("dt", { title }, k), h("dd", {}, v)];
}

function countdown(endsAt: number, now: number, done?: string): HTMLElement {
  return h(
    "span",
    { class: "mono", "data-ends": endsAt, "data-done": done },
    formatCountdown(endsAt - now, done),
  );
}

function promoLive(l: Listing, now: number): number {
  return l.promo && l.buyout !== null && now < l.promo.endsAt ? 1 : 0;
}

function durationLabel(ms: number): string {
  return SALE_DURATIONS.find((d) => d.ms === ms)?.label ?? formatCountdown(ms);
}

function whenLabel(t: number): string {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * A whole-number field. type=text + inputmode=numeric (numeric keypad on phones) because `size` sets
 * the width of text inputs only: a type=number box is ~186 px wide and overflows a 181 px lot card.
 */
function creditsInput(attrs: Record<string, unknown>): HTMLInputElement {
  return h("input", { type: "text", inputmode: "numeric", autocomplete: "off", size: 7, ...attrs });
}

/** "" -> null; otherwise the number, floored (the house refuses 0 or less with a readable code). */
function wholeOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

/** Run a market action, toast the outcome (or a readable refusal), re-render. */
function act(app: App, run: () => string): void {
  try {
    toast(run(), 3400);
  } catch (e) {
    toast(marketErrorText(e), 4500);
  }
  app.render();
}

// ------------------------------------------------------------------ timers
/** One interval per rendered panel: refresh every [data-ends] text each second; stops once detached. */
function startCountdowns(root: HTMLElement): void {
  const timer = setInterval(() => {
    if (!root.isConnected) {
      clearInterval(timer);
      return;
    }
    const now = Date.now();
    for (const el of root.querySelectorAll<HTMLElement>("[data-ends]")) {
      el.textContent = formatCountdown(Number(el.dataset.ends) - now, el.dataset.done);
    }
  }, 1000);
}

/** The market heartbeat (every 5 s) while the Market screen is open; it clears itself on leaving. */
function ensureLive(app: App): void {
  if (liveTimer !== undefined) return;
  liveTimer = setInterval(() => {
    if (app.screen !== "market") {
      clearInterval(liveTimer);
      liveTimer = undefined;
      refreshPending = false;
      return;
    }
    let changed = false;
    try {
      changed = getMarket(app).live(app.profile, Date.now()).changed;
    } catch (e) {
      console.warn("market: live step failed", e);
    }
    if (changed || refreshPending) refresh(app);
  }, LIVE_MS);
}

/** Re-render with the scroll kept; postponed while the player is typing in the panel. */
function refresh(app: App): void {
  const panel = document.getElementById("panel");
  const focus = document.activeElement;
  if (panel && focus && panel.contains(focus) && /^(INPUT|SELECT|TEXTAREA)$/.test(focus.tagName)) {
    refreshPending = true;
    return;
  }
  refreshPending = false;
  const y = panel?.scrollTop ?? 0;
  app.render();
  if (panel) panel.scrollTop = y;
}
