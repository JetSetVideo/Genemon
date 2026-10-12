import type { App } from "../app.ts";
import { SPACES, type AxisId } from "../../data/axes.ts";
import { ELEMENT_IDS, ELEMENTS } from "../../data/elements.ts";
import { GROUND_IDS, type GroundId } from "../../data/grounds.ts";
import { EXPERIENCE_IDS, EXPERIENCES, type ExperienceId, FOOD_IDS, FOODS, type FoodId } from "../../data/lifestyle.ts";
import { age, createGenemon, expose, feed, type Genemon, live, phenotypeOf, STAGE_NAMES } from "../../genome/genemon.ts";
import { breed, fuse, geneticDistance, morph, mutate } from "../../genome/breeding.ts";
import { PLAN_GENES } from "../../genome/genome.ts";
import { epigeneticPressure } from "../../genome/epigenetics.ts";
import { hashSeed } from "../../core/rng.ts";
import { bar, fmt, h, hex, section, select, toast } from "../dom.ts";
import { axisRow, bodyBlock, elChip, movesBlock, psycheBlock, statsBlock } from "../widgets.ts";

let tab: "overview" | "genome" | "psyche" | "moves" | "life" | "breed" = "overview";
let food: FoodId = "berries";
let exp: ExperienceId = "gymTraining";
let ground: GroundId = "water";
let physical = true;
let partner = "";
let morphT = 0.5;

function ctx(app: App) {
  return { ledger: app.ledger, when: Date.now(), who: app.profile.id, where: { x: 0, y: 0, z: 0, zone: "lab", space: "lab" as const } };
}

function addChild(app: App, child: Genemon, why: string): void {
  app.profile.collection.push(child);
  if (!app.profile.pokedex.includes(child.genome.id)) app.profile.pokedex.push(child.genome.id);
  app.log("genemon.create", why, child.id, `${child.name} gen ${child.genome.generation}`);
  app.save();
  app.select(child.id);
  toast(`${child.name} joined your collection (${why}).`);
}

