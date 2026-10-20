import { Rng } from "./rng";
import type { WorldState } from "./types";

// Observer-only measurement. Nothing here is read by the engine, decision
// observations, or model prompts: bots never see their own rank.

export type DeferenceRelation = "adopt" | "inspect" | "maintain" | "fork" | "lineage" | "learn";

/**
 * One measured act: `fromId` acted on work that `toId` made. Costly acts weigh
 * more: forking builds a new artifact on an inherited controller, and learning
 * spends two gathered materials to reproduce an authored skill.
 */
export const DEFERENCE_WEIGHTS: Readonly<Record<DeferenceRelation, number>> = {
  adopt: 1,
  inspect: 1,
  maintain: 1,
  fork: 3,
  lineage: 1,
  learn: 3,
};

export const HIERARCHY_DAMPING = 0.85;
export const HIERARCHY_MIN_EDGES = 10;
export const HIERARCHY_MIN_TRIADS = 5;
export const HIERARCHY_NULL_SAMPLES = 100;
export const HIERARCHY_SNAPSHOT_INTERVAL_TICKS = 600;
export const HIERARCHY_MAX_SNAPSHOTS = 720;

const AGENT_ID = /^A\d{3}$/u;
const TIE_EPSILON = 1e-9;

/** Removed artifacts kept by an archive; any missing list simply adds no acts. */
export interface HierarchyFossilArtifact {
  id: string;
  creatorId?: string;
  parentId?: string;
  generation?: number;
  authors?: string[];
  adopters?: string[];
  serviceInspectedBy?: string[];
  contributors?: string[];
}

/** Extinct skills kept by an archive; `learnerIds` are agents who had learned it. */
export interface HierarchyFossilSkill {
  id: string;
  authorId?: string;
  learnerIds?: string[];
}

export interface HierarchyFossils {
  artifacts?: HierarchyFossilArtifact[];
  skills?: HierarchyFossilSkill[];
}

export interface DeferenceAct {
  relation: DeferenceRelation;
  sourceId: string;
  fromId: string;
  toId: string;
  weight: number;
}

export interface DeferenceEdge {
  fromId: string;
  toId: string;
  weight: number;
}

export interface RankedAgent {
  id: string;
  name: string;
  color: number;
  /** Assigned only when the population metric has enough edges and this bot received deference. */
  rank?: number;
  /** PageRank share times population: 1 is an equal share. */
  prestige: number;
  received: Record<DeferenceRelation, number> & { weight: number; deferrers: number };
  given: { weight: number; targets: number };
  authored: { artifacts: number; skills: number; skillUses: number };
  activity: { builds: number; crafts: number; discoveries: number; artifactsTouched: number };
  /** Shown for context and excluded from prestige. */
  speech: { delivered: number; heardBy: number };
  topDeferrers: Array<{ id: string; weight: number }>;
}

export interface HierarchyNullModel {
  samples: number;
  seed: number;
  giniMean: number;
  giniP95: number;
  giniPValue: number;
  topDecileMean: number;
  topDecileP95: number;
  topDecilePValue: number;
  exceedsChance: boolean;
}

export interface HierarchyMetrics {
  agents: number;
  deferenceActs: number;
  deferenceEdges: number;
  deferenceWeight: number;
  /** Prestige of a bot nobody defers to; concentration metrics use prestige above it. */
  prestigeFloor: number;
  deferringAgents: number;
  deferredToAgents: number;
  prestigeGini?: number;
  topDecileShare?: number;
  nullModel?: HierarchyNullModel;
  transitivity?: number;
  completeTriads: number;
  transitiveTriads: number;
  artifacts: number;
  forkedArtifacts: number;
  lineageMaxGeneration?: number;
  lineageMeanGeneration?: number;
  fossilArtifacts: number;
  fossilSkills: number;
  insufficient: { concentration?: string; transitivity?: string; lineage?: string };
}

export interface HierarchyReport {
  tick: number;
  seed: number;
  agents: RankedAgent[];
  metrics: HierarchyMetrics;
  method: {
    measure: "pagerank";
    damping: number;
    weights: Readonly<Record<DeferenceRelation, number>>;
    minEdges: number;
    minTriads: number;
    nullModel: "out-preserving-target-shuffle";
    speechCounted: false;
  };
}

