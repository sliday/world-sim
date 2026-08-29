import { hashNoise, Rng, toroidalField } from "./rng";
import { generateAgentName } from "./names";
import {
  actionIdForGoal,
  assignableActionIcons,
  baseActionLibrary,
  dedupeActionLibrary,
  initialDocuments,
  initialScript,
  registerAction,
  updateAgentScript,
} from "./action-sandbox";
import {
  AGENT_COUNT,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type Agent,
  type AgentActionDefinition,
  type AgentDirective,
  type AgentGoal,
  type Artifact,
  type Controller,
  type ControllerAction,
  type Inventory,
  type MaterialKind,
  type PublicWorldSnapshot,
  type Station,
  type TerrainKind,
  type Tile,
  type WorldEvent,
  type WorldMetrics,
  type WorldState,
} from "./types";

const materials: readonly MaterialKind[] = ["water", "fungus", "mineral", "cellulose", "chitin"];
const controllerActions: readonly ControllerAction[] = [
  "collect-water",
  "remediate",
  "heal",
  "grow",
  "signal",
];
const goals: readonly AgentGoal[] = ["explore", "gather", "build", "inspect", "maintain"];
export const ARTIFACT_CONTACT_RADIUS = 3;
const emptyInventory = (): Inventory => ({
  water: 0,
  fungus: 0,
  mineral: 0,
  cellulose: 0,
  chitin: 0,
});

const materialForTerrain: Partial<Record<TerrainKind, MaterialKind>> = {
  tidal: "water",
  fungus: "fungus",
  mineral: "mineral",
  cellulose: "cellulose",
  chitin: "chitin",
};

const artifactWords: Record<MaterialKind, readonly [string, string, string]> = {
  water: ["Tidal", "Moisture", "Spring"],
  fungus: ["Mycelial", "Hyphae", "Spore"],
  mineral: ["Basalt", "Mineral", "Catalyst"],
  cellulose: ["Cellulose", "Fiber", "Trellis"],
  chitin: ["Chitin", "Cuticle", "Shell"],
};

const formWords = [
  "Veil",
  "Lattice",
  "Scaffold",
  "Panel",
  "Membrane",
  "Exchange",
  "Array",
] as const;

function wrap(value: number, size: number): number {
  return ((value % size) + size) % size;
}

function tileIndex(x: number, y: number): number {
  return wrap(y, WORLD_HEIGHT) * WORLD_WIDTH + wrap(x, WORLD_WIDTH);
}

function tileAt(state: WorldState, x: number, y: number): Tile {
  const tile = state.terrain[tileIndex(x, y)];
  if (!tile) throw new Error("World tile missing");
  return tile;
}

function distanceSquared(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = Math.min(Math.abs(a.x - b.x), WORLD_WIDTH - Math.abs(a.x - b.x));
  const dy = Math.min(Math.abs(a.y - b.y), WORLD_HEIGHT - Math.abs(a.y - b.y));
  return dx * dx + dy * dy;
}

export function isArtifactContact(
  agent: { x: number; y: number },
  artifact: { x: number; y: number },
): boolean {
  return distanceSquared(agent, artifact) <= ARTIFACT_CONTACT_RADIUS ** 2;
}

function nearest<T extends { x: number; y: number }>(
  origin: { x: number; y: number },
  items: T[],
): T | undefined {
  let result: T | undefined;
  let best = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const distance = distanceSquared(origin, item);
    if (distance < best) {
      result = item;
      best = distance;
    }
  }
  return result;
}

function createTerrain(seed: number): Tile[] {
  const result: Tile[] = [];
  for (let y = 0; y < WORLD_HEIGHT; y += 1) {
    for (let x = 0; x < WORLD_WIDTH; x += 1) {
      const elevation =
        toroidalField(seed, x, y, WORLD_WIDTH, WORLD_HEIGHT) * 0.68 +
        toroidalField(seed + 83, x, y, WORLD_WIDTH, WORLD_HEIGHT, 3) * 0.32;
      const ecology = toroidalField(seed + 173, x, y, WORLD_WIDTH, WORLD_HEIGHT, 2);
      const geology = toroidalField(seed + 509, x, y, WORLD_WIDTH, WORLD_HEIGHT, 4);
      let terrain: TerrainKind = "plain";
      if (elevation < 0.27) terrain = "deep-water";
      else if (elevation < 0.35) terrain = "tidal";
      else if (geology > 0.7) terrain = "mineral";
      else if (ecology > 0.7) terrain = "fungus";
      else if (ecology < 0.32) terrain = "chitin";
      else if (geology < 0.38) terrain = "cellulose";
      const detail = hashNoise(seed, x, y);
      result.push({
        terrain,
        richness: terrain === "deep-water" ? 0 : 0.35 + detail * 0.65,
        moisture: Math.max(0.05, 1 - elevation + detail * 0.16),
        contamination: detail * 0.08,
      });
    }
  }
  return result;
}

