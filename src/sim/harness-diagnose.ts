import { actionIdForGoal, baseActionLibrary } from "./action-sandbox";
import { identityHash32 } from "./names";
import {
  SCOPE_COMPONENTS,
  type AgentHarness,
  type ExecutionRecord,
  type HarnessClause,
  type HarnessComponent,
  type HarnessEdit,
  type HarnessFact,
  type HarnessGuard,
  type HarnessGuidance,
  type HarnessItem,
  type HarnessSkillTrigger,
  type LibraryEntry,
  type SituationFeatures,
  type TrajectoryStep,
} from "./harness-types";
import {
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type Agent,
  type AgentGoal,
  type MaterialKind,
  type Station,
  type TerrainKind,
  type Tile,
  type WorldState,
} from "./types";

type Point = { x: number; y: number };
type EditDraft = Omit<HarnessEdit, "id">;
type FactDraft = Omit<HarnessFact, "id" | "text" | "verifiedTick">;

/** One reference run's evidence for a candidate edit: its first moment and how often it recurred. */
interface Hit {
  run: string;
  step: TrajectoryStep;
  count: number;
}

interface Candidate {
  edit: EditDraft;
  /** References that show the evidence. */
  support: number;
  /** Another reference without the evidence delivered something. */
  divergent: boolean;
  occurrences: number;
}

interface Context {
  world: WorldState;
  agent: Agent;
  features: SituationFeatures;
  references: ExecutionRecord[];
  knownActionIds: string[];
}

const VIABLE_RICHNESS = 0.12;
const GATHER_FLOOR = 0.08;
const ENERGY_FLOOR = 0.3;
const REFILL_ENERGY = 0.7;
const REFILL_WATER = 1.5;
const CRASH_ENERGY = 0.1;
const HOARD_LIMIT = 12;
const HAZARD_CONTAMINATION = 0.45;
const VISIBLE_RADIUS = 6;
const REPEATED_FAILURES = 3;
const STALL_PATH = 2;
const SCOPE_LIMIT = 6;
const FAILED = " precondition failed";

const materials: readonly MaterialKind[] = ["water", "fungus", "mineral", "cellulose", "chitin"];
const materialForTerrain: Partial<Record<TerrainKind, MaterialKind>> = {
  tidal: "water",
  fungus: "fungus",
  mineral: "mineral",
  cellulose: "cellulose",
  chitin: "chitin",
};
const terrainForMaterial: Record<MaterialKind, TerrainKind> = {
  water: "tidal",
  fungus: "fungus",
  mineral: "mineral",
  cellulose: "cellulose",
  chitin: "chitin",
};
const stationForMaterial: Record<MaterialKind, Station["kind"]> = {
  water: "wash",
  fungus: "assay",
  mineral: "foundry",
  cellulose: "weave",
  chitin: "grind",
};
// Criteria text of the targetMaterial options in clef-decisions.ts, kept so guidance that
// replaces an option still says what the option is.
const materialRole: Record<MaterialKind, string> = {
  water: "Energy reserve and repair input.",
  fungus: "Biological construction matter; process at an assay.",
  mineral: "Structural construction matter; process at a foundry.",
  cellulose: "Fibrous construction matter; process at a weave station.",
  chitin: "Protective construction matter; process at a grind station.",
};
const productivePrimitive: Partial<Record<AgentGoal, string>> = {
  gather: "gather-local",
  build: "build-local",
  inspect: "inspect-local",
  maintain: "repair-local",
};
const failureFallback: Record<string, string> = {
  "gather-local": "pick a material with a viable tile, or explore",
  "build-local": "carry build-ready matter to its matching station first",
  "inspect-local": "approach an artifact first, or choose another goal",
  "repair-local": "approach an artifact with water in hand first",
  "craft-local": "gather the missing ingredient first",
  "mix-local": "gather the missing ingredient first",
};
const builtInActionIds = new Set(baseActionLibrary().map((action) => action.id));
const itemKeyFields: Record<Exclude<HarnessComponent, "procedure">, string[]> = {
  guards: ["when", "effect"],
  memory: ["kind", "x", "y", "material", "stationKind"],
  guidance: ["question", "label", "text"],
  skills: ["when", "goal", "actionId"],
};

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function at(point: Point): string {
  return `(${point.x},${point.y})`;
}

/** Truncates, so a value under a threshold never prints as the threshold. */
function fixed(value: number): string {
  return (Math.floor(value * 100 + 1e-9) / 100).toFixed(2);
}

function tileAt(world: WorldState, point: Point): Tile {
  const tile = world.terrain[point.y * WORLD_WIDTH + point.x];
  if (!tile) throw new Error("World tile missing");
  return tile;
}

