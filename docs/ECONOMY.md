# Genemon economy: credits, items, auction house

**Summary (read this first)**

1. One deterministic **auction house** (`src/economy/market.ts`) holds every wallet, inventory and escrow. Companies, NPC traders and players all trade through it, for integer **credits**.
2. **63 catalogue items** (`src/economy/items.ts`): the 14 lifestyle foods at their `FOODS` price, plus 49 others (potions, one lure per element, one egg per rarity, stones, cosmetics, flags, incubators, tickets, maps). A Genemon trades as the unique item `genemon:<id>`, priced by `appraiseGenemon`.
3. **Auctions:** the minimum raise is 5 %, an outbid bidder is refunded at once, and a bid in the last 30 s adds 30 s. The seller pays a 5 % fee, rounded up, which goes to the treasury. Buyouts are allowed, and only companies can run flash promotions (-10..40 % for 5-30 min).
4. **Four NPC personalities** trade on a *fair value*: the list price blended with the trade median, clamped to 0.5-3x list. They are the bargain hunter, the collector, the flipper and the forager. Each NPC draws from its own seeded stream, so the same seed gives a byte-identical market.
5. **Status:** the model exists and is tested: 17 tests pass, and each of 18 seeded rule mutations is caught by at least one test. It is **not wired** into the engine or the UI yet; see [Integration requests](#integration-requests).

---

## 1. Files and status

| File | Owns | Status |
|---|---|---|
| `src/economy/items.ts` | `ITEMS`, `ITEM_IDS`, rarity tables, `appraiseGenemon`, `genemonItemDef`, `itemDef` | TESTED, not integrated |
| `src/economy/market.ts` | `AuctionHouse`, `COMPANIES`, `NPC_TRADERS`, `MarketError`, rule constants | TESTED, not integrated |
| `tests/market_test.ts` | 17 tests (rule → test map in section 13) | 17/17 pass (`deno test --allow-read tests/market_test.ts`) |
| `docs/ECONOMY.md` | this file | - |

Both modules are pure: no DOM, no clock, and no `Math.random`. Every time is a `now` parameter in ms, and every draw comes from `Rng(seed)`.

## 2. Currency

- **Credits** are the only currency. They are integers in `1..MAX_CREDITS` (1e11) per amount, and the house holds them.
  - `balance(id)` is the *available* amount.
  - `escrowed(id)` is the amount locked as the leading bid on open listings.
- **Faucets** (credits enter):
  - `deposit(id, n, now, why)`: quest and battle rewards, starter grants.
  - The NPC **liquidity refill**: when an NPC wallet falls under half its `floor`, the house tops it back up to the floor. Each refill is logged as `market.deposit` with `why: "<personality> liquidity budget"`.
- **Sinks** (credits leave circulation):
  - `withdraw` covers fixed-price shops and entry fees.
  - The **seller fee** goes to `treasury`.
  - **Company revenue** sits idle in company wallets, because companies never buy.
- **Conservation invariant** (`moneySupply().balanced`): `wallets + escrow + treasury === minted - withdrawn`. Asserted in tests, including after full NPC simulations.

### NFT / real money: out of scope

Credits are a **closed-loop, non-redeemable** game currency. A Genemon's genome id gives it a stable, verifiable identity (NFT-*style* uniqueness). The market enforces uniqueness itself (`duplicate-unique`), with no blockchain.

Buying credits with money, cashing out, or minting creatures on a chain would each bring legal exposure:

- Paid random items such as eggs are treated as loot boxes, which some jurisdictions regulate as gambling and many require odds disclosure for.
- Transferable value raises payment, AML and KYC duties.
- Tokens can raise crypto-asset rules, depending on the design.
- There are consumer-protection rules for minors, app-store policies on loot boxes and NFTs, and tax.

**This is not legal advice. Get counsel before designing any of it.** Until then the module has no cash-in and no cash-out path, by design.

## 3. Item catalogue

Generated from `ITEMS` with the snippet in section 14; do not hand-edit the numbers. Prices are per unit. "stack" means the item can be listed as a bundle (`qty > 1`).

| id | name | kind | price | rarity | stack | effects |
|---|---|---|---:|---|:-:|---|
| `food.berries` | Wild berries | food | 4 | common | yes | food=berries, nutrition=1, joy=0.05 |
| `food.greens` | Leafy greens | food | 3 | common | yes | food=greens, nutrition=1, joy=0.01 |
| `food.meat` | Meat | food | 9 | common | yes | food=meat, nutrition=2, joy=0.04 |
| `food.fish` | Fish | food | 8 | common | yes | food=fish, nutrition=1.6, joy=0.04 |
| `food.honey` | Honey | food | 7 | common | yes | food=honey, nutrition=1.2, joy=0.08 |
| `food.spicyPepper` | Spicy pepper | food | 5 | common | yes | food=spicyPepper, nutrition=0.5, joy=0.02 |
| `food.minerals` | Mineral lick | food | 6 | common | yes | food=minerals, nutrition=0.4, joy=0 |
| `food.mushroom` | Cave mushroom | food | 6 | common | yes | food=mushroom, nutrition=0.8, joy=0.02 |
| `food.candy` | Candy | food | 2 | common | yes | food=candy, nutrition=0.6, joy=0.12 |
| `food.seaweed` | Seaweed | food | 5 | common | yes | food=seaweed, nutrition=0.8, joy=0.01 |
| `food.iceCream` | Ice cream | food | 4 | common | yes | food=iceCream, nutrition=0.7, joy=0.1 |
| `food.coffeeBean` | Coffee bean | food | 5 | common | yes | food=coffeeBean, nutrition=0.2, joy=0.03 |
| `food.glowFruit` | Glow fruit | food | 14 | uncommon | yes | food=glowFruit, nutrition=1, joy=0.06 |
| `food.ashRoot` | Ash root | food | 16 | uncommon | yes | food=ashRoot, nutrition=0.9, joy=0 |
| `potion.heal` | Healing tonic | potion | 12 | common | yes | heal=0.35 |
| `potion.fullHeal` | Phoenix draught | potion | 60 | rare | yes | heal=1 |
| `potion.energy` | Energy drink | potion | 10 | common | yes | energy=40 |
| `potion.surge` | Surge elixir | potion | 35 | uncommon | yes | energy=100, regenBoost=0.5, durationS=30 |
| `potion.cleanse` | Cleansing salts | potion | 18 | uncommon | yes | cleanse=all, immunityS=5 |
| `potion.revive` | Revival seed | potion | 80 | rare | yes | revive=0.5 |
| `lure.neutral` | Plain lure | lure | 15 | common | yes | element=neutral, spawnBias=0.35, durationMin=30, radiusM=40 |
| `lure.fire` | Fire lure | lure | 25 | common | yes | element=fire, spawnBias=0.35, durationMin=30, radiusM=40 |
| `lure.water` | Water lure | lure | 25 | common | yes | element=water, spawnBias=0.35, durationMin=30, radiusM=40 |
| `lure.plant` | Plant lure | lure | 25 | common | yes | element=plant, spawnBias=0.35, durationMin=30, radiusM=40 |
| `lure.earth` | Earth lure | lure | 25 | common | yes | element=earth, spawnBias=0.35, durationMin=30, radiusM=40 |
| `lure.air` | Air lure | lure | 25 | common | yes | element=air, spawnBias=0.35, durationMin=30, radiusM=40 |
| `lure.electric` | Electric lure | lure | 35 | uncommon | yes | element=electric, spawnBias=0.35, durationMin=30, radiusM=40 |
| `lure.ice` | Ice lure | lure | 35 | uncommon | yes | element=ice, spawnBias=0.35, durationMin=30, radiusM=40 |
| `lure.metal` | Metal lure | lure | 35 | uncommon | yes | element=metal, spawnBias=0.35, durationMin=30, radiusM=40 |
| `lure.poison` | Poison lure | lure | 35 | uncommon | yes | element=poison, spawnBias=0.35, durationMin=30, radiusM=40 |
| `lure.light` | Light lure | lure | 60 | rare | yes | element=light, spawnBias=0.35, durationMin=30, radiusM=40 |
| `lure.shadow` | Shadow lure | lure | 60 | rare | yes | element=shadow, spawnBias=0.35, durationMin=30, radiusM=40 |
| `lure.psychic` | Psychic lure | lure | 60 | rare | yes | element=psychic, spawnBias=0.35, durationMin=30, radiusM=40 |
| `lure.void` | Void lure | lure | 120 | epic | yes | element=void, spawnBias=0.35, durationMin=30, radiusM=40 |
| `egg.common` | Common egg | egg | 40 | common | yes | hatchKm=2, minQuality=0.3, mutationChance=0.01 |
| `egg.uncommon` | Uncommon egg | egg | 110 | uncommon | yes | hatchKm=5, minQuality=0.42, mutationChance=0.02 |
| `egg.rare` | Rare egg | egg | 300 | rare | yes | hatchKm=7, minQuality=0.55, mutationChance=0.04 |
| `egg.epic` | Epic egg | egg | 850 | epic | yes | hatchKm=10, minQuality=0.68, mutationChance=0.07 |
| `egg.legendary` | Legendary egg | egg | 2400 | legendary | yes | hatchKm=15, minQuality=0.82, mutationChance=0.12 |
| `stone.evolution` | Evolution stone | stone | 250 | rare | yes | evolve=1, minGrowth=0.6 |
| `stone.everstone` | Everstone | stone | 60 | uncommon | yes | lockStage=1 |
| `stone.voidShard` | Void shard | stone | 600 | epic | yes | mutate=0.3, focus=substance,phase,luminance |
| `stone.fusionCore` | Fusion core | stone | 2500 | legendary | yes | fuse=1, consumes=2 |
| `stone.prism` | Prism shard | stone | 300 | rare | yes | rerollPattern=1 |
| `stone.helixKey` | Helix key | stone | 900 | epic | yes | mutationRateMult=1.5 |
| `cosmetic.scarf` | Woolly scarf | cosmetic | 30 | common | no | slot=neck, style=wool |
| `cosmetic.glowPaint` | Glow paint | cosmetic | 90 | uncommon | no | slot=body, glow=0.3 |
| `cosmetic.crown` | Tiny crown | cosmetic | 350 | rare | no | slot=head, style=gold-crown |
| `cosmetic.goldPlate` | Gold nameplate | cosmetic | 260 | rare | no | slot=nameplate, style=gold |
| `cosmetic.starTrail` | Star trail | cosmetic | 800 | epic | no | slot=trail, particles=24 |
| `flag.wood` | Wooden flag | territoryFlag | 50 | common | yes | claimRadiusM=25, holdHours=12, defenseBonus=0 |
| `flag.iron` | Iron banner | territoryFlag | 180 | uncommon | yes | claimRadiusM=50, holdHours=24, defenseBonus=0.05 |
| `flag.crystal` | Crystal standard | territoryFlag | 1400 | epic | yes | claimRadiusM=120, holdHours=72, defenseBonus=0.12 |
| `incubator.basic` | Basic incubator | incubator | 60 | common | no | uses=3, speed=1 |
| `incubator.super` | Super incubator | incubator | 200 | uncommon | no | uses=3, speed=1.5 |
| `incubator.thermal` | Thermal incubator | incubator | 450 | rare | no | uses=1, speed=1, element=fire, mutationChance=0.05 |
| `ticket.arenaBronze` | Bronze cup pass | ticket | 40 | common | yes | arenaTier=1, entries=1 |
| `ticket.arenaGold` | Gold cup pass | ticket | 300 | rare | yes | arenaTier=3, entries=1 |
| `ticket.crystalCave` | Crystal cave pass | ticket | 120 | uncommon | yes | dungeon=crystal-cave, entries=1, durationMin=30 |
| `ticket.voidAbyss` | Void abyss pass | ticket | 900 | epic | yes | dungeon=void-abyss, entries=1, durationMin=20 |
| `map.tornTreasure` | Torn treasure map | map | 80 | uncommon | no | lootTier=1, radiusKm=2 |
| `map.nest` | Nest map | map | 260 | rare | no | revealsNest=1, durationH=6 |
| `map.ancientTreasure` | Ancient treasure map | map | 1100 | epic | no | lootTier=3, radiusKm=10 |

Counts by kind: food 14, potion 6, lure 14, egg 5, stone 6, cosmetic 5, territoryFlag 3, incubator 3, ticket 4, map 3, for 63 in total. Genemon items are dynamic and are never in `ITEMS`.

**How effects connect to the rest of the game.** `effects` is a flat bag; the consuming system reads it:

| Effect | Consumer |
|---|---|
| `food` | `genemon.feed(g, effects.food)` |
| `stone.voidShard` | `breeding.mutate(genome, seed, 0.3, focus axes)` |
| `stone.fusionCore` | `breeding.fuse` |
| `stone.helixKey` | multiplies `BreedOptions.mutationRate` |
| lures, flags, maps | the world designer's spawn, claim and loot rules |
| tickets | the arena and dungeon entry rules |
| cosmetics | visual only (no stats, to stay out of pay-to-win) |

**Element rarity** (drives lure prices and appraisal):

| Rarity | Elements | Value multiplier |
|---|---|---|
| common | neutral, fire, water, plant, earth, air | x1 |
| uncommon | electric, ice, metal, poison | x1.3 |
| rare | light, shadow, psychic | x1.75 |
| epic | void | x2.4 |
| legendary | none | x3.5 |

## 4. Auction rules

| Rule | Value | Code |
|---|---|---|
| Lot pricing | Every price on a listing (start, buyout, bids) is for the **whole lot** (`qty` units); history and stats are **per unit** | `Listing.qty`, `priceHistory` |
| Durations | 1 min .. 7 days for anyone; company lots last 2 h, NPC lots 1-3 h | `MIN/MAX_DURATION_MS` |
| Opening bid | `>= startPrice` | `#minBid` |
| Min raise | `currentBid + max(1, ceil(currentBid x 5 %))`, e.g. 100 → 105, 105 → 111 | `MIN_INCREMENT_BPS` |
| Bid at or above buyout | Becomes a **buyout at the buyout price**; you never pay your higher bid | `#bid` |
| Escrow | Posting removes the items from the seller's inventory (companies: infinite stock, nothing removed); bidding removes credits from the wallet; raising your own lead only charges the difference | `post`, `bid` |
| Outbid | The previous leader is refunded **in full at once** (`market.bid` row: `exits.refundTo/refundAmount`) | `#bid` |
| Anti-sniping | A bid with `endsAt - now <= 30 s` moves `endsAt += 30 s`. Each late bid extends again; uncapped, but each extension costs >= 5 % more | `ANTI_SNIPE_*` |
| End of auction | Bids are accepted while `now < endsAt`; `tick(now)` settles every open listing with `endsAt <= now` | `tick` |
| Settlement | Sold: item to the high bidder, `price - fee` to the seller, `fee` to the treasury. Expired (no bid): items back to the seller (company lots just vanish) | `#sell`, `tick` |
| Fee | `fee = ceil(price x feeRate)` (default 5 %), integer basis-point math, paid by **every** seller kind | `#sell` |
| Buyout | Immediate; refunds the current leader; the promo price applies while `now < promo.endsAt` | `buyout` |
| Cancel | Seller only, open listings only, **only without bids**; items return | `cancel` |
| Who may buy | Players only. House accounts (`house`, `co:*`, `npc:*`) are refused on the public `bid`/`buyout` (`impersonation`); NPCs act through the house's internal path | `#needPlayer` |
| Rejections | Throw `MarketError` with a `code` **and** emit a `market.reject` row (`entries.code`, `entries.action`) | `#fail` |

Error codes: `invalid-account`, `invalid-amount`, `invalid-time`, `invalid-duration`, `invalid-promo`, `unknown-item`, `unknown-listing`, `unknown-company`, `unknown-npc`, `impersonation`, `forbidden`, `not-stackable`, `duplicate-unique`, `insufficient-items`, `insufficient-funds`, `not-open`, `ended`, `own-listing`, `bid-too-low`, `no-buyout`, `has-bids`, `not-seller`, `promo-company-only`.

Listing life cycle: `open → sold` (buyout or settlement), `open → expired` (tick without bid), `open → cancelled` (no bid). Closed listings stay readable up to 2,000. History is kept per item (last 500 trades), and the fraud trade log keeps the last 5,000.

## 5. Promotions

- **Companies only**, and only on listings that have a buyout. The discount applies to the **buyout** while `now < promo.endsAt`. The promo end is clamped inside the listing's end.
- `companyRestock(now)` tops each company up to its `maxOpen` with 1-2 lots per call. Every lot gets a flash promo with p = 0.45: a discount of 10..40 % in steps of 5, lasting 5-30 min, with a label such as `"Happy hour -25%"`. **Every restock that posts anything carries at least one promotion**. That guarantee is tested: removing it fails the suite.
- `quote(listingId, now)` gives the UI the live promo state: `{ minBid, buyout, promoActive, msLeft, fair }`.

## 6. Sellers

### Companies (infinite stock, list-price anchored)

| company | sells | max open | buyout markup |
|---|---|---:|---:|
| `co:freshmart` FreshMart Supermarket | food | 6 | x1.1 |
| `co:genelab` GeneLab Supplies | potion, egg, incubator, stone | 5 | x1.2 |
| `co:wildgear` Wildgear Outfitters | lure, map, territoryFlag | 5 | x1.15 |
| `co:stadium` Stadium League Box Office | ticket | 3 | x1 |
| `co:atelier` Atelier Chroma | cosmetic | 3 | x1.25 |

- Lots start at 75 % of list price, and the buyout is list x markup.
- Item choice is weighted by rarity: common 6, uncommon 3, rare 1, epic 0.25, **legendary 0**. Companies never sell legendary items and never sell Genemon (`forbidden`).

### NPC traders (behaviour is data)

| NPC | personality | floor | actions/round | noise | bias | buys out if <= | bids if minBid <= | spend share | fresh band | relist band |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| `npc:penny` Penny the Bargain Hunter | bargainHunter | 800 | 2 | 0.08 | 1 | 0.88 x value | 0.7 x value | 0.35 | 1-1 | 1-1 |
| `npc:magpie` Magpie the Collector | collector | 2500 | 2 | 0.15 | 1.2 | 1 x value | 0.95 x value | 0.6 | 1-1 | 1-1 |
| `npc:flint` Flint the Flipper | flipper | 1500 | 2 | 0.06 | 1 | 0.82 x value | 0.85 x value | 0.4 | 1.08-1.25 | 1.08-1.25 |
| `npc:moss` Moss the Forager | forager | 100 | 2 | 0.1 | 1 | 0 x value | 0 x value | 0 | 1-1.2 | 0.75-0.95 |

**How one round of `npcActivity(now)` works:**

- Each NPC draws from `Rng(hashSeed(seed, "npc", npcId, round))`.
- Its private valuation of a lot is `fairValue x qty x bias x exp(N(0, noise))`.
- It visits open listings in a seeded shuffled order and stops after `maxActions`.

**What each personality does:**

- **Bargain hunter:** buys out clearly underpriced lots (mostly company promos) and places lowball minimum bids. Ignores Genemon.
- **Collector:** wants rare-or-better items, plus uncommon-or-better eggs, cosmetics and *appraised* Genemon. Pays up to 1.2x fair value. Never sells.
- **Flipper:** first relists what it bought last round at +8..25 %. It buys out under 82 % of fair value, and only bids on auctions with **<= 2 min left**: it snipes, and the anti-sniping rule extends those auctions. It skips lots worth under 20 credits, because the fee eats the margin.
- **Forager (the wild supply):** relists unsold lots as clearance (0.75-0.95 x fair). Then it gathers 1-2 world drops: food, stones, maps and eggs, weighted common 10 / uncommon 4 / rare 1.2 / epic 0.3 / legendary 0.05. It auctions them at 0.7-0.9x start and 1.0-1.2x buyout. It stops at 6 open lots, so supply backs off when nobody buys.

Every NPC action goes through the same code path as a player action (escrow, fee, ledger row). The `why` field records the motive, for example `"bargainHunter: buyout 31% under fair value"`.

## 7. Price discovery and data science

**Fair value (per unit).**

- With fewer than 3 trades, fair value is the list price.
- After that: `fair = (1 - w) x list + w x clamp(median(last 50), 0.5 x list, 3 x list)`, with `w = min(0.6, trades / 25)`.
- Unappraised Genemon are worth 0, so NPCs skip them.

The market can move prices. A burst of trades (wash or genuine) can drag the reference that NPCs use to at most 2.2x list. Tested with a pump of 20 trades at 70x list.

**Statistics.** `stats(itemId, since?)` works on per-unit trade prices:

| Field | Meaning |
|---|---|
| `median` | Robust price; `null` with no trades |
| `mean` | Average price; `null` with no trades |
| `volatility` | **Realised volatility**: RMS of log returns between consecutive trades (0.1 ≈ 10 % moves) |
| `volume` | Units traded |
| `last` | Last trade price; `null` with no trades |
| `trades` | Number of trades |

`priceHistory(itemId)` returns `{t, price}` oldest-first (per unit). Settlements are stamped at the auction's real end, not at the tick that noticed it.

**Measured probe** (a lab sample, not a balance verdict):

- Setup: seed 2026, 600 NPC rounds 5 min apart (50 simulated hours), restock every 15 min, **no players**. Deno 2.9.7, aarch64 macOS.
- Speed: about 0.1 ms per round (0.09-0.11 across runs). The run produced 4,066 ledger rows (about 6.8 per round). Credits stayed balanced.
- Credits: 67,722 minted, all of it NPC refills. Treasury 3,527. Company revenue 44,877, which sits idle.
- Listings: 1,276 posted, 731 sold, 515 expired.
- **Commodity medians settle about 25-30 % under list price** (meat 6.4 vs 9, berries 3 vs 4). Most single-bidder auctions clear at the 0.75x start price. The fair-value floor and blend keep NPC valuations at 0.85-1x list.
- **Zero anti-snipe extensions in that run.** A 5-min NPC cadence never lands inside the flipper's 2-min horizon. The snipe path is covered by a dedicated unit test instead. In live play, call `npcActivity` every 30-60 s.
- The bargain hunter **hoards** (2,296 items). There is no NPC consumption sink yet (open question 1).

**What to chart on the Data screen:**

- Per item: `stats()` median and volatility, with `priceHistory()` as a sparkline.
- `moneySupply()` over time (wallets, escrow, treasury) as the inflation monitor.
- `ledger.counts()` filtered on `market.*`.

## 8. Anti-fraud

- **Escrow everywhere.** Items and credits are locked the moment they are listed or bid, so nothing can be double-spent. Credit conservation (`moneySupply().balanced`) is an invariant the tests assert.
- **Server authority.** Run the house on the server and accept only *intents* from clients. Because every draw is seeded and every state change is a ledger row, a disputed session can be **re-simulated** from seed plus intents and compared row by row.
- **Unique creatures.** A `genemon:<id>` exists at most once across all inventories and escrow (`duplicate-unique`). It always trades as one unit (`not-stackable`). Companies cannot sell creatures (`forbidden`).
- **No impersonation.** Company and NPC ids cannot post as players, and house accounts cannot use the public buy API. Posting as a company requires a registered company id (`unknown-company`).
- **Promotions are company-only.** This prevents fake "-40 %" reference-price scams between players.
- **Every refusal is data.** `market.reject` rows carry `who`, `action` and `code`. Repeated `own-listing`, `impersonation` or `insufficient-funds` probes from one account are a cheap bot or abuse signal.
- **Wash-trading leads** (`washTradeSignals(minTrades = 3)`) look at **player-to-player** trades only; NPCs and companies trade with everyone by design. Per player pair it reports:
  - `trades`: how many times they traded.
  - `share`: the largest fraction of one side's player sales that went to the other.
  - `roundTrips`: the same item going a→b and later b→a.
  - `offMarket`: prices above 2.5x or below 0.4x the reference.
  - `score = 0.4·share·min(1, trades/minTrades) + 0.4·min(1, roundTrips/2) + 0.2·min(1, offMarket/2)`.

  It is a **lead for human review, not a verdict**. Auto-banning on it would punish friends who trade.
- **Manipulation of NPC demand.** A pump cannot drag fair value past 0.5-3x list (section 7). That caps how much a wash ring can profit by selling into NPC bots.

## 9. How a Genemon is appraised

`appraiseGenemon(ph, { generation, mutations })` returns an integer of at least 10:

```
perSlot = power / sqrt(slots)                       # [SPEC B1]: a big body also costs team slots
value   = 20 + 0.55 x perSlot x (1 + level/20)
             x RARITY_MULT[ELEMENT_RARITY[primary]]
             x (secondary ? 1.1 + 0.25 x (mult(secondary) - 1) : 1)
             x (1 + 0.12 x min(generation, 10))     # pedigree: bred lineages
             x (1 + 0.05 x min(mutations, 10))
             x (1 + 0.08 x abilities)               # fly, swim, dig, phaseShift, weatherShaper, terraformer
             x (1 + 0.15 x glow)                    # collector appeal
```

**Rarity tier of an appraisal:**

| Tier | Appraisal (credits) |
|---|---|
| common | < 250 |
| uncommon | < 800 |
| rare | < 2,500 |
| epic | < 8,000 |
| legendary | >= 8,000 |

`Phenotype` does not carry the generation, so pass `genome.generation` and `genome.mutations.length`.

**Calibration**, measured over 200 wild generation-0 creatures per level (`createGenemon({ seed: s·7919 + level, level })`):

| level | min | p25 | median | p75 | p95 | max | tiers |
|---:|---:|---:|---:|---:|---:|---:|---|
| 5 | 74 | 116 | 148 | 190 | 260 | 320 | 184 common, 16 uncommon |
| 15 | 163 | 265 | 362 | 476 | 615 | 723 | 40 common, 160 uncommon |
| 30 | 275 | 494 | 697 | 863 | 1,119 | 1,455 | 135 uncommon, 65 rare |
| 50 | 484 | 970 | 1,272 | 1,589 | 2,017 | 2,489 | 25 uncommon, 175 rare |
| 80 | 861 | 1,893 | 2,607 | 3,202 | 4,277 | 5,287 | 91 rare, 109 epic |

No wild generation-0 creature reached legendary. Legendary takes level, rare elements **and** pedigree, which is intentional.

To trade a creature: call `registerGenemon(id, ph, info)` to store its appraised item definition. It becomes the reference price that the collector NPC and `quote().fair` use. An unregistered creature can still trade, but at basePrice 0, so NPCs ignore it.

## 10. Where supply and demand come from

| Source | Path into the market | Status |
|---|---|---|
| Supermarket food | `co:freshmart` restocks every food (bundles 1-10, list x1.1, promos) | TESTED |
| Breeding and care supplies, field gear, tickets, cosmetics | the other four companies | TESTED |
| World drops | the forager NPC gathers rarity-weighted drops and auctions them; the world can also call `give(player, item, qty, now, "drop")` directly | forager TESTED; world hook OPEN |
| Players | `give` (rewards) → `post`; the creatures they raise → `registerGenemon` → `post` | API TESTED; UI OPEN |
| Credits | `deposit` for quest and battle rewards; the NPC liquidity refill | TESTED |
| Consumption (item sink) | `take(owner, item, qty, now, "used")` when food is eaten or a potion or stone is used | API TESTED; engine hook OPEN |
| Credit sinks | seller fee → treasury; `withdraw` (fixed-price shops, entry fees); idle company revenue | TESTED |

## 11. Ledger events

Every row has `where = { x: 0, y: 0, z: 0, zone: "auction-house", space: "market" }`, and tags start with `"market"`. Payloads are flat; a missing value is `0` or `"none"`, never `null`.

| what | who | from → to | key entries / exits |
|---|---|---|---|
| `market.deposit` / `market.withdraw` | owner | `faucet` → `wallet:id` / `wallet:id` → `sink` | credits / balance |
| `market.give` / `market.take` | owner | `world` → `inv:id` / back | itemId, kind, qty / held |
| `market.genemon.appraise` | house | `genemon:id` → `catalogue` | level, power, elements, generation / appraisal, rarity |
| `market.post` | seller | `inv:id` or `company:id` → `listing:L#` | qty, startPrice, buyout, promo / listingId, endsAt, fair |
| `market.bid` | bidder | `wallet:id` → `listing:L#` | amount, minBid, prevBid, msLeft / endsAt, extended, refundTo, refundAmount |
| `market.buyout` | buyer | `wallet:id` → `inv:id` | price, listPrice, promoActive / fee, proceeds, refundTo |
| `market.cancel` | seller | `listing:L#` → `inv:id` | qty / returned |
| `market.sold` / `market.expired` | house | `listing:L#` → `inv:buyer` / back to seller | price, bids, extensions / fee, proceeds, unitPrice |
| `market.reject` | actor | actor → ref | action, code / accepted=false |
| `market.company.restock` | house | `companies` → `market` | round / posted, promos |
| `market.npc.round` | house | `npc` → `market` | round / actions, bids, buyouts, posts, gathers, refills |

## 12. API (exported)

```ts
// items.ts
type ItemKind = "food"|"potion"|"lure"|"egg"|"stone"|"cosmetic"|"territoryFlag"|"incubator"|"ticket"|"map"|"genemon";
type Rarity = "common"|"uncommon"|"rare"|"epic"|"legendary";
interface ItemDef { id; name; kind: ItemKind; basePrice: number; rarity: Rarity; stackable: boolean; effects: Record<string, number|string>; note: string }
const ITEMS: Record<string, ItemDef>; const ITEM_IDS: readonly string[]; const ITEM_KINDS, RARITIES, RARITY_RANK, RARITY_MULT, ELEMENT_RARITY;
foodItemId(food: FoodId): string                       // "food.<id>"
genemonItemId(genemonId: string): string               // "genemon:<id>"
isGenemonItem(itemId: string): boolean
appraiseGenemon(ph: Phenotype, info?: GenemonInfo): number   // GenemonInfo = { generation?, mutations?, name? }
rarityForValue(value: number): Rarity
genemonItemDef(genemonId: string, ph?: Phenotype, info?: GenemonInfo): ItemDef
itemDef(itemId: string): ItemDef | undefined           // catalogue + unappraised genemon; prototype keys never match

// market.ts
new AuctionHouse({ seed: number; ledger?: Ledger; feeRate?: number /* 0.05 */ })
deposit(ownerId, credits, now?, why?): number          withdraw(ownerId, credits, now?, why?): number
balance(ownerId): number                               escrowed(ownerId): number
give(ownerId, itemId, qty, now?, why?): number         take(ownerId, itemId, qty, now?, why?): number
inventory(ownerId): Record<string, number>
registerGenemon(genemonId, ph: Phenotype, info?: GenemonInfo & { now? }): ItemDef
post(sellerId, sellerKind: SellerKind, itemId, qty, startPrice, buyout: number|null, durationMs, now, promo?: Promo): Listing
bid(listingId, bidderId, amount, now): Listing         buyout(listingId, buyerId, now): Listing
cancel(listingId, sellerId, now): Listing              tick(now): Settlement[]
listing(id): Listing|null                              listings(filter?: ListingFilter): Listing[]   // {itemId, kind, sellerKind, status, sellerId, bidderId}
quote(listingId, now): Quote|null                      priceHistory(itemId): {t, price}[]
stats(itemId, since?): MarketStats                     fairValue(itemId): number
moneySupply(): MoneySupply                             washTradeSignals(minTrades?): WashSignal[]
companyRestock(now): Listing[]                         npcActivity(now): NpcAction[]
// also: COMPANIES, NPC_TRADERS, isHouseAccount, MarketError{code}, DEFAULT_FEE_RATE, MIN_INCREMENT_BPS,
//       ANTI_SNIPE_WINDOW_MS, ANTI_SNIPE_EXTEND_MS, MIN/MAX_DURATION_MS, MAX_CREDITS, HOUSE_ID, HOUSE_ZONE
```

`Listing` is the specified shape plus `bidCount`, `extensions`, `buyerId`, `finalPrice` and `closedAt`. The house returns **copies**, so its records only change through its methods.

## 13. Rules pinned by tests

| Rule | Test (`tests/market_test.ts`) |
|---|---|
| E1 escrow on post and bid, instant full refund when outbid, settle at expiry | `auction: post -> bid -> outbid refunds -> settles…` |
| E2 min raise 5 % (ceil, >= 1) | same test + `anti-sniping…` |
| E3 bid with <= 30 s left adds 30 s, repeatedly | `anti-sniping: a bid in the last 30 s…` |
| E4 fee = ceil(price x rate) → treasury; conservation | `the seller fee goes to the treasury…` |
| E5 buyout immediate, refunds the leader; bid >= buyout = buyout at buyout price | `buyout is immediate…` |
| E6 promo company-only, discount on buyout while it runs | `promo: the discount applies…` |
| E7 restock: shelf caps, 10-40 % promos, >= 1 promo per restock, infinite company stock never lands in an inventory | `companyRestock posts flash promotions…` |
| E8 own-listing bid/buyout and impersonation refused **and logged** | `bidding or buying out your own listing…` |
| E9 insufficient funds refused with no side effect; escrow locks credits | `insufficient funds are rejected…` |
| E10 cancel only without bids; expiry returns items | `cancel only without bids…` |
| E11 NPC determinism per seed (isolated from restocks), 4 personalities, >= 3 trade | `NPC activity is deterministic…`, `NPC market loop…` |
| E12 the flipper snipes in its last 2 min, the house extends, it relists at a margin | `the flipper snipes…` |
| E13 every row valid, flat, finite, `space=market`, `zone=auction-house` | `ledger: every market action…` |
| E14 catalogue: all foods at list price, >= 30 others, every kind, a lure per element | `catalogue: …` |
| E15 appraisal rises with level and pedigree; Genemon unique | `genemon: appraisal grows…` |
| E16 median, mean, realised volatility, volume; fair-value clamp | `price stats: …` |
| E17 wash-trade pair flagged, honest trade not | `wash trading: …` |

**Mutation check.** 18 deliberate rule breaks were applied to a scratch copy, one at a time:

- anti-snipe off; refund removed; fee floored; promo ignored; own-listing allowed; funds unchecked;
- NPC stream ignores the seed; no min raise; early settlement; promo guarantee removed; pump unclamped;
- wash round-trips ignored; flipper ignores its horizon; cancel with bids; company lot returned to an inventory;
- Genemon not unique; own-raise double-charged; house accounts allowed to bid.

Each one fails at least one test.

## 14. Regenerating the tables

The catalogue, company and NPC tables in sections 3 and 6 were printed from code. Regenerate them after any price change, and do not edit them by hand:

```sh
deno eval 'import { ITEMS, ITEM_IDS } from "./src/economy/items.ts";
for (const id of ITEM_IDS) { const d = ITEMS[id];
  console.log(`| \`${id}\` | ${d.name} | ${d.kind} | ${d.basePrice} | ${d.rarity} | ${d.stackable ? "yes" : "no"} | ${Object.entries(d.effects).map(([k, v]) => `${k}=${v}`).join(", ")} |`); }'
