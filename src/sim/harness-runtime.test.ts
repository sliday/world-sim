import { describe, expect, it } from "vite-plus/test";
import { createClefClient } from "./clef-client";
import { prepareClefDecision } from "./clef-decisions";
import {
  advanceWorld,
  applyDirective,
  createInitialWorld,
  decisionAgentsDue,
  decisionObservation,
} from "./engine";
import { baseHarness, situationFeatures, validateHarness } from "./harness";
import { runImprovementRound } from "./harness-improver";
import {
  adoptedAgentHarness,
  createRoundDeps,
  decisionIsOpen,
  failedHarnessRoundRow,
  harnessComponentCounts,
  harnessConfig,
  harnessEventText,
  harnessRoundId,
  harnessRoundRow,
  nextRoundTickAfter,
  pickRoundAgent,
  ROUND_MIN_REMAINING_CALLS,
  roundSeed,
  roundSkipReason,
  type HarnessConfig,
} from "./harness-runtime";
import type { AgentHarness, DecisionQuestion, RoundResult } from "./harness-types";
import type { Agent, WorldState } from "./types";

interface Logged {
  state: Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
}

/** First label weighs most; a question whose instructions carry a harness procedure line gets
 * the reverse order, standing in for a model that reads it. */
function labelOrderFetch(log: Logged[]): typeof fetch {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as Logged & { model: string };
    log.push({ state: body.state, questions: body.questions });
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([id, question]) => {
        const labels = Object.keys(question.criteria);
        const total = (labels.length * (labels.length + 1)) / 2;
        const reversed = question.instructions.includes("Harness procedure:");
        const probabilities = Object.fromEntries(
          labels.map((label, index) => [
            label,
            (reversed ? index + 1 : labels.length - index) / total,
          ]),
        );
        const choice = reversed ? labels.at(-1)! : labels[0]!;
        return [id, { type: "choice", choice, confidence: probabilities[choice], probabilities }];
      }),
    );
    return Response.json({ answers, model: body.model, usage: { cost: 0.0001 } });
  }) as typeof fetch;
}

function dueWorld(): { world: WorldState; agentId: string; decisionTick: number } {
  const world = advanceWorld(createInitialWorld(260826081, 0), 480);
  while (!decisionAgentsDue(world, world.tick + 1).length) advanceWorld(world, 1);
  return {
    world,
    agentId: decisionAgentsDue(world, world.tick + 1)[0]!.id,
    decisionTick: world.tick + 1,
  };
}

function observationOf(world: WorldState, agentId: string): Record<string, unknown> {
  const agent = world.agents.find((candidate) => candidate.id === agentId)!;
  return { ...decisionObservation(world, agent), scheduledDecisionTick: world.tick + 1 };
}

const parallelOne: HarnessConfig = { enabled: true, k: 1, mode: "parallel", intervalTicks: 60 };

describe("decisionIsOpen", () => {
  function freshAgent(changes: Partial<Agent> = {}) {
    const world = createInitialWorld(42);
    Object.assign(world.agents[0]!, changes);
    return { world, agent: world.agents[0]! };
  }

  it("is open when Clef still chooses among several goals", () => {
    const { world, agent } = freshAgent({ energy: 0.9 });
    agent.inventory.water = 3;
    expect(decisionIsOpen(observationOf(world, agent.id))).toBe(true);
  });

  it("is closed in the emergency-water state, where goal and material are forced", () => {
    // Every agent of this world is due at tick 480 with energy 0.32 and no water.
    const { world, agentId } = dueWorld();
    const observation = observationOf(world, agentId);
    const prepared = prepareClefDecision(observation);
    expect(prepared.fixed).toMatchObject({ goal: "gather", targetMaterial: "water" });
    expect(decisionIsOpen(observation)).toBe(false);
  });

  it("is closed during a crafting commitment and when a creative session is due", () => {
    const { world, agent } = freshAgent({
      energy: 0.9,
      craftingTarget: {
        mode: "craft",
        actionName: "Woven filter",
        ingredients: ["fungus", "cellulose"],
        purpose: "Filter local contamination",
        startedTick: 0,
      },
    });
    agent.inventory.water = 3;
    expect(decisionIsOpen(observationOf(world, agent.id))).toBe(false);
    agent.craftingTarget = undefined;
    expect(
      decisionIsOpen({ ...observationOf(world, agent.id), creativeSessionEligible: true }),
    ).toBe(false);
  });

  it("is closed when a harness guard requires the goal", () => {
    const { world, agent } = freshAgent({ energy: 0.9 });
    agent.inventory.water = 3;
    const harness: AgentHarness = {
      ...baseHarness(),
      guards: [
        {
          id: "explore-first",
          when: { all: [] },
          effect: { kind: "require", question: "goal", label: "explore" },
          note: "Nothing viable is mapped nearby.",
        },
      ],
    };
    const options = {
      harness,
      features: situationFeatures(world, agent),
      knownActionIds: agent.knownActionIds,
    };
    expect(decisionIsOpen(observationOf(world, agent.id), options)).toBe(false);
    expect(
      decisionIsOpen(observationOf(world, agent.id), { ...options, harness: baseHarness() }),
    ).toBe(true);
  });
});

