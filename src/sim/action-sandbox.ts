import type {
  Agent,
  AgentActionDefinition,
  AgentActionProposal,
  AgentDocuments,
  AgentGoal,
  AgentScript,
  ActionPrimitive,
  MaterialKind,
} from "./types";
import { identityHash32 } from "./names";

export const modelActionPrimitives = [
  "scan-local",
  "roam",
  "gather-local",
  "seek-resource",
  "build-local",
  "seek-station",
  "inspect-local",
  "repair-local",
  "seek-artifact",
] as const satisfies readonly ActionPrimitive[];

export const actionPrimitives = [
  ...modelActionPrimitives,
  "craft-local",
  "mix-local",
  "seek-crafting-material",
] as const satisfies readonly ActionPrimitive[];

export const assignableActionIcons = [
  "⌁",
  "◎",
  "◈",
  "◇",
  "△",
  "✦",
  "✧",
  "⚙",
  "⚒",
  "☄",
  "♢",
  "♧",
  "⊕",
  "⊛",
  "⌬",
  "╫",
  "≈",
  "⟁",
  "⟡",
  "∞",
] as const;

const baseActions: AgentActionDefinition[] = [
  {
    id: "survey",
    name: "Survey",
    icon: "◎",
    algorithm: "Read the local tile, then take one bounded step through unexplored terrain.",
    program: ["scan-local", "roam"],
    authorId: "WORLD",
    createdTick: 0,
    uses: 0,
  },
  {
    id: "forage",
    name: "Forage",
    icon: "♧",
    algorithm: "Collect useful matter underfoot; otherwise move toward the requested material.",
    program: ["gather-local", "seek-resource"],
    authorId: "WORLD",
    createdTick: 0,
    uses: 0,
  },
  {
    id: "fabricate",
    name: "Fabricate",
    icon: "⚒",
    algorithm: "Build from carried matter when possible; otherwise seek a station or feedstock.",
    program: ["build-local", "seek-station", "seek-resource"],
    authorId: "WORLD",
    createdTick: 0,
    uses: 0,
  },
  {
    id: "study",
    name: "Study",
    icon: "◇",
    algorithm: "Inspect a nearby artifact; if none is reachable, move toward the nearest one.",
    program: ["inspect-local", "seek-artifact", "roam"],
    authorId: "WORLD",
    createdTick: 0,
    uses: 0,
  },
  {
    id: "steward",
    name: "Steward",
    icon: "⚙",
    algorithm: "Repair a nearby artifact with available water; otherwise approach one.",
    program: ["repair-local", "seek-artifact", "seek-resource"],
    authorId: "WORLD",
    createdTick: 0,
    uses: 0,
  },
  {
    id: "craft",
    name: "Craft",
    icon: "⌬",
    algorithm:
      "Combine the reserved materials into a known skill; seek and gather any missing ingredient.",
    program: ["craft-local", "seek-crafting-material", "gather-local"],
    authorId: "WORLD",
    createdTick: 0,
    uses: 0,
  },
  {
    id: "creative-session",
    name: "Creative Session",
    icon: "✦",
    algorithm:
      "Try a new material pairing; seek and reserve ingredients until a novel bounded behavior is built.",
    program: ["mix-local", "seek-crafting-material", "gather-local"],
    authorId: "WORLD",
    createdTick: 0,
    uses: 0,
  },
];

export function baseActionLibrary(): AgentActionDefinition[] {
  return structuredClone(baseActions);
}

export function actionIdForGoal(goal: AgentGoal): string {
  if (goal === "gather") return "forage";
  if (goal === "build") return "fabricate";
  if (goal === "inspect") return "study";
  if (goal === "maintain") return "steward";
  if (goal === "craft") return "craft";
  if (goal === "create") return "creative-session";
  return "survey";
}

export function initialDocuments(name: string): AgentDocuments {
  return {
    soulMd:
      "# SOUL.md\nObserve before acting. Share the planet. Prefer working evidence to confident stories. Leave useful structure behind.",
    memoryMd: `# MEMORY.md\n${name} has just awakened. No result is known until the world measures it.`,
    userMd:
      "# USER.md\nThere is no player to obey. The shared world is the beneficiary. Preserve resources, inspect inherited work, and make bounded changes.",
  };
}

export function initialScript(): AgentScript {
  return {
    revision: 0,
    updatedTick: 0,
    actionId: "survey",
    icon: "◎",
    program: ["scan-local", "roam"],
    rationale: "begin with local observation",
    lastResult: "not run",
  };
}