```

A `tools/econ-report.ts` that prints these tables, the appraisal calibration and the probe numbers is a next quest. The orchestrator owns `tools/`.

## 15. Decisions (and why)

1. **Integer credits with basis-point math.** In floats, `140 x 0.05` can come out as `7.000000000000001`, and `ceil` then charges 8. With integer numerators and a single division, fees are exact and replays are bit-identical.
2. **The house is the custodian of wallets, inventories and escrow.** Escrow needs atomic custody, and keeping custody in one module lets one testable invariant (credit conservation) hold everywhere. The cost: the game must route item grants and uses through `give`/`take`.
3. **Prices are per lot; history is per unit.** Bundles read naturally in the UI ("10 meat for 60"). Unit prices keep the history comparable across bundle sizes.
4. **The fee is charged to the seller, rounded up, for every seller kind.** It is the main credit sink, and rounding up makes spam lots of 2-credit candy cost something. Applying it uniformly avoids a hidden company privilege.
5. **A bid at or above the buyout becomes a buyout at the buyout price.** This avoids the incoherent state of a bid above the buyout and never makes a player overpay.
6. **Anti-sniping is literal "+30 s", uncapped.** That matches the spec. It is bounded in practice because each extension costs at least 5 % more (n extensions ≥ 1.05ⁿ x the price).
7. **Promotions are company-only.** They are a house marketing tool. Letting players set them would invite fake-discount scams against an inflated reference price.
8. **Companies anchor list prices, never sell legendaries or creatures, and have infinite stock.** Shelves stay predictable (MSRP), while scarcity of the top tier comes only from the world and from players.
9. **NPC behaviour is data plus one seeded stream per (seed, NPC, round).** Every decision can be replayed and explained (`why`), tuned without code changes, and tested for determinism in isolation.
10. **Fair value is anchored to list price** (blend ≤ 0.6, median clamped to 0.5-3x). The market can move prices, but a wash ring cannot drag NPC demand anywhere it likes.
11. **Refusals both throw and log.** The UI gets a machine-readable `code`; analytics and anti-abuse get the attempt.
12. **Volatility is RMS log returns, not the standard deviation of prices.** With two trades a standard deviation can be 0 while the price moved; and mixed-quality lots are dispersion, not movement.
13. **The appraisal divides power by √slots.** The balance contract normalises power per size class, and a bigger body costs team slots [SPEC B1]. The square root keeps big creatures somewhat more valuable without letting a 4-slot creature price as four.
14. **NPC liquidity refill.** Without players, NPCs would go broke and the market would die. The refill is a visible, logged faucet that must be tuned once real faucets exist.
15. **Eggs stack; maps, incubators and cosmetics do not.** An egg's contents roll at hatch time, so unhatched eggs of a tier are fungible. A map points at one place, and an incubator wears out.

## Integration requests

These are for the orchestrator, who owns the shared files:

1. **Engine:**
   - Create one `new AuctionHouse({ seed: hashSeed(worldSeed, "market"), ledger })` and share the main ledger.
   - On the game clock, never `Date.now()` inside logic, call:
     - `tick(now)` about every second;
     - `npcActivity(now)` every 30-60 s, so the flipper's 2-min snipe horizon is reachable;
     - `companyRestock(now)` every 10-15 min.
2. **Inventory plumbing:**
   - Route supermarket purchases, world drops and quest rewards through `give`.
   - Route eating and item use through `take`. For example, `take(owner, "food.honey", 1)` then `feed(g, "honey")`; `effects.food` carries the `FoodId`.
   - Route rewards through `deposit`, and fixed-price spending through `withdraw`.
3. **Creature trades:**
   - Before listing, call `registerGenemon(g.id, phenotypeOf(g), { generation: g.genome.generation, mutations: g.genome.mutations.length, name: g.name, now })`, then `give(owner, genemonItemId(g.id), 1)`.
   - The market never touches `Genemon` objects. When a `market.sold` or `market.buyout` row has an `itemId` starting with `genemon:`, set `g.owner` to the buyer (and log it).
4. **UI, a "Market" screen with panels:**
   - **Browse:** `listings({ status: "open", kind })` + `quote()`.
   - **Deals:** company promos with a countdown from `promo.endsAt`.
   - **My bids:** `listings({ bidderId })` + `escrowed()`.
   - **Sell:** `inventory()` with `fairValue()` as the suggested price.
   - **Item page:** `priceHistory()` chart + `stats()`.
   - Show `MarketError.code` as friendly text.
   - Add a debug "Wash-trade review" panel for `washTradeSignals()`.
5. **Data screen:**
   - A market ticker from ledger rows tagged `market`.
   - `moneySupply()` over time (wallets, escrow, treasury) as the inflation monitor.
6. **World designer:** lure, flag, map and incubator `effects` keys are proposals. Confirm or rename them in `docs/WORLD.md` and I will align `ITEMS`.

## Open questions

1. **Item sinks for NPCs.** The bargain hunter hoards (2,296 items in the 50 h probe). Should NPCs consume purchases, which would be a `take` sink, or is hoarding fine because the stock is out of circulation?
2. **Idle company revenue.** It is the largest de-facto credit sink. Should companies run buybacks or seasonal events to recycle it?
3. **Cap anti-snipe extensions?** For example, a maximum of 10 extensions, or a hard end at 2x the duration.
4. **Listing deposit.** A small non-refundable posting fee would stop spam relists; the forager and flipper churn showed how much relisting happens.
5. **Re-anchoring egg prices.** They should match the expected appraisal of their hatch distribution once hatching exists. Today a common egg (40) hatches into a creature worth ~150 at level 5.
6. **Physical vs virtual markets.** Should some shops exist only at GPS locations, with `where` coming from the world instead of the fixed `auction-house` zone?
7. **Persistence.** There is no snapshot or restore yet. Saves and server restarts need `toJSON`/`fromJSON`, plus a replay test showing that seed + intents equals the snapshot.
8. **Shill bidding.** A seller's alt account bidding up their own lot isn't covered by the wash heuristic, which only looks at trades. It needs bid-pair concentration analysis and device-level signals from the `device` space.
9. **Real-money or NFT bridges.** Out of scope until there is legal review (section 2).

## Next quests

1. Wire the house into the engine clock and the shared ledger (integration requests 1-3).
2. Build the Market UI panels and the Data-screen money-supply chart (integration requests 4-5).
3. Snapshot/restore plus a replay-equality test.
4. `tools/econ-report.ts`, which generates sections 3, 6 and 9 and the probe numbers from code.
5. A persona-driven Monte Carlo of the 12 personas from `src/sim/personas.ts` against the market. Measure inflation, wealth Gini, price drift vs list, and refill-faucet share. Tune the floors, fee and start prices against those numbers.
6. Shill-bid detection and per-account rate limits on `post` and `bid`.
