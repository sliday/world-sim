import { describe, expect, it } from "vite-plus/test";
import {
  runImprovementRound,
  sampleChoice,
  sampleDistinct,
  type RoundDeps,
  type RoundInput,
} from "./harness-improver";
import type {
  AgentHarness,
  ClefClient,
  DecisionAnswer,
  DecisionQuestion,
  ExecutionOutcome,
  ExecutionRecord,
  HarnessEdit,
  HarnessGuidance,
  HarnessItem,
} from "./harness-types";
import { Rng } from "./rng";
import type { AgentDirective, MaterialKind } from "./types";

type Choice = string | Record<string, number>;
type Policy = (id: string, labels: string[]) => Choice;

interface ClefCall {
  state: Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
}

const CUE =
  "energy:ok|water:low|terrain:moss|richness:viable|commitment:no|build:none|contamination:clean|hoard:no";

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

function input(overrides: Partial<RoundInput> = {}): RoundInput {
  return {
    roundId: "round-7",
    agentId: "A001",
    tick: 600,
    condition: "full-culture",
    mode: "parallel",
    k: 1,
    base: emptyHarness(),
    seed: 42,
    ...overrides,
  };
}

function procedureEdit(id: string, line: string): HarnessEdit {
  return {
    id,
    scope: "INV",
    component: "procedure",
    op: "add",
    item: line,
    summary: line,
    moment: { run: "ref-1", tick: 4, text: "three failed scans before moving" },
    source: "diagnosis",
  };
}

function guidanceEdit(
  id: string,
  label: MaterialKind,
  text = `In this workspace ${label} grows two tiles east`,
): HarnessEdit {
  const item: HarnessGuidance = { id: `g-${id}`, question: "targetMaterial", label, text };
  return {
    id,
    scope: "DOM",
    component: "guidance",
    op: "add",
    item,
    summary: `steer ${label} toward the verified patch`,
    moment: { run: "ref-1", tick: 9, text: `walked past viable ${label}` },
    source: "diagnosis",
  };
}

const REFILL = procedureEdit("edit-refill", "refill water before exploring");
const SCAN = procedureEdit("edit-scan", "scan once, then move to the nearest viable tile");
const FUNGUS = guidanceEdit("edit-fungus", "fungus");
const MINERAL = guidanceEdit("edit-mineral", "mineral");

function answerFor(pick: Choice, labels: string[]): DecisionAnswer {
  const probabilities = Object.fromEntries(
    labels.map((label) => [
      label,
      typeof pick === "string" ? (label === pick ? 1 : 0) : (pick[label] ?? 0),
    ]),
  );
  const choice = labels.reduce((best, label) =>
    probabilities[label]! > probabilities[best]! ? label : best,
  );
  return { choice, confidence: probabilities[choice]!, probabilities };
}

const defaultPolicy: Policy = (id, labels) => {
  if (id === "inv" || id === "dom") return labels.find((label) => label !== "keep")!;
  if (/^e\d+$/.test(id)) return "kept";
  if (/^v\d+$/.test(id)) return "helped";
  if (id === "confidence") return "medium";
  return labels[0]!;
};

function policy(overrides: Record<string, Choice | ((labels: string[]) => Choice)>): Policy {
  return (id, labels) => {
    const key = Object.keys(overrides).find((pattern) => new RegExp(`^${pattern}$`).test(id));
    if (key === undefined) return defaultPolicy(id, labels);
    const pick = overrides[key]!;
    return typeof pick === "function" ? pick(labels) : pick;
  };
}

function fakeClef(choose: Policy = defaultPolicy, fail?: (ids: string[]) => Error | undefined) {
  const calls: ClefCall[] = [];
  const client: ClefClient = {
    async decide(state, questions) {
      calls.push({ state: structuredClone(state), questions: structuredClone(questions) });
      const error = fail?.(Object.keys(questions));
      if (error) throw error;
      return {
        model: "cloudflare/clef-flash",
        cost: 0.00003,
        answers: Object.fromEntries(
          Object.entries(questions).map(([id, question]) => {
            const labels = Object.keys(question.criteria);
            return [id, answerFor(choose(id, labels), labels)];
          }),
        ),
      };
    },
  };
  return { calls, client };
}