function offsets(a: Point, b: Point): { dx: number; dy: number } {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return { dx: Math.min(dx, WORLD_WIDTH - dx), dy: Math.min(dy, WORLD_HEIGHT - dy) };
}

function distance(a: Point, b: Point): number {
  const { dx, dy } = offsets(a, b);
  return Math.hypot(dx, dy);
}

function tiles(world: WorldState, test: (tile: Tile) => boolean): Array<Point & { tile: Tile }> {
  return world.terrain.flatMap((tile, index) =>
    test(tile) ? [{ x: index % WORLD_WIDTH, y: Math.floor(index / WORLD_WIDTH), tile }] : [],
  );
}

function nearestViable(world: WorldState, origin: Point, material: MaterialKind) {
  return tiles(
    world,
    (tile) => materialForTerrain[tile.terrain] === material && tile.richness >= VIABLE_RICHNESS,
  )
    .map((point) => ({ ...point, distance: distance(origin, point) }))
    .sort((a, b) => a.distance - b.distance)[0];
}

function richestTile(world: WorldState, origin: Point, material: MaterialKind) {
  return tiles(world, (tile) => materialForTerrain[tile.terrain] === material).sort(
    (a, b) => b.tile.richness - a.tile.richness || distance(origin, a) - distance(origin, b),
  )[0];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return identityHash32(canonical(value)).toString(36);
}

function itemContent(item: HarnessItem): unknown {
  return typeof item === "string"
    ? item
    : Object.fromEntries(Object.entries(item).filter(([key]) => key !== "id"));
}

function withId<T extends Exclude<HarnessItem, string>>(prefix: string, item: Omit<T, "id">): T {
  return { id: `${prefix}-${hash(item)}`, ...item } as T;
}

/** What an item says, so a restatement of the base or of another candidate is caught. */
function itemKey(component: HarnessComponent, item: HarnessItem): string {
  if (typeof item === "string") return `${component}:${item}`;
  const record = item as unknown as Record<string, unknown>;
  const fields = itemKeyFields[component as Exclude<HarnessComponent, "procedure">];
  return `${component}:${canonical(fields.map((field) => record[field]))}`;
}

function harnessItems(harness: AgentHarness): Array<[HarnessComponent, HarnessItem]> {
  return [
    ...harness.procedure.map((line): [HarnessComponent, HarnessItem] => ["procedure", line]),
    ...harness.guards.map((item): [HarnessComponent, HarnessItem] => ["guards", item]),
    ...harness.memory.map((item): [HarnessComponent, HarnessItem] => ["memory", item]),
    ...harness.guidance.map((item): [HarnessComponent, HarnessItem] => ["guidance", item]),
    ...harness.skills.map((item): [HarnessComponent, HarnessItem] => ["skills", item]),
  ];
}

export function editId(edit: Omit<HarnessEdit, "id">): string {
  return `e-${hash([edit.component, edit.op, itemContent(edit.item)])}`;
}

export function verifyFact(state: WorldState, fact: HarnessFact): boolean {
  if (
    !Number.isInteger(fact.x) ||
    !Number.isInteger(fact.y) ||
    fact.x < 0 ||
    fact.y < 0 ||
    fact.x >= WORLD_WIDTH ||
    fact.y >= WORLD_HEIGHT
  )
    return false;
  const tile = tileAt(state, fact);
  const material = materialForTerrain[tile.terrain];
  if (fact.kind === "resource")
    return material !== undefined && material === fact.material && tile.richness >= VIABLE_RICHNESS;
  if (fact.kind === "depleted")
    return (
      material !== undefined &&
      (fact.material === undefined || material === fact.material) &&
      tile.richness < VIABLE_RICHNESS
    );
  if (fact.kind === "station")
    return state.stations.some(
      (station) =>
        station.kind === fact.stationKind && station.x === fact.x && station.y === fact.y,
    );
  if (fact.kind === "hazard") return tile.contamination >= HAZARD_CONTAMINATION;
  return state.artifacts.some((artifact) => {
    const { dx, dy } = offsets(fact, artifact);
    return dx <= 1 && dy <= 1;
  });
}