export function validateActionProposal(proposal: AgentActionProposal): boolean {
  return (
    proposal.name.trim().length >= 2 &&
    proposal.name.trim().length <= 32 &&
    proposal.algorithm.trim().length >= 12 &&
    proposal.algorithm.trim().length <= 180 &&
    assignableActionIcons.includes(proposal.icon as (typeof assignableActionIcons)[number]) &&
    proposal.program.length >= 2 &&
    proposal.program.length <= 4 &&
    proposal.program.every((step) =>
      modelActionPrimitives.includes(step as (typeof modelActionPrimitives)[number]),
    )
  );
}

function actionSignature(action: AgentActionProposal): string {
  // The executable program is the behavior. Renaming the same primitive
  // sequence is not a technological extension and must not create a fork.
  return action.program.join(":");
}

export function dedupeActionLibrary(library: AgentActionDefinition[]): Map<string, string> {
  const canonical = new Map<string, AgentActionDefinition>();
  const aliases = new Map<string, string>();
  const unique: AgentActionDefinition[] = [];
  for (const action of library) {
    const signature = actionSignature(action);
    const existing = canonical.get(signature);
    if (existing) {
      aliases.set(action.id, existing.id);
      continue;
    }
    canonical.set(signature, action);
    unique.push(action);
  }
  library.splice(0, library.length, ...unique);
  return aliases;
}

function trimDynamicActions(library: AgentActionDefinition[]): void {
  const baseIds = new Set(baseActions.map((action) => action.id));
  while (library.length > 64) {
    const oldestDynamic = library.findIndex((action) => !baseIds.has(action.id));
    if (oldestDynamic < 0) break;
    library.splice(oldestDynamic, 1);
  }
}

export function normalizeActionLibrary(library: AgentActionDefinition[]): Map<string, string> {
  const baseIds = new Set(baseActions.map((action) => action.id));
  const canonicalBase = baseActionLibrary().map((action) => ({
    ...action,
    uses: library.find((candidate) => candidate.id === action.id)?.uses ?? action.uses,
  }));
  const normalized = [...canonicalBase, ...library.filter((action) => !baseIds.has(action.id))];
  const aliases = dedupeActionLibrary(normalized);
  trimDynamicActions(normalized);
  library.splice(0, library.length, ...normalized);
  return aliases;
}

export function registerAction(
  library: AgentActionDefinition[],
  proposal: AgentActionProposal,
  authorId: string,
  tick: number,
  recipe?: [MaterialKind, MaterialKind],
): AgentActionDefinition | undefined {
  if (!validateActionProposal(proposal)) return undefined;
  const signature = actionSignature(proposal);
  if (library.some((action) => actionSignature(action) === signature)) return undefined;
  const id = `a-${identityHash32(signature).toString(36).slice(0, 7)}`;
  const existing = library.find((action) => action.id === id);
  if (existing) return existing;
  const action: AgentActionDefinition = {
    id,
    name: proposal.name.trim(),
    icon: proposal.icon,
    algorithm: proposal.algorithm.trim(),
    program: [...proposal.program],
    authorId,
    createdTick: tick,
    uses: 0,
    recipe: recipe ? [...recipe] : undefined,
  };
  library.push(action);
  trimDynamicActions(library);
  return action;
}

export function updateAgentScript(
  agent: Agent,
  library: AgentActionDefinition[],
  tick: number,
  localSummary: string,
): AgentActionDefinition {
  const requested = agent.directive.actionId ?? actionIdForGoal(agent.directive.goal);
  const action =
    library.find(
      (candidate) => candidate.id === requested && agent.knownActionIds.includes(candidate.id),
    ) ??
    library.find((candidate) => candidate.id === actionIdForGoal(agent.directive.goal)) ??
    library[0]!;
  agent.script = {
    revision: agent.script.revision + 1,
    updatedTick: tick,
    actionId: action.id,
    icon: action.icon,
    program: [...action.program],
    rationale: agent.directive.note.slice(0, 100),
    lastResult: agent.script.lastResult,
  };
  agent.icon = agent.directive.icon ?? action.icon;
  action.uses += 1;
  const purpose = Object.entries(agent.materialPurposes)
    .map(([material, reason]) => `${material} → ${reason}`)
    .join("; ");
  agent.documents.memoryMd =
    `# MEMORY.md\nT${tick}: ${localSummary}\nCurrent algorithm: ${action.name} — ${action.algorithm}${purpose ? `\nReserved materials: ${purpose}` : ""}`.slice(
      0,
      600,
    );
  return action;
}