function findTerrainPoint(
  terrain: Tile[],
  kind: TerrainKind,
  start: number,
): { x: number; y: number } {
  for (let offset = 0; offset < terrain.length; offset += 1) {
    const index = (start + offset * 37) % terrain.length;
    if (terrain[index]?.terrain === kind)
      return { x: index % WORLD_WIDTH, y: Math.floor(index / WORLD_WIDTH) };
  }
  return { x: start % WORLD_WIDTH, y: Math.floor(start / WORLD_WIDTH) % WORLD_HEIGHT };
}

function createStations(terrain: Tile[], rng: Rng): Station[] {
  const kinds: Station["kind"][] = ["wash", "grind", "weave", "foundry", "assay", "foundry"];
  const desired: TerrainKind[] = ["tidal", "mineral", "cellulose", "plain", "plain", "fungus"];
  return kinds.map((kind, index) => ({
    id: `S${index + 1}`,
    kind,
    ...findTerrainPoint(terrain, desired[index] ?? "plain", rng.int(terrain.length)),
  }));
}

function instinctDirective(rng: Rng): AgentDirective {
  return {
    goal: rng.pick(goals),
    targetMaterial: rng.pick(materials),
    controllerAction: rng.pick(controllerActions),
    note: "local observation only",
    source: "instinct",
  };
}

function initialDirective(): AgentDirective {
  return {
    goal: "explore",
    targetMaterial: "water",
    controllerAction: "collect-water",
    note: "observe locally and leave useful work behind",
    source: "instinct",
  };
}

function trajectoryRegion(position: { x: number; y: number }): string {
  return `${Math.floor((position.x / WORLD_WIDTH) * 10)}:${Math.floor((position.y / WORLD_HEIGHT) * 10)}`;
}

function createAgent(terrain: Tile[], rng: Rng, seed: number, index: number): Agent {
  const position = findTerrainPoint(terrain, "plain", rng.int(terrain.length));
  const id = `A${String(index + 1).padStart(3, "0")}`;
  const name = generateAgentName(`${seed}:${id}`);
  return {
    id,
    name,
    ...position,
    energy: 0.9,
    mode: "surveying",
    inventory: emptyInventory(),
    discoveries: 0,
    artifactsTouched: 0,
    builds: 0,
    directive: initialDirective(),
    lastDecisionTick: 0,
    trail: [position],
    trajectory: {
      pathLength: 0,
      regionsVisited: [trajectoryRegion(position)],
      artifactContactTicks: 0,
      artifactContactRadius: ARTIFACT_CONTACT_RADIUS,
      observedTicks: 0,
    },
    color: Math.floor((index / AGENT_COUNT) * 360),
    icon: "◎",
    documents: initialDocuments(name),
    script: initialScript(),
    knownActionIds: baseActionLibrary().map((action) => action.id),
    heardMessages: [],
  };
}

function createAgents(terrain: Tile[], rng: Rng, seed: number): Agent[] {
  return Array.from({ length: AGENT_COUNT }, (_, index) => createAgent(terrain, rng, seed, index));
}

export function createInitialWorld(seed = 260826081, now = Date.now()): WorldState {
  const rng = new Rng(seed);
  const terrain = createTerrain(seed);
  const state: WorldState = {
    version: 2,
    seed,
    rngState: rng.snapshot,
    tick: 0,
    lastAdvancedAt: now,
    terrain,
    agents: createAgents(terrain, rng, seed),
    artifacts: [],
    discoveryFrontierPerformance: 0,
    discoveryFrontierArea: 0,
    discoveryFrontierTrackedTicks: 0,
    stations: createStations(terrain, rng),
    events: [],
    actionLibrary: baseActionLibrary(),
    messages: [],
    metrics: emptyMetrics(),
    llm: {
      callsToday: 0,
      callDay: new Date(now).toISOString().slice(0, 10),
      totalCalls: 0,
      totalCost: 0,
    },
  };
  state.rngState = rng.snapshot;
  state.metrics = calculateMetrics(state);
  return state;
}