function outcome(directive: AgentDirective): ExecutionOutcome {
  const producedNothing = directive.goal === "build";
  const gathered = { water: 0, fungus: 0, mineral: 0, cellulose: 0, chitin: 0 };
  if (!producedNothing) gathered[directive.targetMaterial] = directive.goal === "gather" ? 3 : 1;
  return {
    goal: directive.goal,
    targetMaterial: directive.targetMaterial,
    actionId: "forage",
    ticks: 120,
    energyStart: 0.6,
    energyEnd: 0.5,
    energyMin: 0.4,
    reboots: 0,
    gathered,
    builds: 0,
    crafts: 0,
    inspections: 0,
    repairs: 0,
    successfulPrimitives: producedNothing ? 0 : 4,
    failedPrimitives: producedNothing ? 6 : 1,
    failuresByPrimitive: {},
    pathLength: 12,
    regionsVisited: 2,
    producedNothing,
    events: [],
  };
}

function gatheredTotal(record: ExecutionRecord): number {
  return Object.values(record.outcome.gathered).reduce((sum, value) => sum + value, 0);
}

interface WorldOptions {
  propose?: RoundDeps["propose"];
  directive?: (harness: AgentHarness) => Pick<AgentDirective, "goal" | "targetMaterial">;
  validate?: RoundDeps["validate"];
  digest?: RoundDeps["executionDigest"];
  libraryIndex?: RoundDeps["libraryIndex"];
  decideError?: (call: number) => Error | undefined;
}

function fakeWorld(clef: ClefClient, options: WorldOptions = {}) {
  const decided: Array<{ harness: AgentHarness; draws: number; seed: number }> = [];
  const choose =
    options.directive ??
    ((harness: AgentHarness) => ({
      goal: harness.procedure.length ? ("gather" as const) : ("explore" as const),
      targetMaterial: harness.guidance.length ? ("fungus" as const) : ("water" as const),
    }));
  const deps: RoundDeps = {
    clef,
    cue: CUE,
    knownActionIds: [],
    libraryIndex: options.libraryIndex ?? [],
    async decide(harness, draws, seed) {
      decided.push({ harness: structuredClone(harness), draws, seed });
      const error = options.decideError?.(decided.length);
      if (error) throw error;
      const { goal, targetMaterial } = choose(harness);
      return {
        directives: Array.from({ length: draws }, () => ({
          goal,
          targetMaterial,
          controllerAction: "collect-water" as const,
          note: `${goal}: ${targetMaterial}`,
          source: "openrouter" as const,
        })),
        probabilities: { goal: { [goal]: 1 } },
        model: "cloudflare/clef-flash",
        cost: 0.00003,
      };
    },
    rollout: (directive, run, harness, probabilities) => ({
      run,
      harness,
      directive,
      probabilities,
      model: "cloudflare/clef-flash",
      outcome: outcome(directive),
      trajectory: [],
    }),
    contrast(references, candidate) {
      const sameDirective = references.some(
        (reference) =>
          reference.directive.goal === candidate.directive.goal &&
          reference.directive.targetMaterial === candidate.directive.targetMaterial,
      );
      const mean =
        references.reduce((sum, reference) => sum + gatheredTotal(reference), 0) /
        references.length;
      return {
        run: candidate.run,
        against: references.map((reference) => reference.run),
        sameDirective,
        ...(sameDirective ? {} : { firstDivergenceTick: 2 }),
        deltas: { gatheredTotal: gatheredTotal(candidate) - mean },
        moments: sameDirective
          ? []
          : [
              {
                run: candidate.run,
                tick: 2,
                text: `${candidate.directive.goal} ${candidate.directive.targetMaterial}`,
              },
            ],
        unsafe:
          candidate.outcome.producedNothing &&
          references.some((reference) => !reference.outcome.producedNothing),
      };
    },
    deliverableSummary: (result) =>
      `${result.goal} ${result.targetMaterial}: ${result.producedNothing ? "produced nothing" : `gathered ${Object.values(result.gathered).reduce((sum, value) => sum + value, 0)} units`}`,
    executionDigest:
      options.digest ??
      ((record) => `${record.run}: ${record.directive.goal} ${record.directive.targetMaterial}`),
    propose: options.propose ?? (() => ({ INV: [REFILL], DOM: [FUNGUS] })),
    applyEdits(harness, edits) {
      const next = structuredClone(harness);
      for (const edit of edits) {
        const list = next[edit.component] as HarnessItem[];
        if (!list.some((item) => JSON.stringify(item) === JSON.stringify(edit.item)))
          list.push(edit.item);
      }
      return next;
    },
    validate: options.validate ?? (() => ({ valid: true, errors: [] })),
    signature: (harness) =>
      JSON.stringify([
        harness.procedure,
        harness.guards,
        harness.memory,
        harness.guidance,
        harness.skills,
      ]),
  };
  return { deps, decided };
}

