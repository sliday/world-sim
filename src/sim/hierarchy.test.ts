import { describe, expect, it } from "vite-plus/test";
import { advanceWorld, applyDirective, createInitialWorld, decisionObservation } from "./engine";
import {
  aggregateEdges,
  collectDeferenceActs,
  computeHierarchy,
  DEFERENCE_WEIGHTS,
  gini,
  hierarchyHistoryPoint,
  HIERARCHY_MIN_EDGES,
  pageRank,
  topDecileShare,
  triadTransitivity,
  type DeferenceEdge,
} from "./hierarchy";
import type { Artifact, WorldState } from "./types";

function artifact(id: string, creatorId: string, fields: Partial<Artifact> = {}): Artifact {
  return {
    id,
    name: id,
    x: 0,
    y: 0,
    material: "mineral",
    health: 1,
    performance: 0.5,
    generation: 1,
    creatorId,
    authors: [creatorId],
    contributors: [creatorId],
    adopters: [],
    serviceInspectedBy: [],
    controller: { sensor: "contamination", threshold: 0.2, action: "remediate", revision: 1 },
    builtAt: 0,
    uses: 0,
    validated: false,
    ...fields,
  };
}

function emptyWorld(): WorldState {
  const world = createInitialWorld(260826081, 0);
  world.artifacts = [];
  return world;
}

function agentIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `A${String(index + 1).padStart(3, "0")}`);
}

/** Every bot in `deferrers` adopts one artifact made by `creator`. */
function starWorld(creator: string, deferrers: string[]): WorldState {
  const world = emptyWorld();
  world.artifacts = deferrers.map((id, index) =>
    artifact(`T${index}-${creator}`, creator, { adopters: [id] }),
  );
  return world;
}

function allFinite(report: ReturnType<typeof computeHierarchy>): boolean {
  const numbers = JSON.stringify(report).match(/-?\d+(\.\d+)?(e[-+]?\d+)?|NaN|Infinity/g) ?? [];
  return !numbers.some((value) => value === "NaN" || value === "Infinity");
}

