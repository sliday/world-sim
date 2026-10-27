// Probes for Harness² (arXiv 2610.14224): deterministic rollouts of one decision on a cloned
// world, behavioural contrasts between them, and the texts later stages read.
import { advanceWorld, applyDirective, missingCraftingMaterial } from "./engine";
import type {
  AgentHarness,
  BehavioralContrast,
  EvidenceMoment,
  ExecutionOutcome,
  ExecutionRecord,
  TrajectoryStep,
} from "./harness-types";
import {
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type AgentDirective,
  type Inventory,
  type MaterialKind,
  type WorldState,
} from "./types";

export const PROBE_HORIZON_TICKS = 120;

/** The hold count is compared when a directive carries one. */
type HeldDirective = AgentDirective & { holdMacroturns?: number };

const materials: readonly MaterialKind[] = ["water", "fungus", "mineral", "cellulose", "chitin"];
const productiveResults = new Set([
  "gathered local material",
  "constructed an artifact",
  "inspected an artifact",
  "maintained an artifact",
  "crafted a known action",
  "built a novel action",
]);
const deltaKeys = [
  "energyEnd",
  "energyMin",
  "reboots",
  "gatheredTotal",
  "builds",
  "crafts",
  "inspections",
  "repairs",
  "failedPrimitives",
  "successfulPrimitives",
  "pathLength",
] as const;

function failedPrimitive(result: string): string | undefined {
  if (result === "activity has no bounded primitives") return "empty-program";
  return result.endsWith(" precondition failed")
    ? result.slice(0, -" precondition failed".length)
    : undefined;
}

function region(position: { x: number; y: number }): string {
  return `${Math.floor((position.x / WORLD_WIDTH) * 10)}:${Math.floor((position.y / WORLD_HEIGHT) * 10)}`;
}

function total(inventory: Inventory): number {
  return materials.reduce((sum, material) => sum + inventory[material], 0);
}

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function amount(value: number): string {
  return String(round(value, 2));
}

export function rolloutDirective(
  world: WorldState,
  agentId: string,
  directive: AgentDirective,
  decisionTick: number,
  run: string,
  harness: AgentHarness,
  options: {
    horizon?: number;
    probabilities?: Record<string, Record<string, number>>;
    model?: string;
  } = {},
): ExecutionRecord {
  const state = structuredClone(world);
  const agent = state.agents.find((candidate) => candidate.id === agentId);
  if (agent?.nextDecisionTick !== decisionTick)
    throw new Error(`Probe agent ${agentId} has no decision due at tick ${decisionTick}`);
  if (!applyDirective(state, agentId, directive, false, decisionTick))
    throw new Error(`Probe directive for ${agentId} could not be committed`);
  const horizon = options.horizon ?? PROBE_HORIZON_TICKS;
  const { goal, targetMaterial } = agent.directive;
  const actionId = agent.script.actionId;
  const energyStart = agent.energy;
  const pathStart = agent.trajectory.pathLength;
  const buildsStart = agent.builds;
  const craftsStart = agent.crafts;
  const committed = Boolean(agent.craftingTarget);
  const gathered: Inventory = { water: 0, fungus: 0, mineral: 0, cellulose: 0, chitin: 0 };
  const failuresByPrimitive: Record<string, number> = {};
  const trajectory: TrajectoryStep[] = [];
  const events: string[] = [];
  const regions = new Set([region(agent)]);
  let energyMin = energyStart;
  let reboots = 0;
  let inspections = 0;
  let repairs = 0;
  let failed = 0;
  for (let step = 0; step < horizon; step += 1) {
    const before = { ...agent.inventory };
    const energyBefore = agent.energy;
    const head = state.events[0];
    advanceWorld(state, 1);
    const seen = state.events.indexOf(head);
    for (const event of state.events.slice(0, seen < 0 ? undefined : seen).reverse())
      if (events.length < 8 && event.text.startsWith(`${agent.name} `)) events.push(event.text);
    // A reboot resets energy to 0.42. Its event can fall off the engine's 28-event list when
    // many agents reboot in the same tick, so the reset itself is the record.
    const rebooted = agent.energy - energyBefore > 0.2;
    if (rebooted) reboots += 1;
    for (const material of materials) {
      const change = agent.inventory[material] - before[material];
      if (change > 0) gathered[material] += change;
    }
    const result = agent.script.lastResult;
    const primitive = failedPrimitive(result);
    if (primitive) {
      failed += 1;
      failuresByPrimitive[primitive] = (failuresByPrimitive[primitive] ?? 0) + 1;
    }
    if (result === "inspected an artifact") inspections += 1;
    if (result === "maintained an artifact") repairs += 1;
    energyMin = Math.min(energyMin, rebooted ? 0 : agent.energy);
    regions.add(region(agent));
    trajectory.push({
      tick: state.tick,
      x: agent.x,
      y: agent.y,
      energy: agent.energy,
      mode: agent.mode,
      result,
    });
  }
  const builds = agent.builds - buildsStart;
  const crafts = agent.crafts - craftsStart;
  const target = agent.craftingTarget;
  const missing = missingCraftingMaterial(agent);
  const commitment = target
    ? `${target.actionName}: ${missing ? `missing ${missing}` : "ingredients ready"}`
    : committed
      ? crafts > 0
        ? "completed"
        : "ended without a new action"
      : undefined;
  return {
    run,
    harness,
    directive,
    probabilities: options.probabilities,
    model: options.model,
    outcome: {
      goal,
      targetMaterial,
      actionId,
      ticks: horizon,
      energyStart,
      energyEnd: agent.energy,
      energyMin,
      reboots,
      gathered,
      builds,
      crafts,
      inspections,
      repairs,
      successfulPrimitives: horizon - failed,
      failedPrimitives: failed,
      failuresByPrimitive,
      pathLength: agent.trajectory.pathLength - pathStart,
      regionsVisited: regions.size,
      commitment,
      producedNothing:
        reboots > 0 || (total(gathered) === 0 && builds + crafts + inspections + repairs === 0),
      events,
    },
    trajectory,
  };
}

