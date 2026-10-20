import { describe, expect, it } from "vite-plus/test";
import {
  advanceWorld,
  createInitialWorld,
  decisionAgentsDue,
  ensureAgentOperatingSystem,
} from "./engine";
import {
  contrastExecutions,
  deliverableSummary,
  executionDigest,
  PROBE_HORIZON_TICKS,
  rolloutDirective,
} from "./harness-probe";
import type { AgentHarness, ExecutionOutcome } from "./harness-types";
import type { AgentDirective, AgentGoal, MaterialKind, WorldState } from "./types";

// Live production snapshot at tick ~400K: every bot is stuck gathering water on depleted
// tidal tiles. Too large (1.2 MB) for a fixture, so its test runs only where it exists.
const SNAPSHOT_PATH = "/Users/stas/.claude/jobs/20600704/tmp/snap.json";
const fs = (await import("node:fs" as string)) as {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
};

const baseHarness: AgentHarness = {
  revision: 0,
  origin: "base",
  procedure: [],
  guards: [],
  memory: [],
  guidance: [],
  skills: [],
};

function directive(goal: AgentGoal, targetMaterial: MaterialKind = "water"): AgentDirective {
  return {
    goal,
    targetMaterial,
    controllerAction: "collect-water",
    note: `${goal} ${targetMaterial}`,
    source: "openrouter",
  };
}

function dueAgent(world: WorldState): { agentId: string; decisionTick: number } {
  while (!decisionAgentsDue(world, world.tick + 1).length) advanceWorld(world, 1);
  return { agentId: decisionAgentsDue(world, world.tick + 1)[0]!.id, decisionTick: world.tick + 1 };
}

const world = advanceWorld(createInitialWorld(260826081, 0), 480);
const { agentId, decisionTick } = dueAgent(world);

function rollout(
  chosen: AgentDirective,
  run: string,
  harness = baseHarness,
  options?: Parameters<typeof rolloutDirective>[6],
) {
  return rolloutDirective(world, agentId, chosen, decisionTick, run, harness, options);
}

function gatheredTotal(outcome: ExecutionOutcome): number {
  return Object.values(outcome.gathered).reduce((sum, value) => sum + value, 0);
}

