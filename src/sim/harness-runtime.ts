// Production wiring of a Harness² round (Xu et al., arXiv 2610.14224) on the routine Clef
// decision, plus the pure scheduling rules the Worker applies around it.
import {
  CLEF_MODEL,
  directiveFromSelection,
  prepareClefDecision,
  type ClefHarnessOptions,
} from "./clef-decisions";
import { decisionObservation, mechanismsForCondition } from "./engine";
import {
  applyEdits,
  applySkillTriggers,
  baseHarness,
  harnessSignature,
  situationCue,
  situationFeatures,
  validateHarness,
} from "./harness";
import { proposeCandidateEdits } from "./harness-diagnose";
import { sampleChoice, type RoundDeps } from "./harness-improver";
import { libraryIndex, matchLibrary } from "./harness-library";
import {
  contrastExecutions,
  deliverableSummary,
  executionDigest,
  rolloutDirective,
} from "./harness-probe";
import type {
  AgentHarness,
  ClefClient,
  EditVerdict,
  HarnessComponent,
  LibraryEntry,
  RoundResult,
  SituationFeatures,
} from "./harness-types";
import { Rng } from "./rng";
import type { Agent, WorldState } from "./types";

/* ---------- Round wiring ---------- */

export interface RoundWiring {
  world: WorldState;
  agentId: string;
  /** The agent's scheduled decision tick, one past `world.tick`. */
  decisionTick: number;
  /** Transport for the improver's stages: Editor, Composer, selection, Reflector. */
  clef: ClefClient;
  /** Transport for decide() (references, probes, successors); defaults to `clef`. */
  decisionClef?: ClefClient;
  /** The state a routine decision sends. Defaults to the agent's observation at decisionTick. */
  observation?: Record<string, unknown>;
  /** Library rows of this world's interaction condition. Visibility is filtered here. */
  library?: LibraryEntry[];
}

export interface WiredRound {
  deps: RoundDeps;
  cue: string;
  features: SituationFeatures;
  /** Library rows this agent may read for its cue. */
  visible: LibraryEntry[];
}

// Draw order within one sampled directive. Hold lengths are drawn after every directive's
// activity, so whether the hold question is open (it closes on low reserves or under a guard)
// never shifts the activity draws that common random numbers keep aligned across harnesses.
const ACTIVITY_ORDER = ["goal", "targetMaterial", "actionId", "controllerAction", "craftActionId"];
const HOLD = "holdMacroturns";

/** Wires the real modules into runImprovementRound: decide() asks the routine question set
 * under a harness, and rollouts run on clones of `world` at `decisionTick`. */
export function createRoundDeps(wiring: RoundWiring): WiredRound {
  const { world, agentId, decisionTick, clef } = wiring;
  const agent = world.agents.find((candidate) => candidate.id === agentId);
  if (!agent) throw new Error(`Harness round needs a live agent; ${agentId} is missing`);
  const features = situationFeatures(world, agent);
  const cue = situationCue(features);
  const knownActionIds = [...agent.knownActionIds];
  const observation = wiring.observation ?? {
    ...decisionObservation(world, agent),
    scheduledDecisionTick: decisionTick,
  };
  const visible = matchLibrary(wiring.library ?? [], cue, {
    condition: world.interactionCondition,
    agentId,
    shared: mechanismsForCondition(world.interactionCondition).skillLibrary,
  });
  const decisionClef = wiring.decisionClef ?? clef;
  const deps: RoundDeps = {
    clef,
    cue,
    knownActionIds,
    libraryIndex: libraryIndex(visible),
    async decide(harness, draws, seed) {
      const options: ClefHarnessOptions = { harness, features, knownActionIds };
      const { state, asked, fixed, emergencyWater } = prepareClefDecision(observation, options);
      const response = Object.keys(asked).length
        ? await decisionClef.decide(state, asked)
        : { answers: {}, model: CLEF_MODEL, cost: 0 };
      const rng = new Rng(seed);
      const draw = (id: string) =>
        sampleChoice(response.answers[id]!, Object.keys(asked[id]!.criteria), rng);
      const activity = [
        ...ACTIVITY_ORDER.filter((id) => Object.hasOwn(asked, id)),
        ...Object.keys(asked).filter((id) => id !== HOLD && !ACTIVITY_ORDER.includes(id)),
      ];
      const selections = Array.from({ length: draws }, () => {
        const selected = { ...fixed };
        for (const id of activity) selected[id] = draw(id);
        return selected;
      });
      if (Object.hasOwn(asked, HOLD))
        for (const selected of selections) selected[HOLD] = draw(HOLD);
      const directives = selections.map((selected) => {
        const directive = directiveFromSelection(
          observation,
          selected,
          emergencyWater,
          response.model,
        );
        return applySkillTriggers(directive, harness, features, knownActionIds);
      });
      return {
        directives,
        probabilities: Object.fromEntries(
          Object.entries(response.answers).map(([id, answer]) => [id, answer.probabilities]),
        ),
        model: response.model,
        cost: response.cost,
      };
    },
    rollout: (directive, run, harness, probabilities) =>
      rolloutDirective(world, agentId, directive, decisionTick, run, harness, { probabilities }),
    contrast: contrastExecutions,
    deliverableSummary,
    executionDigest,
    // Sequential steps diagnose the checkpoints and probes in the history too. A history run
    // that repeated an earlier directive would count the same failure twice, so only history
    // runs with a new directive join the references.
    propose: (references, history) =>
      proposeCandidateEdits({
        world,
        agentId,
        features,
        references: history.reduce(
          (runs, record) =>
            contrastExecutions(runs, record).sameDirective ? runs : [...runs, record],
          references,
        ),
        library: visible,
        base: baseHarness(),
        knownActionIds,
      }),
    applyEdits,
    validate: (harness) => validateHarness(harness, { knownActionIds }),
    signature: harnessSignature,
  };
  return { deps, cue, features, visible };
}