/** Fact text read from the current world, so a re-verified library fact never carries stale numbers. */
function describeFact(world: WorldState, fact: FactDraft): string {
  const tile = tileAt(world, fact);
  const material = fact.material ?? materialForTerrain[tile.terrain] ?? "matter";
  if (fact.kind === "resource")
    return `In this workspace ${at(fact)} is ${tile.terrain} with viable ${material}, richness ${fixed(tile.richness)}.`;
  if (fact.kind === "depleted")
    return material !== "matter" && !nearestViable(world, fact, material)
      ? `In this workspace no ${tile.terrain} tile holds viable ${material} (>= 0.12); ${at(fact)} has ${fixed(tile.richness)}.`
      : `In this workspace the ${tile.terrain} tile ${at(fact)} is depleted: ${material} richness ${fixed(tile.richness)}, under 0.12.`;
  if (fact.kind === "station") {
    const processed = materials.find(
      (candidate) => stationForMaterial[candidate] === fact.stationKind,
    );
    return `In this workspace the ${fact.stationKind} station at ${at(fact)} processes ${processed}.`;
  }
  if (fact.kind === "hazard")
    return `In this workspace ${at(fact)} holds contamination ${fixed(tile.contamination)}, above the 0.45 hazard mark.`;
  const artifact = world.artifacts
    .filter((candidate) => {
      const { dx, dy } = offsets(fact, candidate);
      return dx <= 1 && dy <= 1;
    })
    .sort((a, b) => distance(fact, a) - distance(fact, b))[0]!;
  return clip(
    `In this workspace ${clip(artifact.name, 32)} (${artifact.material}, ${artifact.controller.action}) stands at ${at(artifact)}, last service ${fixed(artifact.lastService ?? 0)}.`,
    140,
  );
}

function makeFact(world: WorldState, fact: FactDraft): HarnessFact {
  return withId<HarnessFact>("f", {
    ...fact,
    text: clip(describeFact(world, fact), 140),
    verifiedTick: world.tick,
  });
}

/** True when the effect could take away the water route (gather, water, built-in forage). */
function threatensWater({ kind, question, label }: HarnessGuard["effect"]): boolean {
  if (question === "controllerAction") return false;
  const route = (
    { goal: "gather", targetMaterial: "water", actionId: "default" } as Record<string, string>
  )[question];
  return route === undefined || (kind === "forbid" ? label === route : label !== route);
}

/** Guards never hold while energy < 0.3 if they could block the only energy source. */
function makeGuard(
  when: HarnessClause[],
  effect: HarnessGuard["effect"],
  note: string,
): HarnessGuard {
  const floored =
    threatensWater(effect) &&
    !when.some(
      (clause) => clause.feature === "energy" && clause.op === ">=" && clause.value >= ENERGY_FLOOR,
    );
  return withId<HarnessGuard>("g", {
    when: {
      all: floored ? [...when, { feature: "energy", op: ">=", value: ENERGY_FLOOR }] : when,
    },
    effect,
    note: clip(note, 160),
  });
}

function scopeOf(component: HarnessComponent): "INV" | "DOM" {
  return SCOPE_COMPONENTS.INV.includes(component) ? "INV" : "DOM";
}

function candidate(
  context: Context,
  component: HarnessComponent,
  item: HarnessItem,
  summary: string,
  hits: Hit[],
  text: string,
): Candidate {
  const first = hits[0]!;
  const runs = new Set(hits.map((hit) => hit.run));
  return {
    edit: {
      scope: scopeOf(component),
      component,
      op: "add",
      item,
      summary: clip(summary, 120),
      moment: {
        run: first.run,
        tick: first.step.tick,
        text: clip(`${text}; ${runs.size}/${context.references.length} runs`, 200),
      },
      source: "diagnosis",
    },
    support: runs.size,
    divergent: context.references.some(
      (record) => !runs.has(record.run) && !record.outcome.producedNothing,
    ),
    occurrences: hits.reduce((total, hit) => total + hit.count, 0),
  };
}

function failedPrimitive(result: string): string | undefined {
  return result.endsWith(FAILED) ? result.slice(0, -FAILED.length) : undefined;
}

function hitsWhere(
  context: Context,
  match: (record: ExecutionRecord) => TrajectoryStep[],
  minimum = 1,
): Hit[] {
  return context.references.flatMap((record) => {
    const steps = match(record);
    return steps.length >= minimum
      ? [{ run: record.run, step: steps[0]!, count: steps.length }]
      : [];
  });
}

/** gather-local failures on tiles whose own material sits below the gather floor. */
function depletedGathers(
  context: Context,
): Map<MaterialKind, { hits: Hit[]; steps: TrajectoryStep[] }> {
  const result = new Map<MaterialKind, { hits: Hit[]; steps: TrajectoryStep[] }>();
  for (const material of materials) {
    const steps: TrajectoryStep[] = [];
    const hits = hitsWhere(context, (record) => {
      const matched = record.trajectory.filter((step) => {
        if (failedPrimitive(step.result) !== "gather-local") return false;
        const tile = tileAt(context.world, step);
        return materialForTerrain[tile.terrain] === material && tile.richness < GATHER_FLOOR;
      });
      steps.push(...matched);
      return matched;
    });
    if (hits.length) result.set(material, { hits, steps });
  }
  return result;
}