export function ensureAgentOperatingSystem(state: WorldState): WorldState {
  state.actionLibrary ??= baseActionLibrary();
  state.messages ??= [];
  for (const artifact of state.artifacts) {
    artifact.creatorId ??=
      artifact.id.match(/-(A\d{3})$/u)?.[1] ?? artifact.authors.at(-1) ?? artifact.authors[0]!;
    artifact.adopters ??= [];
    artifact.contributors ??= [artifact.creatorId];
  }
  state.discoveryFrontierPerformance ??= state.artifacts.reduce(
    (best, artifact) => Math.max(best, artifact.performance),
    0,
  );
  state.discoveryFrontierArea ??= 0;
  state.discoveryFrontierTrackedTicks ??= 0;
  if (state.agents.length < AGENT_COUNT) {
    const rng = new Rng(state.rngState);
    while (state.agents.length < AGENT_COUNT)
      state.agents.push(createAgent(state.terrain, rng, state.seed, state.agents.length));
    state.rngState = rng.snapshot;
  }
  const aliases = dedupeActionLibrary(state.actionLibrary);
  const baseIds = baseActionLibrary().map((action) => action.id);
  for (const agent of state.agents) {
    agent.trail ??= [{ x: agent.x, y: agent.y }];
    agent.trajectory ??= {
      pathLength: Math.max(0, agent.trail.length - 1),
      regionsVisited: [...new Set(agent.trail.map(trajectoryRegion))],
      artifactContactTicks: 0,
      artifactContactRadius: ARTIFACT_CONTACT_RADIUS,
      observedTicks: 0,
    };
    if (agent.trajectory.artifactContactRadius !== ARTIFACT_CONTACT_RADIUS) {
      agent.trajectory.artifactContactTicks = 0;
      agent.trajectory.observedTicks = 0;
      agent.trajectory.artifactContactRadius = ARTIFACT_CONTACT_RADIUS;
    }
    agent.icon ??= "◎";
    agent.documents ??= initialDocuments(agent.name);
    agent.script ??= initialScript();
    agent.knownActionIds ??= [...baseIds];
    agent.heardMessages ??= [];
    agent.directive.actionId =
      aliases.get(agent.directive.actionId ?? "") ?? agent.directive.actionId;
    agent.script.actionId = aliases.get(agent.script.actionId) ?? agent.script.actionId;
    agent.knownActionIds = [...new Set(agent.knownActionIds.map((id) => aliases.get(id) ?? id))];
    for (const id of baseIds) if (!agent.knownActionIds.includes(id)) agent.knownActionIds.push(id);
  }
  return state;
}

function emptyMetrics(): WorldMetrics {
  return {
    activeAgents: AGENT_COUNT,
    artifacts: 0,
    bestArtifactPerformance: 0,
    discoveryFrontierPerformance: 0,
    discoveryFrontierAuc: 0,
    validatedInventions: 0,
    forkDepth: 0,
    artifactCenteredFraction: 0,
    portfolioResilience: 0,
    physicalReuseFraction: 0,
    openRouterCalls: 0,
    openRouterCost: 0,
    meanPathLength: 0,
    meanRegionsVisited: 0,
    artifactContactRate: 0,
    spatialEntropy: 0,
  };
}

function addEvent(
  state: WorldState,
  kind: WorldEvent["kind"],
  text: string,
  x: number,
  y: number,
): void {
  state.events.unshift({
    id: `${state.tick}-${state.rngState}-${state.events.length}`,
    tick: state.tick,
    kind,
    text,
    x,
    y,
  });
  state.events.length = Math.min(state.events.length, 28);
}

export function normalizeSpeech(value: string): string {
  const firstSentence = value.replace(/\s+/g, " ").trim().split(/[.!?]/u)[0] ?? "";
  const words = firstSentence.match(/[\p{L}\p{N}'’-]+/gu)?.slice(0, 9) ?? [];
  return `${words.length ? words.join(" ") : "No clear sign here"}.`;
}

export function deliverSpeech(state: WorldState, fromId: string, rawSpeech: string): boolean {
  const sender = state.agents.find((agent) => agent.id === fromId);
  if (!sender) return false;
  const recipient = state.agents
    .filter((agent) => agent.id !== fromId)
    .map((agent) => ({ agent, distance: distanceSquared(sender, agent) }))
    .filter(({ distance }) => distance <= 64)
    .sort((a, b) => a.distance - b.distance || a.agent.id.localeCompare(b.agent.id))[0]?.agent;
  if (!recipient) return false;
  const text = normalizeSpeech(rawSpeech);
  sender.lastSpeech = text;
  recipient.heardMessages.push({ tick: state.tick, fromId, text });
  recipient.heardMessages = recipient.heardMessages.slice(-4);
  state.messages.unshift({
    id: `M${state.tick}-${fromId}-${recipient.id}-${state.messages.length}`,
    tick: state.tick,
    fromId,
    toId: recipient.id,
    text,
  });
  state.messages.length = Math.min(state.messages.length, 18);
  return true;
}

function localSpeech(state: WorldState, agent: Agent): string {
  const tile = tileAt(state, agent.x, agent.y);
  const material = materialForTerrain[tile.terrain];
  if (tile.contamination > 0.55) return "Bad rot here, keep away.";
  if (agent.energy < 0.3) return "Energy low, need water.";
  if (material && tile.richness > 0.62) return `${material} rich here, come gather.`;
  const artifact = nearest(agent, state.artifacts);
  if (artifact && distanceSquared(agent, artifact) <= 9)
    return `${artifact.material} machine works here, come see.`;
  return "Ground plain here, keep searching.";
}

function chooseGoal(agent: Agent, state: WorldState, rng: Rng): AgentGoal {
  const carried = totalInventory(agent.inventory);
  const nearbyArtifact = nearest(agent, state.artifacts);
  const artifactDistance = nearbyArtifact
    ? distanceSquared(agent, nearbyArtifact)
    : Number.POSITIVE_INFINITY;
  if (agent.energy < 0.28) return "gather";
  if (carried >= 8 && (artifactDistance < 100 || rng.chance(0.35))) return "build";
  if (nearbyArtifact && artifactDistance <= 9 && rng.chance(0.55))
    return rng.chance(0.58) ? "inspect" : "maintain";
  if (carried < 4 && rng.chance(0.46)) return "gather";
  return "explore";
}

function totalInventory(inventory: Inventory): number {
  return Object.values(inventory).reduce((total, amount) => total + amount, 0);
}

function resourcePosition(
  state: WorldState,
  material: MaterialKind,
  agent: Agent,
): { x: number; y: number } {
  let best = agent;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let y = 0; y < WORLD_HEIGHT; y += 2) {
    for (let x = 0; x < WORLD_WIDTH; x += 2) {
      if (materialForTerrain[tileAt(state, x, y).terrain] !== material) continue;
      const point = { x, y };
      const distance = distanceSquared(agent, point);
      if (distance < bestDistance) {
        best = { ...agent, ...point };
        bestDistance = distance;
      }
    }
  }
  return { x: best.x, y: best.y };
}

function stepToward(agent: Agent, target: { x: number; y: number }, rng: Rng): void {
  const dxRaw = target.x - agent.x;
  const dyRaw = target.y - agent.y;
  const dx = Math.abs(dxRaw) > WORLD_WIDTH / 2 ? -Math.sign(dxRaw) : Math.sign(dxRaw);
  const dy = Math.abs(dyRaw) > WORLD_HEIGHT / 2 ? -Math.sign(dyRaw) : Math.sign(dyRaw);
  if (dx !== 0 && dy !== 0) {
    if (rng.chance(0.5)) agent.x = wrap(agent.x + dx, WORLD_WIDTH);
    else agent.y = wrap(agent.y + dy, WORLD_HEIGHT);
  } else {
    agent.x = wrap(agent.x + dx, WORLD_WIDTH);
    agent.y = wrap(agent.y + dy, WORLD_HEIGHT);
  }
}

function roam(agent: Agent, rng: Rng): void {
  const directions = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
  ] as const;
  const direction = rng.pick(directions);
  agent.x = wrap(agent.x + direction.x, WORLD_WIDTH);
  agent.y = wrap(agent.y + direction.y, WORLD_HEIGHT);
}