export function renderLab(app: App): HTMLElement {
  const g = app.selectedGenemon();
  if (!g) return h("p", {}, "No Genemon.");
  const ph = phenotypeOf(g);
  const refresh = () => {
    app.save();
    app.labView?.setGenemon(g);
    app.render();
  };
  const tabs = h("div", { class: "row" }, ...(["overview", "genome", "psyche", "moves", "life", "breed"] as const).map((t) =>
    h("button", { class: `btn small ${tab === t ? "on" : ""}`, "data-tab": t, onclick: () => {
      tab = t;
      app.render();
    } }, t)));
  const head = h("div", {},
    h("div", { class: "row" }, h("h1", {}, g.name), h("span", { class: "size" }, `${ph.sizeClass}·${ph.slots}`), elChip(ph.elements.primary), ph.elements.secondary ? elChip(ph.elements.secondary) : null),
    h("p", { class: "muted" }, `${ph.kind} · ${STAGE_NAMES[g.stage]} · Lv ${ph.level} · gen ${g.genome.generation} · ${g.genome.id}`),
    h("div", { class: "row" },
      h("button", { class: `btn small ${app.profile.settings.showSkeleton ? "on" : ""}`, title: "Overlay bones, centre of mass and support polygon", onclick: () => app.updateSettings({ showSkeleton: !app.profile.settings.showSkeleton }) }, "🦴 skeleton"),
      h("button", { class: "btn small", onclick: () => app.labView && (app.labView.autoRotate = !app.labView.autoRotate) }, "⟳ rotate"),
      h("span", { class: "muted" }, `stability ${fmt(app.labView?.stability ?? 0, 2)} · animation phase cycles idle → charge → active → rest`)),
    tabs);
  let body: HTMLElement;
  switch (tab) {
    case "overview": {
      const aff = ELEMENT_IDS.filter((e) => e !== "neutral").slice().sort((a, b) => ph.elements.affinity[b] - ph.elements.affinity[a]).slice(0, 5);
      body = h("div", {},
        section("Body", bodyBlock(ph)),
        section("Stats", statsBlock(ph)),
        section("Element affinity (emergent from the axes)", ...aff.map((e) => h("div", { class: "row" }, h("span", { class: "muted" }, ELEMENTS[e].name.padEnd(9)), h("div", { class: "spacer" }, bar(Math.max(0, ph.elements.affinity[e]), hex(ELEMENTS[e].color)))))));
      break;
    }
    case "genome": {
      const press = epigeneticPressure(g.conditions);
      body = h("div", {},
        h("p", {}, "Dot = expressed value (genes + life). Small grey dot = genetic value alone. Life can bend each axis by at most ±0.5."),
        ...Object.entries(SPACES).map(([name, ids]) => section(`${name} space`, ...ids.map((id) => axisRow(id as AxisId, ph.axes[id as AxisId], ph.genetic[id as AxisId])))),
        section("Body-plan genes", ...PLAN_GENES.map((k) => h("div", { class: "row" }, h("span", { class: "muted" }, k.padEnd(9)), h("div", { class: "spacer" }, bar(ph.plan[k], "#ffd166"))))),
        section("Where the life pressure comes from", h("table", { class: "t" },
          h("tr", {}, h("th", {}, "source"), h("th", {}, "strongest pushes")),
          ...Object.entries(press.sources).map(([src, v]) => h("tr", {}, h("td", {}, src), h("td", { class: "muted" }, Object.entries(v).filter(([, x]) => Math.abs(x) > 0.005).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 4).map(([k, x]) => `${k} ${x > 0 ? "+" : ""}${x.toFixed(2)}`).join(", ") || "-"))))),
        section("Lineage", h("p", {}, `Generation ${g.genome.generation}. Parents: ${g.genome.lineage.join(", ") || "wild"}. Mutations: ${g.genome.mutations.join(", ") || "none"}.`)));
      break;
    }
    case "psyche":
      body = section("Mind", psycheBlock(ph));
      break;
    case "moves":
      body = h("div", {}, section("Moveset (learned from elements, body and level)", movesBlock(g)), h("p", { class: "muted" }, "Each move runs 3 phases: charge (tell) → active (strike) → rest (vulnerable). Cost = power × area × range × accuracy × tempo + effects, × element rarity × live meta."));
      break;
    case "life": {
      body = h("div", {},
        h("p", {}, "Life conditions bend the genome: food, places, experiences, time. Some experiences need you to physically move."),
        section("Feed", h("div", { class: "row" }, select<FoodId>(FOOD_IDS.map((f) => ({ value: f, label: `${FOODS[f].name} (${FOODS[f].price}c)` })), food, (v) => (food = v)),
          h("button", { class: "btn", onclick: () => {
            feed(g, food, 1, { ...ctx(app), why: "fed in the lab" });
            refresh();
          } }, "Feed ×1"),
          h("button", { class: "btn", onclick: () => {
            feed(g, food, 10, { ...ctx(app), why: "feast in the lab" });
            refresh();
          } }, "×10"))),
        section("Experience", h("div", { class: "row" }, select<ExperienceId>(EXPERIENCE_IDS.map((e) => ({ value: e, label: `${EXPERIENCES[e].name}${EXPERIENCES[e].physicalOnly ? " (physical)" : ""}` })), exp, (v) => (exp = v)),
          h("label", { class: "row muted" }, h("input", { type: "checkbox", checked: physical, onchange: (e: Event) => (physical = (e.target as HTMLInputElement).checked) }), "I am physically there"),
          h("button", { class: "btn", onclick: () => {
            const ok = live(g, exp, 1, { ...ctx(app), physical, why: "lab experience" });
            if (!ok) toast("This experience needs physical presence (GPS).");
            refresh();
          } }, "Do it"))),
        section("Habitat", h("div", { class: "row" }, select(GROUND_IDS, ground, (v) => (ground = v)),
          h("button", { class: "btn", onclick: () => {
            expose(g, ground, 24, { ...ctx(app), why: "spent a day there" });
            refresh();
          } }, "Spend 24 h"),
          h("button", { class: "btn", onclick: () => {
            age(g, 7, { ...ctx(app), why: "a week passed" });
            refresh();
          } }, "+7 days"))),
        section("Condition record", h("dl", { class: "kv" },
          h("dt", {}, "Age"), h("dd", {}, `${fmt(g.conditions.ageDays, 1)} days`),
          h("dt", {}, "XP"), h("dd", {}, fmt(g.conditions.xp)),
          h("dt", {}, "Hunger"), h("dd", {}, fmt(g.conditions.hunger, 2)),
          h("dt", {}, "Bond"), h("dd", {}, fmt(g.conditions.bond, 2)),
          h("dt", {}, "Battles"), h("dd", {}, `${g.conditions.battles.won}W ${g.conditions.battles.lost}L ${g.conditions.battles.draws}D, ${g.conditions.battles.kos} KOs`),
          h("dt", {}, "Learned"), h("dd", {}, Object.entries(g.knowledge).map(([k, v]) => `${k}=${v}`).join(", ") || "nothing yet"))));
      break;
    }
    case "breed": {
      const others = app.profile.collection.filter((x) => x.id !== g.id);
      partner = others.some((x) => x.id === partner) ? partner : others[0]?.id ?? "";
      const pg = others.find((x) => x.id === partner);
      const seed = hashSeed(g.genome.id, pg?.genome.id ?? "", app.profile.collection.length);
      body = h("div", {},
        h("p", {}, "Combine genomes. Breeding is Mendelian (one allele from each parent), with mutations that rise with chaos."),
        section("Partner", select(others.map((x) => ({ value: x.id, label: `${x.name} (${phenotypeOf(x).elements.primary}, ${phenotypeOf(x).kind})` })), partner, (v) => {
          partner = v;
          app.render();
        }), pg ? h("p", { class: "muted" }, `Genetic distance ${fmt(geneticDistance(g.genome, pg.genome), 2)} (higher = more diverse offspring).`) : null),
        pg ? section("Operations",
          h("div", { class: "grid2" },
            h("button", { class: "btn primary", onclick: () => addChild(app, createGenemon({ seed, owner: app.profile.id, level: 5, ageDays: 1, genome: breed(g.genome, pg.genome, seed) }), `bred ${g.name} × ${pg.name}`) }, "Breed"),
            h("button", { class: "btn", onclick: () => addChild(app, createGenemon({ seed: seed + 1, owner: app.profile.id, level: Math.max(phenotypeOf(g).level, phenotypeOf(pg).level), genome: fuse(g.genome, pg.genome, seed) }), `fused ${g.name} + ${pg.name}`) }, "Fuse"),
            h("button", { class: "btn", onclick: () => addChild(app, createGenemon({ seed: seed + 2, owner: app.profile.id, level: phenotypeOf(g).level, genome: morph(g.genome, pg.genome, morphT) }), `morphed ${Math.round(morphT * 100)}%`) }, `Morph ${Math.round(morphT * 100)}%`),
            h("button", { class: "btn", onclick: () => addChild(app, createGenemon({ seed: seed + 3, owner: app.profile.id, level: phenotypeOf(g).level, genome: mutate(g.genome, seed, 0.35) }), `mutated ${g.name}`) }, "Mutate")),
          h("label", { class: "field" }, "Morph blend", h("input", { type: "range", min: 0, max: 1, step: 0.05, value: morphT, oninput: (e: Event) => (morphT = Number((e.target as HTMLInputElement).value)), onchange: () => app.render() }))) : h("p", {}, "You need at least two Genemon."),
        section("Release", h("p", { class: "muted" }, "Released Genemon return to the wild and influence spawns around you."), h("button", { class: "btn", onclick: () => {
          if (app.profile.collection.length <= 1) return;
          app.profile.collection = app.profile.collection.filter((x) => x.id !== g.id);
          app.profile.team = app.profile.team.filter((x) => x !== g.id);
          app.log("genemon.release", "user released a Genemon", g.id, g.name);
          app.selected = null;
          app.save();
          app.go("lab");
        } }, `Release ${g.name}`)));
      break;
    }
  }
  return h("div", {}, head, body);
}