function fixedRng(...values: number[]): Rng {
  return { next: () => values.shift()! } as unknown as Rng;
}

describe("Harness² sampling", () => {
  it("samples one label by inverse CDF in label order", () => {
    const answer = { choice: "b", confidence: 0.5, probabilities: { a: 0.2, b: 0.5, c: 0.3 } };
    expect(sampleChoice(answer, ["a", "b", "c"], fixedRng(0.1))).toBe("a");
    expect(sampleChoice(answer, ["a", "b", "c"], fixedRng(0.69))).toBe("b");
    expect(sampleChoice(answer, ["a", "b", "c"], fixedRng(0.71))).toBe("c");
    expect(sampleChoice(answer, ["c", "b", "a"], fixedRng(0.1))).toBe("c");
  });

  it("samples without replacement, renormalizing, and never draws a zero-probability label", () => {
    const answer = { choice: "a", confidence: 0.6, probabilities: { a: 0.6, b: 0.4, c: 0 } };
    expect(sampleDistinct(answer, ["a", "b", "c"], fixedRng(0.7, 0.2), 3)).toEqual(["b", "a"]);
    const draw = () => sampleDistinct(answer, ["a", "b", "c"], new Rng(9), 2);
    expect(draw()).toEqual(draw());
  });
});

describe("Harness² improvement round", () => {
  it("runs the k = 1 contrastive step in exactly seven calls", async () => {
    const clef = fakeClef();
    const { deps, decided } = fakeWorld(clef.client);
    const result = await runImprovementRound(input(), deps);

    expect(decided.length + clef.calls.length).toBe(7);
    expect(result.record.calls).toBe(7);
    expect(result.record.cost).toBeCloseTo(7 * 0.00003);
    expect(clef.calls.map((call) => Object.keys(call.questions))).toEqual([
      ["inv", "dom"],
      ["e1", "e2"],
      ["v1", "v2", "lesson", "confidence"],
    ]);
    expect(decided.map((call) => call.draws)).toEqual([1, 1, 1, 1]);
    expect(result.record.candidates.map((candidate) => candidate.run)).toEqual(["inv-1", "dom-1"]);
    expect(result.record.compositions).toHaveLength(1);
    for (const decision of result.record.compositions[0]!.decisions)
      expect(decision.reason).toMatch(/^kept -> .+ -> ref-1 t\d+: .+; (inv|dom)-1: .+ \d\/1$/);
    expect(result.record.selection).toBeUndefined();
    expect(result.record.adoptedRun).toBe("succ-1");
    expect(result.directive).toMatchObject({ goal: "gather", targetMaterial: "fungus" });
    expect(result.adoptedHarness).toMatchObject({
      revision: 1,
      origin: "adopted",
      roundId: "round-7",
      adoptedTick: 600,
      procedure: [REFILL.item],
      guidance: [FUNGUS.item],
    });
    expect(result.entry).toMatchObject({
      id: "round-7",
      visibility: "shared",
      cue: CUE,
      edits: [REFILL, FUNGUS],
      experience: {
        cue: CUE,
        lesson: "Add to procedure: refill water before exploring",
        confidence: "medium",
      },
    });
  });

  it("keeps the base harness when the Editor picks keep for both scopes", async () => {
    const clef = fakeClef(policy({ inv: "keep", dom: "keep" }));
    const round = input();
    const { deps, decided } = fakeWorld(clef.client);
    const result = await runImprovementRound(round, deps);

    expect(decided.length + clef.calls.length).toBe(2);
    expect(result.record.calls).toBe(2);
    expect(result.record.adoptedRun).toBe("ref-1");
    expect(result.adoptedHarness).toBe(round.base);
    expect(result.record.candidates).toEqual([]);
    expect(result.record.compositions).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.entry).toBeUndefined();
    expect(result.directive).toMatchObject({ goal: "explore", targetMaterial: "water" });
  });

  it("drops an UNSAFE edit with its reason and never asks the Composer about it", async () => {
    const clef = fakeClef();
    const { deps } = fakeWorld(clef.client, {
      directive: (harness) => ({
        goal: harness.procedure.length ? "build" : "explore",
        targetMaterial: harness.guidance.length ? "fungus" : "water",
      }),
    });
    const result = await runImprovementRound(input(), deps);

    const composer = clef.calls.find((call) => call.questions.e1)!;
    expect(Object.keys(composer.questions)).toEqual(["e1"]);
    expect(composer.state.edits).toEqual([
      expect.objectContaining({ id: "e1", change: expect.stringContaining("guidance") }),
    ]);
    const decisions = result.record.compositions[0]!.decisions;
    expect(decisions.find((decision) => decision.editId === REFILL.id)).toEqual({
      editId: REFILL.id,
      decision: "dropped",
      reason:
        "dropped -> refill water before exploring -> UNSAFE: inv-1 produced nothing while 1/1 base rollouts delivered",
    });
    expect(decisions.find((decision) => decision.editId === FUNGUS.id)?.decision).toBe("kept");
    expect(result.adoptedHarness.procedure).toEqual([]);
    expect(result.adoptedHarness.guidance).toEqual([FUNGUS.item]);
  });

  it("selects among anonymous deliverables with no harness text or run ids when k > 1", async () => {
    const clef = fakeClef(
      policy({
        inv: (labels) => Object.fromEntries(labels.map((label) => [label, 1 / labels.length])),
        "e\\d+": { kept: 0.7, dropped: 0.3 },
      }),
    );
    const { deps } = fakeWorld(clef.client, {
      propose: () => ({ INV: [REFILL, SCAN], DOM: [FUNGUS] }),
    });
    const result = await runImprovementRound(input({ k: 3 }), deps);

    const selection = clef.calls.find((call) => call.questions.select)!;
    const text = JSON.stringify(selection);
    expect(text).not.toMatch(/ref-|inv-|dom-|succ-/);
    for (const harnessText of [
      REFILL.summary,
      SCAN.summary,
      FUNGUS.summary,
      (FUNGUS.item as HarnessGuidance).text,
    ])
      expect(text).not.toContain(harnessText);
    const anonymousIds = result.record.selection!.anonymousIds;
    expect(Object.keys(selection.questions.select!.criteria)).toEqual(Object.keys(anonymousIds));
    expect(Object.values(anonymousIds)).toEqual(
      expect.arrayContaining(["ref-1", "ref-2", "ref-3"]),
    );
    expect(Object.values(anonymousIds).length).toBeGreaterThan(3);
    expect(Object.values(anonymousIds)).toContain(result.record.adoptedRun);
    expect(result.record.selection!.chosen).toBe(result.record.adoptedRun);
  });

  it("composes each sequential checkpoint over every edit seen so far", async () => {
    const C = procedureEdit("edit-rest", "rest on moss when energy is low");
    const clef = fakeClef();
    const { deps } = fakeWorld(clef.client, {
      propose: () => ({ INV: [REFILL, C], DOM: [FUNGUS, MINERAL] }),
    });
    const result = await runImprovementRound(input({ mode: "sequential", k: 2 }), deps);

    const composers = clef.calls.filter((call) => call.questions.e1);
    expect(composers.map((call) => Object.keys(call.questions).length)).toEqual([2, 4]);
    expect(
      (composers[1]!.state.edits as Array<{ change: string }>).map((edit) => edit.change),
    ).toEqual([
      expect.stringContaining(REFILL.summary),
      expect.stringContaining(FUNGUS.summary),
      expect.stringContaining(C.summary),
      expect.stringContaining(MINERAL.summary),
    ]);
    expect(composers[1]!.questions.e1!.instructions).toContain("checkpoint 2 of 2");
    expect(result.record.candidates.map((candidate) => candidate.run)).toEqual([
      "seq-1-inv",
      "seq-1-dom",
      "seq-2-inv",
      "seq-2-dom",
    ]);
    expect(result.record.compositions.map((composition) => composition.run)).toEqual([
      "seq-1-ckpt",
      "seq-2-ckpt",
    ]);
    expect(Object.values(result.record.selection!.anonymousIds).sort()).toEqual([
      "ref-1",
      "ref-2",
      "seq-1-ckpt",
      "seq-2-ckpt",
    ]);
    expect(result.record.calls).toBe(13);
  });

  it("overrides reflection for edits that changed no directive or were never isolated", async () => {
    const parallelClef = fakeClef(policy({ e1: "kept", e2: "dropped", "v\\d+": "hurt" }));
    const parallel = await runImprovementRound(
      input(),
      fakeWorld(parallelClef.client, {
        directive: (harness) => ({
          goal: "explore",
          targetMaterial: harness.guidance.length ? "fungus" : "water",
        }),
      }).deps,
    );
    expect(
      parallel.rows.map(({ editId, candidates, verdict }) => ({ editId, candidates, verdict })),
    ).toEqual([
      { editId: REFILL.id, candidates: ["inv-1", "succ-1"], verdict: "no observed effect" },
      { editId: FUNGUS.id, candidates: ["dom-1"], verdict: "hurt" },
    ]);
    expect(Object.keys(parallelClef.calls.at(-1)!.questions)).toEqual([
      "v1",
      "lesson",
      "confidence",
    ]);

    const C = procedureEdit("edit-rest", "rest on moss when energy is low");
    const sequentialClef = fakeClef();
    const sequential = await runImprovementRound(
      input({ mode: "sequential", k: 2 }),
      fakeWorld(sequentialClef.client, {
        propose: (_, history) => ({ INV: history.length ? [REFILL, C] : [REFILL], DOM: [] }),
        directive: (harness) => ({
          goal: harness.procedure.length ? "gather" : "explore",
          targetMaterial: harness.procedure.length > 1 ? "mineral" : "water",
        }),
      }).deps,
    );
    expect(
      sequential.rows.map(({ editId, candidates, verdict }) => ({ editId, candidates, verdict })),
    ).toEqual([
      {
        editId: REFILL.id,
        candidates: ["seq-1-inv", "seq-1-ckpt", "seq-2-inv", "seq-2-ckpt"],
        verdict: "helped",
      },
      { editId: C.id, candidates: ["seq-2-inv", "seq-2-ckpt"], verdict: "confounded" },
    ]);
    expect(Object.keys(sequentialClef.calls.at(-1)!.questions)).toEqual([
      "v1",
      "lesson",
      "confidence",
    ]);
  });

  it("writes an experience entry only when the chosen lesson rests on a helped or hurt row", async () => {
    const run = async (choose: Policy) =>
      runImprovementRound(input(), fakeWorld(fakeClef(choose).client).deps);

    const confounded = await run(policy({ "v\\d+": "confounded" }));
    expect(confounded.rows.every((row) => row.verdict === "confounded")).toBe(true);
    expect(confounded.entry).toMatchObject({ experience: null, edits: [REFILL, FUNGUS] });

    const declined = await run(policy({ lesson: "NO_ENTRY" }));
    expect(declined.rows.every((row) => row.verdict === "helped")).toBe(true);
    expect(declined.entry?.experience).toBeNull();

    const hurt = await run(
      policy({ "v\\d+": "hurt", lesson: (labels) => labels[1]!, confidence: "low" }),
    );
    expect(hurt.entry?.experience).toEqual({
      cue: CUE,
      lesson: `Do not add to guidance: ${FUNGUS.summary}`,
      evidence: expect.stringMatching(/^edit-fungus hurt in dom-1, succ-1: dom-1 vs ref-1/),
      confidence: "low",
    });
  });

  it("aborts the round on a retryable transport error", async () => {
    const transport = Object.assign(new Error("Clef HTTP 503"), { retryable: true });
    const editor = fakeClef(defaultPolicy, (ids) => (ids.includes("inv") ? transport : undefined));
    await expect(runImprovementRound(input(), fakeWorld(editor.client).deps)).rejects.toBe(
      transport,
    );

    const probe = fakeClef();
    const world = fakeWorld(probe.client, {
      decideError: (call) => (call === 2 ? transport : undefined),
    });
    await expect(runImprovementRound(input(), world.deps)).rejects.toBe(transport);
    expect(probe.calls).toHaveLength(1);
  });

  it("falls back to KEEP_BASE and records it when the Editor fails without retry", async () => {
    const invalid = Object.assign(new Error("Clef returned an invalid inv choice"), {
      retryable: false,
    });
    const clef = fakeClef(defaultPolicy, (ids) => (ids.includes("inv") ? invalid : undefined));
    const round = input();
    const result = await runImprovementRound(round, fakeWorld(clef.client).deps);

    expect(result.record.fallbacks).toEqual([
      "editor failed (Clef returned an invalid inv choice); KEEP_BASE",
    ]);
    expect(result.record.calls).toBe(2);
    expect(result.record.adoptedRun).toBe("ref-1");
    expect(result.adoptedHarness).toBe(round.base);
    expect(result.entry).toBeUndefined();
  });

  it("keeps every state under 6,000 characters, every question open, and every stage free of grading words", async () => {
    const long = (text: string) => `${text} ${"along the eastern ridge ".repeat(12)}`;
    const labels: MaterialKind[] = ["water", "fungus", "mineral", "water", "chitin", "cellulose"];
    const inv = labels.map((_, index) => ({
      ...procedureEdit(`edit-p${index}`, long(`procedure ${index}`)),
      moment: { run: "ref-2", tick: index, text: long("stalled") },
    }));
    const dom = labels.map((label, index) => ({
      ...guidanceEdit(`edit-g${index}`, label, long(`In this workspace ${label}`)),
      summary: long(`guidance ${index}`),
    }));
    const base = {
      ...emptyHarness(),
      procedure: [long("base procedure")],
      memory: [
        {
          id: "f1",
          kind: "resource" as const,
          text: long("In this workspace water"),
          x: 3,
          y: 4,
          verifiedTick: 10,
        },
      ],
    };
    const clef = fakeClef(
      policy({
        "inv|dom|select": (options) =>
          Object.fromEntries(options.map((label) => [label, 1 / options.length])),
        "e\\d+": { kept: 0.6, dropped: 0.4 },
      }),
    );
    const { deps, decided } = fakeWorld(clef.client, {
      propose: () => ({ INV: inv, DOM: dom }),
      digest: (record) => `${record.run}: ${"d".repeat(392)}`,
      libraryIndex: Array.from({ length: 40 }, (_, index) => ({
        id: `lib-${index}`,
        cue: CUE,
        lesson: long("Add to guards"),
        confidence: "medium",
      })),
      validate: (harness) =>
        harness.procedure.length > 3
          ? { valid: false, errors: [`procedure has ${harness.procedure.length} lines; limit 3`] }
          : { valid: true, errors: [] },
      directive: (harness) => ({
        goal: harness.procedure.length > 2 ? "gather" : "explore",
        targetMaterial: (harness.guidance[0]?.label as MaterialKind | undefined) ?? "water",
      }),
    });
    const result = await runImprovementRound(input({ k: 5, base }), deps);

    expect(clef.calls.map((call) => Object.keys(call.questions).length)).toEqual([2, 10, 1, 11]);
    expect(result.record.fallbacks.some((note) => note.includes("limit 3"))).toBe(true);
    expect(result.record.calls).toBe(decided.length + clef.calls.length);
    for (const call of clef.calls) {
      expect(JSON.stringify(call.state).length).toBeLessThan(6_000);
      for (const question of Object.values(call.questions)) {
        expect(Object.keys(question.criteria).length).toBeGreaterThanOrEqual(2);
        expect(JSON.stringify(question)).not.toMatch(/score|grader|rubric/i);
      }
    }
    for (const composition of result.record.compositions) {
      expect(composition.harness.procedure.length).toBeLessThanOrEqual(3);
      const keys = composition.harness.guidance.map((item) => `${item.question}:${item.label}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("returns the same result for the same deps and seed", async () => {
    const run = () => {
      const clef = fakeClef(
        policy({
          "inv|dom": (labels) =>
            Object.fromEntries(labels.map((label) => [label, 1 / labels.length])),
          "e\\d+": { kept: 0.55, dropped: 0.45 },
          select: (labels) =>
            Object.fromEntries(
              labels.map((label, index) => [label, index === 1 ? 0.6 : 0.4 / (labels.length - 1)]),
            ),
        }),
      );
      return runImprovementRound(
        input({ k: 3, seed: 1234 }),
        fakeWorld(clef.client, { propose: () => ({ INV: [REFILL, SCAN], DOM: [FUNGUS, MINERAL] }) })
          .deps,
      );
    };
    expect(await run()).toEqual(await run());
  });
});
