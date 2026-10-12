# AI & Data: condition-aware ladder, statistics, learned models

> **Summary**
>
> 1. Every match goes through a condition-aware Elo (`src/ladder/mmr.ts`):
>    `E = sigmoid(rating gap + learned weights · match conditions)`. Beating the conditions pays more than
>    being carried by them.
> 2. Arena and weather act as **interactions** (they change how much each side-relative feature counts).
>    Combos come back in through a derived `comboEdge` feature, and the win condition scales K.
> 3. `src/ml/stats.ts` (summaries, Wilson CIs, ridge regression, PCA, k-means) and `src/ml/mlp.ts` (backprop
>    MLP + outcome predictor) are pure, seeded and have no dependencies.
> 4. The ledger is the only data source. `ladder.match` rows become a dataset through `matchDataset()` and
>    feed the outcome model; genome/phenotype rows feed the Genospace PCA and the archetype clusters.
> 5. Status: **TESTED, not wired**. There are 25 unit tests, and every mutant with a behavioural effect is
>    caught. The engine/UI integration is OPEN (see §15).

Owner: Data scientist (`src/ladder/*`, `src/ml/*`, this file). Tests: `tests/ladder_test.ts`,
`tests/ml_test.ts`. Status vocabulary: `LIVE` = seen running in the game, `TESTED` = unit-tested but not
wired, `MODEL` = pure model with no caller, `OPEN` = asked for but not built.

---

## 1. Requirements and status

| id   | requirement                                                                                                 | file            | status   | pinned by test                                     |
| ---- | ----------------------------------------------------------------------------------------------------------- | --------------- | -------- | -------------------------------------------------- |
| AD1  | `E_A = sigmoid(ln10·(R_A−R_B)/400 + Σ x_f·w_f)`; equal ratings + zero context = 0.5; a 400-point gap = 10:1 | mmr.ts          | TESTED   | `equal ratings + zero context…`, `worked example…` |
| AD2  | Rating update `K·(S−E)`, zero-sum per match, pool mean stays at base                                        | mmr.ts          | TESTED   | `Elo update is zero-sum…`                          |
| AD3  | Provisional K = 2k for the first 10 games; one K per match = mean of both players' K                        | mmr.ts          | TESTED   | `provisional K doubles…`                           |
| AD4  | Context weights learned online by SGD on the logistic loss (same pre-match E)                               | mmr.ts          | TESTED   | `learns that a decisive condition matters…`        |
| AD5  | A win in unfavourable conditions gains more than a win in favourable ones                                   | mmr.ts          | TESTED   | same test, plus the worked example                 |
| AD6  | Swapping A/B (negating features, flipping the score) mirrors every update                                   | mmr.ts          | TESTED   | `swapping sides mirrors every update`              |
| AD7  | Arena/weather interactions learn _where_ a condition matters                                                | mmr.ts          | TESTED   | `arena/weather interactions learn WHERE…`          |
| AD8  | `comboEdge`: combo history feeds the expectation                                                            | mmr.ts          | TESTED   | `best and worst combos rank by Wilson bounds`      |
| AD9  | Win condition scales K (`WIN_CONDITION_K`)                                                                  | mmr.ts          | TESTED   | `provisional K doubles…`                           |
| AD10 | `conditionStats` by arena/weather/combo/win condition with Wilson 95%, draws excluded                       | mmr.ts          | TESTED   | `conditionStats excludes draws…`                   |
| AD11 | `bestCombos` / `worstCombos` ranked by Wilson lower/upper bound                                             | mmr.ts          | TESTED   | `best and worst combos…`                           |
| AD12 | One flat `ladder.match` ledger row per record; `matchDataset()` rebuilds the dataset                        | mmr.ts          | TESTED   | `one flat ladder.match ledger row…`                |
| AD13 | `toJSON`/`fromJSON` round trip, including future updates                                                    | mmr.ts          | TESTED   | `toJSON/fromJSON round trip…`                      |
| AD14 | When conditions dominate, the ratings track true skill better than classic Elo                              | mmr.ts          | TESTED   | `when conditions dominate…`                        |
| ML1  | mean/std/quantile/median/histogram/correlation/zscore; non-finite values ignored                            | stats.ts        | TESTED   | `stats: …` (4 tests)                               |
| ML2  | Wilson interval contains p and narrows with n                                                               | stats.ts        | TESTED   | `Wilson interval contains p…`                      |
| ML3  | PCA recovers the main direction (\|cos\| > 0.95, explained[0] > 0.8)                                        | stats.ts        | TESTED   | `PCA recovers the main direction…`                 |
| ML4  | k-means++ separates two blobs; deterministic per seed                                                       | stats.ts        | TESTED   | `kmeans separates two…`                            |
| ML5  | Ridge regression recovers coefficients and survives collinearity                                            | stats.ts        | TESTED   | `ridge linearRegression…`                          |
| ML6  | MLP learns XOR (loss < 0.05); JSON round trip; same seed gives the same net                                 | mlp.ts          | TESTED   | `mlp: …` (5 tests)                                 |
| ML7  | `predictOutcomeModel` learns a deciding feature from ledger rows                                            | mlp.ts + mmr.ts | TESTED   | `…matchDataset feeds the outcome model`            |
| INT1 | Engine builds `MatchContext` (§4) and calls `ladder.record` at match end                                    | engine          | **OPEN** | —                                                  |
| INT2 | Data screen graphs (§11)                                                                                    | ui              | **OPEN** | —                                                  |
| INT3 | Genospace PCA view, archetype clusters                                                                      | render/ui       | **OPEN** | —                                                  |
| INT4 | Battle policy network + neuroevolution (§8)                                                                 | ml              | **OPEN** | —                                                  |