export interface HierarchyHistoryPoint {
  tick: number;
  createdAt: number;
  kind: "baseline" | "interval";
  deferenceEdges: number;
  deferenceWeight: number;
  prestigeGini?: number;
  topDecileShare?: number;
  nullGiniP95?: number;
  nullTopDecileP95?: number;
  exceedsChance?: boolean;
  transitivity?: number;
  completeTriads: number;
  lineageMaxGeneration?: number;
  leaders: Array<{ id: string; prestige: number }>;
}

export interface HierarchyHistory {
  intervalTicks: number;
  maxPoints: number;
  startedTick?: number;
  points: HierarchyHistoryPoint[];
}

export interface HierarchyApiResponse {
  current: HierarchyReport;
  history: HierarchyHistory;
}

function ids(values: readonly string[] | undefined): string[] {
  return Array.isArray(values) ? values.filter((value) => typeof value === "string") : [];
}

interface LineageRecord {
  id: string;
  creatorId?: string;
  parentId?: string;
  generation?: number;
  authors?: string[];
  adopters?: string[];
  serviceInspectedBy?: string[];
  contributors?: string[];
}

function creatorOf(record: LineageRecord): string | undefined {
  return record.creatorId ?? ids(record.authors).at(-1);
}

/**
 * Extract every measurable deference act from live artifacts, live skills,
 * and optional fossils. Live records win over fossils with the same id.
 */
export function collectDeferenceActs(
  world: WorldState,
  fossils: HierarchyFossils = {},
): DeferenceAct[] {
  const agentIds = new Set(world.agents.map((agent) => agent.id));
  const valid = (id: string | undefined): id is string =>
    typeof id === "string" && AGENT_ID.test(id) && agentIds.has(id);
  const acts = new Map<string, DeferenceAct>();
  const add = (relation: DeferenceRelation, sourceId: string, fromId: string, toId?: string) => {
    if (!valid(fromId) || !valid(toId) || fromId === toId) return;
    const key = `${relation}|${sourceId}|${fromId}|${toId}`;
    if (!acts.has(key))
      acts.set(key, { relation, sourceId, fromId, toId, weight: DEFERENCE_WEIGHTS[relation] });
  };

  const records = new Map<string, LineageRecord>();
  for (const fossil of fossils.artifacts ?? []) if (fossil?.id) records.set(fossil.id, fossil);
  for (const artifact of world.artifacts) records.set(artifact.id, artifact);

  for (const record of records.values()) {
    const creator = creatorOf(record);
    if (!valid(creator)) continue;
    for (const id of ids(record.adopters)) add("adopt", record.id, id, creator);
    for (const id of ids(record.serviceInspectedBy)) add("inspect", record.id, id, creator);
    for (const id of ids(record.contributors)) add("maintain", record.id, id, creator);
    const authors = ids(record.authors);
    let parentCreator: string | undefined;
    if (record.parentId) {
      const parent = records.get(record.parentId);
      // A retired parent leaves its creator as the author just before this one.
      parentCreator = parent
        ? creatorOf(parent)
        : authors.at(-1) === creator
          ? authors.at(-2)
          : undefined;
      add("fork", record.id, creator, parentCreator);
    }
    for (const author of authors)
      if (author !== parentCreator) add("lineage", record.id, creator, author);
  }

  const learners = new Map<string, Set<string>>();
  for (const agent of world.agents) {
    for (const actionId of ids(agent.knownActionIds)) {
      const known = learners.get(actionId) ?? new Set<string>();
      known.add(agent.id);
      learners.set(actionId, known);
    }
  }
  const skills = new Map<string, { authorId?: string; learnerIds: Set<string> }>();
  for (const fossil of fossils.skills ?? []) {
    if (fossil?.id)
      skills.set(fossil.id, {
        authorId: fossil.authorId,
        learnerIds: new Set(ids(fossil.learnerIds)),
      });
  }
  for (const action of world.actionLibrary) {
    const learnerIds = skills.get(action.id)?.learnerIds ?? new Set<string>();
    for (const id of learners.get(action.id) ?? []) learnerIds.add(id);
    skills.set(action.id, { authorId: action.authorId, learnerIds });
  }
  for (const [skillId, skill] of skills) {
    for (const learner of skill.learnerIds) add("learn", skillId, learner, skill.authorId);
  }

  return [...acts.values()].sort(
    (first, second) =>
      first.fromId.localeCompare(second.fromId) ||
      first.toId.localeCompare(second.toId) ||
      first.relation.localeCompare(second.relation) ||
      first.sourceId.localeCompare(second.sourceId),
  );
}