function recordTrail(agent: Agent, state: WorldState): void {
  agent.trajectory.observedTicks += 1;
  const artifact = nearest(agent, state.artifacts);
  if (artifact && isArtifactContact(agent, artifact)) agent.trajectory.artifactContactTicks += 1;
  const previous = agent.trail.at(-1);
  if (previous?.x === agent.x && previous.y === agent.y) return;
  if (previous) agent.trajectory.pathLength += Math.sqrt(distanceSquared(previous, agent));
  agent.trail.push({ x: agent.x, y: agent.y });
  if (agent.trail.length > 36) agent.trail.shift();
  const region = trajectoryRegion(agent);
  if (!agent.trajectory.regionsVisited.includes(region))
    agent.trajectory.regionsVisited.push(region);
}

function gather(agent: Agent, state: WorldState, rng: Rng): boolean {
  const tile = tileAt(state, agent.x, agent.y);
  const material = materialForTerrain[tile.terrain];
  if (!material || tile.richness < 0.08) return false;
  const amount = Math.min(tile.richness, 0.45 + rng.next() * 0.45);
  agent.inventory[material] += amount;
  tile.richness = Math.max(0.02, tile.richness - amount * 0.035);
  agent.energy = Math.min(1, agent.energy + (material === "water" ? 0.055 : 0.018));
  agent.mode = "harvesting";
  if (rng.chance(0.035)) {
    agent.discoveries += 1;
    addEvent(state, "discovery", `${agent.name} mapped a rich ${material} seam`, agent.x, agent.y);
  }
  return true;
}

function canBuild(agent: Agent): MaterialKind | undefined {
  return materials
    .filter((material) => material !== "water")
    .sort((a, b) => agent.inventory[b] - agent.inventory[a])
    .find((material) => agent.inventory[material] >= 5 && agent.inventory.water >= 1.5);
}

export function controllerBehaviorDiffers(parent: Controller, child: Controller): boolean {
  return (
    parent.sensor !== child.sensor ||
    parent.action !== child.action ||
    parent.threshold !== child.threshold
  );
}

function controllerFor(agent: Agent, parent: Artifact | undefined, rng: Rng): Controller {
  if (parent) {
    const child: Controller = {
      ...parent.controller,
      action: rng.chance(0.72) ? agent.directive.controllerAction : parent.controller.action,
      threshold: Math.max(
        0.18,
        Math.min(0.82, parent.controller.threshold + (rng.next() - 0.5) * 0.18),
      ),
      revision: parent.controller.revision + 1,
    };
    if (!controllerBehaviorDiffers(parent.controller, child)) {
      child.threshold =
        parent.controller.threshold >= 0.82 ? 0.81 : parent.controller.threshold + 0.01;
    }
    return child;
  }
  const sensor: Controller["sensor"] =
    agent.directive.controllerAction === "remediate"
      ? "contamination"
      : agent.directive.controllerAction === "heal"
        ? "health"
        : "moisture";
  return {
    sensor,
    threshold: 0.34 + rng.next() * 0.34,
    action: agent.directive.controllerAction,
    revision: 1,
  };
}

