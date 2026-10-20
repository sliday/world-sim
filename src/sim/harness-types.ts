// Shared contract for recursive agent harnessing (Harness², arXiv 2610.14224).
// Types only: every module that implements a stage codes against these shapes.
import type {
  AgentDirective,
  AgentGoal,
  AgentMode,
  InteractionCondition,
  Inventory,
  MaterialKind,
  Station,
  TerrainKind,
} from "./types";

/* ---------- Clef transport ---------- */

export interface DecisionQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface DecisionAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface DecisionResponse {
  answers: Record<string, DecisionAnswer>;
  model: string;
  cost: number;
}

/** One validated call to the OpenRouter Decisions API. Questions with fewer than two
 * options must never reach it; callers resolve those locally. */
export interface ClefClient {
  decide(
    state: Record<string, unknown>,
    questions: Record<string, DecisionQuestion>,
  ): Promise<DecisionResponse>;
}

/* ---------- Situation ---------- */

/** Deterministic features of one agent at decision time, read from the world, never from
 * model output. Harness conditions and library cues are evaluated against these. */
export interface SituationFeatures {
  tick: number;
  energy: number;
  curiosity: number;
  inventory: Inventory;
  localTerrain: TerrainKind;
  localRichness: number;
  localMoisture: number;
  localContamination: number;
  hasCommitment: boolean;
  /** Material the agent could build with right now, if any. */
  buildReady?: MaterialKind;
  /** Distance in tiles to the nearest viable (richness >= 0.12) tile of each material. */
  nearestViable: Partial<Record<MaterialKind, number>>;
  /** Distance in tiles to the nearest processing station of each kind. */
  nearestStation: Partial<Record<Station["kind"], number>>;
  visibleArtifacts: number;
}

export type HarnessNumericFeature =
  | "energy"
  | "curiosity"
  | "localRichness"
  | "localMoisture"
  | "localContamination"
  | `inventory.${MaterialKind}`
  | `nearestViable.${MaterialKind}`;

export type HarnessClause =
  | { feature: HarnessNumericFeature; op: "<" | ">="; value: number }
  | { feature: "localTerrain"; op: "in"; value: TerrainKind[] }
  | { feature: "hasCommitment"; op: "="; value: boolean }
  | { feature: "buildReady"; op: "="; value: boolean };

/** Conjunction of clauses. An empty list always holds. */
export interface HarnessCondition {
  all: HarnessClause[];
}

/* ---------- Execution harness H (Table 5 of the paper, mapped to this world) ---------- */

/** C2 guardrails + C8 plugin: enforced in code before the request, outside model discretion.
 * forbid removes `label` from `question` while `when` holds (never below one option).
 * require restricts `question` to `label` while `when` holds (resolved locally). */
export interface HarnessGuard {
  id: string;
  when: HarnessCondition;
  effect: { kind: "forbid" | "require"; question: string; label: string };
  note: string;
}

/** C3 memory: a workspace fact verified against the world, anchored to a place and tick. */
export interface HarnessFact {
  id: string;
  kind: "resource" | "depleted" | "station" | "hazard" | "artifact";
  text: string;
  x: number;
  y: number;
  material?: MaterialKind;
  stationKind?: Station["kind"];
  verifiedTick: number;
}

/** C4 tool guidance: replaces the criteria text of one option of one question. */
export interface HarnessGuidance {
  id: string;
  question: string;
  label: string;
  text: string;
}

/** C6 skills: when `when` holds and Clef picks `goal`, run the known learned action
 * `actionId` instead of the built-in activity. */
export interface HarnessSkillTrigger {
  id: string;
  when: HarnessCondition;
  goal: AgentGoal;
  actionId: string;
  note: string;
}

export const HARNESS_LIMITS = {
  procedureLines: 3,
  procedureLineChars: 160,
  guards: 6,
  memory: 6,
  factChars: 140,
  guidance: 6,
  guidanceChars: 160,
  skills: 4,
} as const;

export interface AgentHarness {
  revision: number;
  origin: "base" | "adopted";
  roundId?: string;
  adoptedTick?: number;
  /** C1 system prompt: lines appended to the goal question's instructions. */
  procedure: string[];
  guards: HarnessGuard[];
  memory: HarnessFact[];
  guidance: HarnessGuidance[];
  skills: HarnessSkillTrigger[];
}

export type HarnessComponent = "procedure" | "guards" | "memory" | "guidance" | "skills";
/** INV: how the agent works (procedure, guards, skills). DOM: what a practitioner knows
 * about this workspace (memory facts, guidance). */
export type HarnessScope = "INV" | "DOM";
export const SCOPE_COMPONENTS: Record<HarnessScope, readonly HarnessComponent[]> = {
  INV: ["procedure", "guards", "skills"],
  DOM: ["memory", "guidance"],
};

/** A trajectory moment that motivated or decided something. */
export interface EvidenceMoment {
  run: string;
  tick: number;
  text: string;
}

export type HarnessItem =
  | string
  | HarnessGuard
  | HarnessFact
  | HarnessGuidance
  | HarnessSkillTrigger;