describe("pickRoundAgent", () => {
  const withHarness = (adoptedTick: number): AgentHarness => ({
    ...baseHarness(),
    revision: 1,
    adoptedTick,
  });

  it("prefers agents without a harness, then the oldest adoption, then id", () => {
    const agents = [
      { id: "A004", harness: withHarness(300) },
      { id: "A003", harness: withHarness(100) },
      { id: "A002" },
      { id: "A001", harness: withHarness(100) },
      { id: "A005" },
    ];
    const open = (agent: { id: string }) => agent.id !== "A002";
    expect(pickRoundAgent(agents, open)?.id).toBe("A005");
    const harnessed = agents.filter((agent) => agent.harness);
    expect(pickRoundAgent(harnessed, () => true)?.id).toBe("A001");
    expect(pickRoundAgent(harnessed.slice(0, 1), () => true)?.id).toBe("A004");
  });

  it("returns undefined when no due agent has an open decision", () => {
    expect(pickRoundAgent([{ id: "A001" }, { id: "A002" }], () => false)).toBeUndefined();
  });
});

describe("harnessConfig", () => {
  it("defaults to learning off, k = 1, parallel, every 600 ticks", () => {
    expect(harnessConfig({})).toEqual({
      enabled: false,
      k: 1,
      mode: "parallel",
      intervalTicks: 600,
    });
  });

  it("parses the wrangler defaults", () => {
    expect(
      harnessConfig({
        HARNESS_LEARNING: "true",
        HARNESS_K: "1",
        HARNESS_MODE: "parallel",
        HARNESS_ROUND_INTERVAL_TICKS: "600",
      }),
    ).toEqual({ ...parallelOne, intervalTicks: 600 });
  });

  it.each([
    ["3", 3],
    [" 5 ", 5],
    ["9", 5],
    ["0", 1],
    ["-2", 1],
    ["2.5", 1],
    ["two", 1],
    ["", 1],
  ])("reads HARNESS_K %j as %i", (value, k) => {
    expect(harnessConfig({ HARNESS_K: value }).k).toBe(k);
  });

  it("enables learning only for the exact value true", () => {
    expect(harnessConfig({ HARNESS_LEARNING: " true " }).enabled).toBe(true);
    for (const value of ["TRUE", "1", "yes", "false", ""])
      expect(harnessConfig({ HARNESS_LEARNING: value }).enabled).toBe(false);
  });

  it("accepts sequential mode and falls back to parallel otherwise", () => {
    expect(harnessConfig({ HARNESS_MODE: "sequential" }).mode).toBe("sequential");
    expect(harnessConfig({ HARNESS_MODE: "Sequential" }).mode).toBe("parallel");
    expect(harnessConfig({ HARNESS_MODE: "tree" }).mode).toBe("parallel");
  });

  it("keeps the round interval a positive whole number of ticks", () => {
    expect(harnessConfig({ HARNESS_ROUND_INTERVAL_TICKS: "120" }).intervalTicks).toBe(120);
    expect(harnessConfig({ HARNESS_ROUND_INTERVAL_TICKS: "0" }).intervalTicks).toBe(600);
    expect(harnessConfig({ HARNESS_ROUND_INTERVAL_TICKS: "1e3" }).intervalTicks).toBe(600);
  });
});

describe("roundSkipReason", () => {
  const gate = {
    config: parallelOne,
    tick: 600,
    nextRoundTick: 600,
    callsToday: 0,
    dailyLimit: 1_000,
    now: 1_000_000,
  };

  it("runs a due round with budget to spare", () => {
    expect(roundSkipReason(gate)).toBeUndefined();
    expect(roundSkipReason({ ...gate, tick: 700 })).toBeUndefined();
  });

  it("skips when learning is off or the round is not due", () => {
    expect(roundSkipReason({ ...gate, config: { ...parallelOne, enabled: false } })).toBe(
      "learning disabled",
    );
    expect(roundSkipReason({ ...gate, tick: 599 })).toBe("next round at T600");
  });

  it("skips when fewer than 40 daily calls remain", () => {
    expect(
      roundSkipReason({ ...gate, callsToday: gate.dailyLimit - ROUND_MIN_REMAINING_CALLS }),
    ).toBeUndefined();
    expect(
      roundSkipReason({ ...gate, callsToday: gate.dailyLimit - ROUND_MIN_REMAINING_CALLS + 1 }),
    ).toMatch(/fewer than 40/);
  });

  it("skips while Clef decisions are blocked", () => {
    expect(roundSkipReason({ ...gate, decisionBlockedUntil: gate.now + 1 })).toMatch(/cooldown/);
    expect(roundSkipReason({ ...gate, decisionBlockedUntil: gate.now })).toBeUndefined();
  });

  it("skips while text generation is blocked, since a build or create pick would be lost", () => {
    expect(roundSkipReason({ ...gate, generationBlockedUntil: gate.now + 1 })).toBe(
      "text generation is on cooldown",
    );
    expect(roundSkipReason({ ...gate, generationBlockedUntil: gate.now })).toBeUndefined();
  });
});

