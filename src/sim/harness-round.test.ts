// End-to-end Harness² round: createRoundDeps wires the real M1-M4 modules into
// runImprovementRound the way the Worker does, with Clef replaced by a fetch stub that answers
// from label order.
import { describe, expect, it } from "vite-plus/test";
import { createClefClient } from "./clef-client";
import {
  advanceWorld,
  applyDirective,
  createInitialWorld,
  decisionAgentsDue,
  ensureAgentOperatingSystem,
  mechanismsForCondition,
} from "./engine";
import { baseHarness, validateHarness } from "./harness";
import { runImprovementRound, type RoundDeps } from "./harness-improver";
import { matchLibrary } from "./harness-library";
import { createRoundDeps } from "./harness-runtime";
import type { DecisionQuestion, LibraryEntry, RoundResult } from "./harness-types";
import type { InteractionCondition, WorldState } from "./types";

const SNAPSHOT_PATH = "/Users/stas/.claude/jobs/20600704/tmp/snap.json";
const STATE_LIMIT = 6_000;

const fs = (await import("node:fs" as string)) as {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
};

interface ClefRequest {
  state: Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
}

/** Answers every question with probabilities that fall with label order: the first of n labels
 * weighs n, the last weighs 1. A `steered` question gets the reverse order, standing in for a
 * model that reads the harness text in it. Logs every request body it receives. */