function seekingHits(context: Context, material: MaterialKind): Hit[] {
  return hitsWhere(context, (record) =>
    record.trajectory.filter((step) => step.result.startsWith(`seeking ${material}`)),
  );
}

/* ---------- INV: how the agent works ---------- */

function repeatedFailures(context: Context): Candidate[] {
  const primitives = new Set(
    context.references.flatMap((record) =>
      record.trajectory.flatMap((step) => failedPrimitive(step.result) ?? []),
    ),
  );
  return [...primitives].flatMap((primitive) => {
    const hits = hitsWhere(
      context,
      (record) => record.trajectory.filter((step) => failedPrimitive(step.result) === primitive),
      REPEATED_FAILURES,
    );
    if (!hits.length) return [];
    const first = hits[0]!;
    const tile = tileAt(context.world, first.step);
    const line = `If currentScript.lastResult is "${primitive}${FAILED}", change the activity: ${failureFallback[primitive] ?? "choose another goal or material"}.`;
    return [
      candidate(
        context,
        "procedure",
        line,
        `procedure: change the activity after ${primitive} fails`,
        hits,
        `${primitive} failed ${first.count}x, first at ${at(first.step)} on ${tile.terrain} (richness ${fixed(tile.richness)})`,
      ),
    ];
  });
}

function depletedGatherGuards(context: Context): Candidate[] {
  return [...depletedGathers(context)].map(([material, { hits }]) => {
    const terrain = terrainForMaterial[material];
    const first = hits[0]!;
    const guard = makeGuard(
      [
        { feature: "localTerrain", op: "in", value: [terrain] },
        { feature: "localRichness", op: "<", value: GATHER_FLOOR },
      ],
      { kind: "forbid", question: "targetMaterial", label: material },
      `gather-local failed ${first.count}x on depleted ${terrain} ${at(first.step)} in ${hits.length}/${context.references.length} runs`,
    );
    return candidate(
      context,
      "guards",
      guard,
      `guard: forbid ${material} target on depleted ${terrain}${guard.when.all.some((clause) => clause.feature === "energy") ? " while energy >= 0.3" : ""}`,
      hits,
      `gather-local failed ${first.count}x on depleted ${terrain} at ${at(first.step)} (richness ${fixed(tileAt(context.world, first.step).richness)})`,
    );
  });
}

function energyCrashes(context: Context): Candidate[] {
  const hits = context.references.flatMap((record): Hit[] => {
    const steps = record.trajectory;
    if (!steps.length || (!record.outcome.reboots && record.outcome.energyMin >= CRASH_ENERGY))
      return [];
    const reboot = steps.find(
      (step, index) => index > 0 && step.energy > steps[index - 1]!.energy + 0.3,
    );
    const low = steps.reduce((lowest, step) => (step.energy < lowest.energy ? step : lowest));
    return [{ run: record.run, step: reboot ?? low, count: Math.max(1, record.outcome.reboots) }];
  });
  if (!hits.length) return [];
  const first = hits[0]!;
  const record = context.references.find((candidate) => candidate.run === first.run)!;
  const text = record.outcome.reboots
    ? `rebooted at ${at(first.step)} on tick ${first.step.tick} after energy ran out, carrying ${fixed(context.features.inventory.water)} water`
    : `energy fell to ${fixed(record.outcome.energyMin)} near ${at(first.step)}, carrying ${fixed(context.features.inventory.water)} water`;
  const when: HarnessClause[] = [
    { feature: "energy", op: "<", value: REFILL_ENERGY },
    { feature: "inventory.water", op: "<", value: REFILL_WATER },
  ];
  const note = `refill before energy ${REFILL_ENERGY}: ${first.run} ${record.outcome.reboots ? "rebooted" : "crashed"} on tick ${first.step.tick}`;
  return [
    candidate(
      context,
      "guards",
      makeGuard(when, { kind: "require", question: "goal", label: "gather" }, note),
      `guard: require gather below energy ${REFILL_ENERGY} with water < ${REFILL_WATER}`,
      hits,
      text,
    ),
    candidate(
      context,
      "guards",
      makeGuard(when, { kind: "require", question: "targetMaterial", label: "water" }, note),
      `guard: require water target below energy ${REFILL_ENERGY} with water < ${REFILL_WATER}`,
      hits,
      text,
    ),
  ];
}