describe("nextRoundTickAfter", () => {
  it("keeps at least the interval and makes the gap coprime with the 60-tick macroturn", () => {
    expect(nextRoundTickAfter(600, 60)).toBe(661);
    expect(nextRoundTickAfter(600, 59)).toBe(659);
    expect(nextRoundTickAfter(600, 30)).toBe(631);
    expect(nextRoundTickAfter(600, 6)).toBe(607);
    expect(nextRoundTickAfter(600, 1)).toBe(601);
    expect(nextRoundTickAfter(600, 120)).toBe(721);
  });

  it("lets successive rounds reach every agent, not only the first round's phase", () => {
    // Only agents whose phase matches the tick modulo 60 can be due at that tick.
    const { agents } = createInitialWorld(260826081, 0);
    const reachable = (ticks: number[]) =>
      new Set(
        agents
          .filter((agent) => ticks.some((tick) => (tick - agent.decisionPhase) % 60 === 0))
          .map((agent) => agent.id),
      );
    const roundTicks = (step: (tick: number) => number) => {
      const ticks = [601];
      while (ticks.length < 60) ticks.push(step(ticks.at(-1)!));
      return ticks;
    };
    expect(reachable(roundTicks((tick) => nextRoundTickAfter(tick, 60))).size).toBe(agents.length);
    // The old fixed 60-tick gap kept every round on the first round's one or two agents.
    expect(reachable(roundTicks((tick) => tick + 60)).size).toBeLessThanOrEqual(2);
  });
});

describe("roundSeed and harnessRoundId", () => {
  it("derive deterministically from world seed, agent id and tick", () => {
    const seed = roundSeed(260826081, "A001", 600);
    expect(roundSeed(260826081, "A001", 600)).toBe(seed);
    expect(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32).toBe(true);
    expect(
      new Set([
        seed,
        roundSeed(260826082, "A001", 600),
        roundSeed(260826081, "A002", 600),
        roundSeed(260826081, "A001", 601),
      ]).size,
    ).toBe(4);
    expect(harnessRoundId(600, "A001")).toBe("round-600-A001");
  });
});