function artifactPerformance(
  material: MaterialKind,
  controller: Controller,
  tile: Tile,
  rng: Rng,
): number {
  const actionFit: Record<ControllerAction, number> = {
    "collect-water": 1 - tile.moisture,
    remediate: tile.contamination + 0.45,
    heal: 0.58,
    grow: tile.richness,
    signal: 0.42,
  };
  const materialFit: Record<MaterialKind, number> = {
    water: 0.42,
    fungus: controller.action === "heal" ? 0.78 : 0.58,
    mineral: controller.action === "remediate" ? 0.74 : 0.64,
    cellulose: controller.action === "collect-water" ? 0.73 : 0.57,
    chitin: controller.action === "heal" ? 0.71 : 0.62,
  };
  return Math.max(
    0.12,
    Math.min(
      0.92,
      materialFit[material] * 0.55 + actionFit[controller.action] * 0.3 + rng.next() * 0.15,
    ),
  );
}

function build(agent: Agent, state: WorldState, rng: Rng): boolean {
  const material = canBuild(agent);
  if (!material) return false;
  const parent = nearest(agent, state.artifacts);
  const canFork = parent && distanceSquared(agent, parent) <= 16 && parent.authors[0] !== agent.id;
  const controller = controllerFor(agent, canFork ? parent : undefined, rng);
  const generation = canFork ? parent.generation + 1 : 1;
  const id = `T${String(state.tick).padStart(6, "0")}-${agent.id}`;
  const name = `${rng.pick(artifactWords[material])} ${rng.pick(formWords)}`;
  const performance = artifactPerformance(
    material,
    controller,
    tileAt(state, agent.x, agent.y),
    rng,
  );
  const artifact: Artifact = {
    id,
    name,
    x: agent.x,
    y: agent.y,
    material,
    health: 1,
    performance,
    generation,
    parentId: canFork ? parent.id : undefined,
    creatorId: agent.id,
    authors: canFork ? [...new Set([...parent.authors, agent.id])].slice(-6) : [agent.id],
    contributors: [agent.id],
    adopters: [],
    controller,
    builtAt: state.tick,
    uses: 0,
    validated: performance >= 0.57,
  };
  state.discoveryFrontierPerformance = Math.max(state.discoveryFrontierPerformance, performance);
  agent.inventory[material] -= 5;
  agent.inventory.water -= 1.5;
  agent.builds += 1;
  agent.mode = canFork ? "forking" : "fabricating";
  agent.forkedProgramId = canFork ? parent.id : undefined;
  state.artifacts.push(artifact);
  if (state.artifacts.length > 140) {
    const retired = state.artifacts.findIndex((candidate) => candidate.health <= 0.08);
    state.artifacts.splice(retired >= 0 ? retired : 0, 1);
  }
  addEvent(
    state,
    canFork ? "fork" : "build",
    canFork
      ? `${agent.name} forked ${parent.name} → ${name} · gen ${generation}`
      : `${agent.name} built ${name}${artifact.validated ? " · validated" : ""}`,
    artifact.x,
    artifact.y,
  );
  return true;
}

function inspectOrMaintain(agent: Agent, state: WorldState, rng: Rng, repair: boolean): boolean {
  const artifact = nearest(agent, state.artifacts);
  if (!artifact || distanceSquared(agent, artifact) > 5) return false;
  artifact.uses += 1;
  agent.artifactsTouched += 1;
  if (agent.id !== artifact.creatorId && !artifact.adopters.includes(agent.id))
    artifact.adopters.push(agent.id);
  if (repair && agent.inventory.water >= 0.2) {
    artifact.health = Math.min(1, artifact.health + 0.055);
    agent.inventory.water -= 0.2;
    if (!artifact.contributors.includes(agent.id)) artifact.contributors.push(agent.id);
    agent.mode = "maintaining";
    if (rng.chance(0.02))
      addEvent(state, "repair", `${agent.name} restored ${artifact.name}`, artifact.x, artifact.y);
  } else {
    agent.mode = "forking";
    agent.forkedProgramId = artifact.id;
    agent.directive = {
      ...agent.directive,
      targetMaterial: artifact.material,
      controllerAction: artifact.controller.action,
      goal: "build",
      note: `observed ${artifact.id} in the world`,
      source: "instinct",
    };
  }
  return true;
}

