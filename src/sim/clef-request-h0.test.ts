// Golden request bodies for routine Clef decisions. The snapshots under __snapshots__/clef-h0
// were recorded from requestClefDirective before the harness refactor (commit d0168e2) and
// re-recorded after #11 reworded the hold question for 600-tick macroturns; a decision without
// a harness, or under H0, must keep sending exactly these bytes.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createClefClient } from "./clef-client";
import { requestClefDirective } from "./clef-decisions";
import { advanceWorld, createInitialWorld, decisionObservation } from "./engine";
import { baseHarness, situationFeatures } from "./harness";
import { createRoundDeps } from "./harness-runtime";
import type { AgentHarness, SituationFeatures } from "./harness-types";
import type { InteractionCondition, WorldState } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Scenario {
  name: string;
  state: Record<string, unknown>;
  world: WorldState;
  agentId: string;
  features: SituationFeatures;
  knownActionIds: string[];
}

function routineState(world: WorldState, agentId: string): Record<string, unknown> {
  const agent = world.agents.find((candidate) => candidate.id === agentId)!;
  return {
    ...decisionObservation(world, agent),
    scheduledDecisionTick: world.tick + 1,
    longTermMemory: { estimatedTokens: 12, compactions: 0, compactedSummary: "", recentLog: [] },
    nullclawPolicy: "concise",
  };
}

function scenario(
  name: string,
  world: WorldState,
  agentId: string,
  extra: Record<string, unknown> = {},
): Scenario {
  const agent = world.agents.find((candidate) => candidate.id === agentId)!;
  return {
    name,
    state: { ...routineState(world, agentId), ...extra },
    world: structuredClone(world),
    agentId,
    features: situationFeatures(world, agent),
    knownActionIds: [...agent.knownActionIds],
  };
}

function fresh(condition: InteractionCondition = "full-culture"): WorldState {
  const world = createInitialWorld(42);
  world.interactionCondition = condition;
  return world;
}

function scenarios(): Scenario[] {
  const list: Scenario[] = [];
  list.push(scenario("normal", fresh(), "A001"));
  list.push(scenario("no-communication", fresh("no-communication"), "A001"));

  const emergency = fresh();
  emergency.agents[0]!.energy = 0.4;
  emergency.agents[0]!.inventory.water = 1.4;
  list.push(scenario("emergency", emergency, "A001"));

  const creative = fresh();
  creative.agents[0]!.energy = 0.9;
  creative.agents[0]!.inventory.water = 3;
  list.push(scenario("creative", creative, "A001", { creativeSessionEligible: true }));

  const commitment = fresh();
  commitment.agents[0]!.energy = 0.4;
  commitment.agents[0]!.inventory.water = 2;
  commitment.agents[0]!.craftingTarget = {
    mode: "craft",
    actionName: "Woven filter",
    ingredients: ["fungus", "cellulose"],
    purpose: "Filter local contamination",
    startedTick: 0,
  };
  list.push(scenario("commitment", commitment, "A001"));

  const learned = fresh();
  learned.actionLibrary.push(
    {
      id: "learned-water",
      name: "Water search",
      icon: "≈",
      algorithm: "Seek water and gather it.",
      program: ["seek-resource", "gather-local"],
      authorId: "A001",
      createdTick: 0,
      uses: 0,
    },
    {
      id: "woven-filter",
      name: "Woven filter",
      icon: "◇",
      algorithm: "Combine fungus and cellulose.",
      program: ["craft-local"],
      recipe: ["fungus", "cellulose"],
      authorId: "A002",
      createdTick: 0,
      uses: 0,
    },
  );
  learned.agents[0]!.knownActionIds.push("learned-water");
  list.push(scenario("learned-and-craftable", learned, "A001"));

  const lived = advanceWorld(createInitialWorld(42), 900);
  for (const agentId of ["A001", "A037", "A100"])
    list.push(scenario(`lived-${agentId}`, lived, agentId));
  // Without model decisions every lived agent drifts into the emergency branch; this one has
  // reserves and too little curiosity for a creative session, so its goal stays open.
  const open = lived.agents.find((agent) => agent.id === "A050")!;
  open.energy = 0.8;
  open.inventory.water = 2;
  open.curiosity = 0.3;
  list.push(scenario("lived-open", lived, "A050"));
  return list;
}

/** Captures the request body and answers every open question with its first label. */
function capture(bodies: string[]): typeof fetch {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    const body = String(init?.body);
    bodies.push(body);
    const { questions } = JSON.parse(body) as {
      questions: Record<string, { criteria: Record<string, string> }>;
    };
    const answers = Object.fromEntries(
      Object.entries(questions).map(([id, question]) => {
        const labels = Object.keys(question.criteria);
        return [
          id,
          {
            type: "choice",
            choice: labels[0],
            confidence: 1,
            probabilities: Object.fromEntries(labels.map((label, index) => [label, index ? 0 : 1])),
          },
        ];
      }),
    );
    return Response.json({ model: "cloudflare/clef-flash", answers, usage: { cost: 0 } });
  }) as typeof fetch;
}

/** H0 as a round leaves it on an agent: empty components with adoption metadata. */
function adoptedH0(): AgentHarness {
  return { ...baseHarness(), revision: 3, roundId: "round-600-A001", adoptedTick: 600 };
}

const cases = scenarios().map((entry) => [entry.name, entry] as const);

describe("routine Clef request bodies", () => {
  it.each(cases)("%s matches the recorded body without a harness", async (name, scenario) => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", capture(bodies));
    await requestClefDirective("key", scenario.state);
    expect(bodies).toHaveLength(1);
    await expect(bodies[0]).toMatchFileSnapshot(`./__snapshots__/clef-h0/${name}.txt`);
  });

  it.each(cases)("%s matches the recorded body under H0", async (name, scenario) => {
    for (const harness of [baseHarness(), adoptedH0()]) {
      const bodies: string[] = [];
      vi.stubGlobal("fetch", capture(bodies));
      const { directive } = await requestClefDirective("key", scenario.state, {
        harness,
        features: scenario.features,
        knownActionIds: scenario.knownActionIds,
      });
      vi.stubGlobal("fetch", capture([]));
      expect(directive).toEqual((await requestClefDirective("key", scenario.state)).directive);
      expect(bodies).toHaveLength(1);
      await expect(bodies[0]).toMatchFileSnapshot(`./__snapshots__/clef-h0/${name}.txt`);
    }
  });

  it.each(cases)("%s round references send the recorded body under H0", async (name, scenario) => {
    const bodies: string[] = [];
    const { deps } = createRoundDeps({
      world: scenario.world,
      agentId: scenario.agentId,
      decisionTick: scenario.world.tick + 1,
      observation: scenario.state,
      clef: createClefClient("key", capture([])),
      decisionClef: createClefClient("key", capture(bodies)),
    });
    await deps.decide(baseHarness(), 2, 7);
    expect(bodies).toHaveLength(1);
    await expect(bodies[0]).toMatchFileSnapshot(`./__snapshots__/clef-h0/${name}.txt`);
  });
});
