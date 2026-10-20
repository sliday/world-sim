import { describe, expect, it } from "vite-plus/test";
import { modelActionPrimitives } from "./action-sandbox";
import { buildCraftTree } from "./craft-tree";
import {
  advanceWorld,
  applyDirective,
  createInitialWorld,
  decisionObservation,
  ensureAgentOperatingSystem,
  mechanismsForCondition,
  publicSnapshot,
} from "./engine";
import {
  ARTIFACT_DECAY_WINDOW_TICKS,
  emptyFossilRecord,
  MAX_ARTIFACT_FOSSILS,
  MAX_SKILL_FOSSILS,
  pruneWorld,
  SKILL_FORGETTING_WINDOW_TICKS,
} from "./pruning";
import type {
  ActionPrimitive,
  Agent,
  AgentActionDefinition,
  AgentActionProposal,
  Artifact,
  WorldState,
} from "./types";

const baseIds = ["survey", "forage", "fabricate", "study", "steward", "craft", "creative-session"];

function deadArtifact(id: string, builtAt: number, overrides: Partial<Artifact> = {}): Artifact {
  return {
    id,
    name: `Ruin ${id}`,
    x: 10,
    y: 10,
    material: "mineral",
    health: 0,
    performance: 0.6,
    generation: 1,
    creatorId: "A001",
    authors: ["A001"],
    contributors: ["A001"],
    adopters: [],
    controller: { sensor: "contamination", threshold: 0.4, action: "remediate", revision: 1 },
    serviceInspectedBy: [],
    builtAt,
    lastTouchedTick: builtAt,
    uses: 0,
    validated: false,
    ...overrides,
  };
}

function distinctProgram(index: number): ActionPrimitive[] {
  const size = modelActionPrimitives.length;
  return [
    modelActionPrimitives[index % size]!,
    modelActionPrimitives[Math.floor(index / size) % size]!,
    "scan-local",
    "scan-local",
  ];
}

function learnedSkill(id: string, authorId: string, index: number): AgentActionDefinition {
  return {
    id,
    name: `Skill ${id}`,
    icon: "✧",
    algorithm: "Run one bounded learned behavior on local evidence.",
    program: distinctProgram(index),
    authorId,
    createdTick: 0,
    uses: 0,
    recipe: ["fungus", "mineral"],
  };
}

function knowSkill(agent: Agent, actionId: string, lastUsedTick: number): void {
  agent.knownActionIds.push(actionId);
  agent.skillLastUsedTick[actionId] = lastUsedTick;
}

function startCreativeSession(
  world: WorldState,
  agent: Agent,
  proposal: AgentActionProposal,
): boolean {
  agent.curiosity = 1;
  agent.inventory.fungus = 2;
  agent.inventory.mineral = 2;
  return applyDirective(
    world,
    agent.id,
    {
      goal: "create",
      targetMaterial: "fungus",
      controllerAction: "grow",
      note: "mix local matter into a reusable sampling skill",
      source: "openrouter",
      actionId: "creative-session",
      creativeSession: {
        ...proposal,
        ingredients: ["fungus", "mineral"],
        purpose: "build a reusable material sampling behavior",
      },
    },
    true,
    agent.nextDecisionTick,
  );
}