/** A round can change a decision only when Clef still chooses the goal: after the harness and
 * the forced-choice rules, the goal question keeps at least two options. In the emergency-water
 * state the goal and material are forced, so a round there could change nothing. */
export function decisionIsOpen(
  observation: Record<string, unknown>,
  options?: ClefHarnessOptions,
): boolean {
  return Object.hasOwn(prepareClefDecision(observation, options).asked, "goal");
}

/** Among due agents with an open decision: agents without a harness first, then the oldest
 * adoption, then id. */
export function pickRoundAgent<T extends Pick<Agent, "id" | "harness">>(
  due: readonly T[],
  isOpen: (agent: T) => boolean,
): T | undefined {
  return due
    .filter(isOpen)
    .sort(
      (a, b) =>
        Number(a.harness !== undefined) - Number(b.harness !== undefined) ||
        (a.harness?.adoptedTick ?? -1) - (b.harness?.adoptedTick ?? -1) ||
        a.id.localeCompare(b.id),
    )[0];
}

/* ---------- Worker configuration and scheduling ---------- */

export interface HarnessConfig {
  enabled: boolean;
  /** Candidates per scope and compositions (parallel) or chained steps (sequential). */
  k: number;
  mode: "parallel" | "sequential";
  intervalTicks: number;
}

export interface HarnessEnv {
  HARNESS_LEARNING?: string;
  HARNESS_K?: string;
  HARNESS_MODE?: string;
  HARNESS_ROUND_INTERVAL_TICKS?: string;
}

/** A round costs at most 28 calls (sequential, k = 5); the margin covers it and the tick's
 * routine decisions. */
export const ROUND_MIN_REMAINING_CALLS = 40;

/** A whole number from an env string: anything else, or a value below `min`, falls back, and a
 * value above `max` is capped. */
function boundedInteger(value: string | undefined, fallback: number, min: number, max: number) {
  if (!/^\s*\d+\s*$/u.test(value ?? "")) return fallback;
  const parsed = Number(value);
  return parsed < min ? fallback : Math.min(max, parsed);
}

export function harnessConfig(env: HarnessEnv): HarnessConfig {
  return {
    enabled: env.HARNESS_LEARNING?.trim() === "true",
    k: boundedInteger(env.HARNESS_K, 1, 1, 5),
    mode: env.HARNESS_MODE?.trim() === "sequential" ? "sequential" : "parallel",
    intervalTicks: boundedInteger(env.HARNESS_ROUND_INTERVAL_TICKS, 60, 1, 1_000_000),
  };
}

export interface RoundGate {
  config: HarnessConfig;
  /** The candidate tick the Worker is deciding for. */
  tick: number;
  nextRoundTick: number;
  callsToday: number;
  dailyLimit: number;
  decisionBlockedUntil?: number;
  now: number;
}

/** Why no round runs on this tick, or undefined when one is due and affordable. */
export function roundSkipReason(gate: RoundGate): string | undefined {
  if (!gate.config.enabled) return "learning disabled";
  if (gate.tick < gate.nextRoundTick) return `next round at T${gate.nextRoundTick}`;
  if ((gate.decisionBlockedUntil ?? 0) > gate.now) return "Clef decisions are on cooldown";
  if (gate.dailyLimit - gate.callsToday < ROUND_MIN_REMAINING_CALLS)
    return `fewer than ${ROUND_MIN_REMAINING_CALLS} daily model calls remain`;
  return undefined;
}