export interface HarnessEdit {
  /** Stable id derived from the edit content, so identical edits from different
   * candidates share one id. */
  id: string;
  scope: HarnessScope;
  component: HarnessComponent;
  op: "add" | "remove";
  /** Item to add, or for remove the item being removed. */
  item: HarnessItem;
  summary: string;
  moment: EvidenceMoment;
  source: "diagnosis" | "library";
  libraryEntryId?: string;
}

export interface HarnessValidation {
  valid: boolean;
  errors: string[];
}

/* ---------- Executions and behavioral contrast ---------- */

export interface TrajectoryStep {
  tick: number;
  x: number;
  y: number;
  energy: number;
  mode: AgentMode;
  /** The focal agent's script result after this tick, e.g. "gathered local material". */
  result: string;
}

export interface ExecutionOutcome {
  goal: AgentGoal;
  targetMaterial: MaterialKind;
  actionId: string;
  ticks: number;
  energyStart: number;
  energyEnd: number;
  energyMin: number;
  reboots: number;
  /** Positive inventory change per material over the rollout. */
  gathered: Inventory;
  builds: number;
  crafts: number;
  inspections: number;
  repairs: number;
  successfulPrimitives: number;
  failedPrimitives: number;
  failuresByPrimitive: Record<string, number>;
  pathLength: number;
  regionsVisited: number;
  /** e.g. "Fungal Water Purifier: missing water" or "completed", absent without a commitment. */
  commitment?: string;
  /** No gather, build, craft, inspection, or repair succeeded, or the agent rebooted. */
  producedNothing: boolean;
  /** Up to eight world-event texts that name the focal agent. */
  events: string[];
}

export interface ExecutionRecord {
  /** "ref-1".."ref-k", "inv-1", "dom-1", "succ-1", "seq-2-inv" ... */
  run: string;
  harness: AgentHarness;
  directive: AgentDirective;
  /** Clef's per-question probabilities for this decision, when a call produced it. */
  probabilities?: Record<string, Record<string, number>>;
  model?: string;
  outcome: ExecutionOutcome;
  trajectory: TrajectoryStep[];
}

export interface BehavioralContrast {
  run: string;
  against: string[];
  /** Candidate directive equals a reference directive on goal, material, action and hold. */
  sameDirective: boolean;
  /** First tick where the focal agent's position or mode differs from reference 1. */
  firstDivergenceTick?: number;
  /** Candidate minus mean of references: energyEnd, energyMin, reboots, gatheredTotal,
   * builds, crafts, inspections, repairs, failedPrimitives, successfulPrimitives, pathLength. */
  deltas: Record<string, number>;
  /** Up to four concrete moments that show the difference. */
  moments: EvidenceMoment[];
  /** The candidate produced nothing while at least one reference delivered something. */
  unsafe: boolean;
}

/* ---------- Improvement record D_t, reflection, and library R_t ---------- */

export type EditDecision = "kept" | "dropped";
export type EditVerdict = "helped" | "hurt" | "no observed effect" | "confounded";

export interface CompositionRecord {
  run: string;
  decisions: Array<{ editId: string; decision: EditDecision; reason: string }>;
  harness: AgentHarness;
  keepBase: boolean;
}

export interface CandidateRecord {
  run: string;
  scope: HarnessScope;
  edit?: HarnessEdit;
  contrast: BehavioralContrast;
}

export interface ImprovementRecord {
  roundId: string;
  agentId: string;
  tick: number;
  condition: InteractionCondition;
  mode: "parallel" | "sequential";
  k: number;
  cue: string;
  references: Array<{ run: string; summary: string }>;
  candidates: CandidateRecord[];
  compositions: CompositionRecord[];
  selection?: { chosen: string; anonymousIds: Record<string, string>; why: string };
  adoptedRun: string;
  /** Validation failures, retries, and stages that inherited their input. */
  fallbacks: string[];
  calls: number;
  cost: number;
}

export interface EditVerdictRow {
  editId: string;
  component: HarnessComponent;
  candidates: string[];
  change: string;
  observed: string;
  verdict: EditVerdict;
}

export interface ExperienceEntry {
  cue: string;
  lesson: string;
  evidence: string;
  confidence: "high" | "medium" | "low";
}

export interface LibraryEntry {
  id: string;
  createdTick: number;
  agentId: string;
  condition: InteractionCondition;
  /** "shared", or the agent id when explicit culture is ablated. */
  visibility: string;
  cue: string;
  /** null records NO_ENTRY: the adopted harness is kept without a lesson. */
  experience: ExperienceEntry | null;
  harness: AgentHarness;
  edits: HarnessEdit[];
  rows: EditVerdictRow[];
}

export interface RoundResult {
  directive: AgentDirective;
  adoptedHarness: AgentHarness;
  record: ImprovementRecord;
  rows: EditVerdictRow[];
  /** Absent when the adopted harness equals the base harness and no lesson exists. */
  entry?: LibraryEntry;
}