Mutation check (run on an isolated copy of the tree): each of these bugs, injected one at a time, turned at
least one named test red:

- a non-zero-sum update
- the context term dropped from E
- draws counted in the denominator
- comboEdge sign flipped
- always-provisional K
- gradient ascent in the MLP
- a wrong Wilson half-width

Removing the PCA deflation does **not** fail any test. The reason is that each power iterate is also
re-orthogonalised against the components already found, so deflation is redundant (it stays because the spec
asks for it).

---

## 2. Ledger → datasets pipeline

The ledger (`src/core/ledger.ts`) is the single event schema. Datasets are always **rebuilt from ledger
rows**, never from module state, so any JSONL export under `artifacts/` can regenerate them.

| ledger `what` (producer)                                                                                          | dataset           | row → features                                                                                         | consumer                                                                              |
| ----------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `ladder.match` (mmr.ts `Ladder.record`)                                                                           | match outcomes    | `ratingDiff = (R_A−R_B)/400` before the match, `x.<feature>` for every context feature, `win = scoreA` | `matchDataset()` → `predictOutcomeModel()`; calibration plots; weight charts          |
| `ladder.match` exits                                                                                              | rating history    | `exits.ratingA/ratingB`, `deltaA`, `surprise = S−E` per `when`                                         | rating curves, surprise distribution, collusion check (§14)                           |
| `ladder.match` entries `combosA/B`                                                                                | meta usage        | combo/move tags per side                                                                               | `MetaUsage.share` for `moveCost()` in `src/combat/moves.ts` (popular moves cost more) |
| `genemon.levelUp` / `evolve` / `specialize` / `xp` / `feed` / `experience` / `exposure` (`src/genome/genemon.ts`) | life trajectories | genome id, `when`, the triggering input, the resulting level/stage/elements                            | epigenetic drift graphs, Genospace trails                                             |
| phenotype snapshots (`phenotypeOf(g).axes`, 26 `AXIS_IDS`)                                                        | genospace         | one row per Genemon: the 26 axes (or one `SPACES` group)                                               | `pca()` → Genospace view; `kmeans()` → archetypes                                     |
| `battle.*` (planned; the combat engine owns it)                                                                   | policy dataset    | (state, action, reward) per decision tick; inputs in §8                                                | behaviour cloning, neuroevolution fitness                                             |
| `device.*`, `session.*`, `ui.*` (space `device`/`ui`)                                                             | hardware/session  | sampled frame-time windows, device class, durations                                                    | §12                                                                                   |

Rules:

- Payload values stay flat scalars, as `isValidEvent` requires. Feature columns are prefixed `x.` so they can
  never collide with bookkeeping keys.
- Use `when` from the match, never `Date.now()` inside logic.
- **Every feature must be known before the match** (see §5 on combos). Anything measured during the battle
  leaks the outcome into `E`.
- `matchDataset(events, names?)`: the default columns are `ratingDiff`, then the canonical `CONTEXT_FEATURES`
  order, then any other feature alphabetically. A feature missing from an older row reads as 0, so schema
  growth is safe.

---

## 3. Condition-aware MMR

### 3.1 Model

```
E_A = sigmoid( z_rating + z_context )
z_rating  = ln10 · (R_A − R_B) / 400                      (classic Elo, unchanged scale)
z_context = Σ_f  x_f · ( w_f + w_f|arena:<arena> + w_f|weather:<weather> )
```

- `x_f` is a context feature from **side A's perspective**, ~[−1, 1], positive = good for A. The ladder clamps
  it to ±2, and a non-finite value becomes 0.