function stalls(context: Context): Candidate[] {
  const hits = hitsWhere(context, (record) =>
    record.outcome.producedNothing && record.outcome.pathLength <= STALL_PATH
      ? record.trajectory.slice(0, 1)
      : [],
  );
  if (!hits.length) return [];
  const first = hits[0]!;
  const outcome = context.references.find((record) => record.run === first.run)!.outcome;
  return [
    candidate(
      context,
      "procedure",
      "If previousPlan produced nothing and the agent stayed on one tile, do not choose the same goal and material again; change one of them.",
      "procedure: change goal or material after a stalled activity",
      hits,
      `produced nothing in ${outcome.ticks} ticks and moved ${outcome.pathLength.toFixed(1)} tiles from ${at(first.step)}`,
    ),
  ];
}

function hoarding(context: Context): Candidate[] {
  return materials
    .filter((material) => material !== "water")
    .flatMap((material) => {
      const carried = context.features.inventory[material];
      const hits = hitsWhere(context, (record) => {
        const gathered = record.outcome.gathered[material];
        if (gathered <= 0 || carried + gathered < HOARD_LIMIT) return [];
        const step =
          record.trajectory.find((candidate) => candidate.result === "gathered local material") ??
          record.trajectory[0];
        return step ? [step] : [];
      });
      if (!hits.length) return [];
      const gathered = context.references.find((record) => record.run === hits[0]!.run)!.outcome
        .gathered[material];
      const guard = makeGuard(
        [{ feature: `inventory.${material}` as const, op: ">=", value: HOARD_LIMIT }],
        { kind: "forbid", question: "targetMaterial", label: material },
        `hoarding: gathered more ${material} while carrying ${fixed(carried)} in ${hits.length}/${context.references.length} runs`,
      );
      return [
        candidate(
          context,
          "guards",
          guard,
          `guard: forbid ${material} target once ${material} >= ${HOARD_LIMIT}`,
          hits,
          `gathered ${fixed(gathered)} more ${material} on top of ${fixed(carried)} carried`,
        ),
      ];
    });
}

function unbuiltMatter(context: Context): Candidate[] {
  const material = context.features.buildReady;
  if (!material) return [];
  const hits = hitsWhere(context, (record) =>
    record.outcome.builds === 0 ? record.trajectory.slice(0, 1) : [],
  );
  if (!hits.length) return [];
  const ticks = context.references.find((record) => record.run === hits[0]!.run)!.outcome.ticks;
  const guard = makeGuard(
    [{ feature: "buildReady", op: "=", value: true }],
    { kind: "require", question: "goal", label: "build" },
    `carried build-ready ${material} without building in ${hits.length}/${context.references.length} runs`,
  );
  return [
    candidate(
      context,
      "guards",
      guard,
      "guard: require build while carrying build-ready matter (energy >= 0.3)",
      hits,
      `carried build-ready ${material} for ${ticks} ticks from ${at(hits[0]!.step)} without building`,
    ),
  ];
}

function learnedActions(context: Context): Candidate[] {
  const learned = context.world.actionLibrary.filter(
    (action) => context.knownActionIds.includes(action.id) && !builtInActionIds.has(action.id),
  );
  if (!learned.length) return [];
  const goals = [...new Set(context.references.map((record) => record.directive.goal))].filter(
    (goal) => productivePrimitive[goal],
  );
  return goals.flatMap((goal) => {
    const primitive = productivePrimitive[goal]!;
    const hits = hitsWhere(context, (record) => {
      if (
        record.directive.goal !== goal ||
        record.directive.actionId !== actionIdForGoal(goal) ||
        !record.outcome.producedNothing
      )
        return [];
      const failures = record.trajectory.filter(
        (step) => failedPrimitive(step.result) === primitive,
      );
      return failures.length ? failures : record.trajectory.slice(0, 1);
    });
    if (!hits.length) return [];
    const proven = context.references.find(
      (record) =>
        record.directive.goal === goal &&
        !record.outcome.producedNothing &&
        learned.some((action) => action.id === record.directive.actionId),
    );
    const action = proven
      ? learned.find((candidate) => candidate.id === proven.directive.actionId)
      : learned
          .filter((candidate) => {
            const index = candidate.program.indexOf(
              primitive as (typeof candidate.program)[number],
            );
            return (
              index > 0 &&
              candidate.program.slice(0, index).some((step) => step.startsWith("seek-"))
            );
          })
          .sort((a, b) => b.uses - a.uses || a.id.localeCompare(b.id))[0];
    if (!action) return [];
    const when: HarnessClause[] =
      goal === "build"
        ? [{ feature: "buildReady", op: "=", value: true }]
        : context.features.localRichness < GATHER_FLOOR
          ? [{ feature: "localRichness", op: "<", value: GATHER_FLOOR }]
          : [{ feature: "localTerrain", op: "in", value: [context.features.localTerrain] }];
    const builtIn = actionIdForGoal(goal);
    const skill = withId<HarnessSkillTrigger>("s", {
      when: { all: when },
      goal,
      actionId: action.id,
      note: clip(
        proven
          ? `${action.name} delivered for ${goal} in ${proven.run}; ${builtIn} produced nothing in ${hits.length} runs`
          : `${builtIn} produced nothing for ${goal} in ${hits.length} runs; ${action.name} seeks before ${primitive}`,
        160,
      ),
    });
    return [
      candidate(
        context,
        "skills",
        skill,
        `skill: run ${action.name} (${action.id}) for ${goal}`,
        hits,
        `${builtIn} produced nothing for ${goal}; ${primitive} failed ${hits[0]!.count}x from ${at(hits[0]!.step)}`,
      ),
    ];
  });
}