describe("harness probes", () => {
  it("rolls a decision out on a clone and leaves the source world untouched", () => {
    const before = JSON.stringify(world);
    const record = rollout(directive("gather"), "ref-1", baseHarness, {
      probabilities: { goal: { gather: 0.7, explore: 0.3 } },
      model: "cloudflare/clef-flash",
    });

    expect(JSON.stringify(world)).toBe(before);
    expect(record).toMatchObject({
      run: "ref-1",
      harness: baseHarness,
      probabilities: { goal: { gather: 0.7, explore: 0.3 } },
      model: "cloudflare/clef-flash",
    });
    expect(record.trajectory).toHaveLength(PROBE_HORIZON_TICKS);
    expect(record.trajectory[0]!.tick).toBe(decisionTick);
    expect(record.trajectory.at(-1)!.tick).toBe(decisionTick + PROBE_HORIZON_TICKS - 1);
    expect(record.outcome).toMatchObject({ goal: "gather", actionId: "forage", ticks: 120 });
    expect(record.outcome.successfulPrimitives + record.outcome.failedPrimitives).toBe(120);
    expect(gatheredTotal(record.outcome)).toBeGreaterThan(0);
    expect(record.outcome.producedNothing).toBe(false);
  });

  it("reproduces the same trajectory for the same directive under matched conditions", () => {
    const first = rollout(directive("gather"), "ref-1");
    const second = rollout(directive("gather"), "ref-2");
    const contrast = contrastExecutions([first], second);

    expect(second.trajectory).toEqual(first.trajectory);
    expect(second.outcome).toEqual(first.outcome);
    expect(contrast).toMatchObject({ run: "ref-2", against: ["ref-1"], sameDirective: true });
    expect(contrast.firstDivergenceTick).toBeUndefined();
    expect(Object.values(contrast.deltas).every((delta) => delta === 0)).toBe(true);
    expect(contrast.unsafe).toBe(false);
  });

  it("reports where and by how much two directives diverge", () => {
    const reference = rollout(directive("gather", "water"), "ref-1");
    const candidate = rollout(directive("gather", "fungus"), "dom-1");
    const contrast = contrastExecutions([reference], candidate);

    expect(contrast.sameDirective).toBe(false);
    expect(contrast.firstDivergenceTick).toBeGreaterThanOrEqual(decisionTick);
    expect(contrast.firstDivergenceTick).toBeLessThan(decisionTick + PROBE_HORIZON_TICKS);
    expect(Object.keys(contrast.deltas).sort()).toEqual(
      [
        "builds",
        "crafts",
        "energyEnd",
        "energyMin",
        "failedPrimitives",
        "gatheredTotal",
        "inspections",
        "pathLength",
        "reboots",
        "repairs",
        "successfulPrimitives",
      ].sort(),
    );
    expect(contrast.deltas.gatheredTotal).not.toBe(0);
    expect(contrast.deltas.energyEnd).not.toBe(0);
    expect(contrast.moments[0]).toMatchObject({ run: "dom-1", tick: contrast.firstDivergenceTick });
    expect(contrast.moments.length).toBeLessThanOrEqual(4);
    expect(contrast.unsafe).toBe(false);
  });

  it("marks a candidate unsafe when it produces nothing while a reference gathers", () => {
    const reference = rollout(directive("gather"), "ref-1");
    const candidate = rollout(directive("explore"), "inv-1");
    const contrast = contrastExecutions([reference], candidate);

    expect(candidate.outcome.producedNothing).toBe(true);
    expect(contrast.unsafe).toBe(true);
    expect(contrast.deltas.gatheredTotal).toBeCloseTo(-gatheredTotal(reference.outcome), 2);
    expect(contrast.moments.some((moment) => moment.run === "ref-1")).toBe(true);
    expect(contrastExecutions([candidate], reference).unsafe).toBe(false);
  });

  it("marks a candidate unsafe when it reboots while no reference does", () => {
    const options = { horizon: 300 };
    const reference = rollout(directive("gather"), "ref-1", baseHarness, options);
    const candidate = rollout(directive("explore"), "inv-1", baseHarness, options);
    const contrast = contrastExecutions([reference], candidate);

    expect(reference.outcome.reboots).toBe(0);
    expect(candidate.outcome).toMatchObject({ reboots: 1, energyMin: 0, producedNothing: true });
    expect(contrast.unsafe).toBe(true);
    expect(contrast.deltas.reboots).toBe(1);
    expect(contrast.moments.some((moment) => moment.text === "inv-1 rebooted")).toBe(true);
  });

  it("detects a repeated directive by goal, material, action and hold, ignoring the note", () => {
    const reference = rollout(directive("gather"), "ref-1");
    const same = (changes: Partial<AgentDirective> & { holdMacroturns?: number }) =>
      contrastExecutions([reference], {
        ...reference,
        run: "inv-1",
        directive: { ...reference.directive, ...changes },
      }).sameDirective;

    expect(same({ note: "different words, same activity", source: "instinct" })).toBe(true);
    expect(same({ targetMaterial: "fungus" })).toBe(false);
    expect(same({ goal: "explore" })).toBe(false);
    expect(same({ actionId: "forage" })).toBe(false);
    expect(same({ holdMacroturns: 2 })).toBe(false);
  });

  it("summarizes the deliverable without the run id or any harness content", () => {
    const harness: AgentHarness = {
      revision: 4,
      origin: "adopted",
      roundId: "round-A005-481",
      adoptedTick: 481,
      procedure: ["Refill carried water before any long survey walk."],
      guards: [
        {
          id: "guard-low-energy-refill",
          when: { all: [{ feature: "energy", op: "<", value: 0.3 }] },
          effect: { kind: "require", question: "goal", label: "gather" },
          note: "Low energy forces a refill first",
        },
      ],
      memory: [
        {
          id: "fact-tidal-spring",
          kind: "resource",
          text: "In this workspace a viable tidal spring sits at 30,40",
          x: 30,
          y: 40,
          material: "water",
          verifiedTick: 480,
        },
      ],
      guidance: [
        {
          id: "guidance-spring",
          question: "targetMaterial",
          label: "water",
          text: "Prefer the verified spring north of camp",
        },
      ],
      skills: [
        {
          id: "skill-spring-forage",
          when: { all: [] },
          goal: "gather",
          actionId: "forage",
          note: "Forage beside verified springs",
        },
      ],
    };
    const record = rollout(directive("gather"), "succ-7", harness);
    const summary = deliverableSummary(record.outcome);

    expect(record.harness).toBe(harness);
    expect(summary).toMatch(/^gather water activity over 120 ticks; produced .*gathered/);
    expect(summary.length).toBeLessThanOrEqual(300);
    for (const text of [
      "succ-7",
      harness.roundId!,
      ...harness.procedure,
      ...harness.guards.flatMap((guard) => [guard.id, guard.note]),
      ...harness.memory.flatMap((fact) => [fact.id, fact.text]),
      ...harness.guidance.flatMap((item) => [item.id, item.text]),
      ...harness.skills.flatMap((skill) => [skill.id, skill.note]),
    ])
      expect(summary).not.toContain(text);

    const crowded: ExecutionOutcome = {
      ...record.outcome,
      gathered: { water: 3.456, fungus: 2.5, mineral: 1.25, cellulose: 4, chitin: 0.75 },
      builds: 2,
      crafts: 1,
      inspections: 14,
      repairs: 9,
      reboots: 2,
      commitment: `${"Very Long Creative Action Name ".repeat(8)}: missing chitin`,
    };
    expect(deliverableSummary(crowded).length).toBeLessThanOrEqual(300);
    expect(deliverableSummary(rollout(directive("explore"), "inv-1").outcome)).toContain(
      "produced nothing",
    );
  });

  it("digests an execution for Clef with its run, directive, counts, and first moments", () => {
    const record = rollout(directive("gather"), "ref-1");
    const digest = executionDigest(record);
    const firstFailure = record.trajectory.find((step) =>
      step.result.endsWith("precondition failed"),
    )!;
    const firstGather = record.trajectory.find(
      (step) => step.result === "gathered local material",
    )!;

    expect(digest.length).toBeLessThanOrEqual(400);
    expect(digest).toMatch(/^ref-1: chose gather water, ran gather via forage; /);
    expect(digest).toContain(`over T${firstFailure.tick}-`);
    expect(digest).toContain(`first production T${firstGather.tick}: gathered local material`);
    expect(executionDigest({ ...record, run: "x".repeat(500) }).length).toBe(400);
  });

  it("refuses to probe an agent whose decision is not due at that tick", () => {
    const before = JSON.stringify(world);

    expect(() =>
      rolloutDirective(world, agentId, directive("gather"), decisionTick + 1, "ref-1", baseHarness),
    ).toThrow(/no decision due/);
    expect(() =>
      rolloutDirective(world, "A999", directive("gather"), decisionTick, "ref-1", baseHarness),
    ).toThrow(/no decision due/);
    expect(JSON.stringify(world)).toBe(before);
  });

  it.skipIf(!fs.existsSync(SNAPSHOT_PATH))(
    "probes the live stuck-on-water world without mutating it",
    () => {
      const live = ensureAgentOperatingSystem(
        JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8")) as WorldState,
      );
      const due = dueAgent(live);
      const before = JSON.stringify(live);
      const probe = (chosen: AgentDirective, run: string) =>
        rolloutDirective(live, due.agentId, chosen, due.decisionTick, run, baseHarness);
      const reference = probe(directive("gather"), "ref-1");
      const replay = probe(directive("gather"), "ref-2");
      const survey = probe(directive("explore"), "inv-1");
      const contrast = contrastExecutions([reference, replay], survey);

      expect(JSON.stringify(live)).toBe(before);
      expect(replay.trajectory).toEqual(reference.trajectory);
      expect(reference.outcome.failuresByPrimitive["gather-local"]).toBeGreaterThan(30);
      expect(gatheredTotal(reference.outcome)).toBeLessThan(1);
      expect(contrast.sameDirective).toBe(false);
      expect(contrast.firstDivergenceTick).toBeGreaterThanOrEqual(due.decisionTick);
      expect(contrast.unsafe).toBe(
        survey.outcome.producedNothing && !reference.outcome.producedNothing,
      );
    },
    30_000,
  );
});