function executeAgentScript(agent: Agent, state: WorldState, rng: Rng): boolean {
  for (const instruction of agent.script.program) {
    if (instruction === "scan-local") {
      agent.script.lastResult = `scanned ${tileAt(state, agent.x, agent.y).terrain}`;
      continue;
    }
    if (instruction === "gather-local" && gather(agent, state, rng)) {
      agent.script.lastResult = "gathered local material";
      return true;
    }
    if (instruction === "build-local" && build(agent, state, rng)) {
      agent.script.lastResult = "constructed an artifact";
      return true;
    }
    if (instruction === "inspect-local" && inspectOrMaintain(agent, state, rng, false)) {
      agent.script.lastResult = "inspected an artifact";
      return true;
    }
    if (instruction === "repair-local" && inspectOrMaintain(agent, state, rng, true)) {
      agent.script.lastResult = "maintained an artifact";
      return true;
    }
    if (instruction === "seek-resource") {
      stepToward(agent, resourcePosition(state, agent.directive.targetMaterial, agent), rng);
      agent.mode = "surveying";
      agent.script.lastResult = `seeking ${agent.directive.targetMaterial}`;
      return true;
    }
    if (instruction === "seek-station") {
      const station = nearest(agent, state.stations);
      if (!station) continue;
      stepToward(agent, station, rng);
      agent.mode = "surveying";
      agent.script.lastResult = `seeking ${station.kind}`;
      return true;
    }
    if (instruction === "seek-artifact") {
      const artifact = nearest(agent, state.artifacts);
      if (!artifact) continue;
      stepToward(agent, artifact, rng);
      agent.mode = "surveying";
      agent.script.lastResult = `seeking ${artifact.id}`;
      return true;
    }
    if (instruction === "roam") {
      roam(agent, rng);
      agent.mode = "surveying";
      agent.script.lastResult = "surveyed a neighboring tile";
      return true;
    }
  }
  agent.script.lastResult = "no program precondition passed";
  return false;
}

function advanceAgent(agent: Agent, state: WorldState, rng: Rng): void {
  if ((state.tick + Number(agent.id.slice(1))) % 18 === 0) {
    agent.directive = {
      ...agent.directive,
      goal: chooseGoal(agent, state, rng),
      targetMaterial: rng.pick(materials),
      controllerAction: rng.pick(controllerActions),
      source: "instinct",
    };
  }
  const acted = executeAgentScript(agent, state, rng);
  agent.energy -= acted ? 0.0012 : 0.002;
  if (agent.energy <= 0.14) {
    agent.directive = {
      ...agent.directive,
      goal: "gather",
      targetMaterial: "water",
      source: "instinct",
    };
  }
  if (agent.energy <= 0) {
    agent.energy = 0.42;
    agent.inventory = emptyInventory();
    agent.directive = instinctDirective(rng);
    addEvent(
      state,
      "failure",
      `${agent.name} rebooted after resource exhaustion`,
      agent.x,
      agent.y,
    );
  }
  recordTrail(agent, state);
}

function sensorValue(artifact: Artifact, tile: Tile): number {
  if (artifact.controller.sensor === "contamination") return tile.contamination;
  if (artifact.controller.sensor === "health") return 1 - artifact.health;
  if (artifact.controller.sensor === "nutrients") return 1 - tile.richness;
  return 1 - tile.moisture;
}

function advanceArtifacts(state: WorldState, rng: Rng): void {
  for (const artifact of state.artifacts) {
    const tile = tileAt(state, artifact.x, artifact.y);
    artifact.health = Math.max(0, artifact.health - 0.0007 - tile.contamination * 0.0009);
    if (sensorValue(artifact, tile) < artifact.controller.threshold || artifact.health <= 0.05)
      continue;
    const strength = artifact.performance * artifact.health * 0.018;
    if (artifact.controller.action === "collect-water")
      tile.moisture = Math.min(1, tile.moisture + strength);
    if (artifact.controller.action === "remediate")
      tile.contamination = Math.max(0, tile.contamination - strength);
    if (artifact.controller.action === "heal")
      artifact.health = Math.min(1, artifact.health + strength * 0.8);
    if (artifact.controller.action === "grow")
      tile.richness = Math.min(1, tile.richness + strength * 0.5);
    if (artifact.controller.action === "signal" && rng.chance(0.03)) {
      const agent = nearest(artifact, state.agents);
      if (agent) agent.directive = { ...agent.directive, goal: "inspect", source: "instinct" };
    }
  }
}

function advanceEnvironment(state: WorldState): void {
  const phase = state.tick / 260;
  for (let index = state.tick % 23; index < state.terrain.length; index += 23) {
    const tile = state.terrain[index];
    if (!tile) continue;
    const x = index % WORLD_WIDTH;
    const y = Math.floor(index / WORLD_WIDTH);
    const storm = Math.sin(x * 0.12 + phase) * Math.cos(y * 0.09 - phase * 0.7);
    tile.moisture = Math.max(0.03, Math.min(1, tile.moisture + storm * 0.0008));
    tile.contamination = Math.max(
      0,
      Math.min(1, tile.contamination + Math.max(0, storm) * 0.00022 - 0.00005),
    );
    tile.richness = Math.min(1, tile.richness + 0.00008);
  }
}

