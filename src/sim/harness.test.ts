import { describe, expect, it } from "vite-plus/test";
import { createInitialWorld } from "./engine";
import {
  applyEdits,
  applyHarnessToQuestions,
  applySkillTriggers,
  baseHarness,
  evaluateCondition,
  harnessSignature,
  harnessState,
  situationCue,
  situationFeatures,
  validateHarness,
} from "./harness";
import type {
  AgentHarness,
  DecisionQuestion,
  HarnessClause,
  HarnessEdit,
  HarnessFact,
  HarnessGuard,
  SituationFeatures,
} from "./harness-types";
import type { AgentDirective } from "./types";

const knownActionIds = ["survey", "forage", "fabricate", "learned-water"];

function world() {
  const state = createInitialWorld(42);
  return { state, agent: state.agents[0]! };
}

function features(overrides: Partial<SituationFeatures> = {}): SituationFeatures {
  const { state, agent } = world();
  return { ...situationFeatures(state, agent), ...overrides };
}

function questions(): Record<string, DecisionQuestion> {
  return {
    goal: {
      type: "choice",
      instructions: "Choose the next 60-tick activity.",
      criteria: {
        explore: "Explore terrain.",
        gather: "Gather matter.",
        build: "Construct an artifact.",
      },
    },
    targetMaterial: {
      type: "choice",
      instructions: "Choose the material.",
      criteria: { water: "Energy reserve.", fungus: "Biological matter." },
    },
    controllerAction: {
      type: "choice",
      instructions: "Choose the controller function.",
      criteria: { "collect-water": "Capture moisture.", remediate: "Remove contamination." },
    },
  };
}

function directive(overrides: Partial<AgentDirective> = {}): AgentDirective {
  return {
    goal: "gather",
    targetMaterial: "water",
    controllerAction: "collect-water",
    actionId: "forage",
    icon: "≈",
    note: "gather: water; follow local evidence",
    source: "openrouter",
    ...overrides,
  };
}

function harness(overrides: Partial<AgentHarness> = {}): AgentHarness {
  return { ...baseHarness(), origin: "adopted", ...overrides };
}

function guard(
  id: string,
  kind: "forbid" | "require",
  question: string,
  label: string,
  all: HarnessClause[] = [],
): HarnessGuard {
  return { id, when: { all }, effect: { kind, question, label }, note: `${kind} ${label}` };
}

function fact(overrides: Partial<HarnessFact> = {}): HarnessFact {
  return {
    id: "f1",
    kind: "resource",
    text: "In this workspace mineral is viable at 20,2.",
    x: 20,
    y: 2,
    material: "mineral",
    verifiedTick: 0,
    ...overrides,
  };
}

function edit(
  component: HarnessEdit["component"],
  op: HarnessEdit["op"],
  item: HarnessEdit["item"],
) {
  return {
    id: `${component}-${op}`,
    scope: component === "memory" || component === "guidance" ? "DOM" : "INV",
    component,
    op,
    item,
    summary: "edit",
    moment: { run: "ref-1", tick: 1, text: "moment" },
    source: "diagnosis",
  } satisfies HarnessEdit;
}

describe("H0 parity", () => {
  it("leaves questions deep-equal and returns new objects", () => {
    const original = questions();
    const result = applyHarnessToQuestions(original, baseHarness(), features());
    expect(result.questions).toEqual(original);
    expect(result.questions).not.toBe(original);
    expect(result.questions.goal).not.toBe(original.goal);
    expect(result.applied).toEqual([]);
  });

  it("adds no state", () => {
    expect(harnessState(baseHarness())).toBeUndefined();
  });

  it("returns the directive unchanged", () => {
    const original = directive();
    expect(applySkillTriggers(original, baseHarness(), features(), knownActionIds)).toBe(original);
  });

  it("starts empty at revision 0", () => {
    expect(baseHarness()).toEqual({
      revision: 0,
      origin: "base",
      procedure: [],
      guards: [],
      memory: [],
      guidance: [],
      skills: [],
    });
  });
});