- `w_f` is the global weight. `w_f|arena:*` and `w_f|weather:*` are learned **offsets**: per-arena and
  per-weather interactions.
- There is **no intercept** (no side bias). Swapping sides gives `E_B = 1 − E_A` exactly, and the tests rely
  on that. A real challenger/home advantage has to be an explicit feature that is +1 for A and −1 when the
  sides are swapped.

### 3.2 Updates (one `record()`)

```
K      = mean(K_A, K_B) · WIN_CONDITION_K[winCondition]      K_i = 2k while games_i < 10, else k (k = 24)
ΔR_A   = K · (S − E_A),   ΔR_B = −ΔR_A                        (zero-sum: the pool's mean stays at 1500)
w_key += lr · ((S − E_A) · x_f − λ · w_key)                   for every active key, clamped to ±4
         λ = 0.001 for global keys, 0.01 for arena/weather offsets; lr = 0.02
```

Both steps use the same pre-match `E_A`. The weight step is exactly one SGD step on the logistic loss
`−[S ln E + (1−S) ln(1−E)]`. A draw (`S = 0.5`) pulls E toward 0.5.

`WIN_CONDITION_K`:

| win condition                       | K factor                                       |
| ----------------------------------- | ---------------------------------------------- |
| `ko`                                | 1                                              |
| `ringOut`                           | 1                                              |
| `sweep` (no member lost)            | 1.15                                           |
| `timeout` (decided on remaining HP) | 0.75                                           |
| `forfeit`, `disconnect`             | 1 (quitting must never be cheaper than losing) |
| unknown                             | 1                                              |

### 3.3 Worked example (pinned by `ladder: worked example from docs/AI-AND-DATA.md`)

The setup:

- A is rated 1600 and B 1500. Both are established, so K = 24 and the result is a KO.
- The ladder has learned `w.typeAdvantage = 1.2` and `w.arenaAffinity = 0.6` (no offsets).
- Conditions are **against** A: `typeAdvantage = −0.5`, `arenaAffinity = −0.3`.

The computation:

```
z_rating  = ln10 · 100 / 400                 =  0.575646   → classic Elo E_A = 0.640065
z_context = 1.2·(−0.5) + 0.6·(−0.3)          = −0.780000
E_A       = sigmoid(0.575646 − 0.78)          =  0.449089
```

| A's result | condition-aware ΔR_A | classic Elo ΔR_A | same result with conditions **for** A (E = 0.795051) |
| ---------- | -------------------- | ---------------- | ---------------------------------------------------- |
| win        | **+13.22**           | +8.64            | +4.92                                                |
| loss       | −10.78               | −15.36           | −19.08                                               |

Reading: A was the better player but the conditions favoured B. A win against the type chart and the arena is
worth 2.7× a win the conditions handed over. A loss in those conditions costs less than a classic Elo loss,
and a loss in favourable conditions costs the most.

### 3.4 Measured: skill recovery vs classic Elo (pinned by AD14)

Setup: 10 players with true skill spread 125 Elo-sd, 3000 random matches, outcome logit = skill gap + `c · f0`
with f0 ~ U(−1, 1). Each row is the mean of seeds 1–3, and the classic baseline is
`new Ladder({ lr: 0, interactions: false, comboFeature: false })`:

| condition strength c | RMSE vs true skill: aware | RMSE: classic | rating sd aware / classic (true 124.7) | learned effective weight |
| -------------------- | ------------------------- | ------------- | -------------------------------------- | ------------------------ |
| 0                    | 45.5                      | 45.6          | 140.1 / 139.1                          | −0.09                    |
| 2                    | 40.8                      | 42.0          | 138.1 / 120.2                          | 1.90                     |
| 4                    | **38.6**                  | **54.9**      | 129.9 / 95.3                           | 3.59                     |

Reading:

- When conditions decide matches, classic Elo **compresses** the skill spread, because condition luck looks
  like noise. The aware ladder keeps it.
- With no condition effect the two are identical; the extra machinery costs nothing.
- The effective weight learned is close to the true coefficient (2 → 1.90, 4 → 3.59).
- The ~45-point floor is K = 24 rating noise. Glicko-style uncertainty would lower it (Q8).

### 3.5 Interactions: why arena and weather are not plain features

Arena and weather are **shared** by both sides, so on their own they cannot favour A or B. They matter by
changing how much each side-relative feature counts: type advantage in a thunderstorm (wet bodies conduct),
reach in fog, size on a ring-out arena.

Each feature therefore gets an offset per arena and per weather. The offsets have 10× the L2 penalty of the
global weights, so they only grow on evidence.

Measured result: f0 decides the match in `storm` and is a coin flip in `clear`. Averaged over 3 seeds, the
effective f0 weight is:

| matches | storm | clear |
| ------- | ----- | ----- |
| 800     | 2.14  | 0.70  |
| 3000    | 3.68  | 0.34  |

With few matches the offsets **partially pool** toward the global weight, which is the right prior.

**Show effective weights** (`explain().contributions[i].weight`) on the Data screen, not the raw `weights()`
keys. When every match is in one arena, the split between global and offset is not identifiable; only the sum
means anything.

### 3.6 comboEdge

For each side, take its combo tags. Each combo gets a Beta(2,2)-shrunk win rate `p̂ = (wins+2)/(decisive+4)`
from the ladder's own history **before** this match; unseen combos count as 0.5. Map each to `2p̂−1`, average
them, then compute `comboEdge = (mean_A − mean_B) / 2 ∈ [−1, 1]`.

It is learned like any other feature (including interactions). If the engine already provides a `comboEdge`
column, the ladder does not add its own. Turn it off with `comboFeature: false`.

---

## 4. Context features: the engine contract

`makeContext({...})` builds the `MatchContext` in canonical order. All features come from A's perspective, are
known **pre-match**, and are **antisymmetric**: swapping A and B must negate every value. A test for
`buildMatchContext` should assert that last property (Q1).

| name              | definition (proposed v1, using existing modules)                                                                                                                                                                                                                   | range   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `typeAdvantage`   | adv_X = mean over X's members × each of their damaging moves (`isDamaging`) × each opposing member of `log2(typeMultiplier(move.element, [primary, secondary?]))` (`src/data/elements.ts`). Feature = `clamp((adv_A − adv_B)/2, −1, 1)`                            | [−1, 1] |
| `arenaAffinity`   | aff_X = Σ over the arena's ground mix `frac_g` × mean over members of `GROUNDS[g].affinity[primary] + 0.5·affinity[secondary]` (`src/data/grounds.ts`). Feature = `clamp(4·(aff_A − aff_B), −1, 1)`. v2 adds ability/terrain fits (swim on water, dig on diggable) | [−1, 1] |
| `weatherAffinity` | wx_X = mean over X's damaging-move elements of `log2(WEATHERS[w].elementMult[el] ?? 1)` (`src/data/weather.ts`). Feature = `clamp(2·(wx_A − wx_B), −1, 1)`                                                                                                         | [−1, 1] |
| `powerDiff`       | `(ΣpowerA − ΣpowerB)/(ΣpowerA + ΣpowerB)` over fielded members' `phenotype.power`, which is already slot-normalised: budget × quality × level × growth, [SPEC B1]                                                                                                  | (−1, 1) |
| `synergyDiff`     | syn_X = 0.4·mean `u01(axes.sociality)` + 0.3·coverage (share of non-neutral elements hit for ×2 by some team move) + 0.3·reaction potential (share of teammate element pairs with a `reactionBetween` whose `damageMult > 1`). Feature = syn_A − syn_B             | [−1, 1] |
| `sizeDiff`        | `tanh(ln(ΣmassKg_A / ΣmassKg_B) / 2)`: knockback and ring-out resistance                                                                                                                                                                                           | (−1, 1) |
| `reachDiff`       | `tanh((mean stats.reach_A − mean stats.reach_B) / 2 m)`                                                                                                                                                                                                            | (−1, 1) |
| `comboEdge`       | derived by the ladder (§3.6)                                                                                                                                                                                                                                       | [−1, 1] |

Candidates for v2 (add the name; the ladder learns it with no code change):

| name            | definition                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `tempoDiff`     | `stats.spd` gap                                                                                                                   |
| `levelDiff`     | level gap                                                                                                                         |
| `bondDiff`      | bond gap                                                                                                                          |
| `rhythmFit`     | `axes.rhythm` × real local daylight. Nocturnal/diurnal buffs must be computed from the match's `when` and location, not the clock |
| `knowledgeDiff` | learned type knowledge                                                                                                            |
| `challenger`    | ±1 side advantage, if one exists                                                                                                  |

---

## 5. Combos and win conditions: the contract

`combosA` / `combosB` are tags for what each side **fielded**, known before the match:

| tag               | example                                            |
| ----------------- | -------------------------------------------------- |
| element pair      | `el:fire+air` (sorted)                             |
| loadout move pair | `mv:rainCall>thunderBeam`                          |
| role mix          | `role:tank+striker`                                |
| element in arena  | `fire@volcano` (gives per-element arena win rates) |
| archetype         | `arch:<cluster id>` (§10)                          |

Battle-time events must **not** be combos while `comboFeature` is on: "conduction reaction triggered" or
"sequence actually executed" are written during the match, so they would leak the outcome into `E` and shrink
every rating change. Those belong in `battle.*` rows.

