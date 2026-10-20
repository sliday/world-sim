import { baseActionLibrary } from "./action-sandbox";
import type {
  Agent,
  AgentActionDefinition,
  Artifact,
  ArtifactFossil,
  FossilRecord,
  WorldState,
} from "./types";

// Windows count ticks because world dynamics are tick-based. One macroturn is
// 600 ticks; production ticks every second, so one macroturn is 10 minutes.
// Pruning runs every 60 ticks. The windows below are hundreds of checks long,
// so the check cadence never decides an outcome.
export const PRUNE_INTERVAL_TICKS = 60;
// advanceArtifacts stops all service at or below this health.
export const ARTIFACT_SERVICE_CUTOFF = 0.05;
// 21,600 ticks (36 macroturns, about 6 hours at one tick per second): an
// unmaintained artifact falls from full health to the service cutoff in about
// 1,400 ticks, and its embodied heal reserve adds at most about 2,100 more, so
// an artifact nobody touched for this window has been dead for at least
// 18,000 ticks. 100 agents pass 3,600 macroturns in it without visiting.
export const ARTIFACT_DECAY_WINDOW_TICKS = 21_600;
// 43,200 ticks (72 macroturns, about 12 hours at one tick per second) in which the
// agent never ran the skill. That is about 17 curiosity refills (2,450 ticks
// each), so another agent can craft the recipe many times before the last
// speaker forgets it. Knowledge outlives a dead machine, so this window is
// twice the artifact window.
export const SKILL_FORGETTING_WINDOW_TICKS = 43_200;
// Full archives measure about 33 KB (skills) and 94 KB (artifacts) of JSON,
// which fits beside the 1.2 MB world in its single Durable Object value.
export const MAX_SKILL_FOSSILS = 128;
export const MAX_ARTIFACT_FOSSILS = 256;

const baseActionIds = new Set(baseActionLibrary().map((action) => action.id));

export function isBaseAction(actionId: string): boolean {
  return baseActionIds.has(actionId);
}

export function emptyFossilRecord(): FossilRecord {
  return { extinctSkills: 0, removedArtifacts: 0, skills: [], artifacts: [] };
}

export function touchSkill(agent: Agent, actionId: string, tick: number): void {
  if (isBaseAction(actionId) || !agent.knownActionIds.includes(actionId)) return;
  agent.skillLastUsedTick[actionId] = tick;
}

export function isFossilSkill(state: WorldState, actionId: string): boolean {
  return state.fossils.skills.some((fossil) => fossil.id === actionId);
}

function artifactWasTouched(artifact: Artifact): boolean {
  return (
    artifact.uses > 0 ||
    artifact.adopters.length > 0 ||
    (artifact.serviceInspectedBy?.length ?? 0) > 0 ||
    artifact.contributors.some((id) => id !== artifact.creatorId)
  );
}

// Starts decay and forgetting clocks without inventing history. An artifact
// that nothing ever used, inspected, maintained, or adopted was last touched
// when it was built, or when a child forked it. A skill whose author never ran
// it (library uses 0) was last practiced when the author created it. Every
// other clock starts at migration, because its true tick was never recorded.
export function ensurePruningState(state: WorldState): void {
  state.fossils ??= emptyFossilRecord();
  const unclocked = state.artifacts.filter((artifact) => artifact.lastTouchedTick === undefined);
  if (unclocked.length) {
    const latestFork = new Map<string, number>();
    for (const artifact of state.artifacts) {
      if (!artifact.parentId) continue;
      latestFork.set(
        artifact.parentId,
        Math.max(latestFork.get(artifact.parentId) ?? 0, artifact.builtAt),
      );
    }
    for (const artifact of unclocked) {
      artifact.lastTouchedTick = artifactWasTouched(artifact)
        ? state.tick
        : Math.max(artifact.builtAt, latestFork.get(artifact.id) ?? 0);
    }
  }
  const library = new Map(state.actionLibrary.map((action) => [action.id, action]));
  for (const agent of state.agents) {
    agent.skillLastUsedTick ??= {};
    for (const id of agent.knownActionIds) {
      if (isBaseAction(id) || agent.skillLastUsedTick[id] !== undefined) continue;
      const action = library.get(id);
      agent.skillLastUsedTick[id] =
        action && action.authorId === agent.id && action.uses === 0 && agent.script.actionId !== id
          ? action.createdTick
          : state.tick;
    }
  }
}

export function fossilizeArtifact(
  state: WorldState,
  artifact: Artifact,
  reason: ArtifactFossil["reason"],
): void {
  state.fossils.removedArtifacts += 1;
  state.fossils.artifacts.push({
    id: artifact.id,
    name: artifact.name,
    material: artifact.material,
    creatorId: artifact.creatorId,
    authors: [...artifact.authors],
    contributors: [...artifact.contributors],
    adopters: [...artifact.adopters],
    serviceInspectedBy: [...(artifact.serviceInspectedBy ?? [])],
    parentId: artifact.parentId,
    generation: artifact.generation,
    controllerAction: artifact.controller.action,
    process: artifact.process,
    validated: artifact.validated,
    uses: artifact.uses,
    builtAt: artifact.builtAt,
    lastTouchedTick: artifact.lastTouchedTick ?? artifact.builtAt,
    removedTick: state.tick,
    reason,
  });
  state.fossils.artifacts.splice(
    0,
    Math.max(0, state.fossils.artifacts.length - MAX_ARTIFACT_FOSSILS),
  );
}