export function aggregateEdges(acts: readonly DeferenceAct[]): DeferenceEdge[] {
  const edges = new Map<string, DeferenceEdge>();
  for (const act of acts) {
    const key = `${act.fromId}>${act.toId}`;
    const edge = edges.get(key);
    if (edge) edge.weight += act.weight;
    else edges.set(key, { fromId: act.fromId, toId: act.toId, weight: act.weight });
  }
  return [...edges.values()];
}

/**
 * Weighted PageRank; bots that defer to nobody spread their share evenly.
 * `floor` is the share every bot gets with no incoming deference.
 */
export function pageRank(
  nodeIds: readonly string[],
  edges: readonly DeferenceEdge[],
  damping = HIERARCHY_DAMPING,
): { ranks: number[]; floor: number } {
  const n = nodeIds.length;
  if (n === 0) return { ranks: [], floor: 0 };
  const index = new Map(nodeIds.map((id, position) => [id, position]));
  const outWeight = new Float64Array(n);
  const links: Array<[number, number, number]> = [];
  for (const edge of edges) {
    const from = index.get(edge.fromId);
    const to = index.get(edge.toId);
    if (from === undefined || to === undefined || from === to || !(edge.weight > 0)) continue;
    outWeight[from] += edge.weight;
    links.push([from, to, edge.weight]);
  }
  let rank = new Float64Array(n).fill(1 / n);
  let floor = 1 / n;
  for (let iteration = 0; iteration < 200; iteration += 1) {
    let danglingMass = 0;
    for (let node = 0; node < n; node += 1) if (outWeight[node] === 0) danglingMass += rank[node];
    floor = (1 - damping) / n + (damping * danglingMass) / n;
    const next = new Float64Array(n).fill(floor);
    for (const [from, to, weight] of links)
      next[to] += (damping * rank[from] * weight) / outWeight[from];
    let delta = 0;
    for (let node = 0; node < n; node += 1) delta += Math.abs(next[node] - rank[node]);
    rank = next;
    if (delta < 1e-10) break;
  }
  return { ranks: Array.from(rank), floor };
}

/**
 * Prestige above the floor, in equal-share units. Concentration is measured on
 * this: raw PageRank gives every bot the same floor, which hides whether
 * deference converges on one bot or scatters across many.
 */
export function earnedPrestige({ ranks, floor }: { ranks: number[]; floor: number }): number[] {
  return ranks.map((rank) => Math.max(0, rank - floor) * ranks.length);
}

export function gini(values: readonly number[]): number | undefined {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (sorted.length < 2 || total <= 0) return undefined;
  let weighted = 0;
  sorted.forEach((value, position) => {
    weighted += (position + 1) * value;
  });
  const n = sorted.length;
  return Math.max(0, (2 * weighted) / (n * total) - (n + 1) / n);
}

export function topDecileShare(values: readonly number[]): number | undefined {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (values.length < 2 || total <= 0) return undefined;
  const top = Math.max(1, Math.ceil(values.length * 0.1));
  return (
    [...values]
      .sort((a, b) => b - a)
      .slice(0, top)
      .reduce((sum, value) => sum + value, 0) / total
  );
}

/**
 * Triad transitivity (Shizuka & McDonald 2012). Bot i dominates j when j
 * defers to i more than i defers to j. Among triads whose three pairs are all
 * resolved, P_t is the transitive fraction; t = 4(P_t - 0.75), so random
 * orientation scores 0 and a strict ladder scores 1.
 */