export function harnessRoundId(tick: number, agentId: string): string {
  return `round-${tick}-${agentId}`;
}

/** FNV-1a over the world seed, agent id and tick: the same round replays the same draws. */
export function roundSeed(worldSeed: number, agentId: string, tick: number): number {
  let hash = 0x811c9dc5;
  for (const char of `${worldSeed}:${agentId}:${tick}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/* ---------- Adoption and reporting ---------- */

/** The harness the agent keeps for routine macroturns until its next round. Every round starts
 * from H0, so a round that kept the base harness resets the agent to H0. The revision counts
 * this agent's adoptions. */
export function adoptedAgentHarness(
  previous: AgentHarness | undefined,
  result: RoundResult,
  tick: number,
): AgentHarness {
  return {
    ...structuredClone(result.adoptedHarness),
    roundId: result.record.roundId,
    adoptedTick: tick,
    revision: (previous?.revision ?? 0) + 1,
  };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function harnessEventText(name: string, result: RoundResult): string {
  if (result.adoptedHarness.origin !== "adopted") return `${name} kept its base harness`;
  const edits = result.entry?.edits ?? [];
  const changes = edits.length
    ? edits.map((edit) => `${edit.op} ${edit.component}: ${edit.summary}`).join("; ")
    : "adopted a revised harness";
  return clip(`${name} refined its harness: ${changes}`, 160);
}

export function harnessComponentCounts(harness: AgentHarness): Record<HarnessComponent, number> {
  return {
    procedure: harness.procedure.length,
    guards: harness.guards.length,
    memory: harness.memory.length,
    guidance: harness.guidance.length,
    skills: harness.skills.length,
  };
}

export function harnessComponentLines(harness: AgentHarness): string[] {
  return [
    ...harness.procedure.map((line) => `procedure: ${line}`),
    ...harness.guards.map(
      (guard) => `guard: ${guard.effect.kind} ${guard.effect.question}=${guard.effect.label}`,
    ),
    ...harness.memory.map((fact) => `memory: ${fact.text}`),
    ...harness.guidance.map((item) => `guidance: ${item.question}.${item.label}: ${item.text}`),
    ...harness.skills.map((skill) => `skill: ${skill.goal}->${skill.actionId}`),
  ].map((line) => clip(line, 160));
}

/** The compact round record the Worker keeps in SQLite and serves from /api/harness. */
export interface HarnessRoundRow {
  roundId: string;
  tick: number;
  agentId: string;
  agentName: string;
  cue: string;
  mode: HarnessConfig["mode"];
  k: number;
  adoptedRun?: string;
  adoptedComponents: string[];
  verdicts: Array<{ editId: string; component: string; change: string; verdict: EditVerdict }>;
  /** The Reflector's lesson, or NO_ENTRY. */
  lesson: string;
  calls: number;
  cost: number;
  fallbacks: string[];
  error?: string;
}

export function harnessRoundRow(
  result: RoundResult,
  agentName: string,
  config: Pick<HarnessConfig, "mode" | "k">,
): HarnessRoundRow {
  const { record } = result;
  return {
    roundId: record.roundId,
    tick: record.tick,
    agentId: record.agentId,
    agentName,
    cue: record.cue,
    mode: config.mode,
    k: config.k,
    adoptedRun: record.adoptedRun,
    adoptedComponents: harnessComponentLines(result.adoptedHarness),
    verdicts: result.rows.map((row) => ({
      editId: row.editId,
      component: row.component,
      change: clip(row.change, 200),
      verdict: row.verdict,
    })),
    lesson: result.entry?.experience?.lesson ?? "NO_ENTRY",
    calls: record.calls,
    cost: record.cost,
    fallbacks: record.fallbacks.map((fallback) => clip(fallback, 200)),
  };
}

export function failedHarnessRoundRow(input: {
  roundId: string;
  tick: number;
  agentId: string;
  agentName: string;
  cue: string;
  config: Pick<HarnessConfig, "mode" | "k">;
  calls: number;
  cost: number;
  error: string;
}): HarnessRoundRow {
  return {
    roundId: input.roundId,
    tick: input.tick,
    agentId: input.agentId,
    agentName: input.agentName,
    cue: input.cue,
    mode: input.config.mode,
    k: input.config.k,
    adoptedComponents: [],
    verdicts: [],
    lesson: "NO_ENTRY",
    calls: input.calls,
    cost: input.cost,
    fallbacks: [],
    error: clip(input.error, 200),
  };
}