export function advanceWorld(state: WorldState, steps = 1): WorldState {
  ensureAgentOperatingSystem(state);
  const rng = new Rng(state.rngState);
  for (let step = 0; step < steps; step += 1) {
    const frontierBefore = state.discoveryFrontierPerformance;
    state.tick += 1;
    advanceEnvironment(state);
    advanceArtifacts(state, rng);
    for (const agent of state.agents) {
      if (agent.energy <= 0.14) {
        agent.directive = {
          ...agent.directive,
          goal: "gather",
          targetMaterial: "water",
          actionId: "forage",
          source: "instinct",
        };
      }
      const tile = tileAt(state, agent.x, agent.y);
      const heard = agent.heardMessages.at(-1);
      updateAgentScript(
        agent,
        state.actionLibrary,
        state.tick,
        `${tile.terrain}; energy ${Math.round(agent.energy * 100)}%; ${agent.artifactsTouched} artifact contacts${heard ? `; heard ${heard.fromId}: “${heard.text}”` : ""}`,
      );
      advanceAgent(agent, state, rng);
    }
    if (state.tick % 4 === 0) {
      const speaker = state.agents[Math.floor(state.tick / 4) % state.agents.length];
      if (speaker) deliverSpeech(state, speaker.id, localSpeech(state, speaker));
    }
    state.discoveryFrontierArea += (frontierBefore + state.discoveryFrontierPerformance) / 2;
    state.discoveryFrontierTrackedTicks += 1;
    if (state.tick % 12 === 0) state.metrics = calculateMetrics(state);
  }
  state.rngState = rng.snapshot;
  state.lastAdvancedAt = Date.now();
  return state;
}

export function applyDirective(
  state: WorldState,
  agentId: string,
  directive: AgentDirective,
  extensionFacilitated = false,
): boolean {
  if (!goals.includes(directive.goal)) return false;
  if (!materials.includes(directive.targetMaterial)) return false;
  if (!controllerActions.includes(directive.controllerAction)) return false;
  const agent = state.agents.find((candidate) => candidate.id === agentId);
  if (!agent) return false;
  let actionId = directive.actionId;
  let proposal: AgentActionDefinition | undefined;
  if (extensionFacilitated && directive.actionProposal) {
    proposal = registerAction(state.actionLibrary, directive.actionProposal, agent.id, state.tick);
    if (proposal) {
      actionId = proposal.id;
      if (!agent.knownActionIds.includes(proposal.id)) agent.knownActionIds.push(proposal.id);
      addEvent(
        state,
        "discovery",
        `${agent.name} authored ${proposal.icon} ${proposal.name}: ${proposal.algorithm.slice(0, 70)}`,
        agent.x,
        agent.y,
      );
    }
  }
  if (!agent.knownActionIds.includes(actionId ?? "")) actionId = actionIdForGoal(directive.goal);
  const icon = assignableActionIcons.includes(
    directive.icon as (typeof assignableActionIcons)[number],
  )
    ? directive.icon
    : undefined;
  agent.directive = {
    ...directive,
    actionId,
    icon,
    actionProposal: proposal
      ? {
          name: proposal.name,
          icon: proposal.icon,
          algorithm: proposal.algorithm,
          program: proposal.program,
        }
      : undefined,
    note: directive.note.slice(0, 120),
    speech: directive.speech ? normalizeSpeech(directive.speech) : undefined,
  };
  agent.lastDecisionTick = state.tick;
  if (agent.directive.speech) deliverSpeech(state, agent.id, agent.directive.speech);
  addEvent(
    state,
    "decision",
    `${agent.name} chose ${directive.goal}: ${directive.note.slice(0, 58)}`,
    agent.x,
    agent.y,
  );
  return true;
}

export function chooseDecisionAgents(state: WorldState, count: number): Agent[] {
  return [...state.agents]
    .sort(
      (a, b) =>
        a.lastDecisionTick - b.lastDecisionTick || b.energy - a.energy || a.id.localeCompare(b.id),
    )
    .slice(0, Math.max(1, Math.floor(count)));
}

export function chooseDecisionAgent(state: WorldState): Agent {
  return chooseDecisionAgents(state, 1)[0] ?? state.agents[0]!;
}

