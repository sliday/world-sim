import { describe, expect, it } from "vite-plus/test";
import { botPortraitSvg, generateBotAppearance } from "./bot-appearance";
import { modelActionPrimitives, registerAction } from "./action-sandbox";
import {
  advanceWorld,
  applyDirective,
  artifactValidationEvidence,
  balancedPortfolioScore,
  calculateMetrics,
  controllerBehaviorDiffers,
  controllerBehaviorSignature,
  createInitialWorld,
  decisionAgentsDue,
  decisionPhaseForAgent,
  deliverSpeech,
  ensureAgentOperatingSystem,
  isArtifactContact,
  MODEL_MACROTURN_INTERVAL_TICKS,
  nextScheduledDecisionTick,
  normalizeSpeech,
  realizedPortfolioScore,
} from "./engine";
import { agentNameCatalog, generateAgentName } from "./names";
import {
  collapseRepeatedMemory,
  compactMemoryLog,
  estimateMemoryTokens,
  memoryRunKey,
} from "./memory-log";
import {
  clampOverlayAnchor,
  easeToward,
  fitOverlayText,
  normalizeSettled,
  wrappedTarget,
} from "./motion";
import {
  nextWorldDiaryTick,
  normalizeWorldDiaryLines,
  WORLD_DIARY_INTERVAL_TICKS,
} from "./world-diary";
import type {
  AgentActionDefinition,
  AgentDirective,
  Artifact,
  ControllerAction,
  WorldState,
} from "./types";

function engageAllAgentsInPersistentActivities(world: WorldState): void {
  for (const [index, agent] of world.agents.entries()) {
    const activity = index % 3;
    const goal = activity === 0 ? "build" : activity === 1 ? "inspect" : "maintain";
    const actionId = activity === 0 ? "fabricate" : activity === 1 ? "study" : "steward";
    agent.inventory = {
      water: 80,
      fungus: 80,
      mineral: 80,
      cellulose: 80,
      chitin: 80,
    };
    applyDirective(
      world,
      agent.id,
      {
        goal,
        targetMaterial: "mineral",
        controllerAction: "remediate",
        note: "run one persistent local material activity",
        source: "openrouter",
        actionId,
      },
      false,
      agent.nextDecisionTick,
    );
  }
}

function signature(steps: number): unknown {
  const world = createInitialWorld(42, 0);
  advanceWorld(world, steps);
  return {
    tick: world.tick,
    rng: world.rngState,
    agents: world.agents.map(({ id, x, y, mode, builds, artifactsTouched }) => ({
      id,
      x,
      y,
      mode,
      builds,
      artifactsTouched,
    })),
    artifacts: world.artifacts.map(({ id, parentId, generation, performance, controller }) => ({
      id,
      parentId,
      generation,
      performance,
      controller,
    })),
  };
}

function fluxArtifact(action: ControllerAction): Artifact {
  return {
    id: `flux-${action}`,
    name: `Flux ${action}`,
    x: 0,
    y: 0,
    material: "mineral",
    health: 1,
    performance: 1,
    generation: 1,
    creatorId: "A001",
    authors: ["A001"],
    contributors: ["A001"],
    adopters: [],
    controller: { sensor: "contamination", threshold: 0, action, revision: 1 },
    storedWater: 0,
    reserve: 1.5,
    flux: {
      waterCollected: 0,
      contaminationRemoved: 0,
      reserveConsumed: 0,
      maintenanceInput: 0,
    },
    fluxTrackingStartedTick: 0,
    builtAt: 0,
    uses: 0,
    validated: true,
  };
}

