import { describe, expect, it } from "vite-plus/test";
import { botPortraitSvg, generateBotAppearance } from "./bot-appearance";
import { registerAction } from "./action-sandbox";
import {
  advanceWorld,
  applyDirective,
  balancedPortfolioScore,
  calculateMetrics,
  controllerBehaviorDiffers,
  createInitialWorld,
  decisionAgentsDue,
  decisionPhaseForAgent,
  deliverSpeech,
  ensureAgentOperatingSystem,
  isArtifactContact,
  MODEL_MACROTURN_INTERVAL_TICKS,
  nextScheduledDecisionTick,
  normalizeSpeech,
} from "./engine";
import { agentNameCatalog, generateAgentName } from "./names";
import {
  collapseRepeatedMemory,
  compactMemoryLog,
  estimateMemoryTokens,
  memoryRunKey,
} from "./memory-log";
import { clampOverlayAnchor, easeToward, normalizeSettled, wrappedTarget } from "./motion";
import type { AgentDirective, WorldState } from "./types";

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

describe("deterministic consequence layer", () => {
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

  it("maintains per-agent operating files and executes facilitated bounded actions", () => {
    const world = createInitialWorld(260826081, 0);
    const agent = world.agents[0]!;
    const decisionTick = agent.nextDecisionTick;
    expect(agent.documents.soulMd).toContain("# SOUL.md");
    expect(agent.documents.memoryMd).toContain("# MEMORY.md");
    expect(agent.documents.userMd).toContain("# USER.md");
    const before = world.actionLibrary.length;
    expect(
      applyDirective(
        world,
        agent.id,
        {
          goal: "gather",
          targetMaterial: "fungus",
          controllerAction: "grow",
          note: "sample nearby matter before moving",
          source: "openrouter",
          actionId: "forage",
          icon: "✦",
          actionProposal: {
            name: "Sample Arc",
            icon: "✦",
            algorithm:
              "Sample matter underfoot, then follow the nearest requested resource gradient.",
            program: ["scan-local", "gather-local", "seek-resource"],
          },
        },
        true,
        decisionTick,
      ),
    ).toBe(true);
    expect(world.actionLibrary).toHaveLength(before + 1);
    expect(agent.knownActionIds).toContain(agent.directive.actionId);
    expect(agent.script.updatedTick).toBe(decisionTick);
    expect(agent.script.revision).toBe(1);
    expect(agent.script.icon).toBe("✦");
    expect(agent.scriptCursor).toBe(0);
    expect(agent.nextDecisionTick).toBe(decisionTick + MODEL_MACROTURN_INTERVAL_TICKS);
    expect(agent.documents.memoryMd).toContain(`T${decisionTick}:`);
    const forage = world.actionLibrary.find((action) => action.id === "forage")!;
    expect(registerAction(world.actionLibrary, forage, agent.id, world.tick)).toBeUndefined();
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
  });

  it("does not treat revision metadata alone as an executable fork", () => {
    const parent = { sensor: "moisture", threshold: 0.5, action: "grow", revision: 1 } as const;
    expect(controllerBehaviorDiffers(parent, { ...parent, revision: 2 })).toBe(false);
    expect(controllerBehaviorDiffers(parent, { ...parent, threshold: 0.51, revision: 2 })).toBe(
      true,
    );
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
  });

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
      }>;
    };
    legacy.version = 2;
    delete legacy.agents[37]!.decisionPhase;
    delete legacy.agents[37]!.nextDecisionTick;
    delete legacy.agents[37]!.scriptCursor;

    ensureAgentOperatingSystem(world);
    expect(world.version).toBe(3);
    expect(agent.directive).toEqual(directive);
    expect(agent.script).toEqual(script);
    expect(agent.decisionPhase).toBe(decisionPhaseForAgent(agent.id));
    expect(agent.nextDecisionTick).toBe(nextScheduledDecisionTick(world.tick, agent.decisionPhase));
    expect(agent.scriptCursor).toBe(0);
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