describe("measured hierarchy", () => {
  it("reports insufficient data instead of a ranking when nobody has deferred yet", () => {
    const report = computeHierarchy(emptyWorld());
    expect(report.metrics.deferenceEdges).toBe(0);
    expect(report.metrics.prestigeGini).toBeUndefined();
    expect(report.metrics.topDecileShare).toBeUndefined();
    expect(report.metrics.nullModel).toBeUndefined();
    expect(report.metrics.transitivity).toBeUndefined();
    expect(report.metrics.lineageMaxGeneration).toBeUndefined();
    expect(report.metrics.insufficient.concentration).toContain(`at least ${HIERARCHY_MIN_EDGES}`);
    expect(report.agents.every((agent) => agent.rank === undefined)).toBe(true);
    for (const agent of report.agents) expect(agent.prestige).toBeCloseTo(1, 9);
    expect(allFinite(report)).toBe(true);
  });

  it("turns adoption, inspection, repair, forks, lineage, and learned skills into directed acts", () => {
    const world = emptyWorld();
    world.artifacts = [
      artifact("root", "A001", {
        adopters: ["A002", "A003", "A001"],
        serviceInspectedBy: ["A002"],
        contributors: ["A001", "A004"],
      }),
      artifact("child", "A005", {
        parentId: "root",
        generation: 2,
        authors: ["A001", "A005"],
        contributors: ["A005"],
      }),
      artifact("grandchild", "A006", {
        parentId: "child",
        generation: 3,
        authors: ["A001", "A005", "A006"],
        contributors: ["A006"],
      }),
    ];
    world.actionLibrary.push({
      id: "a-learned",
      name: "Learned",
      icon: "✶",
      algorithm: "x",
      program: ["scan-local"],
      authorId: "A010",
      createdTick: 0,
      uses: 4,
      recipe: ["water", "mineral"],
    });
    world.agents.find((agent) => agent.id === "A010")!.knownActionIds.push("a-learned");
    world.agents.find((agent) => agent.id === "A011")!.knownActionIds.push("a-learned");

    const acts = collectDeferenceActs(world).map(
      ({ relation, fromId, toId }) => `${fromId}>${toId}:${relation}`,
    );
    expect(acts).toEqual(
      expect.arrayContaining([
        "A002>A001:adopt",
        "A003>A001:adopt",
        "A002>A001:inspect",
        "A004>A001:maintain",
        "A005>A001:fork",
        "A006>A005:fork",
        "A006>A001:lineage",
        "A011>A010:learn",
      ]),
    );
    // Self-acts and world-authored base skills never count.
    expect(acts.some((act) => act.startsWith("A001>A001"))).toBe(false);
    expect(acts.some((act) => act.startsWith("A010>A010"))).toBe(false);
    expect(acts).toHaveLength(8);

    const report = computeHierarchy(world);
    const founder = report.agents.find((agent) => agent.id === "A001")!;
    expect(founder.received).toMatchObject({
      adopt: 2,
      inspect: 1,
      maintain: 1,
      fork: 1,
      lineage: 1,
    });
    expect(founder.received.weight).toBe(
      2 * DEFERENCE_WEIGHTS.adopt +
        DEFERENCE_WEIGHTS.inspect +
        DEFERENCE_WEIGHTS.maintain +
        DEFERENCE_WEIGHTS.fork +
        DEFERENCE_WEIGHTS.lineage,
    );
    expect(founder.topDeferrers[0]).toEqual({ id: "A005", weight: DEFERENCE_WEIGHTS.fork });
    expect(report.agents.find((agent) => agent.id === "A010")!.authored).toEqual({
      artifacts: 0,
      skills: 1,
      skillUses: 4,
    });
  });

  it("tolerates retired parents, unknown authors, and stale skill ids without NaN", () => {
    const world = emptyWorld();
    world.artifacts = [
      artifact("orphan", "A008", {
        parentId: "retired",
        generation: 4,
        authors: ["WORLD", "A099", "A007", "A008"],
        adopters: ["A404", "A009"],
      }),
      artifact("broken", "A012", {
        authors: undefined as unknown as string[],
        adopters: undefined as unknown as string[],
        contributors: undefined as unknown as string[],
        serviceInspectedBy: undefined,
      }),
      artifact("nobody", "" as string, { creatorId: undefined as unknown as string, authors: [] }),
    ];
    world.agents[0]!.knownActionIds.push("a-missing", "a-missing");
    world.actionLibrary.push({
      id: "a-orphan",
      name: "Orphan",
      icon: "✶",
      algorithm: "x",
      program: ["scan-local"],
      authorId: "A777",
      createdTick: 0,
      uses: Number.NaN,
    });

    const acts = collectDeferenceActs(world).map(
      ({ relation, fromId, toId }) => `${fromId}>${toId}:${relation}`,
    );
    // The retired parent's creator is the author just before the forker.
    expect(acts).toContain("A008>A007:fork");
    expect(acts).toContain("A008>A099:lineage");
    expect(acts).toContain("A009>A008:adopt");
    expect(acts.some((act) => act.includes("A404") || act.includes("WORLD"))).toBe(false);
    expect(allFinite(computeHierarchy(world))).toBe(true);
  });

  it("keeps a pruned creator's deference when fossils are supplied, without double counting", () => {
    const world = emptyWorld();
    const live = artifact("live", "A001", { adopters: ["A002"] });
    world.artifacts = [live];
    const withoutFossils = collectDeferenceActs(world);
    const withFossils = collectDeferenceActs(world, {
      artifacts: [
        { id: "live", creatorId: "A001", adopters: ["A002"] },
        { id: "pruned", creatorId: "A003", adopters: ["A004", "A005"], contributors: ["A004"] },
        { id: "pruned-child", creatorId: "A006", parentId: "pruned", authors: ["A003", "A006"] },
      ],
      skills: [{ id: "a-extinct", authorId: "A007", learnerIds: ["A008", "A007", "A404"] }],
    });
    expect(withoutFossils).toHaveLength(1);
    expect(
      withFossils.map(({ relation, fromId, toId }) => `${fromId}>${toId}:${relation}`),
    ).toEqual([
      "A002>A001:adopt",
      "A004>A003:adopt",
      "A004>A003:maintain",
      "A005>A003:adopt",
      "A006>A003:fork",
      "A008>A007:learn",
    ]);
  });

  it("ranks by recursive deference: deference from a respected bot counts more", () => {
    const nodes = ["A", "B", "C", "D", "E"];
    const { ranks, floor } = pageRank(nodes, [
      { fromId: "A", toId: "B", weight: 1 },
      { fromId: "B", toId: "C", weight: 1 },
      { fromId: "D", toId: "E", weight: 1 },
    ]);
    expect(ranks.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 9);
    expect(ranks[2]).toBeGreaterThan(ranks[1]!);
    expect(ranks[2]).toBeGreaterThan(ranks[4]!);
    expect(ranks[1]).toBeGreaterThan(ranks[0]!);
    // A and D receive nothing, so they sit exactly on the floor.
    expect(ranks[0]).toBeCloseTo(floor, 12);
    expect(ranks[3]).toBeCloseTo(floor, 12);
  });

  it("separates concentration beyond chance from evenly spread deference", () => {
    const ids = agentIds(100);
    const star = computeHierarchy(starWorld("A001", ids.slice(1, 31)));
    expect(star.metrics.nullModel?.exceedsChance).toBe(true);
    expect(star.metrics.prestigeGini!).toBeGreaterThan(star.metrics.nullModel!.giniP95);
    expect(star.agents[0]).toMatchObject({ id: "A001", rank: 1 });
    expect(star.agents.filter((agent) => agent.rank !== undefined)).toHaveLength(1);

    const ring = emptyWorld();
    ring.artifacts = ids.map((id, index) =>
      artifact(`ring-${id}`, id, { adopters: [ids[(index + 1) % ids.length]!] }),
    );
    const even = computeHierarchy(ring);
    expect(even.metrics.prestigeGini!).toBeLessThan(0.01);
    expect(even.metrics.nullModel?.exceedsChance).toBe(false);
    // A perfect ring ties everyone, so everyone shares rank 1.
    expect(new Set(even.agents.map((agent) => agent.rank))).toEqual(new Set([1]));

    expect(computeHierarchy(starWorld("A001", ids.slice(1, 31))).metrics.nullModel).toEqual(
      star.metrics.nullModel,
    );
  });

  it("scores a dominance ladder as transitive and a rock-paper-scissors tournament as cyclic", () => {
    const nodes = ["A", "B", "C", "D", "E", "F"];
    const ladder: DeferenceEdge[] = [];
    for (const [low, from] of nodes.entries())
      for (const to of nodes.slice(0, low)) ladder.push({ fromId: from, toId: to, weight: 1 });
    expect(triadTransitivity(nodes, ladder)).toEqual({ value: 1, complete: 20, transitive: 20 });

    const five = nodes.slice(0, 5);
    const cyclic: DeferenceEdge[] = five.flatMap((from, index) => [
      { fromId: from, toId: five[(index + 1) % 5]!, weight: 1 },
      { fromId: from, toId: five[(index + 2) % 5]!, weight: 1 },
    ]);
    expect(triadTransitivity(five, cyclic)).toEqual({ value: -1, complete: 10, transitive: 5 });

    // Balanced mutual deference resolves nothing.
    expect(
      triadTransitivity(nodes, [
        ...ladder,
        ...ladder.map((edge) => ({ ...edge, fromId: edge.toId, toId: edge.fromId })),
      ]).value,
    ).toBeUndefined();
  });

  it("computes inequality summaries from first principles", () => {
    expect(gini([1, 1, 1, 1])).toBe(0);
    expect(gini([0, 0, 0, 1])).toBeCloseTo(0.75, 12);
    expect(gini([0, 0])).toBeUndefined();
    expect(topDecileShare([10, ...Array(9).fill(0)])).toBe(1);
    expect(topDecileShare(Array(20).fill(1))).toBeCloseTo(0.1, 12);
  });

  it("aggregates parallel acts into one weighted edge", () => {
    expect(
      aggregateEdges([
        { relation: "adopt", sourceId: "x", fromId: "A002", toId: "A001", weight: 1 },
        { relation: "fork", sourceId: "y", fromId: "A002", toId: "A001", weight: 3 },
      ]),
    ).toEqual([{ fromId: "A002", toId: "A001", weight: 4 }]);
  });

  it("measures a live engine world without mutating it or reaching agent observations", () => {
    const world = createInitialWorld(260826081, 0);
    for (const [index, agent] of world.agents.entries()) {
      const activity = index % 3;
      agent.inventory = { water: 80, fungus: 80, mineral: 80, cellulose: 80, chitin: 80 };
      applyDirective(
        world,
        agent.id,
        {
          goal: activity === 0 ? "build" : activity === 1 ? "inspect" : "maintain",
          targetMaterial: "mineral",
          controllerAction: "remediate",
          note: "run one persistent local material activity",
          source: "openrouter",
          actionId: activity === 0 ? "fabricate" : activity === 1 ? "study" : "steward",
        },
        false,
        agent.nextDecisionTick,
      );
    }
    advanceWorld(world, 400);
    const before = structuredClone(world);
    const report = computeHierarchy(world);
    expect(world).toEqual(before);
    expect(allFinite(report)).toBe(true);
    expect(report.metrics.deferenceEdges).toBeGreaterThanOrEqual(HIERARCHY_MIN_EDGES);
    expect(report.metrics.lineageMaxGeneration).toBeGreaterThan(1);
    expect(report.agents[0]!.rank).toBe(1);
    expect(report.agents[0]!.received.weight).toBeGreaterThan(0);
    for (const agent of report.agents.filter((candidate) => candidate.rank === undefined))
      expect(agent.received.weight).toBe(0);

    const point = hierarchyHistoryPoint(report, "baseline", 1234);
    expect(point).toMatchObject({ tick: world.tick, kind: "baseline", createdAt: 1234 });
    expect(point.leaders[0]!.id).toBe(report.agents[0]!.id);

    for (const agent of world.agents)
      expect(JSON.stringify(decisionObservation(world, agent))).not.toMatch(
        /\b(prestige|rank|ranking|hierarchy)\b/i,
      );
  }, 15_000);
});
