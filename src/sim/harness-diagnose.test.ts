import { describe, expect, it } from "vite-plus/test";
import { baseActionLibrary } from "./action-sandbox";
import { createInitialWorld } from "./engine";
import { editId, proposeCandidateEdits, verifyFact } from "./harness-diagnose";
import type {
  AgentHarness,
  ExecutionOutcome,
  ExecutionRecord,
  HarnessEdit,
  HarnessFact,
  HarnessGuard,
  HarnessGuidance,
  HarnessSkillTrigger,
  LibraryEntry,
  SituationFeatures,
} from "./harness-types";
import {
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type Agent,
  type AgentDirective,
  type Artifact,
  type WorldState,
} from "./types";

type Point = { x: number; y: number };

const SNAPSHOT = "/Users/stas/.claude/jobs/20600704/tmp/snap.json";
const FAILED_GATHER = "gather-local precondition failed";
const BASE_ACTIONS = baseActionLibrary().map((action) => action.id);

async function liveSnapshot(): Promise<WorldState | undefined> {
  const specifier: string = "node:fs";
  const fs = (await import(/* @vite-ignore */ specifier)) as {
    existsSync(path: string): boolean;
    readFileSync(path: string, encoding: "utf8"): string;
  };
  return fs.existsSync(SNAPSHOT)
    ? (JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) as WorldState)
    : undefined;
}

const snapshot = await liveSnapshot();

function emptyHarness(): AgentHarness {
  return {
    revision: 0,
    origin: "base",
    procedure: [],
    guards: [],
    memory: [],
    guidance: [],
    skills: [],
  };
}

function tileAt(world: WorldState, point: Point) {
  return world.terrain[point.y * WORLD_WIDTH + point.x]!;
}

function featuresFor(
  world: WorldState,
  agent: Agent,
  overrides: Partial<SituationFeatures> = {},
): SituationFeatures {
  const tile = tileAt(world, agent);
  return {
    tick: world.tick,
    energy: agent.energy,
    curiosity: agent.curiosity,
    inventory: { ...agent.inventory },
    localTerrain: tile.terrain,
    localRichness: tile.richness,
    localMoisture: tile.moisture,
    localContamination: tile.contamination,
    hasCommitment: Boolean(agent.craftingTarget),
    nearestViable: {},
    nearestStation: {},
    visibleArtifacts: 0,
    ...overrides,
  };
}

function gatherWater(overrides: Partial<AgentDirective> = {}): AgentDirective {
  return {
    goal: "gather",
    targetMaterial: "water",
    controllerAction: "collect-water",
    actionId: "forage",
    note: "gather: water; follow local evidence",
    source: "openrouter",
    ...overrides,
  };
}

function execution(
  run: string,
  world: WorldState,
  agent: Agent,
  results: string[],
  options: {
    positions?: Point[];
    energies?: number[];
    outcome?: Partial<ExecutionOutcome>;
    directive?: AgentDirective;
  } = {},
): ExecutionRecord {
  const directive = options.directive ?? gatherWater();
  const trajectory = results.map((result, index) => ({
    tick: world.tick + index + 1,
    x: options.positions?.[index]?.x ?? agent.x,
    y: options.positions?.[index]?.y ?? agent.y,
    energy: options.energies?.[index] ?? agent.energy - 0.0016 * (index + 1),
    mode: "harvesting" as const,
    result,
  }));
  const failures = results.filter((result) => result.endsWith(" precondition failed"));
  const failuresByPrimitive: Record<string, number> = {};
  for (const failure of failures) {
    const primitive = failure.replace(" precondition failed", "");
    failuresByPrimitive[primitive] = (failuresByPrimitive[primitive] ?? 0) + 1;
  }
  return {
    run,
    harness: emptyHarness(),
    directive,
    outcome: {
      goal: directive.goal,
      targetMaterial: directive.targetMaterial,
      actionId: directive.actionId ?? "forage",
      ticks: results.length,
      energyStart: agent.energy,
      energyEnd: trajectory.at(-1)?.energy ?? agent.energy,
      energyMin: Math.min(agent.energy, ...trajectory.map((step) => step.energy)),
      reboots: 0,
      gathered: { water: 0, fungus: 0, mineral: 0, cellulose: 0, chitin: 0 },
      builds: 0,
      crafts: 0,
      inspections: 0,
      repairs: 0,
      successfulPrimitives: results.length - failures.length,
      failedPrimitives: failures.length,
      failuresByPrimitive,
      pathLength: 0,
      regionsVisited: 1,
      producedNothing: true,
      events: [],
      ...options.outcome,
    },
    trajectory,
  };
}