describe("deterministic consequence layer", () => {
  it("schedules factual world diary checkpoints and bounds readable lines", () => {
    expect(nextWorldDiaryTick(12_345)).toBe(12_345 + WORLD_DIARY_INTERVAL_TICKS);
    expect(
      normalizeWorldDiaryLines([
        "  New mineral seam mapped.  ",
        "A bounded repair action entered the library.",
        "Artifacts reached generation three.",
        "Routine movement omitted.",
        "Water gathering spread north.",
        "This sixth line must be discarded.",
      ]),
    ).toEqual([
      "New mineral seam mapped.",
      "A bounded repair action entered the library.",
      "Artifacts reached generation three.",
      "Routine movement omitted.",
      "Water gathering spread north.",
    ]);
    expect(normalizeWorldDiaryLines({ lines: ["not an array"] })).toEqual([]);
  });

  it("starts every agent with the same policy and no assigned role", () => {
    const world = createInitialWorld(260826081, 0);
    const directives = new Set(world.agents.map((agent) => JSON.stringify(agent.directive)));
    const modes = new Set(world.agents.map((agent) => agent.mode));
    expect(directives.size).toBe(1);
    expect(modes).toEqual(new Set(["surveying"]));
    expect(world.agents).toHaveLength(100);
    expect(new Set(world.agents.map((agent) => agent.energy))).toEqual(new Set([0.9]));
  });

  it("migrates a live 72-agent world to 100 without resetting existing agents", () => {
    const world = createInitialWorld(260826081, 0);
    world.agents = world.agents.slice(0, 72);
    const first = { ...world.agents[0] };
    ensureAgentOperatingSystem(world);

    expect(world.agents).toHaveLength(100);
    expect(world.agents[0]?.id).toBe(first.id);
    expect(world.agents[0]?.x).toBe(first.x);
    expect(world.agents.at(-1)?.id).toBe("A100");
  });

  it("executes one activity primitive and records every trajectory each world tick", () => {
    const world = createInitialWorld(260826081, 0);
    const first = world.agents[0]!;
    const initialPosition = { x: first.x, y: first.y };
    advanceWorld(world, 1);

    expect(first.scriptCursor).toBe(1);
    expect({ x: first.x, y: first.y }).toEqual(initialPosition);
    expect(world.agents.every((agent) => agent.script.updatedTick === 0)).toBe(true);
    expect(world.agents.every((agent) => agent.trajectory.observedTicks === 1)).toBe(true);
    advanceWorld(world, 1);
    expect(first.scriptCursor).toBe(0);
    expect({ x: first.x, y: first.y }).not.toEqual(initialPosition);
    expect(calculateMetrics(world).meanRegionsVisited).toBeGreaterThan(0);
  });

  it("measures artifact contact within the paper's three-cell radius", () => {
    expect(isArtifactContact({ x: 10, y: 10 }, { x: 13, y: 10 })).toBe(true);
    expect(isArtifactContact({ x: 10, y: 10 }, { x: 14, y: 10 })).toBe(false);
    expect(isArtifactContact({ x: 0, y: 10 }, { x: 95, y: 10 })).toBe(true);

    const world = createInitialWorld(260826081, 0);
    const trajectory = world.agents[0]!.trajectory;
    trajectory.artifactContactTicks = 12;
    trajectory.observedTicks = 20;
    trajectory.artifactContactRadius = 5;
    ensureAgentOperatingSystem(world);
    expect(trajectory.artifactContactRadius).toBe(3);
    expect(trajectory.artifactContactTicks).toBe(0);
    expect(trajectory.observedTicks).toBe(0);
  });

  it("turns a facilitated creative session into a physical, shareable crafted action", () => {
    const world = createInitialWorld(260826081, 0);
    const agent = world.agents[0]!;
    const decisionTick = agent.nextDecisionTick;
    agent.curiosity = 1;
    agent.inventory.fungus = 2;
    agent.inventory.mineral = 2;
    expect(agent.documents.soulMd).toContain("# SOUL.md");
    expect(agent.documents.memoryMd).toContain("# MEMORY.md");
    expect(agent.documents.userMd).toContain("# USER.md");
    const before = world.actionLibrary.length;
    expect(
      applyDirective(
        world,
        agent.id,
        {
          goal: "create",
          targetMaterial: "fungus",
          controllerAction: "grow",
          note: "mix local matter into a reusable sampling skill",
          source: "openrouter",
          actionId: "creative-session",
          icon: "✦",
          creativeSession: {
            name: "Sample Arc",
            icon: "✦",
            algorithm:
              "Sample matter underfoot, then follow the nearest requested resource gradient.",
            program: ["scan-local", "gather-local", "seek-resource"],
            ingredients: ["fungus", "mineral"],
            purpose: "build a reusable material sampling behavior",
          },
        },
        true,
        decisionTick,
      ),
    ).toBe(true);
    expect(world.actionLibrary).toHaveLength(before);
    expect(agent.craftingTarget?.actionName).toBe("Sample Arc");
    expect(agent.materialPurposes.fungus).toContain("sampling");
    expect(agent.script.updatedTick).toBe(decisionTick);
    expect(agent.script.revision).toBe(1);
    expect(agent.script.icon).toBe("✦");
    expect(agent.scriptCursor).toBe(0);
    expect(agent.nextDecisionTick).toBe(decisionTick + MODEL_MACROTURN_INTERVAL_TICKS);
    expect(agent.documents.memoryMd).toContain("Reserved materials");

    advanceWorld(world, 1);
    expect(world.actionLibrary).toHaveLength(before + 1);
    const crafted = world.actionLibrary.at(-1)!;
    expect(crafted.recipe).toEqual(["fungus", "mineral"]);
    expect(agent.knownActionIds).toContain(crafted.id);
    expect(agent.craftingTarget).toBeUndefined();
    expect(agent.inventory.fungus).toBe(0);
    expect(agent.inventory.mineral).toBe(0);
    expect(agent.curiosity).toBe(0);
    expect(agent.documents.memoryMd).toContain("The materials were stored to");

    const learner = world.agents[1]!;
    learner.inventory.fungus = 2;
    learner.inventory.mineral = 2;
    expect(
      applyDirective(
        world,
        learner.id,
        {
          goal: "craft",
          targetMaterial: "fungus",
          controllerAction: "grow",
          note: "reproduce the observed sampling skill",
          source: "openrouter",
          actionId: "craft",
          craftActionId: crafted.id,
        },
        false,
        learner.nextDecisionTick,
      ),
    ).toBe(true);
    advanceWorld(world, 1);
    expect(learner.knownActionIds).toContain(crafted.id);
    expect(learner.crafts).toBe(1);
    const forage = world.actionLibrary.find((action) => action.id === "forage")!;
    expect(registerAction(world.actionLibrary, forage, agent.id, world.tick)).toBeUndefined();
  });

  it("rejects model-authored actions that use trusted crafting-control primitives", () => {
    const world = createInitialWorld(260826081, 0);
    expect(
      registerAction(
        world.actionLibrary,
        {
          name: "Recursive Mixer",
          icon: "✦",
          algorithm: "Attempt to invoke internal crafting orchestration as a reusable behavior.",
          program: ["mix-local", "craft-local"],
        },
        world.agents[0]!.id,
        world.tick,
      ),
    ).toBeUndefined();
    expect(
      world.actionLibrary.find((action) => action.id === "creative-session")?.program,
    ).toContain("mix-local");
  });

  it("keeps curiosity unsatisfied and seeks purpose-bound missing ingredients", () => {
    const world = createInitialWorld(260826081, 0);
    const agent = world.agents[0]!;
    agent.curiosity = 1;
    const before = world.actionLibrary.length;
    expect(
      applyDirective(
        world,
        agent.id,
        {
          goal: "create",
          targetMaterial: "chitin",
          controllerAction: "signal",
          note: "test a new signaling mixture",
          source: "openrouter",
          actionId: "creative-session",
          icon: "⟡",
          creativeSession: {
            name: "Chitin Beacon",
            icon: "⟡",
            algorithm: "Inspect local matter, then signal while seeking useful artifacts.",
            program: ["inspect-local", "seek-artifact", "roam"],
            ingredients: ["chitin", "cellulose"],
            purpose: "build a reusable environmental beacon",
          },
        },
        true,
        agent.nextDecisionTick,
      ),
    ).toBe(true);
    const position = { x: agent.x, y: agent.y };
    advanceWorld(world, 2);
    expect(world.actionLibrary).toHaveLength(before);
    expect(agent.craftingTarget?.actionName).toBe("Chitin Beacon");
    expect(agent.materialPurposes.chitin).toContain("beacon");
    expect(agent.materialPurposes.cellulose).toContain("beacon");
    expect(agent.curiosity).toBeGreaterThan(0.99);
    expect(agent.script.lastResult).toContain("seeking chitin");
    expect({ x: agent.x, y: agent.y }).not.toEqual(position);
  });

  it("does not satisfy curiosity when a material mix reproduces existing behavior", () => {
    const world = createInitialWorld(260826081, 0);
    const agent = world.agents[0]!;
    agent.curiosity = 1;
    agent.inventory.water = 2;
    agent.inventory.fungus = 2;
    const before = world.actionLibrary.length;
    expect(
      applyDirective(
        world,
        agent.id,
        {
          goal: "create",
          targetMaterial: "water",
          controllerAction: "collect-water",
          note: "test whether wet fungus improves surveying",
          source: "openrouter",
          actionId: "creative-session",
          icon: "◎",
          creativeSession: {
            name: "Wet Survey",
            icon: "◎",
            algorithm: "Scan the local tile, then roam toward an adjacent observation point.",
            program: ["scan-local", "roam"],
            ingredients: ["water", "fungus"],
            purpose: "build a moisture-aware survey behavior",
          },
        },
        true,
        agent.nextDecisionTick,
      ),
    ).toBe(true);
    advanceWorld(world, 1);
    expect(world.actionLibrary).toHaveLength(before);
    expect(agent.craftingTarget).toBeUndefined();
    expect(agent.inventory.water).toBe(0);
    expect(agent.inventory.fungus).toBe(0);
    expect(agent.curiosity).toBeGreaterThan(0.99);
    expect(agent.documents.memoryMd).toContain("no novel behavior was built");
  });

  it("uses carried water for energy without erasing gathered materials", () => {
    const world = createInitialWorld(260826081, 0);
    const agent = world.agents[0]!;
    agent.energy = 0.03;
    agent.inventory.water = 2;
    agent.inventory.mineral = 4;
    const rebootsBefore = world.events.filter((event) =>
      event.text.includes(`${agent.name} rebooted`),
    ).length;

    advanceWorld(world, 60);

    expect(agent.energy).toBeGreaterThan(0.03);
    expect(agent.inventory.water).toBeLessThan(2);
    expect(agent.inventory.mineral).toBe(4);
    expect(
      world.events.filter((event) => event.text.includes(`${agent.name} rebooted`)).length,
    ).toBe(rebootsBefore);
  });

  it("processes build-ready material at its matching station before construction", () => {
    const world = createInitialWorld(260826081, 0);
    const agent = world.agents[0]!;
    const station = world.stations.find((candidate) => candidate.kind === "assay")!;
    agent.inventory.water = 10;
    agent.inventory.fungus = 10;
    agent.directive = {
      ...agent.directive,
      goal: "build",
      targetMaterial: "fungus",
      actionId: "fabricate",
      artifactSpecification: {
        name: "Mycelial Assay Veil",
        claimedFunction: "Reduce local contamination while preserving exchange.",
        architecture: "Layered porous fungal membrane with bounded channels.",
        bioInspiration: "mycelial transport networks",
        predictedEffects: "Lower contamination near the installed material system.",
      },
    };
    agent.script = {
      ...agent.script,
      actionId: "fabricate",
      program: ["seek-station"],
    };
    agent.x = (station.x + 20) % 96;
    agent.y = station.y;
    const positionBefore = { x: agent.x, y: agent.y };

    advanceWorld(world, 1);
    expect({ x: agent.x, y: agent.y }).not.toEqual(positionBefore);
    expect(agent.script.lastResult).toBe("seeking assay for fungus");

    agent.script.program = ["build-local"];
    agent.scriptCursor = 0;
    advanceWorld(world, 1);
    expect(world.artifacts).toHaveLength(0);
    expect(agent.inventory.fungus).toBe(10);
    expect(agent.inventory.water).toBe(10);

    agent.x = station.x;
    agent.y = station.y;
    agent.scriptCursor = 0;
    advanceWorld(world, 1);
    const artifact = world.artifacts.at(-1)!;
    expect(artifact.stationId).toBe(station.id);
    expect(artifact.process).toBe("assay");
    expect(artifact.name).toBe("Mycelial Assay Veil");
    expect(artifact.validation).toMatchObject({
      testedMaterial: true,
      completeSpecification: true,
      installedAgentController: true,
      processProvenance: true,
      behaviorallyNovel: true,
    });
    expect(artifact.validated).toBe(artifact.performance >= 0.57);
    expect(artifact.x).toBe(station.x);
    expect(artifact.y).toBe(station.y);
    expect(agent.inventory.fungus).toBe(5);
    expect(agent.inventory.water).toBe(8.5);
  });

  it("lets persistent fabrication programs reach stations and construct there", () => {
    const world = createInitialWorld(260826081, 0);
    engageAllAgentsInPersistentActivities(world);

    advanceWorld(world, 240);

    expect(world.artifacts.length).toBeGreaterThan(0);
    expect(
      world.artifacts.every((artifact) => {
        const station = world.stations.find((candidate) => candidate.id === artifact.stationId);
        if (!station || artifact.process !== station.kind) return false;
        const dx = Math.min(
          Math.abs(artifact.x - station.x),
          96 - Math.abs(artifact.x - station.x),
        );
        const dy = Math.min(
          Math.abs(artifact.y - station.y),
          72 - Math.abs(artifact.y - station.y),
        );
        return dx * dx + dy * dy <= 2;
      }),
    ).toBe(true);
  }, 15_000);

  it("conserves water when an artifact transfers local moisture into storage", () => {
    const world = createInitialWorld(260826081, 0);
    const artifact = fluxArtifact("collect-water");
    world.artifacts = [artifact];
    world.terrain[0]!.moisture = 0.8;
    world.terrain[0]!.contamination = 0.5;
    const waterBefore = world.terrain[0]!.moisture + artifact.storedWater!;

    advanceWorld(world, 1);

    const waterAfter = world.terrain[0]!.moisture + artifact.storedWater!;
    expect(waterAfter).toBeCloseTo(waterBefore, 10);
    expect(artifact.storedWater).toBeGreaterThan(0);
    expect(artifact.flux!.waterCollected).toBeCloseTo(artifact.storedWater!, 10);
    expect(artifact.lastService).toBeGreaterThan(0);
    expect(artifact.serviceEma).toBeGreaterThan(0);
    expect(realizedPortfolioScore(world, false)).toBeGreaterThan(0);
    expect(calculateMetrics(world).operationalWaterCollected).toBeCloseTo(
      artifact.storedWater!,
      10,
    );

    const serviceBeforeCapacity = artifact.serviceEma!;
    artifact.storedWater = 2;
    advanceWorld(world, 1);
    expect(artifact.lastService).toBe(0);
    expect(artifact.serviceEma).toBeLessThan(serviceBeforeCapacity);
    expect(realizedPortfolioScore(world, false)).toBe(0);
  });

  it("bounds remediation by local contamination and finite embodied reserve", () => {
    const world = createInitialWorld(260826081, 0);
    const artifact = fluxArtifact("remediate");
    artifact.reserve = 0.01;
    world.artifacts = [artifact];
    world.terrain[0]!.contamination = 0.7;
    const contaminationBefore = world.terrain[0]!.contamination;
    const reserveBefore = artifact.reserve!;

    advanceWorld(world, 1);

    const removed = contaminationBefore - world.terrain[0]!.contamination;
    const reserveUsed = reserveBefore - artifact.reserve!;
    expect(removed).toBeGreaterThan(0);
    expect(removed).toBeLessThanOrEqual(0.02);
    expect(reserveUsed).toBeCloseTo(removed * 0.5, 10);
    expect(artifact.flux!.contaminationRemoved).toBeCloseTo(removed, 10);
    expect(artifact.flux!.reserveConsumed).toBeCloseTo(reserveUsed, 10);

    artifact.reserve = 0;
    const exhaustedContamination = world.terrain[0]!.contamination;
    advanceWorld(world, 1);
    expect(world.terrain[0]!.contamination).toBe(exhaustedContamination);
    expect(artifact.lastService).toBe(0);
  });

  it("redirects saturated water gathering toward diverse material deficits", () => {
    const world = createInitialWorld(260826081, 0);
    const recoveringAgents = world.agents.slice(0, 20);
    for (const agent of recoveringAgents) {
      agent.inventory.water = 6;
      agent.directive = {
        ...agent.directive,
        goal: "gather",
        targetMaterial: "water",
        actionId: "forage",
      };
      agent.script = {
        ...agent.script,
        actionId: "forage",
        program: ["gather-local", "seek-resource"],
      };
      agent.scriptCursor = 1;
    }

    advanceWorld(world, 1);
    const targets = new Set(recoveringAgents.map((agent) => agent.directive.targetMaterial));
    expect(recoveringAgents.every((agent) => agent.directive.targetMaterial !== "water")).toBe(
      true,
    );
    expect(targets.size).toBeGreaterThan(1);
  });

  it("leaves a depleted resource tile to seek viable richness", () => {
    const world = createInitialWorld(260826081, 0);
    const sampledTidal = world.terrain
      .map((tile, index) => ({ tile, x: index % 96, y: Math.floor(index / 96) }))
      .filter(({ tile, x, y }) => tile.terrain === "tidal" && x % 2 === 0 && y % 2 === 0);
    const current = sampledTidal[0]!;
    const viable = sampledTidal.find(
      ({ x, y }) => Math.abs(x - current.x) + Math.abs(y - current.y) > 8,
    )!;
    for (const { tile } of sampledTidal) tile.richness = 0.05;
    viable.tile.richness = 0.9;
    const agent = world.agents[0]!;
    agent.x = current.x;
    agent.y = current.y;
    agent.directive = {
      ...agent.directive,
      goal: "gather",
      targetMaterial: "water",
      actionId: "forage",
    };
    agent.script = {
      ...agent.script,
      actionId: "forage",
      program: ["seek-resource"],
    };
    agent.scriptCursor = 0;

    advanceWorld(world, 1);
    expect({ x: agent.x, y: agent.y }).not.toEqual({ x: current.x, y: current.y });
    expect(agent.script.lastResult).toBe("seeking water");
  });

  it("gives agents stable hash-derived names from a broad universal catalog", () => {
    const world = createInitialWorld(260826081, 0);
    expect(agentNameCatalog.givenNames.length).toBeGreaterThan(180);
    expect(agentNameCatalog.surnames.length).toBeGreaterThan(180);
    expect(agentNameCatalog.suffixes.length).toBeGreaterThan(300);
    expect(new Set(world.agents.map((agent) => agent.name)).size).toBe(world.agents.length);
    expect(world.agents[0]?.name).toBe(generateAgentName("260826081:A001"));
    expect(generateAgentName("260826081:A001")).toBe(generateAgentName("260826081:A001"));
    expect(generateAgentName("260826081:A001")).not.toBe(generateAgentName("260826081:A002"));
  });

  it("gives every agent a stable, diverse procedural robot appearance", () => {
    const world = createInitialWorld(260826081, 0);
    const signatures = world.agents.map((agent) =>
      JSON.stringify(generateBotAppearance(`${world.seed}:${agent.id}`)),
    );
    expect(new Set(signatures).size).toBe(world.agents.length);
    expect(generateBotAppearance("260826081:A001")).toEqual(
      generateBotAppearance("260826081:A001"),
    );
    expect(botPortraitSvg("260826081:A001")).toContain("<radialGradient");
    expect(botPortraitSvg("260826081:A001")).toContain("<feTurbulence");
  });

  it("interpolates agent motion through the shortest toroidal path", () => {
    const seamTarget = wrappedTarget(95.5, 0.5, 96);
    expect(seamTarget).toBe(96.5);
    const firstFrame = easeToward(95.5, seamTarget, 16);
    expect(firstFrame).toBeGreaterThan(95.5);
    expect(firstFrame).toBeLessThan(seamTarget);
    expect(easeToward(4, 12, 0)).toBe(4);
    expect(normalizeSettled(96.5, 96.5, 96)).toEqual([0.5, 0.5]);
  });

  it("keeps speech overlays centered on agents and inside the viewport", () => {
    expect(clampOverlayAnchor(100, 50, 80, 320, 200)).toEqual([100, 50]);
    expect(clampOverlayAnchor(10, -20, 80, 320, 200)).toEqual([44, 13]);
    expect(clampOverlayAnchor(315, 250, 80, 320, 200)).toEqual([276, 187]);
  });

  it("keeps speech copy on one centered line inside its bubble", () => {
    const measure = (value: string): number => value.length;
    expect(fitOverlayText("Water north", 20, measure)).toBe("Water north");
    const fitted = fitOverlayText("Ground plain here keep searching", 16, measure);
    expect(fitted.endsWith("…")).toBe(true);
    expect(measure(fitted)).toBeLessThanOrEqual(16);
    expect(fitOverlayText("Energy low", 0, measure)).toBe("");
  });

  it("exchanges one bounded telegraphic sentence with a nearby bot", () => {
    const world = createInitialWorld(44, 0);
    const sender = world.agents[0]!;
    const recipient = world.agents[1]!;
    recipient.x = sender.x + 1;
    recipient.y = sender.y;
    expect(normalizeSpeech("Water very low here! We should all panic now.")).toBe(
      "Water very low here.",
    );
    expect(deliverSpeech(world, sender.id, "Fungus rich east, come gather. Extra sentence.")).toBe(
      true,
    );
    expect(world.messages).toHaveLength(1);
    expect(world.messages[0]?.text).toBe("Fungus rich east come gather.");
    expect(recipient.heardMessages[0]?.fromId).toBe(sender.id);
  });

  it("replays the same seed exactly", () => {
    expect(signature(1_200)).toEqual(signature(1_200));
  });

  it("creates persistent artifacts and executable lineages without assigned roles", () => {
    const world = createInitialWorld(260826081, 0);
    engageAllAgentsInPersistentActivities(world);
    advanceWorld(world, 800);
    expect(world.artifacts.length).toBeGreaterThan(4);
    expect(world.artifacts.some((artifact) => artifact.parentId && artifact.generation > 1)).toBe(
      true,
    );
    expect(new Set(world.agents.map((agent) => agent.script.actionId)).size).toBeGreaterThan(1);
    expect(world.artifacts.some((artifact) => artifact.uses > 0)).toBe(true);
    expect(world.artifacts.some((artifact) => artifact.adopters.length > 0)).toBe(true);
    for (const artifact of world.artifacts) {
      expect(artifact.contributors).toContain(artifact.creatorId);
      if (!artifact.parentId) continue;
      const parent = world.artifacts.find((candidate) => candidate.id === artifact.parentId);
      if (parent)
        expect(controllerBehaviorDiffers(parent.controller, artifact.controller)).toBe(true);
    }
  }, 15_000);

  it("does not treat revision metadata alone as an executable fork", () => {
    const parent = { sensor: "moisture", threshold: 0.5, action: "grow", revision: 1 } as const;
    expect(controllerBehaviorDiffers(parent, { ...parent, revision: 2 })).toBe(false);
    expect(controllerBehaviorDiffers(parent, { ...parent, threshold: 0.51, revision: 2 })).toBe(
      true,
    );
  });

  it("requires complete evidence and genuinely new controller behavior for validation", () => {
    const prior = fluxArtifact("remediate");
    prior.controller.threshold = 0.43;
    const candidate = fluxArtifact("remediate");
    candidate.id = "candidate";
    candidate.controller.threshold = 0.44;
    candidate.stationId = "S4";
    candidate.process = "foundry";
    candidate.performance = 0.7;
    candidate.specification = {
      name: "Basalt Remediation Veil",
      claimedFunction: "Reduce contamination around the installed material.",
      architecture: "Layered mineral lattice with bounded exchange channels.",
      bioInspiration: "porous volcanic microbial mats",
      predictedEffects: "Lower local contamination while retaining structural service.",
    };

    expect(controllerBehaviorSignature(candidate.controller)).toBe(
      controllerBehaviorSignature(prior.controller),
    );
    expect(artifactValidationEvidence(candidate, [prior])).toMatchObject({
      testedMaterial: true,
      completeSpecification: true,
      installedAgentController: true,
      performanceThreshold: true,
      processProvenance: true,
      behaviorallyNovel: false,
    });

    candidate.controller.threshold = 0.61;
    expect(controllerBehaviorSignature(candidate.controller)).not.toBe(
      controllerBehaviorSignature(prior.controller),
    );
    expect(Object.values(artifactValidationEvidence(candidate, [prior])).every(Boolean)).toBe(true);
  });

  it("balances portfolio magnitude against its weakest service", () => {
    expect(balancedPortfolioScore([1, 1, 1])).toBe(1);
    expect(balancedPortfolioScore([1, 0])).toBe(0.25);
    expect(balancedPortfolioScore([0, 0])).toBe(0);
  });

  it("keeps resources and health inside the physical schema", () => {
    const world = createInitialWorld(17, 0);
    engageAllAgentsInPersistentActivities(world);
    advanceWorld(world, 800);
    for (const agent of world.agents) {
      for (const amount of Object.values(agent.inventory)) expect(amount).toBeGreaterThanOrEqual(0);
    }
    for (const artifact of world.artifacts) {
      expect(artifact.health).toBeGreaterThanOrEqual(0);
      expect(artifact.health).toBeLessThanOrEqual(1);
      expect(artifact.performance).toBeGreaterThanOrEqual(0);
      expect(artifact.performance).toBeLessThanOrEqual(1);
    }
    const bestActivePerformance = world.artifacts
      .filter((artifact) => artifact.health > 0.1)
      .reduce((best, artifact) => Math.max(best, artifact.performance), 0);
    const metrics = calculateMetrics(world);
    expect(metrics.bestArtifactPerformance).toBe(bestActivePerformance);
    expect(metrics.discoveryFrontierPerformance).toBeGreaterThanOrEqual(bestActivePerformance);
    expect(metrics.discoveryFrontierAuc).toBeGreaterThan(0);
    expect(metrics.discoveryFrontierAuc).toBeLessThanOrEqual(metrics.discoveryFrontierPerformance);
    const frontier = metrics.discoveryFrontierPerformance;
    for (const artifact of world.artifacts) artifact.performance = 0;
    expect(calculateMetrics(world).discoveryFrontierPerformance).toBe(frontier);
  }, 15_000);

  it("rejects model output outside the narrow action schema", () => {
    const world = createInitialWorld(9, 0);
    const invalid = {
      goal: "declare-victory",
      targetMaterial: "infinite-gold",
      controllerAction: "execute-javascript",
      note: "trust me",
      source: "openrouter",
    } as unknown as AgentDirective;
    expect(applyDirective(world, "A001", invalid)).toBe(false);
    expect(world.agents[0]?.directive.source).toBe("instinct");
  });

  it("gives every agent one fixed staggered decision opportunity per 60 ticks", () => {
    const world = createInitialWorld(12, 0);
    const scheduled = Array.from({ length: MODEL_MACROTURN_INTERVAL_TICKS }, (_, index) =>
      decisionAgentsDue(world, index + 1),
    );
    const ids = scheduled.flatMap((agents) => agents.map((agent) => agent.id));

    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
    expect(Math.max(...scheduled.map((agents) => agents.length))).toBe(2);
    for (const agent of world.agents) {
      expect(agent.decisionPhase).toBe(decisionPhaseForAgent(agent.id));
      expect(agent.nextDecisionTick).toBe(nextScheduledDecisionTick(0, agent.decisionPhase));
    }
  });

  it("preserves an activity between scheduled successful AI decisions", () => {
    const world = createInitialWorld(13, 0);
    const agent = world.agents[0]!;
    const directive = structuredClone(agent.directive);
    const revision = agent.script.revision;
    const updatedTick = agent.script.updatedTick;

    expect(
      applyDirective(
        world,
        agent.id,
        { ...agent.directive, goal: "gather", note: "unscheduled change", source: "openrouter" },
        false,
        agent.nextDecisionTick - 1,
      ),
    ).toBe(false);
    advanceWorld(world, MODEL_MACROTURN_INTERVAL_TICKS - 1);
    expect(agent.directive).toEqual(directive);
    expect(agent.script.revision).toBe(revision);
    expect(agent.script.updatedTick).toBe(updatedTick);
  });

  it("migrates existing worlds to persistent per-agent schedules without resetting activity", () => {
    const world = createInitialWorld(14, 0);
    const agent = world.agents[37]!;
    const directive = structuredClone(agent.directive);
    const script = structuredClone(agent.script);
    world.tick = 137;
    const legacy = world as unknown as {
      version: number;
      agents: Array<{
        decisionPhase?: number;
        nextDecisionTick?: number;
        scriptCursor?: number;
        crafts?: number;
        curiosity?: number;
        lastCreativeTick?: number;
        materialPurposes?: Record<string, string>;
      }>;
    };
    legacy.version = 2;
    delete legacy.agents[37]!.decisionPhase;
    delete legacy.agents[37]!.nextDecisionTick;
    delete legacy.agents[37]!.scriptCursor;
    delete legacy.agents[37]!.crafts;
    delete legacy.agents[37]!.curiosity;
    delete legacy.agents[37]!.lastCreativeTick;
    delete legacy.agents[37]!.materialPurposes;

    ensureAgentOperatingSystem(world);
    expect(world.version).toBe(7);
    expect(agent.directive).toEqual(directive);
    expect(agent.script).toEqual(script);
    expect(agent.decisionPhase).toBe(decisionPhaseForAgent(agent.id));
    expect(agent.nextDecisionTick).toBe(nextScheduledDecisionTick(world.tick, agent.decisionPhase));
    expect(agent.scriptCursor).toBe(0);
    expect(agent.crafts).toBe(0);
    expect(agent.curiosity).toBeGreaterThanOrEqual(0);
    expect(agent.lastCreativeTick).toBe(world.tick - 600);
    expect(agent.materialPurposes).toEqual({});
    expect(world.actionLibrary.map((action) => action.id)).toEqual(
      expect.arrayContaining(["craft", "creative-session"]),
    );
  });

  it("starts artifact flux and strict validation evidence without inventing history", () => {
    const world = createInitialWorld(14, 0);
    world.tick = 137;
    world.artifacts.push({
      id: "T000012-A001",
      name: "Legacy Veil",
      x: 4,
      y: 5,
      material: "fungus",
      health: 0.8,
      performance: 0.64,
      generation: 1,
      creatorId: "A001",
      authors: ["A001"],
      contributors: ["A001"],
      adopters: [],
      controller: { sensor: "contamination", threshold: 0.4, action: "remediate", revision: 1 },
      builtAt: 12,
      uses: 3,
      validated: true,
    });

    ensureAgentOperatingSystem(world);
    const artifact = world.artifacts[0]!;

    expect(world.version).toBe(7);
    expect(artifact.storedWater).toBe(0);
    expect(artifact.reserve).toBe(1.5);
    expect(artifact.flux).toEqual({
      waterCollected: 0,
      contaminationRemoved: 0,
      reserveConsumed: 0,
      maintenanceInput: 0,
    });
    expect(artifact.fluxTrackingStartedTick).toBe(137);
    expect(artifact.lastService).toBe(0);
    expect(artifact.serviceEma).toBe(0);
    expect(artifact.serviceIntegral).toBe(0);
    expect(artifact.serviceObservedTicks).toBe(0);
    expect(artifact.serviceTrackingStartedTick).toBe(137);
    expect(artifact.validation).toEqual({
      testedMaterial: true,
      completeSpecification: false,
      installedAgentController: true,
      performanceThreshold: true,
      processProvenance: false,
      behaviorallyNovel: true,
    });
    expect(artifact.validated).toBe(false);
  });

  it("canonicalizes and caps a full legacy action library without evicting base actions", () => {
    const world = createInitialWorld(260826081, 0);
    const legacyBase = world.actionLibrary.slice(0, 5);
    const dynamicActions: AgentActionDefinition[] = Array.from({ length: 59 }, (_, index) => ({
      id: `legacy-${index}`,
      name: `Legacy ${index}`,
      icon: "✧",
      algorithm: `Legacy bounded behavior number ${index} retained through migration.`,
      program: [
        modelActionPrimitives[index % modelActionPrimitives.length]!,
        modelActionPrimitives[Math.floor(index / modelActionPrimitives.length)]!,
        "scan-local",
      ],
      authorId: "A001",
      createdTick: index + 1,
      uses: index,
    }));
    world.actionLibrary = [...legacyBase, ...dynamicActions];

    ensureAgentOperatingSystem(world);
    const baseIds = [
      "survey",
      "forage",
      "fabricate",
      "study",
      "steward",
      "craft",
      "creative-session",
    ];
    expect(world.actionLibrary).toHaveLength(64);
    expect(world.actionLibrary.slice(0, baseIds.length).map((action) => action.id)).toEqual(
      baseIds,
    );

    expect(
      registerAction(
        world.actionLibrary,
        {
          name: "Newest Safe Action",
          icon: "⟡",
          algorithm: "Execute a distinct bounded four-step roaming behavior after migration.",
          program: ["roam", "roam", "roam", "roam"],
        },
        "A002",
        world.tick,
      ),
    ).toBeDefined();
    expect(world.actionLibrary).toHaveLength(64);
    expect(baseIds.every((id) => world.actionLibrary.some((action) => action.id === id))).toBe(
      true,
    );
  });

  it("compacts durable episodic memory under a hard token budget", () => {
    const entries = Array.from({ length: 12 }, (_, index) => {
      const content = `Agent observed water and artifact evidence at tick ${index}.`;
      return {
        seq: index + 1,
        tick: index,
        kind: index % 2 === 0 ? "discovery" : "decision",
        content,
        tokens: estimateMemoryTokens(content),
      };
    });
    const compacted = compactMemoryLog(entries, "", 40, 24)!;

    expect(compacted.removed).toBeGreaterThan(0);
    expect(compacted.throughSeq).toBeGreaterThan(0);
    expect(compacted.totalTokens).toBeLessThanOrEqual(40);
    expect(compacted.summary).toContain("COMPACTED LONG-TERM MEMORY");
    expect(compacted.kept.at(-1)?.seq).toBe(12);
  });

  it("collapses only consecutive identical memories into tick-ranged runs", () => {
    const content = "A001 chose explore: continue local survey";
    const tokens = estimateMemoryTokens(content);
    const collapsed = collapseRepeatedMemory([
      { seq: 1, tick: 60, kind: "decision", content, tokens },
      { seq: 2, tick: 120, kind: "decision", content: ` ${content} `, tokens },
      { seq: 3, tick: 130, kind: "heard", content: "Heard A002: Water north.", tokens: 8 },
      { seq: 4, tick: 180, kind: "decision", content, tokens },
    ]);

    expect(memoryRunKey("Decision", ` ${content} `)).toBe(memoryRunKey("decision", content));
    expect(collapsed).toHaveLength(3);
    expect(collapsed[0]).toMatchObject({
      seq: 2,
      tick: 120,
      firstTick: 60,
      lastTick: 120,
      repeatCount: 2,
      content,
    });
    expect(collapsed[2]).toMatchObject({ firstTick: 180, lastTick: 180, repeatCount: 1 });
  });
});
