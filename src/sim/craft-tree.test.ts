import { describe, expect, it } from "vite-plus/test";
import { buildCraftTree, craftRecipeId, normalizeCraftRecipe } from "./craft-tree";
import { createInitialWorld, publicSnapshot } from "./engine";
import type { AgentActionDefinition } from "./types";

describe("craft tree", () => {
  it("enumerates every unordered material pairing, including same-material recipes", () => {
    const tree = buildCraftTree(publicSnapshot(createInitialWorld(260826081, 0), false));

    expect(tree.pairings).toHaveLength(15);
    expect(new Set(tree.pairings.map((pairing) => pairing.id))).toHaveLength(15);
    expect(tree.pairings[0]?.ingredients).toEqual(["water", "water"]);
    expect(tree.pairings.at(-1)?.ingredients).toEqual(["chitin", "chitin"]);
    expect(normalizeCraftRecipe(["mineral", "fungus"])).toEqual(["fungus", "mineral"]);
    expect(craftRecipeId(["mineral", "fungus"])).toBe("fungus+mineral");
  });

  it("joins discovered actions, adoption, and active attempts onto their pairing", () => {
    const world = createInitialWorld(260826081, 0);
    const action: AgentActionDefinition = {
      id: "a-test",
      name: "Mycelial Compass",
      icon: "✦",
      algorithm: "Read the local mineral field, then take one bounded step.",
      program: ["scan-local", "roam"],
      authorId: world.agents[0]!.id,
      createdTick: 18,
      uses: 7,
      recipe: ["fungus", "mineral"],
    };
    world.actionLibrary.push(action);
    world.agents[0]!.knownActionIds.push(action.id);
    world.agents[1]!.knownActionIds.push(action.id);
    world.agents[2]!.craftingTarget = {
      mode: "craft",
      actionId: action.id,
      actionName: action.name,
      ingredients: ["mineral", "fungus"],
      purpose: "rebuild the shared compass",
      startedTick: 24,
    };

    const tree = buildCraftTree(publicSnapshot(world, false));
    const pairing = tree.pairings.find((candidate) => candidate.id === "fungus+mineral");

    expect(tree.discoveredPairings).toBe(1);
    expect(tree.discoveredActions).toBe(1);
    expect(tree.activeAttempts).toBe(1);
    expect(pairing?.actions[0]).toMatchObject({
      knownBy: 2,
      definition: { id: action.id, uses: 7 },
    });
    expect(pairing?.attempts[0]).toMatchObject({
      agentId: world.agents[2]!.id,
      actionName: action.name,
      mode: "craft",
    });
  });
});