describe("applyHarnessToQuestions", () => {
  it("appends procedure lines to the goal instructions without touching the input", () => {
    const original = questions();
    const result = applyHarnessToQuestions(
      original,
      harness({ procedure: ["Refill water first.", "Build near stations."] }),
      features(),
    );
    expect(result.questions.goal!.instructions).toBe(
      "Choose the next 60-tick activity. Harness procedure: Refill water first. Harness procedure: Build near stations.",
    );
    expect(original.goal!.instructions).toBe("Choose the next 60-tick activity.");
    expect(result.applied).toEqual(["procedure"]);
  });

  it("replaces one option's criteria text and skips absent labels", () => {
    const result = applyHarnessToQuestions(
      questions(),
      harness({
        guidance: [
          {
            id: "g1",
            question: "controllerAction",
            label: "remediate",
            text: "Use on toxic tiles.",
          },
          { id: "g2", question: "controllerAction", label: "grow", text: "Absent label." },
          { id: "g3", question: "holdMacroturns", label: "4", text: "Absent question." },
        ],
      }),
      features(),
    );
    expect(result.questions.controllerAction!.criteria).toEqual({
      "collect-water": "Capture moisture.",
      remediate: "Use on toxic tiles.",
    });
    expect(result.applied).toEqual(["g1"]);
  });

  it("forbids a label only while its condition holds", () => {
    const forbid = guard("no-build", "forbid", "goal", "build", [
      { feature: "energy", op: "<", value: 0.5 },
    ]);
    const low = applyHarnessToQuestions(
      questions(),
      harness({ guards: [forbid] }),
      features({ energy: 0.4 }),
    );
    expect(Object.keys(low.questions.goal!.criteria)).toEqual(["explore", "gather"]);
    expect(low.applied).toEqual(["no-build"]);
    const high = applyHarnessToQuestions(
      questions(),
      harness({ guards: [forbid] }),
      features({ energy: 0.9 }),
    );
    expect(Object.keys(high.questions.goal!.criteria)).toEqual(["explore", "gather", "build"]);
    expect(high.applied).toEqual([]);
  });

  it("never forbids the last option", () => {
    const result = applyHarnessToQuestions(
      questions(),
      harness({
        guards: [
          guard("a", "forbid", "targetMaterial", "water"),
          guard("b", "forbid", "targetMaterial", "fungus"),
        ],
      }),
      features(),
    );
    expect(result.questions.targetMaterial!.criteria).toEqual({ fungus: "Biological matter." });
    expect(result.applied).toEqual(["a"]);
  });

  it("requires a label by reducing the question to it", () => {
    const result = applyHarnessToQuestions(
      questions(),
      harness({
        guards: [
          guard("refill", "require", "goal", "gather", [
            { feature: "inventory.water", op: "<", value: 1 },
          ]),
          guard("missing", "require", "controllerAction", "signal"),
        ],
      }),
      features(),
    );
    expect(result.questions.goal!.criteria).toEqual({ gather: "Gather matter." });
    expect(Object.keys(result.questions.controllerAction!.criteria)).toHaveLength(2);
    expect(result.applied).toEqual(["refill"]);
  });

  it("applies guidance only to options that survive guards", () => {
    const result = applyHarnessToQuestions(
      questions(),
      harness({
        guards: [guard("water-only", "require", "targetMaterial", "water")],
        guidance: [{ id: "g1", question: "targetMaterial", label: "fungus", text: "Use fungus." }],
      }),
      features(),
    );
    expect(result.questions.targetMaterial!.criteria).toEqual({ water: "Energy reserve." });
    expect(result.applied).toEqual(["water-only"]);
  });
});

describe("evaluateCondition", () => {
  const situation = features({
    energy: 0.4,
    inventory: { water: 2, fungus: 0, mineral: 6, cellulose: 0, chitin: 0 },
    nearestViable: { mineral: 3 },
    localTerrain: "plain",
    hasCommitment: false,
    buildReady: "mineral",
  });
  const holds = (...all: HarnessClause[]) => evaluateCondition({ all }, situation);

  it("holds for an empty conjunction", () => {
    expect(holds()).toBe(true);
  });

  it("compares numeric features with < and >=", () => {
    expect(holds({ feature: "energy", op: "<", value: 0.5 })).toBe(true);
    expect(holds({ feature: "energy", op: ">=", value: 0.5 })).toBe(false);
    expect(holds({ feature: "energy", op: ">=", value: 0.4 })).toBe(true);
    expect(holds({ feature: "inventory.mineral", op: ">=", value: 6 })).toBe(true);
    expect(holds({ feature: "inventory.fungus", op: ">=", value: 1 })).toBe(false);
    expect(holds({ feature: "localRichness", op: ">=", value: 0 })).toBe(true);
  });

  it("treats a material with no viable tile as infinitely far", () => {
    expect(holds({ feature: "nearestViable.mineral", op: "<", value: 4 })).toBe(true);
    expect(holds({ feature: "nearestViable.chitin", op: "<", value: 1_000 })).toBe(false);
    expect(holds({ feature: "nearestViable.chitin", op: ">=", value: 1_000 })).toBe(true);
  });

  it("checks terrain membership, commitment, and build readiness", () => {
    expect(holds({ feature: "localTerrain", op: "in", value: ["plain", "tidal"] })).toBe(true);
    expect(holds({ feature: "localTerrain", op: "in", value: ["tidal"] })).toBe(false);
    expect(holds({ feature: "hasCommitment", op: "=", value: false })).toBe(true);
    expect(holds({ feature: "hasCommitment", op: "=", value: true })).toBe(false);
    expect(holds({ feature: "buildReady", op: "=", value: true })).toBe(true);
    expect(
      evaluateCondition({ all: [{ feature: "buildReady", op: "=", value: false }] }, features()),
    ).toBe(true);
  });

  it("requires every clause", () => {
    expect(
      holds(
        { feature: "energy", op: "<", value: 0.5 },
        { feature: "localTerrain", op: "in", value: ["tidal"] },
      ),
    ).toBe(false);
  });
});