function sameDirective(a: HeldDirective, b: HeldDirective): boolean {
  return (
    a.goal === b.goal &&
    a.targetMaterial === b.targetMaterial &&
    a.controllerAction === b.controllerAction &&
    a.actionId === b.actionId &&
    a.holdMacroturns === b.holdMacroturns
  );
}

function measures(outcome: ExecutionOutcome): Record<(typeof deltaKeys)[number], number> {
  return { ...outcome, gatheredTotal: total(outcome.gathered) };
}

function firstProduction(record: ExecutionRecord): TrajectoryStep | undefined {
  return record.trajectory.find((step) => productiveResults.has(step.result));
}

function firstFailureStreak(
  record: ExecutionRecord,
): { from: TrajectoryStep; to: TrajectoryStep; primitive: string; failures: number } | undefined {
  const { trajectory } = record;
  const start = trajectory.findIndex((step) => failedPrimitive(step.result));
  if (start < 0) return undefined;
  const stop = trajectory.findIndex(
    (step, index) => index > start && productiveResults.has(step.result),
  );
  const span = trajectory.slice(start, stop < 0 ? undefined : stop);
  return {
    from: span[0]!,
    to: span.at(-1)!,
    primitive: failedPrimitive(span[0]!.result)!,
    failures: span.filter((step) => failedPrimitive(step.result)).length,
  };
}

function firstReboot(record: ExecutionRecord): TrajectoryStep | undefined {
  if (!record.outcome.reboots) return undefined;
  return record.trajectory.find(
    (step, index) =>
      step.energy - (record.trajectory[index - 1]?.energy ?? record.outcome.energyStart) > 0.2,
  );
}

function streakText(record: ExecutionRecord): string | undefined {
  const streak = firstFailureStreak(record);
  return (
    streak &&
    `${streak.primitive} failed ${streak.failures}x over T${streak.from.tick}-T${streak.to.tick} before any production`
  );
}

function stepText(step: TrajectoryStep): string {
  return `${step.mode} at ${step.x},${step.y} (${step.result})`;
}

