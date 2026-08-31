import { describe, expect, it } from "vite-plus/test";
import { buildCraftGraphLayout } from "./craft-graph";
import { buildCraftTree } from "./craft-tree";
import { createInitialWorld, publicSnapshot } from "./engine";
import type { AgentActionDefinition } from "./types";

describe("craft graph layout", () => {
  it("lays out material, pairing, and discovered-action layers with explicit edges", () => {
    const world = createInitialWorld(260826081, 0);
    const action: AgentActionDefinition = {
      id: "a-graph-test",
      name: "Mycelial Compass",
      icon: "✦",
      algorithm: "Read the local field, then take one bounded step.",
      program: ["scan-local", "roam"],
      authorId: world.agents[0]!.id,
      createdTick: 18,
      uses: 3,
      recipe: ["fungus", "mineral"],
    };
    world.actionLibrary.push(action);

    const tree = buildCraftTree(publicSnapshot(world, false));
    const graph = buildCraftGraphLayout(tree);
    const materials = graph.nodes.filter((node) => node.kind === "material");
    const pairings = graph.nodes.filter((node) => node.kind === "pairing");
    const actions = graph.nodes.filter((node) => node.kind === "action");

    expect(materials).toHaveLength(5);
    expect(pairings).toHaveLength(15);
    expect(actions).toHaveLength(1);
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(graph.nodes.length);
    expect(graph.edges.filter((edge) => edge.kind === "ingredient")).toHaveLength(25);
    expect(graph.edges.filter((edge) => edge.kind === "discovery")).toEqual([
      expect.objectContaining({
        from: "pairing:fungus+mineral",
        to: "action:a-graph-test",
      }),
    ]);
    expect(graph.width).toBeGreaterThan(1_000);
    expect(graph.height).toBeGreaterThan(1_000);
  });

  it("allocates separate vertical slots to multiple actions from one pairing", () => {
    const world = createInitialWorld(260826081, 0);
    for (const [index, name] of ["First", "Second", "Third"].entries()) {
      world.actionLibrary.push({
        id: `a-${index}`,
        name,
        icon: "✦",
        algorithm: `Bounded behavior ${index}`,
        program: ["scan-local"],
        authorId: world.agents[index]!.id,
        createdTick: index + 1,
        uses: 0,
        recipe: ["water", "fungus"],
      });
    }

    const graph = buildCraftGraphLayout(buildCraftTree(publicSnapshot(world, false)));
    const actions = graph.nodes.filter(
      (node) => node.kind === "action" && node.pairingId === "water+fungus",
    );
    const verticalIntervals = actions.map((node) => [node.y, node.y + node.height]);

    expect(actions).toHaveLength(3);
    expect(verticalIntervals[0]![1]).toBeLessThan(verticalIntervals[1]![0]);
    expect(verticalIntervals[1]![1]).toBeLessThan(verticalIntervals[2]![0]);
  });
});