function labelOrderFetch(
  log: ClefRequest[],
  steered: (question: DecisionQuestion) => boolean = () => false,
): typeof fetch {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as ClefRequest & { model: string };
    log.push({ state: body.state, questions: body.questions });
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([id, question]) => {
        const labels = Object.keys(question.criteria);
        const total = (labels.length * (labels.length + 1)) / 2;
        const reversed = steered(question);
        const probabilities = Object.fromEntries(
          labels.map((label, index) => [
            label,
            (reversed ? index + 1 : labels.length - index) / total,
          ]),
        );
        const choice = reversed ? labels.at(-1)! : labels[0]!;
        return [
          id,
          {
            type: "choice",
            choice,
            confidence: probabilities[choice],
            probabilities,
          },
        ];
      }),
    );
    return new Response(JSON.stringify({ answers, model: body.model, usage: { cost: 0.0001 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function dueAgent(world: WorldState): { agentId: string; decisionTick: number } {
  while (!decisionAgentsDue(world, world.tick + 1).length) advanceWorld(world, 1);
  return { agentId: decisionAgentsDue(world, world.tick + 1)[0]!.id, decisionTick: world.tick + 1 };
}

interface Harnessed {
  deps: RoundDeps;
  /** Requests the improver's own stages sent (Editor, Composer, selection, Reflector). */
  stageRequests: ClefRequest[];
  /** Requests decide() sent for references, probes, and successors. */
  decisionRequests: ClefRequest[];
  calls: { decide: number; clef: number };
  cue: string;
}

/** The Worker's wiring from createRoundDeps, with counting transports: decisions apply the
 * harness to the routine questions, rollouts run on clones of `world` at `decisionTick`. */
function wireRound(
  world: WorldState,
  agentId: string,
  decisionTick: number,
  library: LibraryEntry[] = [],
): Harnessed {
  const stageRequests: ClefRequest[] = [];
  const decisionRequests: ClefRequest[] = [];
  const calls = { decide: 0, clef: 0 };
  const stageClient = createClefClient("test-key", labelOrderFetch(stageRequests));
  // Clef follows a harness procedure line: it reverses its preference on the goal it extends.
  const decisionClient = createClefClient(
    "test-key",
    labelOrderFetch(decisionRequests, (question) =>
      question.instructions.includes("Harness procedure:"),
    ),
  );
  const wired = createRoundDeps({
    world,
    agentId,
    decisionTick,
    library,
    clef: {
      decide(state, questions) {
        calls.clef += 1;
        return stageClient.decide(state, questions);
      },
    },
    decisionClef: decisionClient,
  });
  const deps: RoundDeps = {
    ...wired.deps,
    decide(harness, draws, seed) {
      calls.decide += 1;
      return wired.deps.decide(harness, draws, seed);
    },
  };
  return { deps, stageRequests, decisionRequests, calls, cue: wired.cue };
}

function stateSize(request: ClefRequest): number {
  return JSON.stringify(request.state).length;
}

/** Checks every invariant the design pins on a finished round. */
function expectSoundRound(
  result: RoundResult,
  wired: Harnessed,
  source: WorldState,
  before: string,
  due: { agentId: string; decisionTick: number },
): void {
  expect(JSON.stringify(source)).toBe(before);
  expect(result.record.calls).toBe(wired.calls.decide + wired.calls.clef);
  expect(wired.stageRequests).toHaveLength(wired.calls.clef);
  for (const request of [...wired.stageRequests, ...wired.decisionRequests]) {
    for (const question of Object.values(request.questions))
      expect(Object.keys(question.criteria).length).toBeGreaterThanOrEqual(2);
    expect(stateSize(request)).toBeLessThan(STATE_LIMIT);
  }
  expect(result.record.fallbacks).toEqual([]);
  expect(
    validateHarness(result.adoptedHarness, { knownActionIds: wired.deps.knownActionIds }).errors,
  ).toEqual([]);
  expect(
    applyDirective(structuredClone(source), due.agentId, result.directive, false, due.decisionTick),
  ).toBe(true);
}

function adoptedSummary(result: RoundResult): Record<string, unknown> {
  const harness = result.adoptedHarness;
  return {
    calls: result.record.calls,
    adoptedRun: result.record.adoptedRun,
    directive: `${result.directive.goal} ${result.directive.targetMaterial} via ${result.directive.actionId}`,
    revision: harness.revision,
    procedure: harness.procedure,
    guards: harness.guards.map(
      (guard) => `${guard.effect.kind} ${guard.effect.question}=${guard.effect.label}`,
    ),
    memory: harness.memory.map((fact) => fact.text),
    guidance: harness.guidance.map((item) => `${item.question}.${item.label}: ${item.text}`),
    skills: harness.skills.map((skill) => `${skill.goal}->${skill.actionId}`),
    verdicts: result.rows.map((row) => `${row.change}: ${row.verdict}`),
    lesson: result.entry?.experience?.lesson ?? (result.entry ? "NO_ENTRY" : "none"),
  };
}

// Every agent of this world is due at tick 480 with energy 0.32 and no water, so the routine
// question set is the emergency-water one: goal and targetMaterial each offer one label.
const world = advanceWorld(createInitialWorld(260826081, 0), 480);
const due = dueAgent(world);

async function playRound(
  mode: "parallel" | "sequential",
  k: number,
  options: {
    library?: LibraryEntry[];
    source?: WorldState;
    due?: { agentId: string; decisionTick: number };
    roundId?: string;
  } = {},
): Promise<{ result: RoundResult; wired: Harnessed }> {
  const source = options.source ?? world;
  const focal = options.due ?? due;
  const before = JSON.stringify(source);
  const wired = wireRound(source, focal.agentId, focal.decisionTick, options.library);
  const result = await runImprovementRound(
    {
      roundId: options.roundId ?? `round-${mode}-${k}`,
      agentId: focal.agentId,
      tick: focal.decisionTick,
      condition: source.interactionCondition,
      mode,
      k,
      base: baseHarness(),
      seed: 7,
    },
    wired.deps,
  );
  expectSoundRound(result, wired, source, before, focal);
  return { result, wired };
}

// Rollouts are CPU-bound, and the default 5-second timeout is too tight when the whole suite
// shares the machine.
describe("Harness² round on the real modules", { timeout: 20_000 }, () => {
  it("parallel k=1 on a forced emergency-water decision", async () => {
    const { result, wired } = await playRound("parallel", 1);

    // decide: ref-1, dom-1, succ-1. Clef: Editor (INV drew keep), Composer. The Reflector is
    // skipped because every row is overridden: a forced decision reproduces the reference.
    expect(wired.calls).toEqual({ decide: 3, clef: 2 });
    expect(result.record.calls).toBe(5);
    expect(result.record.candidates.map((candidate) => candidate.run)).toEqual(["dom-1"]);
    expect(result.record.candidates.every((candidate) => candidate.contrast.sameDirective)).toBe(
      true,
    );
    expect(result.rows.map((row) => row.verdict)).toEqual(["no observed effect"]);
    expect(result.directive).toMatchObject({ goal: "gather", targetMaterial: "water" });
    for (const request of wired.decisionRequests)
      expect(Object.keys(request.questions)).toEqual(["controllerAction"]);
    expect(result.record.adoptedRun).toBe("succ-1");
    expect(result.adoptedHarness).toMatchObject({
      revision: 1,
      origin: "adopted",
      roundId: "round-parallel-1",
    });
    expect(result.adoptedHarness.memory).toHaveLength(1);
    expect(result.entry).toMatchObject({ experience: null, visibility: "shared" });
  });

  it("parallel k=2 selects blind over references and successors", async () => {
    const { result, wired } = await playRound("parallel", 2);

    // decide: ref-1+ref-2 (one call), inv-1, dom-1, succ-1; succ-2 composed the same harness and
    // reuses succ-1's execution. Clef: Editor, Composer, selection.
    expect(wired.calls).toEqual({ decide: 4, clef: 3 });
    expect(result.record.calls).toBe(7);
    expect(result.record.compositions.map((composition) => composition.run)).toEqual([
      "succ-1",
      "succ-1",
    ]);
    expect(Object.values(result.record.selection!.anonymousIds).sort()).toEqual([
      "ref-1",
      "ref-2",
      "succ-1",
    ]);
    const selection = wired.stageRequests.find((request) => request.questions.select)!;
    expect(JSON.stringify(selection)).not.toMatch(
      /ref-|succ-|inv-|dom-|In this workspace|Harness procedure|score|grader|rubric/,
    );
    expect(result.record.adoptedRun).toBe(result.record.selection!.chosen);
  });

  it("sequential k=2 chains checkpoints", async () => {
    const { result, wired } = await playRound("sequential", 2);

    // decide: ref-1+ref-2, seq-1-dom, seq-1-ckpt, seq-2-dom, seq-2-ckpt. Clef: an Editor and a
    // Composer per step, then selection.
    expect(wired.calls).toEqual({ decide: 5, clef: 5 });
    expect(result.record.calls).toBe(10);
    expect(result.record.candidates.map((candidate) => candidate.run)).toEqual([
      "seq-1-dom",
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
  });

  it("an open decision reaches the Reflector, and its entry feeds the next round", async () => {
    const open = structuredClone(world);
    const agent = open.agents.find((candidate) => candidate.id === due.agentId)!;
    agent.energy = 0.8;
    agent.inventory.water = 2;

    const first = await playRound("parallel", 1, { source: open, roundId: "round-open-1" });
    // decide: ref-1, inv-1, succ-1. Clef: Editor, Composer, Reflector.
    expect(first.wired.calls).toEqual({ decide: 3, clef: 3 });
    const entry = first.result.entry!;
    expect(entry.experience?.lesson).toMatch(/^Add to procedure: /);
    expect(first.result.rows.map((row) => row.verdict)).toEqual(["helped"]);

    const second = await playRound("parallel", 2, {
      source: open,
      library: [entry],
      roundId: "round-open-2",
    });
    expect(second.wired.deps.libraryIndex).toEqual([
      {
        id: "round-open-1",
        cue: entry.cue,
        lesson: entry.experience!.lesson,
        confidence: entry.experience!.confidence,
      },
    ]);
    expect(second.result.record.candidates.map((candidate) => candidate.edit?.source)).toEqual([
      "library",
      "diagnosis",
    ]);
    expect(second.result.record.candidates[0]!.edit?.libraryEntryId).toBe("round-open-1");
    expect(second.wired.calls).toEqual({ decide: 4, clef: 4 });
  });

  it.each(["full-culture", "no-communication", "no-explicit-culture"] as const)(
    "a %s entry stays readable by its author",
    async (condition: InteractionCondition) => {
      const source =
        condition === "full-culture"
          ? world
          : advanceWorld(createInitialWorld(260826081, 0, condition), 480);
      const focal = dueAgent(source);
      const { result, wired } = await playRound("parallel", 1, { source, due: focal });
      const shared = mechanismsForCondition(condition).skillLibrary;
      const other = source.agents.find((candidate) => candidate.id !== focal.agentId)!.id;
      const read = (agentId: string) =>
        matchLibrary([result.entry!], wired.cue, { condition, agentId, shared });

      expect(read(focal.agentId)).toEqual([result.entry]);
      expect(read(other)).toHaveLength(shared ? 1 : 0);
    },
  );

  it.skipIf(!fs.existsSync(SNAPSHOT_PATH))(
    "runs one round on the live snapshot",
    async () => {
      const live = ensureAgentOperatingSystem(
        JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8")) as WorldState,
      );
      const focal = dueAgent(live);
      const agent = live.agents.find((candidate) => candidate.id === focal.agentId)!;
      const started = Date.now();
      const { result, wired } = await playRound("parallel", 1, { source: live, due: focal });
      console.log(
        `live snapshot round: ${focal.agentId} at tick ${focal.decisionTick}, energy ${agent.energy.toFixed(2)}, water ${agent.inventory.water.toFixed(2)}, cue ${wired.cue}, ${Date.now() - started} ms`,
        adoptedSummary(result),
      );
      expect(result.record.calls).toBeGreaterThanOrEqual(1);
    },
    120_000,
  );
});