export function triadTransitivity(
  nodeIds: readonly string[],
  edges: readonly DeferenceEdge[],
): { value?: number; complete: number; transitive: number } {
  const index = new Map(nodeIds.map((id, position) => [id, position]));
  const net = new Map<string, number>();
  const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  for (const edge of edges) {
    const from = index.get(edge.fromId);
    const to = index.get(edge.toId);
    if (from === undefined || to === undefined || from === to) continue;
    // Positive net means the lower index dominates the higher index.
    const sign = to < from ? 1 : -1;
    const key = pairKey(from, to);
    net.set(key, (net.get(key) ?? 0) + sign * edge.weight);
  }
  const dominates = (a: number, b: number): number => {
    const value = net.get(pairKey(a, b)) ?? 0;
    if (Math.abs(value) < TIE_EPSILON) return 0;
    return (a < b ? value : -value) > 0 ? 1 : -1;
  };
  const neighbors = new Map<number, number[]>();
  for (const key of net.keys()) {
    if (Math.abs(net.get(key)!) < TIE_EPSILON) continue;
    const [a, b] = key.split(":").map(Number) as [number, number];
    for (const [node, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const list = neighbors.get(node) ?? [];
      list.push(other);
      neighbors.set(node, list);
    }
  }
  let complete = 0;
  let transitive = 0;
  for (const [a, around] of neighbors) {
    const sorted = around.filter((node) => node > a).sort((x, y) => x - y);
    for (let first = 0; first < sorted.length; first += 1) {
      for (let second = first + 1; second < sorted.length; second += 1) {
        const b = sorted[first]!;
        const c = sorted[second]!;
        const bc = dominates(b, c);
        if (bc === 0) continue;
        complete += 1;
        const wins = [0, 0, 0];
        const ab = dominates(a, b);
        const ac = dominates(a, c);
        wins[ab > 0 ? 0 : 1]! += 1;
        wins[ac > 0 ? 0 : 2]! += 1;
        wins[bc > 0 ? 1 : 2]! += 1;
        if (wins.some((count) => count === 2)) transitive += 1;
      }
    }
  }
  return {
    value: complete >= HIERARCHY_MIN_TRIADS ? 4 * (transitive / complete - 0.75) : undefined,
    complete,
    transitive,
  };
}

/**
 * Chance baseline: keep every bot's outgoing deference lumps and re-aim each
 * lump at a uniformly random other bot. Concentration above the 95th
 * percentile of these shuffles exceeds chance.
 */
export function nullModelConcentration(
  nodeIds: readonly string[],
  edges: readonly DeferenceEdge[],
  observed: { gini: number; topDecile: number },
  seed: number,
  samples = HIERARCHY_NULL_SAMPLES,
): HierarchyNullModel {
  const rng = new Rng(seed);
  const index = new Map(nodeIds.map((id, position) => [id, position]));
  const ginis: number[] = [];
  const tops: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const shuffled = edges.map((edge) => {
      let target = rng.int(nodeIds.length - 1);
      if (target >= index.get(edge.fromId)!) target += 1;
      return { fromId: edge.fromId, toId: nodeIds[target]!, weight: edge.weight };
    });
    const earned = earnedPrestige(pageRank(nodeIds, shuffled));
    ginis.push(gini(earned) ?? 0);
    tops.push(topDecileShare(earned) ?? 0);
  }
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const p95 = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.95) - 1)]!;
  const pValue = (values: number[], value: number) =>
    (1 + values.filter((candidate) => candidate >= value - TIE_EPSILON).length) /
    (values.length + 1);
  const giniPValue = pValue(ginis, observed.gini);
  return {
    samples,
    seed,
    giniMean: mean(ginis),
    giniP95: p95(ginis),
    giniPValue,
    topDecileMean: mean(tops),
    topDecileP95: p95(tops),
    topDecilePValue: pValue(tops, observed.topDecile),
    exceedsChance: giniPValue < 0.05,
  };
}

function emptyReceived(): RankedAgent["received"] {
  return {
    weight: 0,
    deferrers: 0,
    adopt: 0,
    inspect: 0,
    maintain: 0,
    fork: 0,
    lineage: 0,
    learn: 0,
  };
}

