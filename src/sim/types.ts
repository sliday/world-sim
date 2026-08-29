export const WORLD_WIDTH = 96;
export const WORLD_HEIGHT = 72;
export const AGENT_COUNT = 100;

export const terrainKinds = [
  "deep-water",
  "tidal",
  "plain",
  "fungus",
  "mineral",
  "cellulose",
  "chitin",
] as const;

export type TerrainKind = (typeof terrainKinds)[number];
export type MaterialKind = "water" | "fungus" | "mineral" | "cellulose" | "chitin";
export type AgentMode = "surveying" | "harvesting" | "fabricating" | "maintaining" | "forking";
export type ControllerAction = "collect-water" | "remediate" | "heal" | "grow" | "signal";
export type AgentGoal = "explore" | "gather" | "build" | "inspect" | "maintain";
export type ActionPrimitive =
  | "scan-local"
  | "roam"
  | "gather-local"
  | "seek-resource"
  | "build-local"
  | "seek-station"
  | "inspect-local"
  | "repair-local"
  | "seek-artifact";

export interface Vec2 {
  x: number;
  y: number;
}

export interface Tile {
  terrain: TerrainKind;
  richness: number;
  moisture: number;
  contamination: number;
}

export interface Inventory {
  water: number;
  fungus: number;
  mineral: number;
  cellulose: number;
  chitin: number;
}

export interface Controller {
  sensor: "moisture" | "contamination" | "health" | "nutrients";
  threshold: number;
  action: ControllerAction;
  revision: number;
}

export interface AgentDirective {
  goal: AgentGoal;
  targetMaterial: MaterialKind;
  controllerAction: ControllerAction;
  note: string;
  source: "instinct" | "openrouter";
  model?: string;
  actionId?: string;
  icon?: string;
  actionProposal?: AgentActionProposal;
  speech?: string;
}

export interface HeardMessage {
  tick: number;
  fromId: string;
  text: string;
}

export interface AgentMessage extends HeardMessage {
  id: string;
  toId: string;
}

export interface AgentActionProposal {
  name: string;
  icon: string;
  algorithm: string;
  program: ActionPrimitive[];
}

export interface AgentActionDefinition extends AgentActionProposal {
  id: string;
  authorId: string;
  createdTick: number;
  uses: number;
}

export interface AgentDocuments {
  soulMd: string;
  memoryMd: string;
  userMd: string;
}

export interface AgentScript {
  revision: number;
  updatedTick: number;
  actionId: string;
  icon: string;
  program: ActionPrimitive[];
  rationale: string;
  lastResult: string;
}

export interface AgentTrajectory {
  pathLength: number;
  regionsVisited: string[];
  artifactContactTicks: number;
  artifactContactRadius: number;
  observedTicks: number;
}

export interface Agent {
  id: string;
  name: string;
  x: number;
  y: number;
  energy: number;
  mode: AgentMode;
  inventory: Inventory;
  discoveries: number;
  artifactsTouched: number;
  builds: number;
  forkedProgramId?: string;
  directive: AgentDirective;
  lastDecisionTick: number;
  decisionPhase: number;
  nextDecisionTick: number;
  scriptCursor: number;
  trail: Vec2[];
  trajectory: AgentTrajectory;
  color: number;
  icon: string;
  documents: AgentDocuments;
  script: AgentScript;
  knownActionIds: string[];
  lastSpeech?: string;
  heardMessages: HeardMessage[];
}

export interface Artifact {
  id: string;
  name: string;
  x: number;
  y: number;
  material: MaterialKind;
  health: number;
  performance: number;
  generation: number;
  parentId?: string;
  creatorId: string;
  authors: string[];
  contributors: string[];
  adopters: string[];
  controller: Controller;
  builtAt: number;
  uses: number;
  validated: boolean;
}

export interface Station {
  id: string;
  x: number;
  y: number;
  kind: "wash" | "grind" | "weave" | "foundry" | "assay";
}

export interface WorldEvent {
  id: string;
  tick: number;
  kind: "discovery" | "build" | "fork" | "repair" | "failure" | "decision";
  text: string;
  x: number;
  y: number;
}

export interface WorldDiaryEntry {
  id: number;
  startTick: number;
  endTick: number;
  lines: string[];
  model?: string;
  createdAt: number;
}

export interface WorldMetrics {
  activeAgents: number;
  artifacts: number;
  bestArtifactPerformance: number;
  discoveryFrontierPerformance: number;
  discoveryFrontierAuc: number;
  validatedInventions: number;
  forkDepth: number;
  artifactCenteredFraction: number;
  portfolioResilience: number;
  physicalReuseFraction: number;
  openRouterCalls: number;
  openRouterCost: number;
  meanPathLength: number;
  meanRegionsVisited: number;
  artifactContactRate: number;
  spatialEntropy: number;
}

export interface WorldState {
  version: 3;
  seed: number;
  rngState: number;
  tick: number;
  lastAdvancedAt: number;
  terrain: Tile[];
  agents: Agent[];
  artifacts: Artifact[];
  discoveryFrontierPerformance: number;
  discoveryFrontierArea: number;
  discoveryFrontierTrackedTicks: number;
  stations: Station[];
  events: WorldEvent[];
  actionLibrary: AgentActionDefinition[];
  messages: AgentMessage[];
  metrics: WorldMetrics;
  llm: {
    callsToday: number;
    callDay: string;
    totalCalls: number;
    totalCost: number;
    lastModel?: string;
    lastError?: string;
  };
}

export interface PublicWorldSnapshot extends WorldState {
  diary: WorldDiaryEntry[];
  engine: {
    mode: "deterministic" | "openrouter-assisted";
    model: string;
    nullclawPolicy: boolean;
    sandbox: "nullclaw-wasm-dsl";
  };
}