describe("harnessState", () => {
  it("lists memory fact texts", () => {
    expect(harnessState(harness({ memory: [fact()] }))).toEqual({
      harnessMemory: ["In this workspace mineral is viable at 20,2."],
    });
  });
});

describe("applySkillTriggers", () => {
  const skill = {
    id: "s1",
    when: { all: [{ feature: "energy", op: ">=", value: 0.3 }] as HarnessClause[] },
    goal: "gather" as const,
    actionId: "learned-water",
    note: "Use the learned water search.",
  };

  it("runs a known learned action instead of the built-in activity", () => {
    expect(
      applySkillTriggers(directive(), harness({ skills: [skill] }), features(), knownActionIds),
    ).toMatchObject({ goal: "gather", actionId: "learned-water", icon: undefined });
  });

  it.each([
    ["the condition fails", directive(), features({ energy: 0.2 }), knownActionIds],
    [
      "the goal differs",
      directive({ goal: "explore", actionId: "survey" }),
      features(),
      knownActionIds,
    ],
    [
      "Clef chose a learned action",
      directive({ actionId: "learned-other" }),
      features(),
      knownActionIds,
    ],
    ["the action is unknown", directive(), features(), ["forage"]],
  ])("keeps the directive when %s", (_case, original, situation, known) => {
    expect(applySkillTriggers(original, harness({ skills: [skill] }), situation, known)).toBe(
      original,
    );
  });
});

describe("applyEdits", () => {
  it("adds and removes items by id without mutating the base", () => {
    const base = harness({ revision: 3, procedure: ["Keep water."] });
    const refill = guard("refill", "require", "goal", "gather");
    const next = applyEdits(base, [
      edit("guards", "add", refill),
      edit("guards", "add", { ...refill, note: "duplicate" }),
      edit("memory", "add", fact()),
      edit("procedure", "add", "Build near stations."),
      edit("procedure", "remove", "Keep water."),
    ]);
    expect(next.guards).toEqual([refill]);
    expect(next.memory).toEqual([fact()]);
    expect(next.procedure).toEqual(["Build near stations."]);
    expect(next.revision).toBe(3);
    expect(base.guards).toEqual([]);
    expect(base.procedure).toEqual(["Keep water."]);
    expect(applyEdits(next, [edit("guards", "remove", refill)]).guards).toEqual([]);
  });
});