describe("a round wired by createRoundDeps", () => {
  async function openRound(): Promise<{
    result: RoundResult;
    world: WorldState;
    agentId: string;
    decisionTick: number;
    decisionRequests: Logged[];
  }> {
    const { world, agentId, decisionTick } = dueWorld();
    const agent = world.agents.find((candidate) => candidate.id === agentId)!;
    agent.energy = 0.8;
    agent.inventory.water = 2;
    const stageRequests: Logged[] = [];
    const decisionRequests: Logged[] = [];
    const { deps } = createRoundDeps({
      world,
      agentId,
      decisionTick,
      clef: createClefClient("key", labelOrderFetch(stageRequests)),
      decisionClef: createClefClient("key", labelOrderFetch(decisionRequests)),
    });
    const result = await runImprovementRound(
      {
        roundId: harnessRoundId(decisionTick, agentId),
        agentId,
        tick: decisionTick,
        condition: world.interactionCondition,
        mode: "parallel",
        k: 1,
        base: baseHarness(),
        // harness-round.test.ts shows this seed adopting a procedure edit that helped.
        seed: 7,
      },
      deps,
    );
    return { result, world, agentId, decisionTick, decisionRequests };
  }

  it("adopts a harness the routine path then applies, and reports it compactly", async () => {
    const { result, world, agentId, decisionTick, decisionRequests } = await openRound();
    const agent = world.agents.find((candidate) => candidate.id === agentId)!;
    expect(decisionIsOpen(observationOf(world, agentId))).toBe(true);
    // References ask the full routine question set, hold included.
    expect(Object.keys(decisionRequests[0]!.questions)).toContain("holdMacroturns");
    expect(result.record.fallbacks).toEqual([]);
    expect(result.adoptedHarness.origin).toBe("adopted");
    expect(
      applyDirective(structuredClone(world), agentId, result.directive, false, decisionTick),
    ).toBe(true);

    const harness = adoptedAgentHarness(undefined, result, decisionTick);
    expect(harness).toMatchObject({
      roundId: result.record.roundId,
      adoptedTick: decisionTick,
      revision: 1,
    });
    expect(validateHarness(harness, { knownActionIds: agent.knownActionIds }).errors).toEqual([]);
    expect(adoptedAgentHarness(harness, result, decisionTick + 60).revision).toBe(2);
    const counts = harnessComponentCounts(harness);
    expect(Object.values(counts).reduce((total, count) => total + count, 0)).toBeGreaterThan(0);

    const prepared = prepareClefDecision(observationOf(world, agentId), {
      harness,
      features: situationFeatures(world, agent),
      knownActionIds: agent.knownActionIds,
    });
    expect(JSON.stringify(prepared)).not.toBe(
      JSON.stringify(prepareClefDecision(observationOf(world, agentId))),
    );

    expect(harnessEventText(agent.name, result)).toMatch(
      new RegExp(`^${agent.name} refined its harness: add `),
    );
    const row = harnessRoundRow(result, agent.name, parallelOne);
    expect(row).toMatchObject({
      roundId: result.record.roundId,
      tick: decisionTick,
      agentId,
      agentName: agent.name,
      cue: result.record.cue,
      mode: "parallel",
      k: 1,
      adoptedRun: result.record.adoptedRun,
      calls: result.record.calls,
      cost: result.record.cost,
      fallbacks: [],
    });
    expect(row.adoptedComponents.length).toBeGreaterThan(0);
    expect(row.verdicts.map((verdict) => verdict.verdict)).toEqual(
      result.rows.map((verdict) => verdict.verdict),
    );
    expect(row.lesson).toBe(result.entry?.experience?.lesson ?? "NO_ENTRY");
    expect(JSON.stringify(row).length).toBeLessThan(4_000);
  });

  it("resets the agent to H0 and says so when the round keeps the base harness", async () => {
    const { result, decisionTick } = await openRound();
    const kept: RoundResult = { ...result, adoptedHarness: baseHarness() };
    const previous: AgentHarness = { ...result.adoptedHarness, revision: 4 };
    const harness = adoptedAgentHarness(previous, kept, decisionTick);
    expect(harness).toMatchObject({ origin: "base", revision: 5, adoptedTick: decisionTick });
    expect(harnessComponentCounts(harness)).toEqual({
      procedure: 0,
      guards: 0,
      memory: 0,
      guidance: 0,
      skills: 0,
    });
    expect(harnessEventText("Ada", kept)).toBe("Ada kept its base harness");
  });

  it("records a failed round with its spend and no adoption", () => {
    expect(
      failedHarnessRoundRow({
        roundId: "round-600-A001",
        tick: 600,
        agentId: "A001",
        agentName: "Ada",
        cue: "energy:ok",
        config: parallelOne,
        calls: 2,
        cost: 0.00006,
        error: "Clef HTTP 503",
      }),
    ).toEqual({
      roundId: "round-600-A001",
      tick: 600,
      agentId: "A001",
      agentName: "Ada",
      cue: "energy:ok",
      mode: "parallel",
      k: 1,
      adoptedComponents: [],
      verdicts: [],
      lesson: "NO_ENTRY",
      calls: 2,
      cost: 0.00006,
      fallbacks: [],
      error: "Clef HTTP 503",
    });
  });

  it("draws every activity before any hold, so an open hold never shifts activity draws", async () => {
    const { world, agentId, decisionTick } = dueWorld();
    const agent = world.agents.find((candidate) => candidate.id === agentId)!;
    agent.energy = 0.8;
    agent.inventory.water = 2;
    const { deps } = createRoundDeps({
      world,
      agentId,
      decisionTick,
      clef: createClefClient("key", labelOrderFetch([])),
    });
    const holdForced: AgentHarness = {
      ...baseHarness(),
      guards: [
        {
          id: "hold-one",
          when: { all: [] },
          effect: { kind: "require", question: "holdMacroturns", label: "1" },
          note: "Reassess at every macroturn.",
        },
      ],
    };
    const open = await deps.decide(baseHarness(), 3, 11);
    const forced = await deps.decide(holdForced, 3, 11);
    const activity = (directive: (typeof open.directives)[number]) => ({
      goal: directive.goal,
      targetMaterial: directive.targetMaterial,
      controllerAction: directive.controllerAction,
      actionId: directive.actionId,
    });
    expect(forced.directives.map(activity)).toEqual(open.directives.map(activity));
    expect(forced.directives.every((directive) => directive.holdMacroturns === 1)).toBe(true);
  });
});