/* ---------- DOM: what a practitioner knows about this workspace ---------- */

function resourceFacts(context: Context): Candidate[] {
  return materials.flatMap((material) => {
    const hits = seekingHits(context, material);
    const viable = hits.length ? nearestViable(context.world, context.agent, material) : undefined;
    if (!viable || viable.distance < 1) return [];
    return [
      candidate(
        context,
        "memory",
        makeFact(context.world, { kind: "resource", x: viable.x, y: viable.y, material }),
        `fact: viable ${material} at ${at(viable)}`,
        hits,
        `seeking ${material} from ${at(hits[0]!.step)}; nearest viable ${material} ${viable.distance.toFixed(0)} tiles away`,
      ),
    ];
  });
}

function depletedTiles(context: Context): Candidate[] {
  const depleted = depletedGathers(context);
  return materials.flatMap((material) => {
    const viable = nearestViable(context.world, context.agent, material);
    const local = depleted.get(material);
    const sought = local || viable ? [] : seekingHits(context, material);
    let anchor: Point;
    let hits: Hit[];
    let text: string;
    if (local) {
      const counts = new Map<string, number>();
      for (const step of local.steps) counts.set(at(step), (counts.get(at(step)) ?? 0) + 1);
      anchor = local.steps.reduce((best, step) =>
        counts.get(at(step))! > counts.get(at(best))! ? step : best,
      );
      hits = local.hits;
      text = `gather-local failed ${counts.get(at(anchor))}x on depleted ${terrainForMaterial[material]} at ${at(anchor)}`;
    } else {
      const richest = sought.length
        ? richestTile(context.world, context.agent, material)
        : undefined;
      if (!richest) return [];
      anchor = richest;
      hits = sought;
      text = `seeking ${material} from ${at(hits[0]!.step)} while no ${terrainForMaterial[material]} tile holds viable ${material}`;
    }
    const best = viable ? undefined : richestTile(context.world, context.agent, material)!;
    const where = viable
      ? `nearest viable ${material}: ${at(viable)}, ${viable.distance.toFixed(0)} tiles.`
      : `no tile holds viable ${material}, best ${at(best!)} at ${fixed(best!.tile.richness)}, ${distance(context.agent, best!).toFixed(0)} tiles.`;
    const guidance = withId<HarnessGuidance>("u", {
      question: "targetMaterial",
      label: material,
      text: clip(
        `${materialRole[material]} In this workspace ${material} is depleted at ${at(anchor)}; ${where}`,
        160,
      ),
    });
    return [
      candidate(
        context,
        "memory",
        makeFact(context.world, { kind: "depleted", x: anchor.x, y: anchor.y, material }),
        `fact: ${material} depleted at ${at(anchor)}`,
        hits,
        text,
      ),
      candidate(
        context,
        "guidance",
        guidance,
        `guidance: ${material} option names the depleted tile and ${viable ? "nearest viable" : "best remaining"} ${material}`,
        hits,
        text,
      ),
    ];
  });
}

function stationFacts(context: Context): Candidate[] {
  const material = context.features.buildReady;
  if (!material) return [];
  const kind = stationForMaterial[material];
  const station = context.world.stations
    .filter((candidate) => candidate.kind === kind)
    .sort((a, b) => distance(context.agent, a) - distance(context.agent, b))[0];
  if (!station) return [];
  const hits = hitsWhere(context, (record) => {
    if (record.outcome.builds) return [];
    const carrying = record.trajectory.find(
      (step) =>
        step.result.startsWith(`carrying ${material}`) || step.result.startsWith(`seeking ${kind}`),
    );
    return carrying ? [carrying] : record.trajectory.slice(0, 1);
  });
  if (!hits.length) return [];
  const away = distance(context.agent, station).toFixed(0);
  const text = `carried build-ready ${material} without building; the ${kind} at ${at(station)} is ${away} tiles away`;
  return [
    candidate(
      context,
      "memory",
      makeFact(context.world, { kind: "station", x: station.x, y: station.y, stationKind: kind }),
      `fact: ${kind} station at ${at(station)}`,
      hits,
      text,
    ),
    candidate(
      context,
      "guidance",
      withId<HarnessGuidance>("u", {
        question: "goal",
        label: "build",
        text: clip(
          `Build from carried matter at its station. In this workspace carried ${material} is build-ready; the ${kind} at ${at(station)} is ${away} tiles away.`,
          160,
        ),
      }),
      `guidance: build option names the ${kind} at ${at(station)}`,
      hits,
      text,
    ),
  ];
}