export function contrastExecutions(
  references: ExecutionRecord[],
  candidate: ExecutionRecord,
): BehavioralContrast {
  const reference = references[0];
  if (!reference) throw new Error("A behavioral contrast needs at least one reference");
  const own = measures(candidate.outcome);
  const baseline = references.map((record) => measures(record.outcome));
  const deltas = Object.fromEntries(
    deltaKeys.map((key) => [
      key,
      round(own[key] - baseline.reduce((sum, row) => sum + row[key], 0) / baseline.length),
    ]),
  );
  const divergence = candidate.trajectory.findIndex((step, index) => {
    const other = reference.trajectory[index];
    return !other || other.x !== step.x || other.y !== step.y || other.mode !== step.mode;
  });
  const delivered = references.find((record) => !record.outcome.producedNothing);
  const unsafe =
    (candidate.outcome.producedNothing && Boolean(delivered)) ||
    (candidate.outcome.reboots > 0 && references.every((record) => record.outcome.reboots === 0));
  const moments: EvidenceMoment[] = [];
  const divergent = candidate.trajectory[divergence];
  if (divergent) {
    const other = reference.trajectory[divergence];
    moments.push({
      run: candidate.run,
      tick: divergent.tick,
      text: `${candidate.run} ${stepText(divergent)}; ${reference.run} ${other ? stepText(other) : "had ended"}`,
    });
  }
  const reboot = firstReboot(candidate);
  if (reboot)
    moments.push({ run: candidate.run, tick: reboot.tick, text: `${candidate.run} rebooted` });
  const production = firstProduction(candidate);
  if (production)
    moments.push({
      run: candidate.run,
      tick: production.tick,
      text: `${candidate.run} first ${production.result}`,
    });
  else if (delivered) {
    const step = firstProduction(delivered);
    if (step)
      moments.push({
        run: delivered.run,
        tick: step.tick,
        text: `${delivered.run} ${step.result} while ${candidate.run} produced nothing`,
      });
  }
  const streak = firstFailureStreak(candidate);
  if (streak)
    moments.push({ run: candidate.run, tick: streak.from.tick, text: streakText(candidate)! });
  const referenceReboot = reboot ? undefined : references.find(firstReboot);
  if (referenceReboot) {
    const step = firstReboot(referenceReboot)!;
    moments.push({
      run: referenceReboot.run,
      tick: step.tick,
      text: `${referenceReboot.run} rebooted; ${candidate.run} did not`,
    });
  }
  return {
    run: candidate.run,
    against: references.map((record) => record.run),
    sameDirective: references.some((record) =>
      sameDirective(record.directive, candidate.directive),
    ),
    firstDivergenceTick: divergent?.tick,
    deltas,
    moments: moments.slice(0, 4),
    unsafe,
  };
}

export function deliverableSummary(outcome: ExecutionOutcome): string {
  const products = [
    ...materials
      .filter((material) => outcome.gathered[material] > 0)
      .map((material) => `${amount(outcome.gathered[material])} ${material} gathered`),
    outcome.builds && `${outcome.builds} artifact${outcome.builds === 1 ? "" : "s"} built`,
    outcome.crafts && `${outcome.crafts} action${outcome.crafts === 1 ? "" : "s"} crafted`,
    outcome.inspections && `${outcome.inspections} artifact inspections`,
    outcome.repairs && `${outcome.repairs} artifact repairs`,
  ].filter(Boolean);
  return [
    `${outcome.goal} ${outcome.targetMaterial} activity over ${outcome.ticks} ticks`,
    products.length ? `produced ${products.join(", ")}` : "produced nothing",
    `energy ${amount(outcome.energyStart)} to ${amount(outcome.energyEnd)}${outcome.reboots ? `, rebooted ${outcome.reboots}x` : ""}`,
    outcome.commitment && `commitment ${outcome.commitment}`,
  ]
    .filter(Boolean)
    .join("; ")
    .slice(0, 300);
}

export function executionDigest(record: ExecutionRecord): string {
  const { outcome } = record;
  const directive: HeldDirective = record.directive;
  const gathered = materials
    .filter((material) => outcome.gathered[material] > 0)
    .map((material) => `${amount(outcome.gathered[material])} ${material}`);
  const production = firstProduction(record);
  return [
    `${record.run}: chose ${directive.goal} ${directive.targetMaterial}${directive.actionId ? ` via ${directive.actionId}` : ""}${directive.holdMacroturns ? ` hold ${directive.holdMacroturns}` : ""}, ran ${outcome.goal} via ${outcome.actionId}`,
    `gathered ${gathered.length ? gathered.join(", ") : "0"}, built ${outcome.builds}, crafted ${outcome.crafts}, inspected ${outcome.inspections}, repaired ${outcome.repairs}`,
    `${outcome.failedPrimitives}/${outcome.ticks} primitives failed, ${outcome.reboots} reboots, energy ${amount(outcome.energyStart)}->${amount(outcome.energyEnd)} min ${amount(outcome.energyMin)}, path ${amount(outcome.pathLength)}`,
    streakText(record) ?? "no failed primitive",
    production ? `first production T${production.tick}: ${production.result}` : "no production",
  ]
    .join("; ")
    .slice(0, 400);
}
