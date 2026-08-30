import type {
  AgentActionDefinition,
  CraftingTarget,
  MaterialKind,
  PublicWorldSnapshot,
} from "./types";

export const craftMaterials = [
  "water",
  "fungus",
  "mineral",
  "cellulose",
  "chitin",
] as const satisfies readonly MaterialKind[];

export interface CraftTreeAction {
  definition: AgentActionDefinition;
  knownBy: number;
}

export interface CraftTreeAttempt {
  agentId: string;
  mode: CraftingTarget["mode"];
  actionName: string;
  purpose: string;
  startedTick: number;
}

export interface CraftTreePairing {
  id: string;
  ingredients: [MaterialKind, MaterialKind];
  actions: CraftTreeAction[];
  attempts: CraftTreeAttempt[];
}

export interface CraftTree {
  pairings: CraftTreePairing[];
  discoveredPairings: number;
  discoveredActions: number;
  activeAttempts: number;
}

const materialIndex = new Map<MaterialKind, number>(
  craftMaterials.map((material, index) => [material, index]),
);

export function normalizeCraftRecipe(
  ingredients: readonly [MaterialKind, MaterialKind],
): [MaterialKind, MaterialKind] {
  const [first, second] = ingredients;
  return (materialIndex.get(first) ?? 0) <= (materialIndex.get(second) ?? 0)
    ? [first, second]
    : [second, first];
}

export function craftRecipeId(ingredients: readonly [MaterialKind, MaterialKind]): string {
  return normalizeCraftRecipe(ingredients).join("+");
}

export function buildCraftTree(
  snapshot: Pick<PublicWorldSnapshot, "actionLibrary" | "agents">,
): CraftTree {
  const pairings: CraftTreePairing[] = [];
  const byId = new Map<string, CraftTreePairing>();

  for (let first = 0; first < craftMaterials.length; first += 1) {
    for (let second = first; second < craftMaterials.length; second += 1) {
      const ingredients: [MaterialKind, MaterialKind] = [
        craftMaterials[first]!,
        craftMaterials[second]!,
      ];
      const pairing: CraftTreePairing = {
        id: craftRecipeId(ingredients),
        ingredients,
        actions: [],
        attempts: [],
      };
      pairings.push(pairing);
      byId.set(pairing.id, pairing);
    }
  }

  for (const definition of snapshot.actionLibrary) {
    if (!definition.recipe) continue;
    const pairing = byId.get(craftRecipeId(definition.recipe));
    if (!pairing) continue;
    pairing.actions.push({
      definition,
      knownBy: snapshot.agents.filter((agent) => agent.knownActionIds.includes(definition.id))
        .length,
    });
  }

  for (const agent of snapshot.agents) {
    const target = agent.craftingTarget;
    if (!target) continue;
    const pairing = byId.get(craftRecipeId(target.ingredients));
    if (!pairing) continue;
    pairing.attempts.push({
      agentId: agent.id,
      mode: target.mode,
      actionName: target.actionName,
      purpose: target.purpose,
      startedTick: target.startedTick,
    });
  }

  for (const pairing of pairings) {
    pairing.actions.sort(
      (first, second) =>
        first.definition.createdTick - second.definition.createdTick ||
        first.definition.id.localeCompare(second.definition.id),
    );
    pairing.attempts.sort(
      (first, second) =>
        first.startedTick - second.startedTick || first.agentId.localeCompare(second.agentId),
    );
  }

  return {
    pairings,
    discoveredPairings: pairings.filter((pairing) => pairing.actions.length > 0).length,
    discoveredActions: pairings.reduce((total, pairing) => total + pairing.actions.length, 0),
    activeAttempts: pairings.reduce((total, pairing) => total + pairing.attempts.length, 0),
  };
}
