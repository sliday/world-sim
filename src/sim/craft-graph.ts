import { craftMaterials, type CraftTree } from "./craft-tree";
import type { MaterialKind } from "./types";

export type CraftGraphNodeKind = "material" | "pairing" | "action";

export interface CraftGraphNode {
  id: string;
  kind: CraftGraphNodeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  material?: MaterialKind;
  pairingId?: string;
  actionId?: string;
}

export interface CraftGraphEdge {
  id: string;
  from: string;
  to: string;
  kind: "ingredient" | "discovery";
}

export interface CraftGraphLayout {
  width: number;
  height: number;
  nodes: CraftGraphNode[];
  edges: CraftGraphEdge[];
}

const MATERIAL_X = 40;
const PAIRING_X = 330;
const ACTION_X = 730;
const MATERIAL_WIDTH = 168;
const MATERIAL_HEIGHT = 58;
const PAIRING_WIDTH = 264;
const PAIRING_HEIGHT = 76;
const ACTION_WIDTH = 340;
const ACTION_HEIGHT = 96;
const ACTION_GAP = 18;
const BLOCK_GAP = 36;

export function buildCraftGraphLayout(tree: CraftTree): CraftGraphLayout {
  const nodes: CraftGraphNode[] = [];
  const edges: CraftGraphEdge[] = [];
  const pairingCenters = new Map<string, number>();
  let cursorY = 50;

  for (const pairing of tree.pairings) {
    const actionBlockHeight = pairing.actions.length
      ? pairing.actions.length * ACTION_HEIGHT + (pairing.actions.length - 1) * ACTION_GAP
      : PAIRING_HEIGHT;
    const blockHeight = Math.max(PAIRING_HEIGHT, actionBlockHeight);
    const pairingY = cursorY + (blockHeight - PAIRING_HEIGHT) / 2;
    const pairingNodeId = `pairing:${pairing.id}`;
    nodes.push({
      id: pairingNodeId,
      kind: "pairing",
      pairingId: pairing.id,
      x: PAIRING_X,
      y: pairingY,
      width: PAIRING_WIDTH,
      height: PAIRING_HEIGHT,
    });
    pairingCenters.set(pairing.id, pairingY + PAIRING_HEIGHT / 2);

    for (const [index, action] of pairing.actions.entries()) {
      const actionNodeId = `action:${action.definition.id}`;
      nodes.push({
        id: actionNodeId,
        kind: "action",
        pairingId: pairing.id,
        actionId: action.definition.id,
        x: ACTION_X,
        y: cursorY + index * (ACTION_HEIGHT + ACTION_GAP),
        width: ACTION_WIDTH,
        height: ACTION_HEIGHT,
      });
      edges.push({
        id: `${pairingNodeId}->${actionNodeId}`,
        from: pairingNodeId,
        to: actionNodeId,
        kind: "discovery",
      });
    }
    cursorY += blockHeight + BLOCK_GAP;
  }

  let previousMaterialY = 24;
  for (const material of craftMaterials) {
    const connected = tree.pairings.filter((pairing) => pairing.ingredients.includes(material));
    const desiredCenter = connected.length
      ? connected.reduce((total, pairing) => total + (pairingCenters.get(pairing.id) ?? 0), 0) /
        connected.length
      : previousMaterialY + MATERIAL_HEIGHT / 2;
    const y = Math.max(previousMaterialY, desiredCenter - MATERIAL_HEIGHT / 2);
    const materialNodeId = `material:${material}`;
    nodes.push({
      id: materialNodeId,
      kind: "material",
      material,
      x: MATERIAL_X,
      y,
      width: MATERIAL_WIDTH,
      height: MATERIAL_HEIGHT,
    });
    previousMaterialY = y + MATERIAL_HEIGHT + 32;
  }

  for (const pairing of tree.pairings) {
    const pairingNodeId = `pairing:${pairing.id}`;
    for (const material of new Set(pairing.ingredients)) {
      edges.push({
        id: `material:${material}->${pairingNodeId}`,
        from: `material:${material}`,
        to: pairingNodeId,
        kind: "ingredient",
      });
    }
  }

  const height = Math.max(cursorY + 24, ...nodes.map((node) => node.y + node.height + 40));
  return { width: 1_120, height, nodes, edges };
}