function fossilizeSkill(state: WorldState, action: AgentActionDefinition): void {
  state.fossils.extinctSkills += 1;
  state.fossils.skills.push({
    id: action.id,
    name: action.name,
    icon: action.icon,
    authorId: action.authorId,
    recipe: action.recipe ? [...action.recipe] : undefined,
    program: [...action.program],
    createdTick: action.createdTick,
    extinctTick: state.tick,
    uses: action.uses,
    knowerIds: [...(action.forgottenBy ?? [])],
  });
  state.fossils.skills.splice(0, Math.max(0, state.fossils.skills.length - MAX_SKILL_FOSSILS));
}

export interface PruneReport {
  forgotten: { agent: Agent; actionId: string }[];
  extinct: AgentActionDefinition[];
  eroded: Artifact[];
}

function listNames(names: readonly string[]): string {
  const shown = names.slice(0, 2).join(", ");
  return names.length > 2 ? `${shown} +${names.length - 2}` : shown;
}

export function pruneSummary(report: PruneReport): string {
  const parts: string[] = [];
  if (report.extinct.length)
    parts.push(
      `${report.extinct.length} extinct skill${report.extinct.length === 1 ? "" : "s"} (${listNames(report.extinct.map((action) => action.name))})`,
    );
  if (report.eroded.length)
    parts.push(
      `${report.eroded.length} dead artifact${report.eroded.length === 1 ? "" : "s"} eroded (${listNames(report.eroded.map((artifact) => artifact.name))})`,
    );
  if (report.forgotten.length) {
    const agents = new Set(report.forgotten.map(({ agent }) => agent.id)).size;
    const skills = new Set(report.forgotten.map(({ actionId }) => actionId)).size;
    parts.push(
      `${agents} bot${agents === 1 ? "" : "s"} forgot ${skills} unused skill${skills === 1 ? "" : "s"}`,
    );
  }
  return `Pruned: ${parts.join(" · ")}`;
}

// Forgetting, extinction, and erosion are physical and cognitive processes, so
// they run under every interaction condition. Fossils stay outside agent
// observations, so pruning never opens a new channel of culture.
export function pruneWorld(
  state: WorldState,
  record: (text: string, x: number, y: number) => void = () => undefined,
): PruneReport {
  const report: PruneReport = { forgotten: [], extinct: [], eroded: [] };
  const library = new Map(state.actionLibrary.map((action) => [action.id, action]));

  for (const agent of state.agents) {
    for (const [actionId, lastUsedTick] of Object.entries(agent.skillLastUsedTick)) {
      if (!agent.knownActionIds.includes(actionId)) {
        delete agent.skillLastUsedTick[actionId];
        continue;
      }
      if (
        actionId === agent.craftingTarget?.actionId ||
        actionId === agent.script.actionId ||
        state.tick - lastUsedTick < SKILL_FORGETTING_WINDOW_TICKS
      )
        continue;
      agent.knownActionIds = agent.knownActionIds.filter((id) => id !== actionId);
      delete agent.skillLastUsedTick[actionId];
      const action = library.get(actionId);
      if (action) action.forgottenBy = [...new Set([...(action.forgottenBy ?? []), agent.id])];
      report.forgotten.push({ agent, actionId });
    }
  }

  const spoken = new Set<string>();
  for (const agent of state.agents) {
    for (const id of agent.knownActionIds) spoken.add(id);
    if (agent.craftingTarget?.actionId) spoken.add(agent.craftingTarget.actionId);
  }
  const extinct = state.actionLibrary.filter(
    (action) => !isBaseAction(action.id) && !spoken.has(action.id),
  );
  for (const action of extinct) {
    state.actionLibrary.splice(state.actionLibrary.indexOf(action), 1);
    fossilizeSkill(state, action);
    report.extinct.push(action);
  }

  const eroded = state.artifacts.filter(
    (artifact) =>
      artifact.health <= ARTIFACT_SERVICE_CUTOFF &&
      state.tick - (artifact.lastTouchedTick ?? state.tick) >= ARTIFACT_DECAY_WINDOW_TICKS,
  );
  for (const artifact of eroded) {
    state.artifacts.splice(state.artifacts.indexOf(artifact), 1);
    fossilizeArtifact(state, artifact, "decay");
    report.eroded.push(artifact);
  }

  if (report.forgotten.length || report.extinct.length || report.eroded.length) {
    const origin = report.eroded[0] ??
      state.agents.find((agent) => agent.id === report.extinct[0]?.authorId) ??
      report.forgotten[0]?.agent ?? { x: 0, y: 0 };
    record(pruneSummary(report), origin.x, origin.y);
  }
  return report;
}
