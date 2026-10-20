import { actionIdForGoal, baseActionLibrary } from "./action-sandbox";
import { canBuild, nearestProcessingStation } from "./engine";
import {
  HARNESS_LIMITS,
  type AgentHarness,
  type DecisionQuestion,
  type HarnessClause,
  type HarnessCondition,
  type HarnessEdit,
  type HarnessItem,
  type HarnessNumericFeature,
  type HarnessValidation,
  type SituationFeatures,
} from "./harness-types";
import {
  terrainKinds,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type Agent,
  type AgentDirective,
  type MaterialKind,
  type TerrainKind,
  type Tile,
  type WorldState,
} from "./types";

const VIABLE_RICHNESS = 0.12;
const materials: readonly MaterialKind[] = ["water", "fungus", "mineral", "cellulose", "chitin"];
const materialForTerrain: Partial<Record<TerrainKind, MaterialKind>> = {
  tidal: "water",
  fungus: "fungus",
  mineral: "mineral",
  cellulose: "cellulose",
  chitin: "chitin",
};
const builtInActionIds = new Set(baseActionLibrary().map((action) => action.id));
const guardVocabulary: Record<string, readonly string[]> = {
  goal: ["explore", "gather", "build", "inspect", "maintain", "craft", "create"],
  targetMaterial: materials,
  controllerAction: ["collect-water", "remediate", "heal", "grow", "signal"],
  holdMacroturns: ["1", "2", "4", "8"],
};
const numericFeatures = new Set<string>([
  "energy",
  "curiosity",
  "localRichness",
  "localMoisture",
  "localContamination",
  ...materials.flatMap((material) => [`inventory.${material}`, `nearestViable.${material}`]),
]);
const forbiddenText = /\{\{|\{%|score|grader|rubric/i;

function wrap(value: number, size: number): number {
  return ((value % size) + size) % size;
}

function tileAt(state: WorldState, x: number, y: number): Tile {
  return state.terrain[wrap(y, WORLD_HEIGHT) * WORLD_WIDTH + wrap(x, WORLD_WIDTH)]!;
}

function distanceSquared(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = Math.min(Math.abs(a.x - b.x), WORLD_WIDTH - Math.abs(a.x - b.x));
  const dy = Math.min(Math.abs(a.y - b.y), WORLD_HEIGHT - Math.abs(a.y - b.y));
  return dx * dx + dy * dy;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (0x1_0000_0000 * (0x1fffff & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

function itemKey(item: HarnessItem): string {
  return typeof item === "string" ? item : item.id;
}

function numericFeature(features: SituationFeatures, feature: HarnessNumericFeature): number {
  const [group, material] = feature.split(".") as [string, MaterialKind | undefined];
  if (group === "inventory") return features.inventory[material!];
  if (group === "nearestViable") return features.nearestViable[material!] ?? Infinity;
  return features[feature as Exclude<HarnessNumericFeature, `${string}.${string}`>];
}

function validClause(clause: HarnessClause): boolean {
  if (clause.feature === "localTerrain")
    return Array.isArray(clause.value) && clause.value.every((kind) => terrainKinds.includes(kind));
  if (clause.feature === "hasCommitment" || clause.feature === "buildReady")
    return typeof clause.value === "boolean";
  return (
    numericFeatures.has(clause.feature) &&
    (clause.op === "<" || clause.op === ">=") &&
    Number.isFinite(clause.value)
  );
}

export function baseHarness(): AgentHarness {
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

export function situationFeatures(state: WorldState, agent: Agent): SituationFeatures {
  const tile = tileAt(state, agent.x, agent.y);
  const nearestViable: SituationFeatures["nearestViable"] = {};
  for (let y = 0; y < WORLD_HEIGHT; y += 2) {
    for (let x = 0; x < WORLD_WIDTH; x += 2) {
      const scanned = tileAt(state, x, y);
      const material = materialForTerrain[scanned.terrain];
      if (!material || scanned.richness < VIABLE_RICHNESS) continue;
      const distance = Math.sqrt(distanceSquared(agent, { x, y }));
      if (distance < (nearestViable[material] ?? Infinity)) nearestViable[material] = distance;
    }
  }
  const nearestStation: SituationFeatures["nearestStation"] = {};
  for (const material of materials) {
    const station = nearestProcessingStation(agent, state, material);
    if (station) nearestStation[station.kind] = Math.sqrt(distanceSquared(agent, station));
  }
  const buildReady = canBuild(agent);
  return {
    tick: state.tick,
    energy: agent.energy,
    curiosity: agent.curiosity,
    inventory: { ...agent.inventory },
    localTerrain: tile.terrain,
    localRichness: tile.richness,
    localMoisture: tile.moisture,
    localContamination: tile.contamination,
    hasCommitment: Boolean(agent.craftingTarget),
    ...(buildReady ? { buildReady } : {}),
    nearestViable,
    nearestStation,
    visibleArtifacts: state.artifacts.filter((artifact) => distanceSquared(agent, artifact) <= 36)
      .length,
  };
}

export function evaluateCondition(
  condition: HarnessCondition,
  features: SituationFeatures,
): boolean {
  return condition.all.every((clause) => {
    if (clause.feature === "localTerrain") return clause.value.includes(features.localTerrain);
    if (clause.feature === "hasCommitment") return features.hasCommitment === clause.value;
    if (clause.feature === "buildReady")
      return (features.buildReady !== undefined) === clause.value;
    const value = numericFeature(features, clause.feature);
    return clause.op === "<" ? value < clause.value : value >= clause.value;
  });
}

export function applyHarnessToQuestions(
  questions: Record<string, DecisionQuestion>,
  harness: AgentHarness,
  features: SituationFeatures,
): { questions: Record<string, DecisionQuestion>; applied: string[] } {
  const result = structuredClone(questions);
  const applied: string[] = [];
  if (result.goal && harness.procedure.length) {
    result.goal.instructions += harness.procedure
      .map((line) => ` Harness procedure: ${line}`)
      .join("");
    applied.push("procedure");
  }
  // Guards run before guidance so guidance only rewrites options that survive.
  for (const guard of harness.guards) {
    const { kind, question: id, label } = guard.effect;
    const question = result[id];
    if (
      !question ||
      !Object.hasOwn(question.criteria, label) ||
      Object.keys(question.criteria).length < 2 ||
      !evaluateCondition(guard.when, features)
    )
      continue;
    if (kind === "forbid") delete question.criteria[label];
    else question.criteria = { [label]: question.criteria[label]! };
    applied.push(guard.id);
  }
  for (const guidance of harness.guidance) {
    const question = result[guidance.question];
    if (
      !question ||
      !Object.hasOwn(question.criteria, guidance.label) ||
      question.criteria[guidance.label] === guidance.text
    )
      continue;
    question.criteria[guidance.label] = guidance.text;
    applied.push(guidance.id);
  }
  return { questions: result, applied };
}

export function harnessState(harness: AgentHarness): Record<string, unknown> | undefined {
  return harness.memory.length
    ? { harnessMemory: harness.memory.map((fact) => fact.text) }
    : undefined;
}

export function applySkillTriggers(
  directive: AgentDirective,
  harness: AgentHarness,
  features: SituationFeatures,
  knownActionIds: string[],
): AgentDirective {
  if (directive.actionId !== undefined && directive.actionId !== actionIdForGoal(directive.goal))
    return directive;
  const skill = harness.skills.find(
    (candidate) =>
      candidate.goal === directive.goal &&
      candidate.actionId !== directive.actionId &&
      knownActionIds.includes(candidate.actionId) &&
      evaluateCondition(candidate.when, features),
  );
  // The learned action supplies its own icon once the script switches to it.
  return skill ? { ...directive, actionId: skill.actionId, icon: undefined } : directive;
}

export function applyEdits(base: AgentHarness, edits: HarnessEdit[]): AgentHarness {
  const harness = structuredClone(base);
  for (const edit of edits) {
    const items = harness[edit.component] as HarnessItem[];
    const index = items.findIndex((item) => itemKey(item) === itemKey(edit.item));
    if (edit.op === "add" && index < 0) items.push(structuredClone(edit.item));
    if (edit.op === "remove" && index >= 0) items.splice(index, 1);
  }
  return harness;
}

export function validateHarness(
  harness: AgentHarness,
  context: { knownActionIds: string[] },
): HarnessValidation {
  const errors: string[] = [];
  const learned = context.knownActionIds.filter((id) => !builtInActionIds.has(id));
  const vocabulary = { ...guardVocabulary, actionId: ["default", ...learned] };
  const counts = [
    ["procedure", harness.procedure.length, HARNESS_LIMITS.procedureLines],
    ["guards", harness.guards.length, HARNESS_LIMITS.guards],
    ["memory", harness.memory.length, HARNESS_LIMITS.memory],
    ["guidance", harness.guidance.length, HARNESS_LIMITS.guidance],
    ["skills", harness.skills.length, HARNESS_LIMITS.skills],
  ] as const;
  for (const [component, count, limit] of counts)
    if (count > limit) errors.push(`${component} has ${count} items; the limit is ${limit}`);
  for (const line of harness.procedure)
    if (!line.trim() || line.length > HARNESS_LIMITS.procedureLineChars)
      errors.push(`procedure line must have 1-${HARNESS_LIMITS.procedureLineChars} characters`);
  for (const guard of harness.guards) {
    const labels = vocabulary[guard.effect.question as keyof typeof vocabulary];
    if (!labels) errors.push(`guard ${guard.id} targets unknown question ${guard.effect.question}`);
    else if (!labels.includes(guard.effect.label))
      errors.push(
        `guard ${guard.id}: ${guard.effect.label} is not a ${guard.effect.question} option`,
      );
    if (!guard.when.all.every(validClause))
      errors.push(`guard ${guard.id} has an invalid condition`);
  }
  for (const fact of harness.memory) {
    if (fact.text.length > HARNESS_LIMITS.factChars)
      errors.push(`fact ${fact.id} exceeds ${HARNESS_LIMITS.factChars} characters`);
    if (
      !Number.isFinite(fact.x) ||
      !Number.isFinite(fact.y) ||
      fact.x < 0 ||
      fact.x >= WORLD_WIDTH ||
      fact.y < 0 ||
      fact.y >= WORLD_HEIGHT
    )
      errors.push(`fact ${fact.id} lies outside the world`);
  }
  for (const guidance of harness.guidance)
    if (guidance.text.length > HARNESS_LIMITS.guidanceChars)
      errors.push(`guidance ${guidance.id} exceeds ${HARNESS_LIMITS.guidanceChars} characters`);
  for (const skill of harness.skills) {
    if (!learned.includes(skill.actionId))
      errors.push(`skill ${skill.id} names unknown learned action ${skill.actionId}`);
    if (!skill.when.all.every(validClause))
      errors.push(`skill ${skill.id} has an invalid condition`);
  }
  const texts = [
    ...harness.procedure,
    ...harness.guards.map((guard) => guard.note),
    ...harness.memory.map((fact) => fact.text),
    ...harness.guidance.map((guidance) => guidance.text),
    ...harness.skills.map((skill) => skill.note),
  ];
  for (const text of texts)
    if (forbiddenText.test(text))
      errors.push(`text contains a template or evaluation term: ${text.slice(0, 60)}`);
  return { valid: errors.length === 0, errors };
}

export function harnessSignature(harness: AgentHarness): string {
  const { procedure, guards, memory, guidance, skills } = harness;
  return hash(canonical({ procedure, guards, memory, guidance, skills }));
}

function bucket(value: number, bounds: Array<[number, string]>, top: string): string {
  return bounds.find(([limit]) => value < limit)?.[1] ?? top;
}

export function situationCue(features: SituationFeatures): string {
  const hoard = materials.some(
    (material) => material !== "water" && features.inventory[material] >= 12,
  );
  return [
    `energy:${bucket(
      features.energy,
      [
        [0.3, "critical"],
        [0.55, "low"],
        [0.8, "ok"],
      ],
      "high",
    )}`,
    `water:${bucket(
      features.inventory.water,
      [
        [0.5, "none"],
        [1.5, "low"],
        [3, "ok"],
      ],
      "full",
    )}`,
    `terrain:${features.localTerrain}`,
    `richness:${bucket(
      features.localRichness,
      [
        [0.08, "depleted"],
        [0.12, "thin"],
        [0.4, "viable"],
      ],
      "rich",
    )}`,
    `commitment:${features.hasCommitment ? "yes" : "no"}`,
    `build:${features.buildReady ? "ready" : "none"}`,
    `contamination:${bucket(
      features.localContamination,
      [
        [0.2, "clean"],
        [0.55, "dirty"],
      ],
      "toxic",
    )}`,
    `hoard:${hoard ? "yes" : "no"}`,
  ].join("|");
}
