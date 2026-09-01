import { hashNoise, Rng, toroidalField } from "./rng";
import { generateAgentName } from "./names";
import {
  actionIdForGoal,
  assignableActionIcons,
  baseActionLibrary,
  initialDocuments,
  initialScript,
  normalizeActionLibrary,
  registerAction,
  updateAgentScript,
  validateActionProposal,
} from "./action-sandbox";
import {
  AGENT_COUNT,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type Agent,
  type AgentDirective,
  type AgentGoal,
  type Artifact,
  type ArtifactSpecification,
  type Controller,
  type ControllerAction,
  type CraftingTarget,
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
const goals: readonly AgentGoal[] = [
  "explore",
  "gather",
  "build",
  "inspect",
  "maintain",
  "craft",
  "create",
];
export const ARTIFACT_CONTACT_RADIUS = 3;
export const MODEL_MACROTURN_INTERVAL_TICKS = 60;
export const CREATIVE_SESSION_COOLDOWN_TICKS = 600;
export const CREATIVE_CURIOSITY_THRESHOLD = 0.68;
const CURIOSITY_PER_TICK = 1 / 3_600;
const CRAFT_INGREDIENT_COST = 2;
const CARRIED_WATER_SIP = 0.02;
const CARRIED_WATER_ENERGY = 0.32;
const PROCESSING_RADIUS_SQUARED = 2;
const ARTIFACT_STORAGE_CAPACITY = 2;
const INITIAL_ARTIFACT_RESERVE = 1.5;
const processingStationForMaterial: Record<MaterialKind, Station["kind"]> = {
  water: "wash",
  fungus: "assay",
  mineral: "foundry",
  cellulose: "weave",
  chitin: "grind",
};
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
    crafts: 0,
    curiosity: (index % 17) / 28,
    lastCreativeTick: -CREATIVE_SESSION_COOLDOWN_TICKS,
    materialPurposes: {},
    directive: initialDirective(),
    lastDecisionTick: 0,
    decisionPhase: decisionPhaseForAgent(id),
    nextDecisionTick: nextScheduledDecisionTick(0, decisionPhaseForAgent(id)),
    scriptCursor: 0,
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
    version: 6,
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
  state.version = 6;
  state.actionLibrary ??= [];
  const aliases = normalizeActionLibrary(state.actionLibrary);
  state.messages ??= [];
  const priorArtifacts: Artifact[] = [];
  for (const artifact of state.artifacts) {
    artifact.creatorId ??=
      artifact.id.match(/-(A\d{3})$/u)?.[1] ?? artifact.authors.at(-1) ?? artifact.authors[0]!;
    artifact.adopters ??= [];
    artifact.contributors ??= [artifact.creatorId];
    artifact.storedWater ??= 0;
    artifact.reserve ??= INITIAL_ARTIFACT_RESERVE;
    artifact.flux ??= {
      waterCollected: 0,
      contaminationRemoved: 0,
      reserveConsumed: 0,
      maintenanceInput: 0,
    };
    artifact.fluxTrackingStartedTick ??= state.tick;
    artifact.validation ??= artifactValidationEvidence(artifact, priorArtifacts);
    artifact.validated = Object.values(artifact.validation).every(Boolean);
    priorArtifacts.push(artifact);
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
    agent.decisionPhase = Number.isInteger(agent.decisionPhase)
      ? ((agent.decisionPhase % MODEL_MACROTURN_INTERVAL_TICKS) + MODEL_MACROTURN_INTERVAL_TICKS) %
        MODEL_MACROTURN_INTERVAL_TICKS
      : decisionPhaseForAgent(agent.id);
    agent.nextDecisionTick =
      Number.isInteger(agent.nextDecisionTick) && agent.nextDecisionTick > state.tick
        ? agent.nextDecisionTick
        : nextScheduledDecisionTick(state.tick, agent.decisionPhase);
    agent.scriptCursor = Number.isInteger(agent.scriptCursor) ? Math.max(0, agent.scriptCursor) : 0;
    agent.crafts ??= 0;
    agent.curiosity = Number.isFinite(agent.curiosity)
      ? Math.max(0, Math.min(1, agent.curiosity))
      : ((Number(agent.id.slice(1)) - 1) % 17) / 28;
    agent.lastCreativeTick ??= state.tick - CREATIVE_SESSION_COOLDOWN_TICKS;
    agent.materialPurposes ??= {};
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

export function decisionPhaseForAgent(
  agentId: string,
  interval = MODEL_MACROTURN_INTERVAL_TICKS,
): number {
  const ordinal = Number(agentId.slice(1));
  if (!Number.isInteger(ordinal) || ordinal < 1) return 0;
  return Math.floor(((ordinal - 1) * interval) / AGENT_COUNT);
}

export function nextScheduledDecisionTick(
  currentTick: number,
  phase: number,
  interval = MODEL_MACROTURN_INTERVAL_TICKS,
): number {
  const normalizedPhase = ((phase % interval) + interval) % interval;
  const delta = (normalizedPhase - (currentTick % interval) + interval) % interval;
  return currentTick + (delta === 0 ? interval : delta);
}

export function decisionAgentsDue(
  state: WorldState,
  candidateTick: number,
  interval = MODEL_MACROTURN_INTERVAL_TICKS,
): Agent[] {
  return state.agents
    .filter(
      (agent) =>
        agent.nextDecisionTick === candidateTick &&
        (candidateTick - agent.decisionPhase) % interval === 0,
    )
    .sort((a, b) => a.id.localeCompare(b.id));
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
    operationalWaterCollected: 0,
    operationalContaminationRemoved: 0,
    operationalReserveConsumed: 0,
    maintenanceMaterialInput: 0,
  };
}

function addEvent(
  state: WorldState,
  kind: WorldEvent["kind"],
  text: string,
  x: number,
  y: number,
  tick = state.tick,
): void {
  state.events.unshift({
    id: `${tick}-${state.rngState}-${state.events.length}`,
    tick,
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

export function deliverSpeech(
  state: WorldState,
  fromId: string,
  rawSpeech: string,
  tick = state.tick,
): boolean {
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
  recipient.heardMessages.push({ tick, fromId, text });
  recipient.heardMessages = recipient.heardMessages.slice(-4);
  state.messages.unshift({
    id: `M${tick}-${fromId}-${recipient.id}-${state.messages.length}`,
    tick,
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

function resourcePosition(
  state: WorldState,
  material: MaterialKind,
  agent: Agent,
): { x: number; y: number } {
  const identitySeed = state.seed ^ (Number(agent.id.slice(1)) || 1);
  let bestViable: { x: number; y: number } | undefined;
  let bestViableScore = Number.POSITIVE_INFINITY;
  let richestFallback: { x: number; y: number } | undefined;
  let richestFallbackValue = Number.NEGATIVE_INFINITY;
  let richestFallbackDistance = Number.POSITIVE_INFINITY;
  for (let y = 0; y < WORLD_HEIGHT; y += 2) {
    for (let x = 0; x < WORLD_WIDTH; x += 2) {
      const tile = tileAt(state, x, y);
      if (materialForTerrain[tile.terrain] !== material) continue;
      const point = { x, y };
      const distance = distanceSquared(agent, point);
      if (
        tile.richness > richestFallbackValue ||
        (tile.richness === richestFallbackValue && distance < richestFallbackDistance)
      ) {
        richestFallback = point;
        richestFallbackValue = tile.richness;
        richestFallbackDistance = distance;
      }
      if (tile.richness < 0.12) continue;
      const score = distance + (1 - tile.richness) * 3 + hashNoise(identitySeed, x, y) * 2;
      if (score < bestViableScore) {
        bestViable = point;
        bestViableScore = score;
      }
    }
  }
  return bestViable ?? richestFallback ?? { x: agent.x, y: agent.y };
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
  if (!agent.materialPurposes[material] && materialStockSatisfied(agent, material)) return false;
  const amount = Math.min(tile.richness, 0.45 + rng.next() * 0.45);
  agent.inventory[material] += amount;
  tile.richness = Math.max(0.02, tile.richness - amount * 0.035);
  agent.mode = "harvesting";
  if (agent.craftingTarget?.ingredients.includes(material)) {
    agent.materialPurposes[material] = agent.craftingTarget.purpose;
  }
  if (rng.chance(0.035)) {
    agent.discoveries += 1;
    addEvent(state, "discovery", `${agent.name} mapped a rich ${material} seam`, agent.x, agent.y);
  }
  return true;
}

function materialStockTarget(agent: Agent, material: MaterialKind): number {
  if (material === "water") return agent.energy < 0.55 ? 4 : 3;
  return 6;
}

function materialStockSatisfied(agent: Agent, material: MaterialKind): boolean {
  return agent.inventory[material] >= materialStockTarget(agent, material);
}

function mostNeededMaterial(agent: Agent): MaterialKind {
  const ordinal = Number(agent.id.slice(1));
  const offset = Number.isInteger(ordinal) && ordinal > 0 ? (ordinal - 1) % materials.length : 0;
  const rotated = [...materials.slice(offset), ...materials.slice(0, offset)];
  return rotated.reduce((needed, material) => {
    const pressure = agent.inventory[material] / materialStockTarget(agent, material);
    const neededPressure = agent.inventory[needed] / materialStockTarget(agent, needed);
    return pressure < neededPressure ? material : needed;
  });
}

function sustainFromCarriedWater(agent: Agent): void {
  if (agent.energy >= 0.72 || agent.inventory.water <= 0) return;
  const sip = Math.min(CARRIED_WATER_SIP, agent.inventory.water);
  agent.inventory.water -= sip;
  agent.energy = Math.min(1, agent.energy + sip * CARRIED_WATER_ENERGY);
}

function craftingRequirement(
  ingredients: [MaterialKind, MaterialKind],
  material: MaterialKind,
): number {
  return ingredients.filter((ingredient) => ingredient === material).length * CRAFT_INGREDIENT_COST;
}

export function missingCraftingMaterial(agent: Agent): MaterialKind | undefined {
  const target = agent.craftingTarget;
  if (!target) return undefined;
  return [...new Set(target.ingredients)].find(
    (material) => agent.inventory[material] < craftingRequirement(target.ingredients, material),
  );
}

function clearCraftingPurpose(agent: Agent, target: CraftingTarget): void {
  for (const material of new Set(target.ingredients)) delete agent.materialPurposes[material];
}

function consumeCraftingMaterials(agent: Agent, target: CraftingTarget): void {
  for (const material of materials) {
    agent.inventory[material] -= craftingRequirement(target.ingredients, material);
  }
}

export function completeCrafting(agent: Agent, state: WorldState): boolean {
  const target = agent.craftingTarget;
  if (!target || missingCraftingMaterial(agent)) return false;

  if (target.mode === "creative") {
    const proposal = target.proposal;
    const action = proposal
      ? registerAction(state.actionLibrary, proposal, agent.id, state.tick, target.ingredients)
      : undefined;
    consumeCraftingMaterials(agent, target);
    clearCraftingPurpose(agent, target);
    agent.craftingTarget = undefined;
    agent.lastCreativeTick = state.tick;
    if (!action) {
      agent.script.lastResult = "mix reproduced an existing behavior";
      agent.documents.memoryMd =
        `# MEMORY.md\nT${state.tick}: Tested ${target.ingredients.join(" + ")} for ${target.actionName}. ` +
        "The materials were consumed, but no novel behavior was built; curiosity remains.";
      addEvent(
        state,
        "creative",
        `${agent.name} tested ${target.ingredients.join(" + ")} · no novel behavior`,
        agent.x,
        agent.y,
      );
      return true;
    }
    if (!agent.knownActionIds.includes(action.id)) agent.knownActionIds.push(action.id);
    agent.directive.actionId = action.id;
    agent.discoveries += 1;
    agent.crafts += 1;
    agent.curiosity = 0;
    agent.mode = "creating";
    agent.documents.memoryMd =
      `# MEMORY.md\nT${state.tick}: Built ${action.name} from ${target.ingredients.join(" + ")}. ` +
      `The materials were stored to ${target.purpose}.`;
    addEvent(
      state,
      "creative",
      `${agent.name} mixed ${target.ingredients.join(" + ")} → ${action.icon} ${action.name}`,
      agent.x,
      agent.y,
    );
    return true;
  }

  const action = state.actionLibrary.find(
    (candidate) => candidate.id === target.actionId && candidate.recipe,
  );
  if (!action) {
    clearCraftingPurpose(agent, target);
    agent.craftingTarget = undefined;
    agent.documents.memoryMd =
      `# MEMORY.md\nT${state.tick}: Could not craft ${target.actionName}; its shared recipe was no longer available. ` +
      "Reserved materials were released and curiosity remains.";
    addEvent(
      state,
      "failure",
      `${agent.name} released an unavailable recipe for ${target.actionName}`,
      agent.x,
      agent.y,
    );
    return true;
  }
  consumeCraftingMaterials(agent, target);
  clearCraftingPurpose(agent, target);
  agent.craftingTarget = undefined;
  if (!agent.knownActionIds.includes(action.id)) agent.knownActionIds.push(action.id);
  agent.crafts += 1;
  agent.curiosity = 0;
  agent.mode = "crafting";
  agent.documents.memoryMd =
    `# MEMORY.md\nT${state.tick}: Crafted ${action.name} from ${target.ingredients.join(" + ")}. ` +
    `The materials were stored to ${target.purpose}.`;
  addEvent(
    state,
    "craft",
    `${agent.name} crafted ${action.icon} ${action.name} from ${target.ingredients.join(" + ")}`,
    agent.x,
    agent.y,
  );
  return true;
}

function canBuild(agent: Agent): MaterialKind | undefined {
  return materials
    .filter((material) => material !== "water")
    .sort((a, b) => agent.inventory[b] - agent.inventory[a])
    .find((material) => agent.inventory[material] >= 5 && agent.inventory.water >= 1.5);
}

function nearestProcessingStation(
  agent: Agent,
  state: WorldState,
  material: MaterialKind,
): Station | undefined {
  const requiredKind = processingStationForMaterial[material];
  return nearest(
    agent,
    state.stations.filter((station) => station.kind === requiredKind),
  );
}

export function controllerBehaviorSignature(controller: Controller): string {
  return `${controller.sensor}:${controller.action}:${Math.round(controller.threshold * 10)}`;
}

function hasCompleteSpecification(specification: ArtifactSpecification | undefined): boolean {
  return Boolean(
    specification &&
    specification.name.trim() &&
    specification.claimedFunction.trim() &&
    specification.architecture.trim() &&
    specification.bioInspiration.trim() &&
    specification.predictedEffects.trim(),
  );
}

function sanitizeArtifactSpecification(
  specification: ArtifactSpecification | undefined,
): ArtifactSpecification | undefined {
  if (!hasCompleteSpecification(specification)) return undefined;
  return {
    name: specification!.name.trim().slice(0, 40),
    claimedFunction: specification!.claimedFunction.trim().slice(0, 140),
    architecture: specification!.architecture.trim().slice(0, 140),
    bioInspiration: specification!.bioInspiration.trim().slice(0, 100),
    predictedEffects: specification!.predictedEffects.trim().slice(0, 140),
  };
}

export function artifactValidationEvidence(
  artifact: Artifact,
  priorArtifacts: readonly Artifact[],
): NonNullable<Artifact["validation"]> {
  const signature = controllerBehaviorSignature(artifact.controller);
  return {
    testedMaterial:
      Number.isFinite(artifact.performance) &&
      artifact.performance >= 0 &&
      artifact.performance <= 1,
    completeSpecification: hasCompleteSpecification(artifact.specification),
    installedAgentController:
      /^A\d{3}$/u.test(artifact.creatorId) && artifact.controller.revision >= 1,
    performanceThreshold: artifact.performance >= 0.57,
    processProvenance: Boolean(artifact.stationId && artifact.process),
    behaviorallyNovel: !priorArtifacts.some(
      (candidate) => controllerBehaviorSignature(candidate.controller) === signature,
    ),
  };
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
  const station = nearestProcessingStation(agent, state, material);
  if (!station || distanceSquared(agent, station) > PROCESSING_RADIUS_SQUARED) return false;
  const parent = nearest(agent, state.artifacts);
  const canFork = parent && distanceSquared(agent, parent) <= 16 && parent.authors[0] !== agent.id;
  const controller = controllerFor(agent, canFork ? parent : undefined, rng);
  const generation = canFork ? parent.generation + 1 : 1;
  const id = `T${String(state.tick).padStart(6, "0")}-${agent.id}`;
  const specification = sanitizeArtifactSpecification(agent.directive.artifactSpecification);
  const name = specification?.name ?? `${rng.pick(artifactWords[material])} ${rng.pick(formWords)}`;
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
    stationId: station.id,
    process: station.kind,
    specification,
    storedWater: 0,
    reserve: INITIAL_ARTIFACT_RESERVE,
    flux: {
      waterCollected: 0,
      contaminationRemoved: 0,
      reserveConsumed: 0,
      maintenanceInput: 0,
    },
    fluxTrackingStartedTick: state.tick,
    builtAt: state.tick,
    uses: 0,
    validated: false,
  };
  artifact.validation = artifactValidationEvidence(artifact, state.artifacts);
  artifact.validated = Object.values(artifact.validation).every(Boolean);
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
      ? `${agent.name} forked ${parent.name} → ${name} at ${station.kind} · gen ${generation}`
      : `${agent.name} built ${name} at ${station.kind}${artifact.validated ? " · validated" : ""}`,
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
    artifact.flux!.maintenanceInput += 0.2;
    if (!artifact.contributors.includes(agent.id)) artifact.contributors.push(agent.id);
    agent.mode = "maintaining";
    if (rng.chance(0.02))
      addEvent(state, "repair", `${agent.name} restored ${artifact.name}`, artifact.x, artifact.y);
  } else {
    agent.mode = "forking";
    agent.forkedProgramId = artifact.id;
  }
  return true;
}

function executeAgentScript(agent: Agent, state: WorldState, rng: Rng): boolean {
  if (!agent.script.program.length) {
    agent.script.lastResult = "activity has no bounded primitives";
    return false;
  }
  const index = agent.scriptCursor % agent.script.program.length;
  const instruction = agent.script.program[index]!;
  agent.scriptCursor = (index + 1) % agent.script.program.length;
  if (instruction === "scan-local") {
    agent.script.lastResult = `scanned ${tileAt(state, agent.x, agent.y).terrain}`;
    return true;
  }
  if (instruction === "gather-local") {
    if (gather(agent, state, rng)) {
      agent.script.lastResult = "gathered local material";
      return true;
    }
  } else if (instruction === "build-local") {
    if (build(agent, state, rng)) {
      agent.script.lastResult = "constructed an artifact";
      return true;
    }
  } else if (instruction === "inspect-local") {
    if (inspectOrMaintain(agent, state, rng, false)) {
      agent.script.lastResult = "inspected an artifact";
      return true;
    }
  } else if (instruction === "repair-local") {
    if (inspectOrMaintain(agent, state, rng, true)) {
      agent.script.lastResult = "maintained an artifact";
      return true;
    }
  } else if (instruction === "craft-local" || instruction === "mix-local") {
    const expectedMode = instruction === "mix-local" ? "creative" : "craft";
    const craftsBefore = agent.crafts;
    if (agent.craftingTarget?.mode === expectedMode && completeCrafting(agent, state)) {
      agent.script.lastResult =
        agent.crafts > craftsBefore
          ? expectedMode === "creative"
            ? "built a novel action"
            : "crafted a known action"
          : "tested a material mix without novelty";
      return true;
    }
  } else if (instruction === "seek-crafting-material") {
    const material = missingCraftingMaterial(agent);
    if (material) {
      agent.directive.targetMaterial = material;
      stepToward(agent, resourcePosition(state, material, agent), rng);
      agent.mode = agent.craftingTarget?.mode === "creative" ? "creating" : "crafting";
      agent.script.lastResult = `seeking ${material} for ${agent.craftingTarget?.actionName ?? "craft"}`;
      return true;
    }
  } else if (instruction === "seek-resource") {
    const buildMaterial = agent.directive.goal === "build" ? canBuild(agent) : undefined;
    if (buildMaterial) {
      const station = nearestProcessingStation(agent, state, buildMaterial);
      if (station) {
        stepToward(agent, station, rng);
        agent.mode = "fabricating";
        agent.script.lastResult = `carrying ${buildMaterial} to ${station.kind}`;
        return true;
      }
    }
    let material = agent.directive.targetMaterial;
    if (!agent.materialPurposes[material] && materialStockSatisfied(agent, material)) {
      material = mostNeededMaterial(agent);
      agent.directive.targetMaterial = material;
    }
    stepToward(agent, resourcePosition(state, material, agent), rng);
    agent.mode = "surveying";
    agent.script.lastResult = `seeking ${material}`;
    return true;
  } else if (instruction === "seek-station") {
    const material = canBuild(agent) ?? agent.directive.targetMaterial;
    const station = nearestProcessingStation(agent, state, material);
    if (station) {
      stepToward(agent, station, rng);
      agent.mode = "fabricating";
      agent.script.lastResult = `seeking ${station.kind} for ${material}`;
      return true;
    }
  } else if (instruction === "seek-artifact") {
    const artifact = nearest(agent, state.artifacts);
    if (artifact) {
      stepToward(agent, artifact, rng);
      agent.mode = "surveying";
      agent.script.lastResult = `seeking ${artifact.id}`;
      return true;
    }
  } else if (instruction === "roam") {
    roam(agent, rng);
    agent.mode = "surveying";
    agent.script.lastResult = "surveyed a neighboring tile";
    return true;
  }
  agent.script.lastResult = `${instruction} precondition failed`;
  return false;
}

function advanceAgent(agent: Agent, state: WorldState, rng: Rng): void {
  agent.curiosity = Math.min(1, agent.curiosity + CURIOSITY_PER_TICK);
  sustainFromCarriedWater(agent);
  const acted = executeAgentScript(agent, state, rng);
  agent.energy -= acted ? 0.0012 : 0.002;
  if (agent.energy <= 0) {
    agent.energy = 0.42;
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
    const flux = artifact.flux!;
    if (artifact.controller.action === "collect-water") {
      const amount = Math.min(
        strength,
        tile.moisture,
        Math.max(0, ARTIFACT_STORAGE_CAPACITY - artifact.storedWater!),
      );
      tile.moisture -= amount;
      artifact.storedWater! += amount;
      flux.waterCollected += amount;
    }
    if (artifact.controller.action === "remediate") {
      const amount = Math.min(strength, tile.contamination, artifact.reserve! * 2);
      const reserveUsed = amount * 0.5;
      tile.contamination -= amount;
      artifact.reserve! -= reserveUsed;
      flux.contaminationRemoved += amount;
      flux.reserveConsumed += reserveUsed;
    }
    if (artifact.controller.action === "heal") {
      const amount = Math.min(strength * 0.8, 1 - artifact.health, artifact.reserve!);
      artifact.health += amount;
      artifact.reserve! -= amount;
      flux.reserveConsumed += amount;
    }
    if (artifact.controller.action === "grow") {
      const amount = Math.min(strength * 0.5, 1 - tile.richness, artifact.reserve!);
      tile.richness += amount;
      artifact.reserve! -= amount;
      flux.reserveConsumed += amount;
    }
    if (artifact.controller.action === "signal" && rng.chance(0.03)) {
      const agent = nearest(artifact, state.agents);
      if (agent) agent.script.lastResult = `received signal from ${artifact.id}`;
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

export function advanceAgentFreeWorld(state: WorldState, steps = 1): WorldState {
  if (state.agents.length) throw new Error("Agent-free advancement requires an empty population");
  const rng = new Rng(state.rngState);
  for (let step = 0; step < steps; step += 1) {
    state.tick += 1;
    advanceEnvironment(state);
    advanceArtifacts(state, rng);
  }
  state.rngState = rng.snapshot;
  state.metrics = calculateMetrics(state);
  return state;
}

export function applyDirective(
  state: WorldState,
  agentId: string,
  directive: AgentDirective,
  extensionFacilitated = false,
  decisionTick = state.tick,
  interval = MODEL_MACROTURN_INTERVAL_TICKS,
): boolean {
  if (!goals.includes(directive.goal)) return false;
  if (!materials.includes(directive.targetMaterial)) return false;
  if (!controllerActions.includes(directive.controllerAction)) return false;
  const agent = state.agents.find((candidate) => candidate.id === agentId);
  if (!agent) return false;
  if (agent.nextDecisionTick !== decisionTick) return false;
  if (!agent.craftingTarget && directive.goal === "create") {
    const session = directive.creativeSession;
    const eligible =
      agent.curiosity >= CREATIVE_CURIOSITY_THRESHOLD &&
      decisionTick - agent.lastCreativeTick >= CREATIVE_SESSION_COOLDOWN_TICKS;
    if (
      extensionFacilitated &&
      eligible &&
      session &&
      validateActionProposal(session) &&
      session.ingredients.length === 2 &&
      session.ingredients.every((material) => materials.includes(material)) &&
      session.purpose.trim().length >= 8
    ) {
      agent.craftingTarget = {
        mode: "creative",
        actionName: session.name.trim(),
        ingredients: [...session.ingredients],
        purpose: session.purpose.trim().slice(0, 120),
        proposal: {
          name: session.name,
          icon: session.icon,
          algorithm: session.algorithm,
          program: [...session.program],
        },
        startedTick: decisionTick,
      };
      agent.lastCreativeTick = decisionTick;
      addEvent(
        state,
        "creative",
        `${agent.name} began a creative session: ${session.ingredients.join(" + ")} for ${session.name}`,
        agent.x,
        agent.y,
        decisionTick,
      );
    }
  }
  if (!agent.craftingTarget && directive.goal === "craft" && directive.craftActionId) {
    const action = state.actionLibrary.find(
      (candidate) =>
        candidate.id === directive.craftActionId &&
        candidate.recipe &&
        !agent.knownActionIds.includes(candidate.id),
    );
    if (action?.recipe) {
      agent.craftingTarget = {
        mode: "craft",
        actionId: action.id,
        actionName: action.name,
        ingredients: [...action.recipe],
        purpose: `learn and preserve ${action.name}`,
        startedTick: decisionTick,
      };
    }
  }

  let committedGoal = directive.goal;
  let actionId = directive.actionId;
  let targetMaterial = directive.targetMaterial;
  if (agent.craftingTarget) {
    committedGoal = agent.craftingTarget.mode === "creative" ? "create" : "craft";
    actionId = actionIdForGoal(committedGoal);
    targetMaterial = missingCraftingMaterial(agent) ?? agent.craftingTarget.ingredients[0];
    for (const material of new Set(agent.craftingTarget.ingredients)) {
      agent.materialPurposes[material] = agent.craftingTarget.purpose;
    }
  } else if (committedGoal === "craft" || committedGoal === "create") {
    committedGoal = "explore";
    actionId = "survey";
  }
  if (!agent.knownActionIds.includes(actionId ?? "")) actionId = actionIdForGoal(committedGoal);
  const icon = assignableActionIcons.includes(
    directive.icon as (typeof assignableActionIcons)[number],
  )
    ? directive.icon
    : undefined;
  agent.directive = {
    ...directive,
    goal: committedGoal,
    targetMaterial,
    actionId,
    icon,
    actionProposal: undefined,
    artifactSpecification:
      committedGoal === "build"
        ? sanitizeArtifactSpecification(directive.artifactSpecification)
        : undefined,
    note: directive.note.slice(0, 120),
    speech: directive.speech ? normalizeSpeech(directive.speech) : undefined,
  };
  const tile = tileAt(state, agent.x, agent.y);
  const heard = agent.heardMessages.at(-1);
  updateAgentScript(
    agent,
    state.actionLibrary,
    decisionTick,
    `${tile.terrain}; energy ${Math.round(agent.energy * 100)}%; ${agent.artifactsTouched} artifact contacts${heard ? `; heard ${heard.fromId}: “${heard.text}”` : ""}`,
  );
  agent.scriptCursor = 0;
  agent.lastDecisionTick = decisionTick;
  agent.nextDecisionTick = decisionTick + interval;
  if (agent.directive.speech) deliverSpeech(state, agent.id, agent.directive.speech, decisionTick);
  addEvent(
    state,
    "decision",
    `${agent.name} chose ${committedGoal}: ${directive.note.slice(0, 58)}`,
    agent.x,
    agent.y,
    decisionTick,
  );
  return true;
}

export function recordFailedDecision(
  state: WorldState,
  agentId: string,
  decisionTick: number,
  reason: string,
  interval = MODEL_MACROTURN_INTERVAL_TICKS,
): boolean {
  const agent = state.agents.find((candidate) => candidate.id === agentId);
  if (!agent || agent.nextDecisionTick !== decisionTick) return false;
  agent.lastDecisionTick = decisionTick;
  agent.nextDecisionTick = decisionTick + interval;
  addEvent(
    state,
    "failure",
    `${agent.name} kept ${agent.script.actionId}: ${reason.slice(0, 72)}`,
    agent.x,
    agent.y,
    decisionTick,
  );
  return true;
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
      process: artifact.process,
      stationId: artifact.stationId,
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
    curiosity: Number(agent.curiosity.toFixed(2)),
    creativeSessionEligible:
      !agent.craftingTarget &&
      agent.curiosity >= CREATIVE_CURIOSITY_THRESHOLD &&
      state.tick - agent.lastCreativeTick >= CREATIVE_SESSION_COOLDOWN_TICKS,
    inventory: Object.fromEntries(
      Object.entries(agent.inventory).map(([key, value]) => [key, Number(value.toFixed(1))]),
    ),
    materialPurposes: agent.materialPurposes,
    craftingTarget: agent.craftingTarget,
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
    craftableActions: state.actionLibrary
      .filter((action) => action.recipe && !agent.knownActionIds.includes(action.id))
      .slice(-12)
      .map(({ id, name, icon, recipe }) => ({ id, name, icon, recipe })),
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
  const fluxTotals = state.artifacts.reduce(
    (totals, artifact) => ({
      waterCollected: totals.waterCollected + (artifact.flux?.waterCollected ?? 0),
      contaminationRemoved:
        totals.contaminationRemoved + (artifact.flux?.contaminationRemoved ?? 0),
      reserveConsumed: totals.reserveConsumed + (artifact.flux?.reserveConsumed ?? 0),
      maintenanceInput: totals.maintenanceInput + (artifact.flux?.maintenanceInput ?? 0),
    }),
    { waterCollected: 0, contaminationRemoved: 0, reserveConsumed: 0, maintenanceInput: 0 },
  );
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
    operationalWaterCollected: fluxTotals.waterCollected,
    operationalContaminationRemoved: fluxTotals.contaminationRemoved,
    operationalReserveConsumed: fluxTotals.reserveConsumed,
    maintenanceMaterialInput: fluxTotals.maintenanceInput,
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
    diary: [],
    engine: {
      mode: openRouterEnabled ? "openrouter-assisted" : "deterministic",
      model,
      nullclawPolicy,
      sandbox: "nullclaw-wasm-dsl",
    },
  };
}