describe("pruning and forgetting", () => {
  it("erodes a dead artifact only after its untouched decay window", () => {
    const world = createInitialWorld(7, 0);
    const ruin = deadArtifact("T000100-A001", 100, { parentId: "T000050-A009", generation: 2 });
    const living = deadArtifact("T000101-A002", 101, { health: 0.6, creatorId: "A002" });
    world.artifacts = [ruin, living];
    const recorded: string[] = [];

    world.tick = 100 + ARTIFACT_DECAY_WINDOW_TICKS - 1;
    expect(pruneWorld(world).eroded).toEqual([]);

    world.tick += 1;
    const report = pruneWorld(world, (text) => recorded.push(text));
    expect(report.eroded).toEqual([ruin]);
    expect(world.artifacts).toEqual([living]);
    expect(world.fossils.removedArtifacts).toBe(1);
    expect(world.fossils.artifacts[0]).toMatchObject({
      id: ruin.id,
      creatorId: "A001",
      parentId: "T000050-A009",
      generation: 2,
      material: "mineral",
      controllerAction: "remediate",
      builtAt: 100,
      lastTouchedTick: 100,
      removedTick: world.tick,
      reason: "decay",
    });
    expect(recorded).toEqual([`Pruned: 1 dead artifact eroded (${ruin.name})`]);

    world.tick += ARTIFACT_DECAY_WINDOW_TICKS * 4;
    expect(pruneWorld(world).eroded).toEqual([]);
  });

  it("resets the decay clock when agents inspect, maintain, or fork an artifact", () => {
    const world = createInitialWorld(260826081, 0);
    const station = world.stations.find((candidate) => candidate.kind === "assay")!;
    const ruin = deadArtifact("ruin", 0, { x: station.x, y: station.y });
    world.artifacts = [ruin];
    const [inspector, steward, builder] = world.agents.slice(1, 4) as [Agent, Agent, Agent];
    for (const agent of world.agents) agent.script = { ...agent.script, program: ["scan-local"] };
    const runOnce = (agent: Agent, program: ActionPrimitive[], tick: number): void => {
      agent.x = station.x;
      agent.y = station.y;
      agent.script = { ...agent.script, program };
      agent.scriptCursor = 0;
      world.tick = tick;
      advanceWorld(world, 1);
      agent.script = { ...agent.script, program: ["scan-local"] };
    };

    runOnce(inspector, ["inspect-local"], 1_000);
    expect(ruin.lastTouchedTick).toBe(1_001);
    expect(ruin.adopters).toEqual([inspector.id]);

    steward.inventory.water = 1;
    runOnce(steward, ["repair-local"], 5_000);
    expect(ruin.lastTouchedTick).toBe(5_001);
    expect(ruin.contributors).toContain(steward.id);

    builder.inventory.water = 10;
    builder.inventory.fungus = 10;
    runOnce(builder, ["build-local"], 9_000);
    const child = world.artifacts.find((artifact) => artifact.parentId === ruin.id)!;
    expect(child.creatorId).toBe(builder.id);
    expect(ruin.lastTouchedTick).toBe(9_001);

    ruin.health = 0;
    world.tick = 9_001 + ARTIFACT_DECAY_WINDOW_TICKS - 1;
    expect(pruneWorld(world).eroded).toEqual([]);
    world.tick += 1;
    expect(pruneWorld(world).eroded).toEqual([ruin]);
    expect(world.artifacts).toEqual([child]);
  });

  it("forgets an unused learned skill after the forgetting window but never a base action", () => {
    const world = createInitialWorld(260826081, 0);
    const skill = learnedSkill("a-spore", "A001", 3);
    world.actionLibrary.push(skill);
    const [author, apprentice, runner] = world.agents as [Agent, Agent, Agent];
    knowSkill(author, skill.id, 100);
    knowSkill(apprentice, skill.id, 200);
    knowSkill(runner, skill.id, 100);
    runner.script = { ...runner.script, actionId: skill.id, program: [...skill.program] };

    world.tick = 100 + SKILL_FORGETTING_WINDOW_TICKS - 1;
    expect(pruneWorld(world).forgotten).toEqual([]);

    world.tick += 1;
    const report = pruneWorld(world);
    expect(report.forgotten.map(({ agent }) => agent.id)).toEqual([author.id]);
    expect(report.extinct).toEqual([]);
    expect(author.knownActionIds).toEqual(baseIds);
    expect(author.skillLastUsedTick).toEqual({});
    expect(apprentice.knownActionIds).toContain(skill.id);
    expect(runner.knownActionIds).toContain(skill.id);
    expect(skill.forgottenBy).toEqual([author.id]);
    expect(
      world.agents.every((agent) => baseIds.every((id) => agent.knownActionIds.includes(id))),
    ).toBe(true);
  });

  it("counts running a learned skill as practice", () => {
    const world = createInitialWorld(260826081, 0);
    const skill = learnedSkill("a-practice", "A001", 4);
    world.actionLibrary.push(skill);
    const agent = world.agents[0]!;
    knowSkill(agent, skill.id, 0);
    agent.script = { ...agent.script, actionId: skill.id, program: ["scan-local"] };

    advanceWorld(world, 3);
    expect(agent.skillLastUsedTick[skill.id]).toBe(world.tick);
    expect(agent.skillLastUsedTick.survey).toBeUndefined();
  });

  it("keeps a recipe while an agent is committed to crafting it", () => {
    const world = createInitialWorld(260826081, 0);
    const skill = learnedSkill("a-committed", "A001", 5);
    world.actionLibrary.push(skill);
    const [keeper, apprentice] = world.agents as [Agent, Agent];
    knowSkill(keeper, skill.id, 0);
    const commitment = {
      mode: "craft" as const,
      actionId: skill.id,
      actionName: skill.name,
      ingredients: ["fungus", "mineral"] as ["fungus", "mineral"],
      purpose: `learn and preserve ${skill.name}`,
      startedTick: 0,
    };
    keeper.craftingTarget = { ...commitment };
    apprentice.craftingTarget = { ...commitment };
    world.tick = SKILL_FORGETTING_WINDOW_TICKS * 2;

    expect(pruneWorld(world)).toEqual({ forgotten: [], extinct: [], eroded: [] });
    expect(keeper.knownActionIds).toContain(skill.id);

    keeper.craftingTarget = undefined;
    const report = pruneWorld(world);
    expect(report.forgotten.map(({ agent }) => agent.id)).toEqual([keeper.id]);
    expect(report.extinct).toEqual([]);
    expect(world.actionLibrary).toContain(skill);

    apprentice.craftingTarget = undefined;
    expect(pruneWorld(world).extinct).toEqual([skill]);
  });

  it("removes an extinct skill from the library and the craft tree but keeps its fossil", () => {
    const world = createInitialWorld(260826081, 0);
    const skill = learnedSkill("a-lost", "A001", 6);
    world.actionLibrary.push(skill);
    knowSkill(world.agents[0]!, skill.id, 0);
    knowSkill(world.agents[1]!, skill.id, 0);
    expect(buildCraftTree(publicSnapshot(world, false)).discoveredActions).toBe(1);

    world.tick = SKILL_FORGETTING_WINDOW_TICKS + 59;
    advanceWorld(world, 1);

    expect(world.actionLibrary.map((action) => action.id)).toEqual(baseIds);
    const tree = buildCraftTree(publicSnapshot(world, false));
    expect(tree.discoveredActions).toBe(0);
    expect(tree.pairings.find((pairing) => pairing.id === "fungus+mineral")?.actions).toEqual([]);
    expect(world.fossils.extinctSkills).toBe(1);
    expect(world.fossils.skills).toEqual([
      {
        id: skill.id,
        name: skill.name,
        icon: skill.icon,
        authorId: "A001",
        recipe: ["fungus", "mineral"],
        program: skill.program,
        createdTick: 0,
        extinctTick: world.tick,
        uses: 0,
        knowerIds: ["A001", "A002"],
      },
    ]);
    const event = world.events.find((candidate) => candidate.kind === "prune");
    expect(event?.text).toBe(
      `Pruned: 1 extinct skill (${skill.name}) · 2 bots forgot 1 unused skill`,
    );
  });

  it("registers a rediscovered extinct program as a novel skill that satisfies curiosity", () => {
    const world = createInitialWorld(260826081, 0);
    const proposal: AgentActionProposal = {
      name: "Sample Arc",
      icon: "✦",
      algorithm: "Sample matter underfoot, then follow the nearest requested resource gradient.",
      program: ["scan-local", "gather-local", "seek-resource"],
    };
    const [inventor, learner] = world.agents as [Agent, Agent];
    expect(startCreativeSession(world, inventor, proposal)).toBe(true);
    advanceWorld(world, 1);
    const original = world.actionLibrary.at(-1)!;
    expect(original.authorId).toBe(inventor.id);
    expect(inventor.skillLastUsedTick[original.id]).toBe(world.tick);

    learner.inventory.fungus = 2;
    learner.inventory.mineral = 2;
    applyDirective(
      world,
      learner.id,
      {
        goal: "craft",
        targetMaterial: "fungus",
        controllerAction: "grow",
        note: "reproduce the sampling skill",
        source: "openrouter",
        actionId: "craft",
        craftActionId: original.id,
      },
      false,
      learner.nextDecisionTick,
    );
    advanceWorld(world, 1);
    expect(learner.knownActionIds).toContain(original.id);
    expect(learner.skillLastUsedTick[original.id]).toBe(world.tick);

    for (const agent of [inventor, learner])
      agent.skillLastUsedTick[original.id] = world.tick - SKILL_FORGETTING_WINDOW_TICKS;
    expect(pruneWorld(world).extinct).toEqual([original]);
    expect(world.fossils.skills.map((fossil) => fossil.knowerIds)).toEqual([
      [inventor.id, learner.id],
    ]);

    const reinventor = world.agents[5]!;
    const discoveriesBefore = reinventor.discoveries;
    expect(startCreativeSession(world, reinventor, { ...proposal, name: "Arc Revival" })).toBe(
      true,
    );
    advanceWorld(world, 1);

    const revived = world.actionLibrary.at(-1)!;
    expect(revived.id).toBe(original.id);
    expect(revived).not.toBe(original);
    expect(revived.name).toBe("Arc Revival");
    expect(revived.authorId).toBe(reinventor.id);
    expect(revived.createdTick).toBe(world.tick);
    expect(reinventor.knownActionIds).toContain(revived.id);
    expect(reinventor.curiosity).toBe(0);
    expect(reinventor.discoveries).toBe(discoveriesBefore + 1);
    expect(world.events[0]?.text).toContain("Arc Revival · rediscovered");
    expect(world.fossils.skills.map((fossil) => fossil.id)).toEqual([original.id]);
  });

  it("bounds the fossil archive while counting every removal", () => {
    const world = createInitialWorld(3, 0);
    world.tick = 1_000_000;
    world.artifacts = Array.from({ length: MAX_ARTIFACT_FOSSILS + 6 }, (_, index) =>
      deadArtifact(`R${index}`, index),
    );
    world.actionLibrary.push(
      ...Array.from({ length: MAX_SKILL_FOSSILS + 4 }, (_, index) =>
        learnedSkill(`a-${index}`, "A001", index),
      ),
    );

    pruneWorld(world);

    expect(world.artifacts).toEqual([]);
    expect(world.fossils.removedArtifacts).toBe(MAX_ARTIFACT_FOSSILS + 6);
    expect(world.fossils.artifacts).toHaveLength(MAX_ARTIFACT_FOSSILS);
    expect(world.fossils.artifacts[0]?.id).toBe("R6");
    expect(world.fossils.artifacts.at(-1)?.id).toBe(`R${MAX_ARTIFACT_FOSSILS + 5}`);
    expect(world.actionLibrary.map((action) => action.id)).toEqual(baseIds);
    expect(world.fossils.extinctSkills).toBe(MAX_SKILL_FOSSILS + 4);
    expect(world.fossils.skills).toHaveLength(MAX_SKILL_FOSSILS);
    expect(world.fossils.skills[0]?.id).toBe("a-4");
  });

  it("starts pre-migration clocks from recorded evidence without inventing touches", () => {
    const world = createInitialWorld(14, 0);
    world.tick = 90_000;
    const legacy = (artifact: Artifact): Artifact => {
      delete artifact.lastTouchedTick;
      return artifact;
    };
    const untouched = legacy(deadArtifact("T000100-A001", 100));
    const forkedParent = legacy(
      deadArtifact("T000200-A002", 200, {
        creatorId: "A002",
        authors: ["A002"],
        contributors: ["A002"],
      }),
    );
    const child = legacy(
      deadArtifact("T000700-A003", 700, {
        creatorId: "A003",
        authors: ["A002", "A003"],
        contributors: ["A003"],
        parentId: forkedParent.id,
        generation: 2,
      }),
    );
    const inspected = legacy(deadArtifact("T000300-A004", 300, { uses: 4, adopters: ["A005"] }));
    world.artifacts = [untouched, forkedParent, child, inspected];

    const solo = { ...learnedSkill("a-solo", "A001", 7), createdTick: 1_000 };
    const shared = { ...learnedSkill("a-shared", "A002", 8), createdTick: 2_000 };
    const practiced = { ...learnedSkill("a-practiced", "A003", 9), createdTick: 3_000, uses: 5 };
    const running = { ...learnedSkill("a-running", "A004", 10), createdTick: 4_000 };
    world.actionLibrary.push(solo, shared, practiced, running);
    const [a1, a2, a3, a4] = world.agents as [Agent, Agent, Agent, Agent];
    a1.knownActionIds.push(solo.id);
    a2.knownActionIds.push(shared.id);
    a3.knownActionIds.push(shared.id, practiced.id);
    a4.knownActionIds.push(running.id);
    a4.script = { ...a4.script, actionId: running.id, program: [...running.program] };
    delete (world as Partial<WorldState>).fossils;
    for (const agent of world.agents) delete (agent as Partial<Agent>).skillLastUsedTick;

    ensureAgentOperatingSystem(world);

    expect(world.fossils).toEqual(emptyFossilRecord());
    expect(untouched.lastTouchedTick).toBe(100);
    expect(forkedParent.lastTouchedTick).toBe(700);
    expect(child.lastTouchedTick).toBe(700);
    expect(inspected.lastTouchedTick).toBe(90_000);
    expect(a1.skillLastUsedTick).toEqual({ "a-solo": 1_000 });
    expect(a2.skillLastUsedTick).toEqual({ "a-shared": 2_000 });
    expect(a3.skillLastUsedTick).toEqual({ "a-shared": 90_000, "a-practiced": 90_000 });
    expect(a4.skillLastUsedTick).toEqual({ "a-running": 90_000 });
    expect(world.agents[4]!.skillLastUsedTick).toEqual({});

    world.tick = 95_000;
    ensureAgentOperatingSystem(world);
    expect(inspected.lastTouchedTick).toBe(90_000);
    expect(a3.skillLastUsedTick).toEqual({ "a-shared": 90_000, "a-practiced": 90_000 });

    const report = pruneWorld(world);
    expect(report.eroded).toEqual([untouched, forkedParent, child]);
    expect(report.forgotten.map(({ agent, actionId }) => `${agent.id}:${actionId}`)).toEqual([
      "A001:a-solo",
      "A002:a-shared",
    ]);
    expect(report.extinct).toEqual([solo]);
  });

  it("forgets and erodes in every interaction condition without exposing fossils to agents", () => {
    for (const condition of ["full-culture", "no-communication", "no-explicit-culture"] as const) {
      const world = createInitialWorld(44, 0, condition);
      const skill = learnedSkill("a-old", "A001", 11);
      world.actionLibrary.push(skill);
      const agent = world.agents[0]!;
      knowSkill(agent, skill.id, 0);
      world.artifacts = [deadArtifact("ruin", 0)];

      world.tick = SKILL_FORGETTING_WINDOW_TICKS + 59;
      advanceWorld(world, 1);

      expect(world.actionLibrary.map((action) => action.id)).toEqual(baseIds);
      expect(world.artifacts).toEqual([]);
      expect(world.fossils.extinctSkills).toBe(1);
      expect(world.fossils.removedArtifacts).toBe(1);
      const observation = decisionObservation(world, agent);
      expect(observation.availableMechanisms).toEqual(mechanismsForCondition(condition));
      expect(JSON.stringify(observation)).not.toMatch(/fossil|a-old|ruin/iu);
    }
  });
});