function alternating(count: number, first: string, second: string): string[] {
  return Array.from({ length: count }, (_, index) => (index % 2 ? second : first));
}

function plainWorld(): { world: WorldState; agent: Agent } {
  const world = createInitialWorld(260826081, 0, "full-culture", 3);
  world.tick = 6_000;
  const agent = world.agents[0]!;
  agent.directive = gatherWater();
  return { world, agent };
}

/** Every tidal tile below the 0.08 gather floor, the agent stranded on one with no water left. */
function collapsedWorld(viable?: Point): { world: WorldState; agent: Agent } {
  const world = createInitialWorld(260826081, 0, "full-culture", 3);
  world.tick = 4_000;
  world.terrain.forEach((tile, index) => {
    if (tile.terrain === "tidal") tile.richness = 0.03 + (index % 5) * 0.01;
  });
  const index = world.terrain.findIndex((tile) => tile.terrain === "tidal");
  const agent = world.agents[0]!;
  agent.x = index % WORLD_WIDTH;
  agent.y = Math.floor(index / WORLD_WIDTH);
  agent.energy = 0.24;
  agent.inventory = { water: 0, fungus: 6.1, mineral: 6.3, cellulose: 6, chitin: 6.2 };
  agent.directive = gatherWater();
  if (viable)
    world.terrain[viable.y * WORLD_WIDTH + viable.x] = {
      terrain: "tidal",
      richness: 0.6,
      moisture: 0.8,
      contamination: 0.01,
    };
  return { world, agent };
}

/** The live world: an agent forced onto water while every tidal tile is depleted. */
function snapshotWorld(source: WorldState): { world: WorldState; agent: Agent } {
  const world = structuredClone(source);
  const depleted = (point: Point) => {
    const tile = tileAt(world, point);
    return tile.terrain === "tidal" && tile.richness < 0.08;
  };
  let agent = world.agents.find(
    (candidate) => depleted(candidate) && candidate.script.lastResult === FAILED_GATHER,
  );
  if (!agent) {
    agent = world.agents[0]!;
    const index = world.terrain.findIndex(
      (tile) => tile.terrain === "tidal" && tile.richness < 0.08,
    );
    agent.x = index % WORLD_WIDTH;
    agent.y = Math.floor(index / WORLD_WIDTH);
  }
  return { world, agent };
}

function strandedReferences(world: WorldState, agent: Agent, count = 3): ExecutionRecord[] {
  return Array.from({ length: count }, (_, index) =>
    execution(`ref-${index + 1}`, world, agent, alternating(60, FAILED_GATHER, "seeking water")),
  );
}

function propose(
  world: WorldState,
  agent: Agent,
  references: ExecutionRecord[],
  options: {
    features?: Partial<SituationFeatures>;
    library?: LibraryEntry[];
    base?: AgentHarness;
    knownActionIds?: string[];
  } = {},
) {
  return proposeCandidateEdits({
    world,
    agentId: agent.id,
    features: featuresFor(world, agent, options.features),
    references,
    library: options.library ?? [],
    base: options.base ?? emptyHarness(),
    knownActionIds: options.knownActionIds ?? agent.knownActionIds,
  });
}

function guards(edits: HarnessEdit[]): HarnessGuard[] {
  return edits
    .filter((edit) => edit.component === "guards")
    .map((edit) => edit.item as HarnessGuard);
}

function facts(edits: HarnessEdit[]): HarnessFact[] {
  return edits
    .filter((edit) => edit.component === "memory")
    .map((edit) => edit.item as HarnessFact);
}

function guidance(edits: HarnessEdit[]): HarnessGuidance[] {
  return edits
    .filter((edit) => edit.component === "guidance")
    .map((edit) => edit.item as HarnessGuidance);
}

function threatensWater({ effect }: HarnessGuard): boolean {
  if (effect.question === "controllerAction") return false;
  const route = (
    { goal: "gather", targetMaterial: "water", actionId: "default" } as Record<string, string>
  )[effect.question];
  return (
    route === undefined ||
    (effect.kind === "forbid" ? effect.label === route : effect.label !== route)
  );
}