function hazards(context: Context): Candidate[] {
  const hits = hitsWhere(context, (record) =>
    record.trajectory.filter(
      (step) => tileAt(context.world, step).contamination >= HAZARD_CONTAMINATION,
    ),
  );
  if (!hits.length) return [];
  const anchor = hits[0]!.step;
  const contamination = tileAt(context.world, anchor).contamination;
  const text = `crossed contamination ${fixed(contamination)} at ${at(anchor)} ${hits[0]!.count}x`;
  return [
    candidate(
      context,
      "memory",
      makeFact(context.world, { kind: "hazard", x: anchor.x, y: anchor.y }),
      `fact: contamination hazard at ${at(anchor)}`,
      hits,
      text,
    ),
    candidate(
      context,
      "guidance",
      withId<HarnessGuidance>("u", {
        question: "controllerAction",
        label: "remediate",
        text: `Remove local contamination. In this workspace ${at(anchor)} holds contamination ${fixed(contamination)}, above the 0.45 hazard mark.`,
      }),
      `guidance: remediate option names the hazard at ${at(anchor)}`,
      hits,
      text,
    ),
  ];
}

function serviceableArtifacts(context: Context): Candidate[] {
  const { agent } = context;
  const artifact = context.world.artifacts
    .filter(
      (candidate) =>
        distance(agent, candidate) <= VISIBLE_RADIUS &&
        (candidate.lastService ?? 0) > 0 &&
        candidate.health > 0.05 &&
        candidate.creatorId !== agent.id &&
        !candidate.serviceInspectedBy?.includes(agent.id),
    )
    .sort((a, b) => distance(agent, a) - distance(agent, b) || a.id.localeCompare(b.id))[0];
  if (!artifact) return [];
  const hits = hitsWhere(context, (record) =>
    record.outcome.inspections || !record.trajectory.length
      ? []
      : [
          record.trajectory.reduce((closest, step) =>
            distance(step, artifact) < distance(closest, artifact) ? step : closest,
          ),
        ],
  );
  if (!hits.length) return [];
  const name = clip(artifact.name, 32);
  const away = distance(agent, artifact).toFixed(0);
  const text = `passed within ${distance(hits[0]!.step, artifact).toFixed(0)} tiles of serving ${artifact.id} without inspecting it`;
  return [
    candidate(
      context,
      "memory",
      makeFact(context.world, { kind: "artifact", x: artifact.x, y: artifact.y }),
      `fact: serving artifact ${artifact.id} at ${at(artifact)}`,
      hits,
      text,
    ),
    candidate(
      context,
      "guidance",
      withId<HarnessGuidance>("u", {
        question: "goal",
        label: "inspect",
        text: clip(
          `Inspect an inherited artifact and verify its service. In this workspace ${name} at ${at(artifact)}, ${away} tiles away, is serving and uninspected.`,
          160,
        ),
      }),
      `guidance: inspect option names ${artifact.id}`,
      hits,
      text,
    ),
  ];
}

/* ---------- Library reuse ---------- */

function libraryItemLabel(component: HarnessComponent, item: HarnessItem): string {
  if (typeof item === "string") return clip(item, 60);
  if (component === "guards") {
    const { effect } = item as HarnessGuard;
    return `${effect.kind} ${effect.question}=${effect.label}`;
  }
  if (component === "memory") {
    const fact = item as HarnessFact;
    return `${fact.kind} at ${at(fact)}`;
  }
  if (component === "guidance") {
    const guidance = item as HarnessGuidance;
    return `${guidance.question}=${guidance.label}`;
  }
  const skill = item as HarnessSkillTrigger;
  return `${skill.goal} -> ${skill.actionId}`;
}

/** Earlier adopted harness items, adapted to this workspace: facts only after re-verification,
 * skills only for known actions, guards with the energy floor, and no prose that asserts
 * another workspace's facts. */