describe("validateHarness", () => {
  const context = { knownActionIds };
  const valid = harness({
    procedure: ["Refill water before long trips."],
    guards: [
      guard("refill", "require", "goal", "gather", [{ feature: "energy", op: "<", value: 0.3 }]),
      guard("learned", "forbid", "actionId", "default"),
      guard("hold", "forbid", "holdMacroturns", "8"),
    ],
    memory: [fact()],
    guidance: [{ id: "g1", question: "goal", label: "inspect", text: "Inspect nearby artifacts." }],
    skills: [
      {
        id: "s1",
        when: { all: [] },
        goal: "gather",
        actionId: "learned-water",
        note: "Search water.",
      },
    ],
  });

  it("accepts a harness within limits and vocabulary", () => {
    expect(validateHarness(valid, context)).toEqual({ valid: true, errors: [] });
    expect(validateHarness(baseHarness(), context).valid).toBe(true);
  });

  it.each<[string, Partial<AgentHarness>]>([
    ["too many procedure lines", { procedure: ["a", "b", "c", "d"] }],
    ["a long procedure line", { procedure: ["x".repeat(161)] }],
    [
      "too many guards",
      { guards: Array.from({ length: 7 }, (_, i) => guard(`g${i}`, "forbid", "goal", "build")) },
    ],
    [
      "an unknown guard question",
      { guards: [guard("g", "forbid", "craftActionId", "woven-filter")] },
    ],
    ["a label outside the vocabulary", { guards: [guard("g", "forbid", "goal", "teleport")] }],
    [
      "a built-in action as an actionId label",
      { guards: [guard("g", "forbid", "actionId", "forage")] },
    ],
    ["an unknown hold", { guards: [guard("g", "require", "holdMacroturns", "3")] }],
    [
      "a non-finite threshold",
      {
        guards: [
          guard("g", "forbid", "goal", "build", [{ feature: "energy", op: "<", value: NaN }]),
        ],
      },
    ],
    [
      "an unknown feature",
      {
        guards: [
          guard("g", "forbid", "goal", "build", [
            { feature: "inventory.gold" as "energy", op: "<", value: 1 },
          ]),
        ],
      },
    ],
    ["too many facts", { memory: Array.from({ length: 7 }, (_, i) => fact({ id: `f${i}` })) }],
    ["a long fact", { memory: [fact({ text: "x".repeat(141) })] }],
    ["an out-of-bounds fact", { memory: [fact({ x: 96 })] }],
    ["a non-finite fact", { memory: [fact({ y: NaN })] }],
    [
      "long guidance",
      { guidance: [{ id: "g", question: "goal", label: "gather", text: "x".repeat(161) }] },
    ],
    [
      "too many skills",
      {
        skills: Array.from({ length: 5 }, (_, i) => ({
          id: `s${i}`,
          when: { all: [] },
          goal: "gather" as const,
          actionId: "learned-water",
          note: "n",
        })),
      },
    ],
    [
      "a skill naming an unknown action",
      { skills: [{ id: "s", when: { all: [] }, goal: "gather", actionId: "teleport", note: "n" }] },
    ],
    [
      "a skill naming a built-in action",
      { skills: [{ id: "s", when: { all: [] }, goal: "gather", actionId: "forage", note: "n" }] },
    ],
    ["a template marker", { procedure: ["Do {{ this }}."] }],
    ["a template tag", { memory: [fact({ text: "In this workspace {% raw %}" })] }],
    [
      "a score",
      { guidance: [{ id: "g", question: "goal", label: "gather", text: "Maximize the Score." }] },
    ],
    ["a grader", { procedure: ["Satisfy the grader."] }],
    [
      "a rubric",
      { guards: [{ ...guard("g", "forbid", "goal", "build"), note: "Per the RUBRIC." }] },
    ],
  ])("rejects %s", (_case, overrides) => {
    const result = validateHarness({ ...valid, ...overrides }, context);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("harnessSignature", () => {
  it("is stable across key order and ignores bookkeeping", () => {
    const refill = guard("refill", "require", "goal", "gather", [
      { feature: "energy", op: "<", value: 0.3 },
    ]);
    const reordered = {
      note: refill.note,
      effect: { label: "gather", question: "goal", kind: "require" as const },
      when: refill.when,
      id: refill.id,
    };
    const a = harness({ guards: [refill], memory: [fact()] });
    const b = {
      ...harness({ guards: [reordered], memory: [fact()] }),
      revision: 9,
      roundId: "r9",
      adoptedTick: 600,
    };
    expect(harnessSignature(a)).toBe(harnessSignature(b));
    expect(harnessSignature(a)).toBe(harnessSignature(structuredClone(a)));
    expect(harnessSignature(a)).toMatch(/^[0-9a-f]{14}$/);
  });

  it("changes when a component changes", () => {
    const a = harness({ memory: [fact()] });
    expect(harnessSignature(a)).not.toBe(harnessSignature(baseHarness()));
    expect(harnessSignature(a)).not.toBe(harnessSignature(harness({ memory: [fact({ x: 22 })] })));
    expect(harnessSignature(harness({ procedure: ["a", "b"] }))).not.toBe(
      harnessSignature(harness({ procedure: ["b", "a"] })),
    );
  });
});

describe("situationFeatures", () => {
  it("reads the agent's tile, stations across the wrap, and viable tiles on a real world", () => {
    const { state, agent } = world();
    const situation = situationFeatures(state, agent);
    expect(agent).toMatchObject({ x: 18, y: 0 });
    expect(situation).toMatchObject({
      tick: 0,
      energy: 0.9,
      localTerrain: "plain",
      hasCommitment: false,
      visibleArtifacts: 0,
    });
    expect(situation.buildReady).toBeUndefined();
    // The wash station at (18, 47) is 25 tiles away across the top edge.
    expect(situation.nearestStation.wash).toBe(25);
    // The foundry at (90, 54) wraps on both axes and beats the one at (66, 65).
    expect(situation.nearestStation.foundry).toBe(30);
    expect(Object.keys(situation.nearestStation).sort()).toEqual([
      "assay",
      "foundry",
      "grind",
      "wash",
      "weave",
    ]);
    expect(Object.keys(situation.nearestViable).sort()).toEqual([
      "cellulose",
      "chitin",
      "fungus",
      "mineral",
      "water",
    ]);
  });

  it("scans every second tile, keeps viable richness, and measures toroidal distance", () => {
    const { state, agent } = world();
    for (const tile of state.terrain) Object.assign(tile, { terrain: "plain", richness: 0 });
    const set = (x: number, y: number, terrain: "mineral" | "tidal", richness: number) =>
      Object.assign(state.terrain[y * 96 + x]!, { terrain, richness });
    agent.x = 0;
    agent.y = 0;
    set(10, 10, "mineral", 0.5);
    set(3, 1, "mineral", 0.9);
    set(2, 2, "mineral", 0.11);
    set(94, 70, "tidal", 0.12);
    const situation = situationFeatures(state, agent);
    expect(situation.nearestViable).toEqual({ mineral: Math.sqrt(200), water: Math.sqrt(8) });
  });

  it("reports build readiness, commitment, and nearby artifacts", () => {
    const { state, agent } = world();
    Object.assign(agent.inventory, { mineral: 6, water: 1.5 });
    agent.craftingTarget = {
      mode: "craft",
      actionName: "Woven filter",
      ingredients: ["fungus", "cellulose"],
      purpose: "Filter",
      startedTick: 0,
    };
    const artifact = { x: agent.x + 6, y: agent.y } as (typeof state.artifacts)[number];
    state.artifacts.push(artifact, { ...artifact, x: agent.x + 7 });
    expect(situationFeatures(state, agent)).toMatchObject({
      buildReady: "mineral",
      hasCommitment: true,
      visibleArtifacts: 1,
    });
  });
});

describe("situationCue", () => {
  it("buckets a fresh agent on a real world", () => {
    expect(situationCue(features())).toBe(
      "energy:high|water:none|terrain:plain|richness:rich|commitment:no|build:none|contamination:clean|hoard:no",
    );
  });

  it.each([
    [{ energy: 0.29 }, "energy:critical"],
    [{ energy: 0.3 }, "energy:low"],
    [{ energy: 0.55 }, "energy:ok"],
    [{ energy: 0.8 }, "energy:high"],
    [{ inventory: { water: 0.5, fungus: 0, mineral: 0, cellulose: 0, chitin: 0 } }, "water:low"],
    [{ inventory: { water: 1.5, fungus: 0, mineral: 0, cellulose: 0, chitin: 0 } }, "water:ok"],
    [{ inventory: { water: 3, fungus: 0, mineral: 0, cellulose: 0, chitin: 0 } }, "water:full"],
    [{ localTerrain: "tidal" as const }, "terrain:tidal"],
    [{ localRichness: 0.07 }, "richness:depleted"],
    [{ localRichness: 0.08 }, "richness:thin"],
    [{ localRichness: 0.12 }, "richness:viable"],
    [{ localRichness: 0.4 }, "richness:rich"],
    [{ hasCommitment: true }, "commitment:yes"],
    [{ buildReady: "mineral" as const }, "build:ready"],
    [{ localContamination: 0.2 }, "contamination:dirty"],
    [{ localContamination: 0.55 }, "contamination:toxic"],
    [{ inventory: { water: 12, fungus: 0, mineral: 0, cellulose: 0, chitin: 0 } }, "hoard:no"],
    [{ inventory: { water: 0, fungus: 0, mineral: 0, cellulose: 0, chitin: 12 } }, "hoard:yes"],
  ])("maps %o to %s", (overrides, token) => {
    expect(situationCue(features(overrides)).split("|")).toContain(token);
  });
});