function hasEnergyFloor(guard: HarnessGuard): boolean {
  return guard.when.all.some(
    (clause) => clause.feature === "energy" && clause.op === ">=" && clause.value >= 0.3,
  );
}

/** Rules every proposal obeys, whatever the scenario. */
function expectWellFormed(
  world: WorldState,
  proposal: { INV: HarnessEdit[]; DOM: HarnessEdit[] },
  references: ExecutionRecord[],
): void {
  expect(proposal.INV.length).toBeLessThanOrEqual(6);
  expect(proposal.DOM.length).toBeLessThanOrEqual(6);
  for (const [scope, edits] of Object.entries(proposal)) {
    for (const { id, ...edit } of edits) {
      expect(edit.scope).toBe(scope);
      expect(id).toBe(editId(edit));
      if (edit.source === "diagnosis") {
        const reference = references.find((record) => record.run === edit.moment.run);
        expect(reference?.trajectory.map((step) => step.tick)).toContain(edit.moment.tick);
        expect(edit.moment.text.length).toBeGreaterThan(0);
      } else expect(edit.libraryEntryId).toBeTruthy();
      const text = JSON.stringify(edit.item);
      expect(text).not.toMatch(/\{\{|\{%|score|grader|rubric/i);
    }
  }
  for (const guard of guards(proposal.INV))
    if (threatensWater(guard)) expect(hasEnergyFloor(guard)).toBe(true);
  for (const fact of facts(proposal.DOM)) {
    expect(verifyFact(world, fact)).toBe(true);
    expect(fact.text.startsWith("In this workspace")).toBe(true);
    expect(fact.text.length).toBeLessThanOrEqual(140);
    expect(fact.verifiedTick).toBe(world.tick);
  }
  for (const item of guidance(proposal.DOM)) expect(item.text.length).toBeLessThanOrEqual(160);
  for (const edit of proposal.INV)
    if (edit.component === "procedure")
      expect((edit.item as string).length).toBeLessThanOrEqual(160);
}

const collapseCases: Array<[string, () => { world: WorldState; agent: Agent }]> = [
  ["a hand-made collapsed world", () => collapsedWorld()],
  ...(snapshot
    ? [
        ["the live snapshot", () => snapshotWorld(snapshot)] as [
          string,
          () => { world: WorldState; agent: Agent },
        ],
      ]
    : []),
];

describe("workspace fact verification", () => {
  it("checks each fact kind against the current world", () => {
    const { world } = plainWorld();
    const mineral = world.terrain.findIndex((tile) => tile.terrain === "mineral");
    const tidal = world.terrain.findIndex((tile) => tile.terrain === "tidal");
    const plain = world.terrain.findIndex((tile) => tile.terrain === "plain");
    const point = (index: number) => ({
      x: index % WORLD_WIDTH,
      y: Math.floor(index / WORLD_WIDTH),
    });
    const fact = (overrides: Partial<HarnessFact>): HarnessFact => ({
      id: "f",
      kind: "resource",
      text: "In this workspace ...",
      x: 0,
      y: 0,
      verifiedTick: world.tick,
      ...overrides,
    });

    world.terrain[mineral]!.richness = 0.5;
    expect(
      verifyFact(world, fact({ kind: "resource", material: "mineral", ...point(mineral) })),
    ).toBe(true);
    expect(
      verifyFact(world, fact({ kind: "resource", material: "water", ...point(mineral) })),
    ).toBe(false);
    world.terrain[mineral]!.richness = 0.11;
    expect(
      verifyFact(world, fact({ kind: "resource", material: "mineral", ...point(mineral) })),
    ).toBe(false);
    expect(
      verifyFact(world, fact({ kind: "depleted", material: "mineral", ...point(mineral) })),
    ).toBe(true);

    world.terrain[tidal]!.richness = 0.05;
    expect(verifyFact(world, fact({ kind: "depleted", material: "water", ...point(tidal) }))).toBe(
      true,
    );
    expect(verifyFact(world, fact({ kind: "depleted", material: "fungus", ...point(tidal) }))).toBe(
      false,
    );
    world.terrain[tidal]!.richness = 0.2;
    expect(verifyFact(world, fact({ kind: "depleted", material: "water", ...point(tidal) }))).toBe(
      false,
    );
    expect(verifyFact(world, fact({ kind: "depleted", ...point(plain) }))).toBe(false);

    const station = world.stations[0]!;
    expect(
      verifyFact(
        world,
        fact({ kind: "station", stationKind: station.kind, x: station.x, y: station.y }),
      ),
    ).toBe(true);
    expect(
      verifyFact(
        world,
        fact({
          kind: "station",
          stationKind: station.kind === "wash" ? "grind" : "wash",
          x: station.x,
          y: station.y,
        }),
      ),
    ).toBe(false);
    expect(
      verifyFact(
        world,
        fact({
          kind: "station",
          stationKind: station.kind,
          x: (station.x + 1) % WORLD_WIDTH,
          y: station.y,
        }),
      ),
    ).toBe(false);

    world.terrain[plain]!.contamination = 0.5;
    expect(verifyFact(world, fact({ kind: "hazard", ...point(plain) }))).toBe(true);
    world.terrain[plain]!.contamination = 0.2;
    expect(verifyFact(world, fact({ kind: "hazard", ...point(plain) }))).toBe(false);

    world.artifacts = [{ ...artifactAt({ x: 0, y: 0 }), id: "corner" }];
    expect(
      verifyFact(world, fact({ kind: "artifact", x: WORLD_WIDTH - 1, y: WORLD_HEIGHT - 1 })),
    ).toBe(true);
    expect(verifyFact(world, fact({ kind: "artifact", x: 2, y: 0 }))).toBe(false);

    expect(verifyFact(world, fact({ kind: "hazard", x: WORLD_WIDTH, y: 0 }))).toBe(false);
    expect(verifyFact(world, fact({ kind: "hazard", x: 1.5, y: 0 }))).toBe(false);
  });
});

describe("edit identity", () => {
  it("hashes component, operation and item content only", () => {
    const guard: HarnessGuard = {
      id: "g-1",
      when: { all: [{ feature: "localRichness", op: "<", value: 0.08 }] },
      effect: { kind: "forbid", question: "targetMaterial", label: "mineral" },
      note: "gather-local failed on depleted mineral",
    };
    const edit = {
      scope: "INV" as const,
      component: "guards" as const,
      op: "add" as const,
      item: guard,
      summary: "guard",
      moment: { run: "ref-1", tick: 4, text: "failed" },
      source: "diagnosis" as const,
    };
    const id = editId(edit);
    expect(id).toBe(
      editId({
        ...edit,
        item: { ...guard, id: "g-2" },
        summary: "another summary",
        moment: { run: "ref-2", tick: 9, text: "elsewhere" },
        source: "library",
        libraryEntryId: "L1",
      }),
    );
    expect(editId({ ...edit, op: "remove" })).not.toBe(id);
    expect(editId({ ...edit, item: { ...guard, note: "other" } })).not.toBe(id);
    expect(editId({ ...edit, component: "procedure", item: "one line" })).toBe(
      editId({ ...edit, component: "procedure", item: "one line", summary: "x" }),
    );
  });
});

describe("candidate edits in a water collapse", () => {
  for (const [name, build] of collapseCases) {
    it(`stops repeated gathering on depleted water and records the depletion in ${name}`, () => {
      const { world, agent } = build();
      const references = strandedReferences(world, agent);
      const proposal = propose(world, agent, references);
      expectWellFormed(world, proposal, references);

      const guard = guards(proposal.INV).find(
        (candidate) =>
          candidate.effect.kind === "forbid" &&
          candidate.effect.question === "targetMaterial" &&
          candidate.effect.label === "water",
      );
      expect(guard?.when.all).toEqual([
        { feature: "localTerrain", op: "in", value: ["tidal"] },
        { feature: "localRichness", op: "<", value: 0.08 },
        { feature: "energy", op: ">=", value: 0.3 },
      ]);
      expect(guard?.note).toContain("depleted tidal");
      expect(proposal.INV.map((edit) => edit.item)).toContain(
        `If currentScript.lastResult is "${FAILED_GATHER}", change the activity: pick a material with a viable tile, or explore.`,
      );
      expect(proposal.INV.find((edit) => edit.component === "guards")?.moment.text).toContain(
        "3/3 runs",
      );

      const depleted = facts(proposal.DOM).find((fact) => fact.kind === "depleted");
      expect(depleted).toMatchObject({ x: agent.x, y: agent.y, material: "water" });
      const waterOption = guidance(proposal.DOM).find(
        (item) => item.question === "targetMaterial" && item.label === "water",
      );
      expect(waterOption?.text).toContain(`depleted at (${agent.x},${agent.y})`);
      const viable = world.terrain.some(
        (tile) => tile.terrain === "tidal" && tile.richness >= 0.12,
      );
      if (viable) expect(waterOption?.text).toMatch(/nearest viable water: \(\d+,\d+\)/);
      else {
        expect(waterOption?.text).toContain("no tile holds viable water");
        expect(depleted?.text).toContain("no tidal tile holds viable water");
      }
    });
  }

  it("names the nearest viable water when one tidal tile still holds it", () => {
    const { world: probe } = collapsedWorld();
    const origin = probe.agents[0]!;
    const viable = { x: (origin.x + 30) % WORLD_WIDTH, y: (origin.y + 20) % WORLD_HEIGHT };
    const { world, agent } = collapsedWorld(viable);
    const references = strandedReferences(world, agent);
    const proposal = propose(world, agent, references);
    expectWellFormed(world, proposal, references);

    const waterOption = guidance(proposal.DOM).find((item) => item.label === "water");
    expect(waterOption?.text).toContain(`nearest viable water: (${viable.x},${viable.y})`);
    expect(waterOption?.text.startsWith("Energy reserve and repair input. In this workspace")).toBe(
      true,
    );
    expect(facts(proposal.DOM)).toContainEqual(
      expect.objectContaining({ kind: "resource", material: "water", ...viable }),
    );
    expect(facts(proposal.DOM).find((fact) => fact.kind === "depleted")?.text).toContain(
      `tile (${agent.x},${agent.y}) is depleted`,
    );
  });

  it("proposes a known learned action that seeks before gathering, and only a known one", () => {
    const { world, agent } = collapsedWorld();
    world.actionLibrary.push(
      {
        id: "a-seekfirst",
        name: "Seek First",
        icon: "◎",
        algorithm: "Walk toward the requested material, then gather it.",
        program: ["seek-resource", "gather-local"],
        authorId: "A002",
        createdTick: 10,
        uses: 3,
        recipe: ["water", "fungus"],
      },
      {
        id: "a-gatherfirst",
        name: "Gather First",
        icon: "◎",
        algorithm: "Gather twice, then build.",
        program: ["gather-local", "gather-local", "build-local"],
        authorId: "A002",
        createdTick: 12,
        uses: 9,
        recipe: ["mineral", "fungus"],
      },
    );
    const references = strandedReferences(world, agent);
    const known = [...BASE_ACTIONS, "a-seekfirst", "a-gatherfirst"];
    const proposal = propose(world, agent, references, { knownActionIds: known });
    expectWellFormed(world, proposal, references);
    const skills = proposal.INV.filter((edit) => edit.component === "skills").map(
      (edit) => edit.item as HarnessSkillTrigger,
    );
    expect(skills).toEqual([
      expect.objectContaining({
        goal: "gather",
        actionId: "a-seekfirst",
        when: { all: [{ feature: "localRichness", op: "<", value: 0.08 }] },
      }),
    ]);
    const unknown = propose(world, agent, references, {
      knownActionIds: [...BASE_ACTIONS, "a-gatherfirst"],
    });
    expect(unknown.INV.some((edit) => edit.component === "skills")).toBe(false);
  });

  it("never re-proposes what the base harness already holds", () => {
    const { world, agent } = collapsedWorld();
    const references = strandedReferences(world, agent);
    const first = propose(world, agent, references);
    const guard = guards(first.INV)[0]!;
    const fact = facts(first.DOM)[0]!;
    const line = first.INV.find((edit) => edit.component === "procedure")!.item as string;
    const base = {
      ...emptyHarness(),
      procedure: [line],
      guards: [{ ...guard, id: "existing", note: "already here" }],
      memory: [{ ...fact, id: "existing-fact", text: "In this workspace water ran out." }],
    };
    const second = propose(world, agent, references, { base });
    expect(second.INV.map((edit) => edit.item)).not.toContain(line);
    expect(
      guards(second.INV).some(
        (item) =>
          JSON.stringify(item.effect) === JSON.stringify(guard.effect) &&
          JSON.stringify(item.when) === JSON.stringify(guard.when),
      ),
    ).toBe(false);
    expect(
      facts(second.DOM).some(
        (item) => item.kind === fact.kind && item.x === fact.x && item.y === fact.y,
      ),
    ).toBe(false);
  });
});

describe("evidence ranking", () => {
  it("puts divergences first, then failures repeated across references, then single-run defects", () => {
    const { world, agent } = plainWorld();
    const inspectThenGather = [
      ...Array.from({ length: 6 }, () => "inspect-local precondition failed"),
      ...Array.from({ length: 3 }, () => FAILED_GATHER),
    ];
    const references = [
      execution("ref-1", world, agent, inspectThenGather),
      execution("ref-2", world, agent, inspectThenGather),
      execution(
        "ref-3",
        world,
        agent,
        [
          FAILED_GATHER,
          FAILED_GATHER,
          FAILED_GATHER,
          "build-local precondition failed",
          "build-local precondition failed",
          "build-local precondition failed",
          "inspected an artifact",
        ],
        { outcome: { producedNothing: false, inspections: 1, pathLength: 4 } },
      ),
    ];
    const proposal = propose(world, agent, references);
    expectWellFormed(world, proposal, references);
    const order = proposal.INV.map((edit) => edit.summary);
    const position = (fragment: string) => order.findIndex((summary) => summary.includes(fragment));
    expect(position("inspect-local")).toBeGreaterThanOrEqual(0);
    expect(position("inspect-local")).toBeLessThan(position("gather-local"));
    expect(position("gather-local")).toBeLessThan(position("build-local"));
    expect(position("build-local")).toBe(order.length - 1);
  });

  it("keeps at most six edits per scope", () => {
    const { world, agent } = plainWorld();
    const results = [
      "gather-local",
      "build-local",
      "inspect-local",
      "repair-local",
      "craft-local",
      "mix-local",
      "seek-artifact",
      "seek-station",
    ].flatMap((primitive) => Array.from({ length: 3 }, () => `${primitive} precondition failed`));
    const references = strandedReferences(world, agent).map((record) =>
      execution(record.run, world, agent, results),
    );
    const proposal = propose(world, agent, references);
    expect(proposal.INV).toHaveLength(6);
    expectWellFormed(world, proposal, references);
  });
});

describe("invariant diagnosers", () => {
  it("adds an earlier refill guard after a reboot", () => {
    const { world, agent } = plainWorld();
    agent.energy = 0.08;
    agent.inventory.water = 0;
    const energies = [0.06, 0.03, 0.001, 0.42, 0.418, 0.416];
    const references = [
      execution(
        "ref-1",
        world,
        agent,
        alternating(6, "scanned plain", "surveyed a neighboring tile"),
        {
          energies,
          outcome: { reboots: 1 },
          directive: gatherWater({ goal: "explore", actionId: "survey" }),
        },
      ),
    ];
    const proposal = propose(world, agent, references);
    expectWellFormed(world, proposal, references);
    const refill = guards(proposal.INV).filter((guard) => guard.effect.kind === "require");
    expect(refill.map((guard) => guard.effect)).toEqual([
      { kind: "require", question: "goal", label: "gather" },
      { kind: "require", question: "targetMaterial", label: "water" },
    ]);
    for (const guard of refill)
      expect(guard.when.all).toEqual([
        { feature: "energy", op: "<", value: 0.7 },
        { feature: "inventory.water", op: "<", value: 1.5 },
      ]);
    expect(proposal.INV[0]!.moment).toMatchObject({ run: "ref-1", tick: world.tick + 4 });
  });

  it("forbids a hoarded material once twelve units are carried", () => {
    const { world, agent } = plainWorld();
    agent.inventory.mineral = 11;
    const references = [1, 2].map((index) =>
      execution(
        `ref-${index}`,
        world,
        agent,
        alternating(8, "gathered local material", "seeking mineral"),
        {
          directive: gatherWater({ targetMaterial: "mineral" }),
          outcome: {
            producedNothing: false,
            gathered: { water: 0, fungus: 0, mineral: 2.4, cellulose: 0, chitin: 0 },
          },
        },
      ),
    );
    const proposal = propose(world, agent, references);
    expectWellFormed(world, proposal, references);
    expect(guards(proposal.INV)).toContainEqual(
      expect.objectContaining({
        when: { all: [{ feature: "inventory.mineral", op: ">=", value: 12 }] },
        effect: { kind: "forbid", question: "targetMaterial", label: "mineral" },
      }),
    );
  });

  it("requires a build for carried build-ready matter and names its station", () => {
    const { world, agent } = plainWorld();
    agent.inventory = { water: 2, fungus: 0, mineral: 6, cellulose: 0, chitin: 0 };
    const references = [1, 2].map((index) =>
      execution(
        `ref-${index}`,
        world,
        agent,
        alternating(10, "carrying mineral to foundry", "build-local precondition failed"),
        {
          directive: gatherWater({
            goal: "build",
            targetMaterial: "mineral",
            actionId: "fabricate",
          }),
        },
      ),
    );
    const proposal = propose(world, agent, references, { features: { buildReady: "mineral" } });
    expectWellFormed(world, proposal, references);
    expect(guards(proposal.INV)).toContainEqual(
      expect.objectContaining({
        when: {
          all: [
            { feature: "buildReady", op: "=", value: true },
            { feature: "energy", op: ">=", value: 0.3 },
          ],
        },
        effect: { kind: "require", question: "goal", label: "build" },
      }),
    );
    const span = (a: Point, b: Point) =>
      Math.hypot(
        Math.min(Math.abs(a.x - b.x), WORLD_WIDTH - Math.abs(a.x - b.x)),
        Math.min(Math.abs(a.y - b.y), WORLD_HEIGHT - Math.abs(a.y - b.y)),
      );
    const foundry = world.stations
      .filter((station) => station.kind === "foundry")
      .sort((a, b) => span(agent, a) - span(agent, b))[0]!;
    expect(facts(proposal.DOM)).toContainEqual(
      expect.objectContaining({
        kind: "station",
        stationKind: "foundry",
        x: foundry.x,
        y: foundry.y,
      }),
    );
    expect(guidance(proposal.DOM).find((item) => item.label === "build")?.text).toContain(
      `foundry at (${foundry.x},${foundry.y})`,
    );
  });
});

function artifactAt(point: Point): Artifact {
  return {
    id: "T000100-A002",
    name: "Basalt Lattice",
    x: point.x,
    y: point.y,
    material: "mineral",
    health: 0.9,
    performance: 0.6,
    generation: 1,
    creatorId: "A002",
    authors: ["A002"],
    contributors: ["A002"],
    adopters: [],
    controller: { sensor: "moisture", threshold: 0.2, action: "collect-water", revision: 1 },
    stationId: "S4",
    process: "foundry",
    serviceInspectedBy: [],
    lastService: 0.4,
    serviceEma: 0.3,
    serviceIntegral: 12,
    serviceObservedTicks: 40,
    storedWater: 0.5,
    reserve: 1.5,
    flux: { waterCollected: 0.5, contaminationRemoved: 0, reserveConsumed: 0, maintenanceInput: 0 },
    builtAt: 100,
    uses: 0,
    validated: false,
  };
}

describe("domain diagnosers", () => {
  it("records a contamination hazard and points remediate at it", () => {
    const { world, agent } = plainWorld();
    const hazard = { x: (agent.x + 1) % WORLD_WIDTH, y: agent.y };
    tileAt(world, hazard).contamination = 0.7;
    const references = [1, 2].map((index) =>
      execution(
        `ref-${index}`,
        world,
        agent,
        ["scanned plain", "surveyed a neighboring tile", "scanned plain"],
        {
          positions: [agent, hazard, hazard],
          directive: gatherWater({ goal: "explore", actionId: "survey" }),
          outcome: { pathLength: 1 },
        },
      ),
    );
    const proposal = propose(world, agent, references);
    expectWellFormed(world, proposal, references);
    expect(facts(proposal.DOM)).toContainEqual(
      expect.objectContaining({ kind: "hazard", ...hazard }),
    );
    expect(guidance(proposal.DOM)).toContainEqual(
      expect.objectContaining({ question: "controllerAction", label: "remediate" }),
    );
  });

  it("records a serving, uninspected artifact and points inspect at it", () => {
    const { world, agent } = plainWorld();
    const spot = { x: (agent.x + 2) % WORLD_WIDTH, y: agent.y };
    world.artifacts = [artifactAt(spot)];
    const references = [1, 2].map((index) =>
      execution(
        `ref-${index}`,
        world,
        agent,
        alternating(6, "scanned plain", "surveyed a neighboring tile"),
        {
          directive: gatherWater({ goal: "explore", actionId: "survey" }),
          outcome: { pathLength: 3 },
        },
      ),
    );
    const proposal = propose(world, agent, references);
    expectWellFormed(world, proposal, references);
    expect(facts(proposal.DOM)).toContainEqual(
      expect.objectContaining({ kind: "artifact", ...spot }),
    );
    expect(guidance(proposal.DOM).find((item) => item.label === "inspect")?.text).toContain(
      `Basalt Lattice at (${spot.x},${spot.y})`,
    );
    world.artifacts[0]!.serviceInspectedBy = [agent.id];
    expect(
      facts(propose(world, agent, references).DOM).some((fact) => fact.kind === "artifact"),
    ).toBe(false);
  });
});

describe("library reuse", () => {
  it("contributes matched harness items with their entry id, re-verified facts only", () => {
    const { world, agent } = collapsedWorld();
    const otherTidal = world.terrain.findIndex(
      (tile, index) => tile.terrain === "tidal" && index !== agent.y * WORLD_WIDTH + agent.x,
    );
    const rich = world.terrain.findIndex((tile) => tile.terrain === "mineral");
    world.terrain[rich]!.richness = 0.9;
    const stale: HarnessFact = {
      id: "f-stale",
      kind: "depleted",
      text: "In this workspace this tile was empty long ago.",
      x: otherTidal % WORLD_WIDTH,
      y: Math.floor(otherTidal / WORLD_WIDTH),
      material: "water",
      verifiedTick: 12,
    };
    const wrong: HarnessFact = {
      id: "f-wrong",
      kind: "depleted",
      text: "In this workspace mineral ran out here.",
      x: rich % WORLD_WIDTH,
      y: Math.floor(rich / WORLD_WIDTH),
      material: "mineral",
      verifiedTick: 12,
    };
    const entry: LibraryEntry = {
      id: "L1",
      createdTick: 300,
      agentId: "A002",
      condition: "full-culture",
      visibility: "shared",
      cue: "energy:critical|water:none|terrain:tidal|richness:depleted",
      experience: {
        cue: "gathering on depleted ground",
        lesson: "guards: stop gathering where the tile is depleted",
        evidence: "inv-1 stopped failing gather-local",
        confidence: "medium",
      },
      harness: {
        revision: 2,
        origin: "adopted",
        procedure: [
          "Keep at least 1.5 water before a long walk.",
          "In this workspace walk east to (3,3) for water.",
        ],
        guards: [
          {
            id: "g-old",
            when: { all: [{ feature: "localRichness", op: "<", value: 0.08 }] },
            effect: { kind: "forbid", question: "goal", label: "gather" },
            note: "gather-local failed on depleted ground",
          },
        ],
        memory: [stale, wrong],
        guidance: [
          {
            id: "u-local",
            question: "targetMaterial",
            label: "water",
            text: "In this workspace water sits at (1,1).",
          },
          {
            id: "u-general",
            question: "goal",
            label: "explore",
            text: "Explore toward tidal ground when water runs short.",
          },
        ],
        skills: [
          {
            id: "s-unknown",
            when: { all: [] },
            goal: "gather",
            actionId: "a-unknown",
            note: "unknown here",
          },
        ],
      },
      edits: [],
      rows: [],
    };
    const references = strandedReferences(world, agent);
    const proposal = propose(world, agent, references, { library: [entry] });
    expectWellFormed(world, proposal, references);

    const library = [...proposal.INV, ...proposal.DOM].filter((edit) => edit.source === "library");
    expect(library.length).toBeGreaterThan(0);
    expect(
      library.every((edit) => edit.libraryEntryId === "L1" && edit.moment.run === "library:L1"),
    ).toBe(true);
    const libraryFacts = facts(library);
    expect(libraryFacts).toEqual([
      expect.objectContaining({
        kind: "depleted",
        x: stale.x,
        y: stale.y,
        verifiedTick: world.tick,
      }),
    ]);
    expect(libraryFacts[0]!.text).not.toBe(stale.text);
    expect(guidance(library).map((item) => item.label)).toEqual(["explore"]);
    expect(library.some((edit) => edit.component === "skills")).toBe(false);
    expect(guards(library)[0]!.when.all).toContainEqual({
      feature: "energy",
      op: ">=",
      value: 0.3,
    });
    expect(
      library.filter((edit) => edit.component === "procedure").map((edit) => edit.item),
    ).toEqual(["Keep at least 1.5 water before a long walk."]);

    const firstLibrary = proposal.INV.findIndex((edit) => edit.source === "library");
    expect(proposal.INV.slice(0, firstLibrary).every((edit) => edit.source === "diagnosis")).toBe(
      true,
    );
    expect(proposal.INV.slice(firstLibrary).every((edit) => edit.source === "library")).toBe(true);
  });
});