`winCondition` describes how the match ended (`ko`, `ringOut`, `sweep`, `timeout`, `forfeit`, `disconnect`). A
missing value is recorded as `draw` or `unspecified` in the stats.

---

## 6. Condition tables (`conditionStats`) and best/worst combos

Each entry is `{ key, games, wins, losses, draws, winRate, lo, hi, score, expected }`:

- `winRate = wins / (wins + losses)`. **Draws are excluded from the denominator.** Otherwise identical builds
  that draw ~90% of the time look like 5%-win builds.
- `lo`, `hi`: the Wilson 95% interval over the decisive games. With no decisive game it is [0, 1] and
  `winRate` is 0 by convention.
- `score` counts draws as half points; compare it with `expected`, the mean pre-match E. If `score` sits well
  away from `expected` for one arena, the model misreads that arena: a missing feature or an interaction that
  hasn't converged.
- **Perspective:**
  - `conditionStats(id)` gives that player's own results.
  - `conditionStats()` gives arena, weather and win condition from the **pre-match favourite** (E ≥ 0.5; an
    exact tie goes to side A). Any perspective-free win rate per arena would be 50% by construction.
  - `byCombo` is always per side: a combo is credited with the result of the side that fielded it, and mirror
    matches count once each way.
- `bestCombos(n, minGames = 1)` ranks by Wilson **lower** bound ("confidently good").
  `worstCombos(n, minGames = 1)` ranks by **upper** bound, ascending ("confidently bad"). So a 1–0 combo never
  outranks an 8–2 one.

---

## 7. Outcome predictor (MLP)

`predictOutcomeModel(rows, rng, opts?)` trains a `[d, 8, 1]` tanh/sigmoid MLP by cross-entropy. The defaults
are 200 epochs, lr 0.1, batch 32, L2 1e-4. Init and shuffling come from `rng.fork("outcome.init")` /
`rng.fork("outcome.fit")`, so the model depends only on the seed and the rows.

Typical use:

```ts
const ds = matchDataset(ledger.rows()); // ratingDiff + x.* columns, win = scoreA
const model = predictOutcomeModel(ds.rows, new Rng(1));
const p = model.forward(featuresInDsOrder)[0]; // P(A wins)
```

Why both models exist. The ladder's logistic model is **linear in the features** (plus arena/weather offsets),
online and interpretable; it is what moves ratings. The MLP can learn **feature × feature** interactions (type
advantage that only matters when reach is short). It is the benchmark: if it beats the ladder's `E` on
held-out matches, look at its errors to find the next feature or interaction. Metrics for the tool in Q4:

- log-loss and Brier score for E vs classic Elo vs MLP, on a **time split** (train on the past, test on the
  future)
- a reliability diagram (10 E-bins, observed score per bin)

MLP facts:

- Plain backprop with mini-batch SGD and optional L2.
- BCE loss for a sigmoid output, MSE for a linear output. Both are means over outputs and samples.
- Xavier/Glorot uniform init (He-uniform for layers feeding a ReLU).
- `toJSON`/`fromJSON` round-trips bit-exact.
- `fit()` returns the per-epoch training-loss curve; `loss(data)` evaluates a validation set.

---

## 8. Planned battle-policy network and neuroevolution (OPEN)

Inputs, one decision tick, about 70 values in roughly [−1, 1]:

- **Self and opponent state:**
  - HP fraction and energy/maxEnergy
  - distance / own reach, relative bearing (sin, cos), closing speed
  - airborne/burrowed/liquid flags
  - the 19 `STATUS_IDS` as remaining-duration fractions (self) plus the debuff subset (opponent)
- **Per move slot (4 × 6):** ready flag, `moveCost/energy`, `log2 typeMultiplier` vs the opponent's types,
  range fit (`dist ≤ range`), weather `elementMult`, and whether a `reactionBetween` exists with the ground or
  zone under the target.
- **Field:** ground under self and opponent (friction, conductivity, wetness), nearest hazard zone (kind
  one-hot, distance), wind, visibility, time remaining.

Outputs:

- 4 move logits
- 6 movement/utility logits: approach, retreat, strafe left, strafe right, guard, dodge
- softmax over the 10; argmax in ranked play, temperature sampling with an `Rng` in training
- optional value head (expected score)

Size: `[70, 32, 32, 10]` tanh, about 3.7k parameters. That runs per tick on the CPU and is cheap enough for
"millions of duels".

Training plan:

1. **Behaviour cloning** from the scripted AI's `battle.*` rows (cross-entropy on the action taken).
2. **Neuroevolution:**
   - population 64, genome = the flat weight vector
   - Gaussian mutation σ = 0.05 from `Rng.normal`, elitism 4, tournament size 3
   - generation g seeds every duel with `rng.fork(g)`, so a whole generation is replayable
   - Fitness = mean `(S − E)` against a fixed opponent pool, where E is the ladder's condition-aware
     expectation. A policy is rewarded for **beating the conditions**, not for being dealt good ones; the
     ladder's model doubles as the fitness baseline.

Needs: a flat get/set for MLP parameters (Q7) and a headless battle loop to call (the combat engine's).

---

## 9. Projections: Genospace (PCA)

Rows are `phenotypeOf(g).axes` for every known Genemon: 26 dimensions, or one `SPACES` group (cosmic 4, matter
6, body 6, psyche 7, combat 6, time 3). Every axis is in [−1, 1] with comparable units, so PCA runs on the
**covariance** (no z-scoring); that keeps the natural variance of each axis.

```ts
const p = pca(rows, 3); // components (unit loadings), explained ratios, projected n×3, mean
```

- `projected` gives 3D positions in the Genospace view, coloured by `ELEMENTS[primary].color` and sized by
  `sizeClass`.
- Each component is labelled with its top three loadings as pole names, using `poleLabel` and the axis signs
  (e.g. "PC1: hot · dry · wild").
- An "explained variance" bar shows how much of the diversity the three shown directions capture.
- Same data gives the same picture: the start vectors come from a fixed seed, and signs are normalised so the
  largest |loading| is positive. When the population changes, axes can still rotate between frames; Procrustes
  alignment to the previous basis is Q9.

---

## 10. Archetype discovery (k-means)

`kmeans(rows, k, rng)` runs on the combat-relevant space: the `SPACES.combat` axes plus z-scored `stats`. Use
`zscore` per column; stats have very different units.

- **Choose k** by the elbow of `inertia` for k = 2..10, each with a fixed seed. Check stability by re-running
  with 5 seeds and comparing assignments (the share of agreeing pairs).
- **Name** each centroid by its top poles ("heavy · hard · close" = bruiser).
- **Use:** add `arch:<k>` combo tags, so the ladder reports archetype win rates and best/worst archetype
  matchups; matchmaking diversity; the meta report.

---

## 11. Graphs on the Data screen

| graph                                                                                | source                                        |
| ------------------------------------------------------------------------------------ | --------------------------------------------- |
| Rating history per player                                                            | `ladder.match` exits over `when`              |
| Rating distribution + percentile of the player                                       | `histogram`, `quantile` over `table()`        |
| "Why this rating change" waterfall: rating term + each feature's push                | `explain().contributions[].logit`             |
| Condition weights: effective weight per feature, per arena/weather heat map          | `explain()` per (arena, weather)              |
| Calibration: E bins vs observed score, per arena                                     | `ladder.match` rows (`expected`, `scoreA`)    |
| Arena / weather / win-condition tables with Wilson error bars, favourite perspective | `conditionStats()`                            |
| "Your conditions": the same tables for the player                                    | `conditionStats(id)`                          |
| Best and worst combos (bars with CI)                                                 | `bestCombos(5)`, `worstCombos(5)`             |
| Feature correlation heat map; feature × win correlation                              | `correlation()` over `matchDataset()` columns |
| Outcome-model loss curve (train vs validation)                                       | `fit()` curve, `loss()`                       |
| Genospace scatter + explained-variance bar                                           | `pca()`                                       |
| Archetype map + elbow plot                                                           | `kmeans()` over k                             |
| Frame-time p50/p95/p99, histogram per device class                                   | §12                                           |

Empty states should be friendly ("Fight a few matches to see your data here"), and every win rate is shown
with its interval, never as a bare percentage.

---

## 12. Hardware and session analytics

Rows in space `device`. All of them are sampled and windowed, never per frame:

| row                             | content                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device.frame`                  | per 10-second window: CPU ms p50/p95, GPU ms p50/p95 (when a timer query exists), share of frames over 16.7 ms, dropped frames                                          |
| `device.info`                   | once per session: device class buckets (cores 2/4/8+, memory class, screen size class, DPR bucket, WebGL2 yes/no). **No raw GPU strings or user agents** in shared data |
| `session.start` / `session.end` | duration, screens visited, matches played, quality preset                                                                                                               |
| `ui.*`                          | navigation flows for onboarding funnels (first 5 minutes)                                                                                                               |

Analysis: `quantile` / `histogram` per device class picks the default quality preset, and `correlation`
between frame-time p95 and session length tests whether stutter drives churn.

---

## 13. Privacy notes

- **Location (GO-style world):** record world zones/cells (about 1 km), never raw GPS, in the ledger or any
  export. Physical-presence checks happen on-device and the ledger keeps only `physical: true/false` (as
  `genemon.experience` already does).
- **Real-life signals** (local time, foods bought, gym or swimming sessions, friends' influence) are
  behavioural data. They are local-first, and nothing is uploaded without opt-in. Cohort statistics are shown
  only with at least 20 contributors (k-anonymity). Retention is limited. Users can export and delete their
  own ledger as JSONL.
- **Ids:** ladder ids are pseudonymous player/team ids, never emails or account names. Ledger exports that AI
  coding sessions read under `artifacts/` must be simulation data or scrubbed.
- **Models:** they are trained on aggregates. Never ship per-player rows inside a model file, and keep the
  dataset and the model JSON separate.
- **Hardware:** coarse buckets only (§12), to avoid fingerprinting.

---

## 14. Decisions (and why)

1. **One logistic model for skill and conditions**, not a separate handicap bonus. A single probability keeps
   the update zero-sum and interpretable, and lets the condition weights be _learned_ rather than hand-tuned.
   The rating then means skill net of conditions.
2. **Online SGD, one step per match.** The ladder updates per match, the result is deterministic and
   O(features), and the rating step and the weight step share the same pre-match E.
3. **No intercept.** Side symmetry is a tested invariant; a real side advantage has to be an explicit ±1
   feature.
4. **Arena and weather as interactions with 10× L2.** Shared conditions cannot favour a side, and
   per-condition offsets must earn their size. Measured partial pooling is in §3.5.
5. **One K per match = mean of both players' K.** This is what keeps the pool's mean at base (no inflation).
   The cost: a veteran's rating moves 1.5× as much against a newcomer. Glicko-2 is Q8.
6. **Clamps:** features to ±2, weights to ±4. One mis-scaled engine feature cannot wreck the ladder;
   non-finite values become 0 (a NaN from physics must not poison ratings).
7. **Draws are excluded from win-rate denominators but kept in `score`.** Win rates stay meaningful, and
   calibration still sees draws.
8. **Global condition tables use the favourite's perspective.** Every other choice without a perspective is
   50% by construction.
9. **comboEdge uses pre-match combos with Beta(2,2) shrinkage.** This avoids outcome leakage, and a combo with
   one lucky win cannot dominate.
10. **Win-condition K table.** A timeout is a narrower and luckier result than a KO, and quitting must never
    save rating.
11. **Statistics ignore non-finite values** instead of propagating NaN: one broken physics sample must not
    erase a digest.
12. **PCA: power iteration + deflation + re-orthogonalisation, with fixed-seed start vectors.** It is
    deterministic and robust to a start vector that happens to be orthogonal to the top direction. A
    deterministic e_j start fails on block-diagonal covariances, so the start is random from a fixed seed.
13. **MLP: plain SGD, mean losses, He init for ReLU layers** (the spec says Xavier; Xavier is kept for tanh
    and linear layers). Small and debuggable, and learning rates transfer across widths.
14. **`matchDataset` reads the ledger, not the Ladder.** The ledger is the single source of truth, so a
    dataset can be rebuilt from any export.

---

## 15. Integration (what the orchestrator wires)

Every export here is reachable only from tests until it is wired. Expect the dead-export audit to flag them;
that list is the to-do.

1. **Battle resolution** (combat/engine):
   - Build the context with `makeContext({...§4})` and fill `combosA/B` per §5.
   - Call `ladder.record({ a, b, scoreA, context, arena, weather, when, combosA, combosB, winCondition })`
     with the shared `Ledger`.
   - Show `RecordOutcome.deltaA` and `explain()` on the result screen.
2. **Persistence:** store `ladder.toJSON()` in the save and restore with `Ladder.fromJSON(json, ledger)`.
3. **Data screen:** the graphs in §11. The calls are `table`, `conditionStats`, `bestCombos`, `worstCombos`,
   `explain`, `weights`, `matchDataset`, `predictOutcomeModel`, `pca`, `kmeans`, `histogram`, `quantile`,
   `correlation`, and `wilson` for any ad-hoc rate.
4. **Meta costs:** compute `MetaUsage.share` for `moveCost()` from the `mv:` combo tags in `ladder.match`
   rows.
5. **Tool:** `tools/ladder-report.ts` (Q4) prints calibration and weights, making the exports live as a
   deliverable.

---

## 16. Open questions

- Should offsets be keyed by arena **family** (dominant ground type) instead of arena id, to share evidence
  across similar arenas?
- What does a ladder id denote: a player, a team, or an individual Genemon? The ladder works for any of them,
  but the Data screen semantics differ.
- `comboEdge` is confounded with skill (good players pick good combos). Should it be computed from residuals
  `S − E` instead of raw wins?
- Schema evolution: a feature missing from old rows reads as 0. Is that acceptable for long histories, or
  should it be imputed?
- Weights drift, so past `expected` values are not comparable over long periods. Should matches be re-scored
  for calibration plots?
- Inactivity decay and season resets: neither exists yet.
- How should the provisional period interact with the mean K? (A newcomer climbs faster against other
  newcomers.)

## 17. Next quests

- **Q1** `buildMatchContext(teamA, teamB, arena, weather)` implementing §4, with a test that swapping sides
  negates every feature. Owner: combat/orchestrator.
- **Q2** Wire `Ladder` into battle resolution and the save (INT1).
- **Q3** Data screen graphs (§11, INT2).
- **Q4** `tools/ladder-report.ts`: log-loss/Brier/reliability for condition-aware E vs classic Elo vs MLP on a
  time split.
- **Q5** Genospace PCA view (INT3).
- **Q6** Archetype clustering + naming + `arch:` combo tags.
- **Q7** Policy network: MLP flat-parameter get/set, behaviour cloning, neuroevolution (§8, INT4).
- **Q8** Rating uncertainty (Glicko-2-style RD) instead of a fixed provisional K.
- **Q9** Procrustes alignment so the Genospace stays stable across population updates.
- **Q10** Collusion/win-trading detection: pairs whose repeated `S − E` residuals are improbable under the
  model.

---

## 18. API reference

```ts
// src/ladder/mmr.ts
interface MatchContext { names: string[]; features: number[] }
interface MatchResult { a; b; scoreA: 1 | 0.5 | 0; context: MatchContext; arena: string; weather: string; when: number;
  combosA: string[]; combosB: string[]; winCondition?: string }
const COMBO_FEATURE = "comboEdge"; const RATING_COLUMN = "ratingDiff";
const CONTEXT_FEATURES: readonly { name: string; note: string }[]; const WIN_CONDITION_K: Readonly<Record<string, number>>;
function makeContext(features: Record<string, number>): MatchContext;
class Ladder {
  constructor(opts?: { k?: 24; base?: 1500; lr?: 0.02; ledger?: Ledger; l2?: 0.001; l2Interaction?: 0.01;
    provisionalGames?: 10; provisionalMult?: 2; maxWeight?: 4; interactions?: true; comboFeature?: true });
  readonly matches: number;
  rating(id): number; games(id): number;
  expected(a, b, ctx, cond?: { arena?; weather?; combosA?; combosB? }): number;
  explain(a, b, ctx, cond?): { expected; ratingOnly; ratingLogit; contextLogit; contributions: { name; value; weight; logit }[] };
  record(r: MatchResult): { expected; deltaA; deltaB; k; ratingOnly };
  weights(): Record<string, number>;            // "f", "f|arena:<id>", "f|weather:<id>"
  table(): { id; rating; games; wins; losses; draws; provisional }[];
  conditionStats(id?): { perspective; byArena; byWeather; byCombo; byWinCondition };   // entries per §6
  bestCombos(n, minGames = 1); worstCombos(n, minGames = 1);
  toJSON(): LadderJSON; static fromJSON(j: LadderJSON, ledger?: Ledger): Ladder;
}
function matchDataset(events: readonly GEvent[], names?: readonly string[]): { names: string[]; rows: { features: number[]; win: number }[] };

// src/ml/stats.ts
mean(v); std(v, sample = false); quantile(v, q); median(v); histogram(v, bins, range?) -> { edges, counts };
correlation(x, y); zscore(v); wilson(wins, n, z = 1.96) -> { p, lo, hi };
linearRegression(x: number[][], y: number[], lambda = 1e-6) -> { weights, intercept, r2 };
pca(rows, k, rng = fixed) -> { components, explained, eigenvalues, projected, mean };
kmeans(rows, k, rng, iters = 50) -> { centroids, assignments, inertia, iterations };

// src/ml/mlp.ts
class MLP { constructor(layers: number[], rng: Rng, hidden: "tanh" | "relu" = "tanh", output: "linear" | "sigmoid" = "sigmoid");
  forward(x): number[]; loss(data): number; trainBatch(batch, lr, l2 = 0): number; fit(data, { epochs, lr, batchSize, rng, l2? }): number[];
  readonly paramCount: number; toJSON(): MLPJSON; static fromJSON(j): MLP }
function predictOutcomeModel(rows: { features: number[]; win: number }[], rng: Rng, opts?: { hidden?; epochs?; lr?; batchSize?; l2? }): MLP;
```