export function decisionObservation(state: WorldState, agent: Agent): Record<string, unknown> {
  const tile = tileAt(state, agent.x, agent.y);
  const visibleArtifacts = state.artifacts
    .filter((artifact) => distanceSquared(agent, artifact) <= 36)
    .slice(0, 5)
    .map((artifact) => ({
      id: artifact.id,
      material: artifact.material,
      performance: Number(artifact.performance.toFixed(2)),
      generation: artifact.generation,
      action: artifact.controller.action,
      distance: Number(Math.sqrt(distanceSquared(agent, artifact)).toFixed(1)),
    }));
  return {
    tick: state.tick,
    agent: { id: agent.id, name: agent.name },
    position: { x: agent.x, y: agent.y },
    localTerrain: tile.terrain,
    localMoisture: Number(tile.moisture.toFixed(2)),
    localContamination: Number(tile.contamination.toFixed(2)),
    energy: Number(agent.energy.toFixed(2)),
    inventory: Object.fromEntries(
      Object.entries(agent.inventory).map(([key, value]) => [key, Number(value.toFixed(1))]),
    ),
    visibleArtifacts,
    knownStations: state.stations.filter((station) => distanceSquared(agent, station) <= 100),
    previousPlan: agent.directive,
    operatingFiles: agent.documents,
    heardSpeech: agent.heardMessages.slice(-4),
    currentScript: agent.script,
    availableActions: state.actionLibrary
      .filter((action) => agent.knownActionIds.includes(action.id))
      .slice(-12)
      .map(({ id, name, icon, algorithm, program }) => ({ id, name, icon, algorithm, program })),
  };
}

export function balancedPortfolioScore(coverage: readonly number[]): number {
  if (!coverage.length) return 0;
  const mean = coverage.reduce((total, value) => total + value, 0) / coverage.length;
  if (mean <= 0) return 0;
  const balance = Math.min(...coverage) / mean;
  return mean * (0.5 + 0.5 * balance);
}

export function calculateMetrics(state: WorldState): WorldMetrics {
  const validated = state.artifacts.filter(
    (artifact) => artifact.validated && artifact.health > 0.1,
  );
  const maxDepth = state.artifacts.reduce(
    (maximum, artifact) => Math.max(maximum, artifact.generation),
    0,
  );
  const centered = state.agents.filter((agent) => {
    const artifact = nearest(agent, state.artifacts);
    return artifact ? isArtifactContact(agent, artifact) : false;
  }).length;
  const serviceCoverage = controllerActions.map((action) =>
    state.artifacts
      .filter((artifact) => artifact.health > 0.1 && artifact.controller.action === action)
      .reduce((best, artifact) => Math.max(best, artifact.performance * artifact.health), 0),
  );
  const reused = state.artifacts.filter((artifact) => artifact.adopters.length > 0).length;
  const pathLength = state.agents.reduce((total, agent) => total + agent.trajectory.pathLength, 0);
  const regionsVisited = state.agents.reduce(
    (total, agent) => total + agent.trajectory.regionsVisited.length,
    0,
  );
  const contactTicks = state.agents.reduce(
    (total, agent) => total + agent.trajectory.artifactContactTicks,
    0,
  );
  const observedTicks = state.agents.reduce(
    (total, agent) => total + agent.trajectory.observedTicks,
    0,
  );
  const occupancy = new Map<string, number>();
  for (const agent of state.agents) {
    const region = trajectoryRegion(agent);
    occupancy.set(region, (occupancy.get(region) ?? 0) + 1);
  }
  const entropy = state.agents.length
    ? [...occupancy.values()].reduce((total, count) => {
        const probability = count / state.agents.length;
        return total - probability * Math.log(probability);
      }, 0)
    : 0;
  const maximumEntropy = Math.log(Math.min(100, Math.max(1, state.agents.length)));
  return {
    activeAgents: state.agents.filter((agent) => agent.energy > 0).length,
    artifacts: state.artifacts.length,
    bestArtifactPerformance: state.artifacts
      .filter((artifact) => artifact.health > 0.1)
      .reduce((best, artifact) => Math.max(best, artifact.performance), 0),
    discoveryFrontierPerformance: state.discoveryFrontierPerformance,
    discoveryFrontierAuc: state.discoveryFrontierTrackedTicks
      ? Math.min(
          state.discoveryFrontierPerformance,
          state.discoveryFrontierArea / state.discoveryFrontierTrackedTicks,
        )
      : 0,
    validatedInventions: validated.length,
    forkDepth: maxDepth,
    artifactCenteredFraction: state.agents.length ? centered / state.agents.length : 0,
    portfolioResilience: balancedPortfolioScore(serviceCoverage),
    physicalReuseFraction: state.artifacts.length ? reused / state.artifacts.length : 0,
    openRouterCalls: state.llm.totalCalls,
    openRouterCost: state.llm.totalCost,
    meanPathLength: state.agents.length ? pathLength / state.agents.length : 0,
    meanRegionsVisited: state.agents.length ? regionsVisited / state.agents.length : 0,
    artifactContactRate: observedTicks ? contactTicks / observedTicks : 0,
    spatialEntropy: maximumEntropy ? entropy / maximumEntropy : 0,
  };
}

export function publicSnapshot(
  state: WorldState,
  openRouterEnabled: boolean,
  model = "openrouter/free",
  nullclawPolicy = true,
): PublicWorldSnapshot {
  state.metrics = calculateMetrics(state);
  return {
    ...structuredClone(state),
    engine: {
      mode: openRouterEnabled ? "openrouter-assisted" : "deterministic",
      model,
      nullclawPolicy,
      sandbox: "nullclaw-wasm-dsl",
    },
  };
}