export function computeHierarchy(
  world: WorldState,
  options: { fossils?: HierarchyFossils; nullSamples?: number } = {},
): HierarchyReport {
  const fossils = options.fossils ?? {};
  const nodeIds = world.agents.map((agent) => agent.id);
  const acts = collectDeferenceActs(world, fossils);
  const edges = aggregateEdges(acts);
  const pagerank = pageRank(nodeIds, edges);
  const ranks = pagerank.ranks;
  const earned = earnedPrestige(pagerank);
  const n = nodeIds.length;

  const received = new Map(nodeIds.map((id) => [id, emptyReceived()]));
  const deferrers = new Map(nodeIds.map((id) => [id, new Map<string, number>()]));
  const given = new Map(nodeIds.map((id) => [id, { weight: 0, targets: new Set<string>() }]));
  for (const act of acts) {
    const target = received.get(act.toId)!;
    target[act.relation] += 1;
    target.weight += act.weight;
    const byDeferrer = deferrers.get(act.toId)!;
    byDeferrer.set(act.fromId, (byDeferrer.get(act.fromId) ?? 0) + act.weight);
    const source = given.get(act.fromId)!;
    source.weight += act.weight;
    source.targets.add(act.toId);
  }

  const speech = new Map(nodeIds.map((id) => [id, { delivered: 0, heardBy: new Set<string>() }]));
  for (const message of world.messages ?? []) {
    if (message.deliveredTick === undefined) continue;
    const sender = speech.get(message.fromId);
    if (!sender) continue;
    sender.delivered += 1;
    if (message.toId !== message.fromId) sender.heardBy.add(message.toId);
  }

  const authoredArtifacts = new Map<string, number>();
  for (const artifact of world.artifacts) {
    const creator = creatorOf(artifact);
    if (creator) authoredArtifacts.set(creator, (authoredArtifacts.get(creator) ?? 0) + 1);
  }
  const authoredSkills = new Map<string, { skills: number; uses: number }>();
  for (const action of world.actionLibrary) {
    const entry = authoredSkills.get(action.authorId) ?? { skills: 0, uses: 0 };
    entry.skills += 1;
    entry.uses += Number.isFinite(action.uses) ? action.uses : 0;
    authoredSkills.set(action.authorId, entry);
  }

  const agents: RankedAgent[] = world.agents.map((agent, position) => {
    const incoming = received.get(agent.id)!;
    const byDeferrer = deferrers.get(agent.id)!;
    incoming.deferrers = byDeferrer.size;
    const outgoing = given.get(agent.id)!;
    const voice = speech.get(agent.id)!;
    const skills = authoredSkills.get(agent.id);
    return {
      id: agent.id,
      name: agent.name,
      color: agent.color,
      prestige: (ranks[position] ?? 0) * n,
      received: incoming,
      given: { weight: outgoing.weight, targets: outgoing.targets.size },
      authored: {
        artifacts: authoredArtifacts.get(agent.id) ?? 0,
        skills: skills?.skills ?? 0,
        skillUses: skills?.uses ?? 0,
      },
      activity: {
        builds: agent.builds ?? 0,
        crafts: agent.crafts ?? 0,
        discoveries: agent.discoveries ?? 0,
        artifactsTouched: agent.artifactsTouched ?? 0,
      },
      speech: { delivered: voice.delivered, heardBy: voice.heardBy.size },
      topDeferrers: [...byDeferrer]
        .sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))
        .slice(0, 3)
        .map(([id, weight]) => ({ id, weight })),
    };
  });
  agents.sort(
    (first, second) =>
      second.prestige - first.prestige ||
      second.received.weight - first.received.weight ||
      first.id.localeCompare(second.id),
  );

  const deferenceWeight = edges.reduce((sum, edge) => sum + edge.weight, 0);
  const metrics: HierarchyMetrics = {
    agents: n,
    deferenceActs: acts.length,
    deferenceEdges: edges.length,
    deferenceWeight,
    prestigeFloor: pagerank.floor * n,
    deferringAgents: new Set(edges.map((edge) => edge.fromId)).size,
    deferredToAgents: new Set(edges.map((edge) => edge.toId)).size,
    completeTriads: 0,
    transitiveTriads: 0,
    artifacts: world.artifacts.length,
    forkedArtifacts: world.artifacts.filter(
      (artifact) => artifact.parentId !== undefined || artifact.generation > 1,
    ).length,
    fossilArtifacts: fossils.artifacts?.length ?? 0,
    fossilSkills: fossils.skills?.length ?? 0,
    insufficient: {},
  };

  if (edges.length >= HIERARCHY_MIN_EDGES && n >= 3) {
    metrics.prestigeGini = gini(earned);
    metrics.topDecileShare = topDecileShare(earned);
    if (metrics.prestigeGini !== undefined && metrics.topDecileShare !== undefined) {
      metrics.nullModel = nullModelConcentration(
        nodeIds,
        edges,
        { gini: metrics.prestigeGini, topDecile: metrics.topDecileShare },
        (Math.imul(world.seed >>> 0, 0x9e3779b1) ^ world.tick) >>> 0,
        options.nullSamples ?? HIERARCHY_NULL_SAMPLES,
      );
    }
  } else {
    metrics.insufficient.concentration = `${edges.length} deference links measured; needs at least ${HIERARCHY_MIN_EDGES}`;
  }

  const triads = triadTransitivity(nodeIds, edges);
  metrics.completeTriads = triads.complete;
  metrics.transitiveTriads = triads.transitive;
  if (triads.value !== undefined) metrics.transitivity = triads.value;
  else
    metrics.insufficient.transitivity = `${triads.complete} fully resolved triads; needs at least ${HIERARCHY_MIN_TRIADS}`;

  const generations = world.artifacts
    .map((artifact) => artifact.generation)
    .filter((generation) => Number.isFinite(generation) && generation >= 1);
  if (generations.length) {
    metrics.lineageMaxGeneration = Math.max(...generations);
    metrics.lineageMeanGeneration =
      generations.reduce((sum, generation) => sum + generation, 0) / generations.length;
  } else metrics.insufficient.lineage = "no artifacts in the world";

  // Ranks exist only once the population measure is meaningful, and only for
  // bots that measurably received deference. Ties share the same rank.
  if (metrics.insufficient.concentration === undefined) {
    let previous: RankedAgent | undefined;
    agents.forEach((agent, position) => {
      if (agent.received.weight <= 0) return;
      agent.rank =
        previous && Math.abs(previous.prestige - agent.prestige) < TIE_EPSILON
          ? previous.rank
          : position + 1;
      previous = agent;
    });
  }

  return {
    tick: world.tick,
    seed: world.seed,
    agents,
    metrics,
    method: {
      measure: "pagerank",
      damping: HIERARCHY_DAMPING,
      weights: DEFERENCE_WEIGHTS,
      minEdges: HIERARCHY_MIN_EDGES,
      minTriads: HIERARCHY_MIN_TRIADS,
      nullModel: "out-preserving-target-shuffle",
      speechCounted: false,
    },
  };
}

export function hierarchyHistoryPoint(
  report: HierarchyReport,
  kind: HierarchyHistoryPoint["kind"],
  createdAt: number,
): HierarchyHistoryPoint {
  const { metrics } = report;
  return {
    tick: report.tick,
    createdAt,
    kind,
    deferenceEdges: metrics.deferenceEdges,
    deferenceWeight: metrics.deferenceWeight,
    prestigeGini: metrics.prestigeGini,
    topDecileShare: metrics.topDecileShare,
    nullGiniP95: metrics.nullModel?.giniP95,
    nullTopDecileP95: metrics.nullModel?.topDecileP95,
    exceedsChance: metrics.nullModel?.exceedsChance,
    transitivity: metrics.transitivity,
    completeTriads: metrics.completeTriads,
    lineageMaxGeneration: metrics.lineageMaxGeneration,
    leaders: report.agents
      .filter((agent) => agent.rank !== undefined)
      .slice(0, 3)
      .map((agent) => ({ id: agent.id, prestige: agent.prestige })),
  };
}