function libraryCandidates(context: Context, entries: LibraryEntry[]): Candidate[] {
  const general = (text: string) => !text.includes("In this workspace");
  return entries.flatMap((entry) => {
    const { harness } = entry;
    const items: Array<[HarnessComponent, HarnessItem]> = [
      ...harness.procedure
        .filter(general)
        .map((line): [HarnessComponent, HarnessItem] => ["procedure", line]),
      ...harness.guards.map((guard): [HarnessComponent, HarnessItem] => [
        "guards",
        makeGuard(guard.when.all, guard.effect, guard.note),
      ]),
      ...harness.skills
        .filter((skill) => context.knownActionIds.includes(skill.actionId))
        .map((skill): [HarnessComponent, HarnessItem] => [
          "skills",
          withId<HarnessSkillTrigger>("s", {
            when: skill.when,
            goal: skill.goal,
            actionId: skill.actionId,
            note: skill.note,
          }),
        ]),
      ...harness.guidance
        .filter((guidance) => general(guidance.text))
        .map((guidance): [HarnessComponent, HarnessItem] => [
          "guidance",
          withId<HarnessGuidance>("u", {
            question: guidance.question,
            label: guidance.label,
            text: guidance.text,
          }),
        ]),
      ...harness.memory
        .filter((fact) => verifyFact(context.world, fact))
        .map((fact): [HarnessComponent, HarnessItem] => [
          "memory",
          makeFact(context.world, {
            kind: fact.kind,
            x: fact.x,
            y: fact.y,
            material: fact.material,
            stationKind: fact.stationKind,
          }),
        ]),
    ];
    const lesson = entry.experience?.lesson ?? `adopted without a lesson under ${entry.cue}`;
    return items.map(([component, item]): Candidate => {
      const label = libraryItemLabel(component, item);
      return {
        edit: {
          scope: scopeOf(component),
          component,
          op: "add",
          item,
          summary: clip(`library ${entry.id}: ${component} ${label}`, 120),
          moment: {
            run: `library:${entry.id}`,
            tick: entry.createdTick,
            text: clip(
              component === "memory"
                ? `re-verified ${label} on tick ${context.world.tick}; ${lesson}`
                : lesson,
              200,
            ),
          },
          source: "library",
          libraryEntryId: entry.id,
        },
        support: 0,
        divergent: false,
        occurrences: 0,
      };
    });
  });
}

/** Repeated-and-divergent evidence first, then repeated, then library reuse, then defects seen
 * in a single run of several. */
function weight(candidate: Candidate, references: number): number {
  if (candidate.edit.source === "library") return 1;
  if (candidate.support < Math.min(2, references)) return 0;
  return candidate.divergent ? 3 : 2;
}

/** `library` holds the entries matchLibrary selected for this situation. */
export function proposeCandidateEdits(input: {
  world: WorldState;
  agentId: string;
  features: SituationFeatures;
  references: ExecutionRecord[];
  library: LibraryEntry[];
  base: AgentHarness;
  knownActionIds: string[];
}): { INV: HarnessEdit[]; DOM: HarnessEdit[] } {
  const agent = input.world.agents.find((candidate) => candidate.id === input.agentId);
  if (!agent) throw new Error(`Unknown agent ${input.agentId}`);
  const context: Context = {
    world: input.world,
    agent,
    features: input.features,
    references: input.references,
    knownActionIds: input.knownActionIds,
  };
  const candidates = [
    ...depletedGatherGuards(context),
    ...repeatedFailures(context),
    ...energyCrashes(context),
    ...stalls(context),
    ...hoarding(context),
    ...unbuiltMatter(context),
    ...learnedActions(context),
    ...depletedTiles(context),
    ...resourceFacts(context),
    ...stationFacts(context),
    ...hazards(context),
    ...serviceableArtifacts(context),
    ...libraryCandidates(context, input.library),
  ].filter(
    ({ edit }) => edit.component !== "memory" || verifyFact(input.world, edit.item as HarnessFact),
  );
  const references = input.references.length;
  const ranked = candidates
    .map((entry, order) => ({ entry, order, weight: weight(entry, references) }))
    .sort(
      (a, b) =>
        b.weight - a.weight ||
        b.entry.support - a.entry.support ||
        Number(b.entry.edit.component === "memory") - Number(a.entry.edit.component === "memory") ||
        b.entry.occurrences - a.entry.occurrences ||
        a.order - b.order,
    );
  const seen = new Set(
    harnessItems(input.base).map(([component, item]) => itemKey(component, item)),
  );
  const result: { INV: HarnessEdit[]; DOM: HarnessEdit[] } = { INV: [], DOM: [] };
  for (const { entry } of ranked) {
    const key = itemKey(entry.edit.component, entry.edit.item);
    const scoped = result[entry.edit.scope];
    if (seen.has(key) || scoped.length >= SCOPE_LIMIT) continue;
    seen.add(key);
    scoped.push({ id: editId(entry.edit), ...entry.edit });
  }
  return result;
}
