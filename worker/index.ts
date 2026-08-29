import { DurableObject } from "cloudflare:workers";
import agentCore from "./nullclaw/agent_core.wasm";
import { generateAgentName } from "../src/sim/names";
import {
  advanceWorld,
  applyDirective,
  createInitialWorld,
  decisionAgentsDue,
  decisionObservation,
  ensureAgentOperatingSystem,
  MODEL_MACROTURN_INTERVAL_TICKS,
  publicSnapshot,
  recordFailedDecision,
} from "../src/sim/engine";
import {
  assignableActionIcons,
  modelActionPrimitives,
  validateActionProposal,
} from "../src/sim/action-sandbox";
import {
  AGENT_MEMORY_CONTEXT_TOKENS,
  AGENT_MEMORY_TOKEN_CAP,
  collapseRepeatedMemory,
  compactMemoryLog,
  estimateMemoryTokens,
  memoryRunKey,
  type DurableMemoryEntry,
} from "../src/sim/memory-log";
import {
  nextWorldDiaryTick,
  normalizeWorldDiaryLines,
  WORLD_DIARY_INTERVAL_TICKS,
} from "../src/sim/world-diary";
import type {
  AgentActionProposal,
  AgentDirective,
  ControllerAction,
  CreativeSessionProposal,
  MaterialKind,
  WorldDiaryEntry,
  WorldEvent,
  WorldState,
} from "../src/sim/types";

interface Env {
  WORLD: DurableObjectNamespace<WorldRoom>;
  ASSETS: Fetcher;
  OPENROUTER_API_KEY?: string;
  LLM_ENABLED: string;
  LLM_PARALLELISM: string;
  MAX_LLM_CALLS_PER_DAY: string;
  WORLD_SEED: string;
  ALARM_INTERVAL_MS: string;
}

const OPENROUTER_FREE_MODEL = "openrouter/free";

interface OpenRouterResponse {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null };
    error?: { message?: string };
  }>;
  usage?: { cost?: number };
  error?: { message?: string };
}

interface ModelDirectiveResult {
  directive: AgentDirective;
  model?: string;
  cost: number;
}

interface ModelDiaryResult {
  lines: string[];
  model?: string;
  cost: number;
}

class ModelDecisionError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "ModelDecisionError";
    this.retryable = retryable;
  }
}

interface MemorySummaryRow {
  [key: string]: SqlStorageValue;
  summary: string;
  tokens: number;
  compactions: number;
  through_seq: number;
}

interface MemoryTotalRow {
  [key: string]: SqlStorageValue;
  tokens: number;
  entries: number;
}

interface MemoryEntryRow {
  [key: string]: SqlStorageValue;
  seq: number;
  tick: number;
  kind: string;
  content: string;
  tokens: number;
  firstTick: number;
  lastTick: number;
  repeatCount: number;
}

interface AgentMemoryView {
  agentId: string;
  tokenCap: number;
  estimatedTokens: number;
  entries: number;
  compactions: number;
  summary: string;
  recent: DurableMemoryEntry[];
}

interface DiaryEntryRow {
  [key: string]: SqlStorageValue;
  id: number;
  startTick: number;
  endTick: number;
  linesJson: string;
  model: string;
  createdAt: number;
}

interface DiaryStateRow {
  [key: string]: SqlStorageValue;
  startTick: number;
  nextTick: number;
  baselineJson: string;
  lastError: string;
}

interface DiaryEventRow {
  [key: string]: SqlStorageValue;
  tick: number;
  kind: string;
  text: string;
}

interface DiaryEventCountRow {
  [key: string]: SqlStorageValue;
  kind: string;
  count: number;
}

interface PolicyExports extends WebAssembly.Exports {
  choose_policy: (
    observationBytes: number,
    hazardPercent: number,
    stalledSteps: number,
    lineageDepth: number,
  ) => number;
  facilitate_extension: (
    evidenceCount: number,
    knownActions: number,
    programSteps: number,
    algorithmBytes: number,
  ) => number;
}

const responseHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const agentDirectiveResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "agent_directive",
    strict: true,
    schema: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          enum: ["explore", "gather", "build", "inspect", "maintain", "craft", "create"],
        },
        targetMaterial: {
          type: "string",
          enum: ["water", "fungus", "mineral", "cellulose", "chitin"],
        },
        controllerAction: {
          type: "string",
          enum: ["collect-water", "remediate", "heal", "grow", "signal"],
        },
        note: { type: "string", maxLength: 120 },
        actionId: { type: "string", maxLength: 32 },
        icon: { type: "string", enum: assignableActionIcons },
        craftActionId: { type: "string", maxLength: 32 },
        creativeSession: {
          type: ["object", "null"],
          properties: {
            name: { type: "string", minLength: 2, maxLength: 32 },
            icon: { type: "string", enum: assignableActionIcons },
            algorithm: { type: "string", minLength: 12, maxLength: 180 },
            program: {
              type: "array",
              items: { type: "string", enum: modelActionPrimitives },
              minItems: 2,
              maxItems: 4,
            },
            ingredients: {
              type: "array",
              items: {
                type: "string",
                enum: ["water", "fungus", "mineral", "cellulose", "chitin"],
              },
              minItems: 2,
              maxItems: 2,
            },
            purpose: { type: "string", minLength: 8, maxLength: 120 },
          },
          required: ["name", "icon", "algorithm", "program", "ingredients", "purpose"],
          additionalProperties: false,
        },
        speech: { type: "string", maxLength: 80 },
      },
      required: [
        "goal",
        "targetMaterial",
        "controllerAction",
        "note",
        "actionId",
        "icon",
        "craftActionId",
        "creativeSession",
        "speech",
      ],
      additionalProperties: false,
    },
  },
} as const;

const worldDiaryResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "world_diary",
    strict: true,
    schema: {
      type: "object",
      properties: {
        lines: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: { type: "string", maxLength: 140 },
        },
      },
      required: ["lines"],
      additionalProperties: false,
    },
  },
} as const;

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(responseHeaders);
  for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  return Response.json(data, { ...init, headers });
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function openRouterEnabled(env: Env): boolean {
  return env.LLM_ENABLED === "true" && Boolean(env.OPENROUTER_API_KEY);
}

export class WorldRoom extends DurableObject<Env> {
  private world?: WorldState;
  private policy?: PolicyExports;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS agent_memory_entries (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL,
          tick INTEGER NOT NULL,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          tokens INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS agent_memory_entries_agent_seq
          ON agent_memory_entries(agent_id, seq);
        CREATE TABLE IF NOT EXISTS agent_memory_summaries (
          agent_id TEXT PRIMARY KEY,
          summary TEXT NOT NULL,
          tokens INTEGER NOT NULL,
          compactions INTEGER NOT NULL,
          through_seq INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS world_diary_events (
          id TEXT PRIMARY KEY,
          tick INTEGER NOT NULL,
          kind TEXT NOT NULL,
          text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS world_diary_events_tick
          ON world_diary_events(tick);
        CREATE TABLE IF NOT EXISTS world_diary_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          start_tick INTEGER NOT NULL,
          end_tick INTEGER NOT NULL UNIQUE,
          lines_json TEXT NOT NULL,
          model TEXT NOT NULL,
          cost REAL NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS world_diary_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          start_tick INTEGER NOT NULL,
          next_tick INTEGER NOT NULL,
          baseline_json TEXT NOT NULL,
          last_error TEXT NOT NULL DEFAULT ''
        );
      `);
      const memoryColumns = new Set(
        ctx.storage.sql
          .exec<{ [key: string]: SqlStorageValue; name: string }>(
            "PRAGMA table_info(agent_memory_entries)",
          )
          .toArray()
          .map((column) => column.name),
      );
      if (!memoryColumns.has("first_tick"))
        ctx.storage.sql.exec("ALTER TABLE agent_memory_entries ADD COLUMN first_tick INTEGER");
      if (!memoryColumns.has("last_tick"))
        ctx.storage.sql.exec("ALTER TABLE agent_memory_entries ADD COLUMN last_tick INTEGER");
      if (!memoryColumns.has("repeat_count"))
        ctx.storage.sql.exec(
          "ALTER TABLE agent_memory_entries ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 1",
        );
      if (!memoryColumns.has("fingerprint"))
        ctx.storage.sql.exec("ALTER TABLE agent_memory_entries ADD COLUMN fingerprint TEXT");
      ctx.storage.sql.exec(
        `UPDATE agent_memory_entries
         SET first_tick = COALESCE(first_tick, tick),
             last_tick = COALESCE(last_tick, tick),
             repeat_count = MAX(1, repeat_count)`,
      );
    });
  }

  private memorySummary(agentId: string): MemorySummaryRow | undefined {
    return this.ctx.storage.sql
      .exec<MemorySummaryRow>(
        "SELECT summary, tokens, compactions, through_seq FROM agent_memory_summaries WHERE agent_id = ?",
        agentId,
      )
      .toArray()[0];
  }

  private memoryTotal(agentId: string): MemoryTotalRow {
    return this.ctx.storage.sql
      .exec<MemoryTotalRow>(
        "SELECT COALESCE(SUM(tokens), 0) AS tokens, COUNT(*) AS entries FROM agent_memory_entries WHERE agent_id = ?",
        agentId,
      )
      .one();
  }

  private readAgentMemory(agentId: string, limit = 12): AgentMemoryView {
    const summary = this.memorySummary(agentId);
    const total = this.memoryTotal(agentId);
    const fetchLimit = Math.max(1, Math.min(1_000, Math.floor(limit) * 64));
    const recentRows = this.ctx.storage.sql
      .exec<MemoryEntryRow>(
        `SELECT seq, tick, kind, content, tokens,
                first_tick AS firstTick, last_tick AS lastTick, repeat_count AS repeatCount
         FROM agent_memory_entries
         WHERE agent_id = ? ORDER BY seq DESC LIMIT ?`,
        agentId,
        fetchLimit,
      )
      .toArray()
      .reverse();
    const recent = collapseRepeatedMemory(recentRows).slice(-Math.max(1, Math.floor(limit)));
    return {
      agentId,
      tokenCap: AGENT_MEMORY_TOKEN_CAP,
      estimatedTokens: total.tokens + (summary?.tokens ?? 0),
      entries: total.entries,
      compactions: summary?.compactions ?? 0,
      summary: summary?.summary ?? "",
      recent,
    };
  }

  private compactAgentMemory(agentId: string): void {
    const summary = this.memorySummary(agentId);
    const total = this.memoryTotal(agentId);
    if (total.tokens + (summary?.tokens ?? 0) <= AGENT_MEMORY_TOKEN_CAP) return;
    const entries = this.ctx.storage.sql
      .exec<MemoryEntryRow>(
        `SELECT seq, tick, kind, content, tokens,
                first_tick AS firstTick, last_tick AS lastTick, repeat_count AS repeatCount
         FROM agent_memory_entries
         WHERE agent_id = ? ORDER BY seq ASC`,
        agentId,
      )
      .toArray();
    const compacted = compactMemoryLog(entries, summary?.summary);
    if (!compacted) return;
    this.ctx.storage.sql.exec(
      "DELETE FROM agent_memory_entries WHERE agent_id = ? AND seq <= ?",
      agentId,
      compacted.throughSeq,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO agent_memory_summaries
        (agent_id, summary, tokens, compactions, through_seq)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
        summary = excluded.summary,
        tokens = excluded.tokens,
        compactions = excluded.compactions,
        through_seq = excluded.through_seq`,
      agentId,
      compacted.summary,
      compacted.summaryTokens,
      (summary?.compactions ?? 0) + 1,
      compacted.throughSeq,
    );
  }

  private appendAgentMemory(
    agentId: string,
    tick: number,
    kind: string,
    content: string,
    firstTick = tick,
    repeatCount = 1,
  ): void {
    const bounded = content.replace(/\s+/g, " ").trim().slice(0, 600);
    if (!bounded) return;
    const boundedKind = kind.slice(0, 24);
    const fingerprint = memoryRunKey(boundedKind, bounded);
    const latest = this.ctx.storage.sql
      .exec<MemoryEntryRow>(
        `SELECT seq, tick, kind, content, tokens, fingerprint,
                first_tick AS firstTick, last_tick AS lastTick, repeat_count AS repeatCount
         FROM agent_memory_entries
         WHERE agent_id = ? ORDER BY seq DESC LIMIT 1`,
        agentId,
      )
      .toArray()[0];
    if (latest && memoryRunKey(latest.kind, latest.content) === fingerprint) {
      this.ctx.storage.sql.exec(
        `UPDATE agent_memory_entries
         SET tick = ?, last_tick = ?, repeat_count = ?, fingerprint = ?
         WHERE seq = ?`,
        tick,
        tick,
        Math.max(1, latest.repeatCount ?? 1) + Math.max(1, repeatCount),
        fingerprint,
        latest.seq,
      );
      return;
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO agent_memory_entries
        (agent_id, tick, kind, content, tokens, first_tick, last_tick, repeat_count, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      agentId,
      tick,
      boundedKind,
      bounded,
      estimateMemoryTokens(bounded),
      Math.min(firstTick, tick),
      tick,
      Math.max(1, repeatCount),
      fingerprint,
    );
    this.compactAgentMemory(agentId);
  }

  private seedAgentMemories(world: WorldState): void {
    for (const agent of world.agents) {
      const total = this.memoryTotal(agent.id);
      if (total.entries > 0 || this.memorySummary(agent.id)) continue;
      this.appendAgentMemory(
        agent.id,
        world.tick,
        "continuity",
        `Persistent memory began at T${world.tick}; ${agent.documents.memoryMd.replace(/^# MEMORY.md\s*/u, "")}`,
      );
    }
  }

  private modelMemoryContext(agentId: string): Record<string, unknown> {
    const memory = this.readAgentMemory(agentId, 6);
    const maxChars = AGENT_MEMORY_CONTEXT_TOKENS * 3;
    const recentChars = memory.recent.reduce((total, entry) => total + entry.content.length, 0);
    return {
      estimatedTokens: memory.estimatedTokens,
      compactions: memory.compactions,
      compactedSummary: memory.summary.slice(-Math.max(0, maxChars - recentChars)),
      recentLog: memory.recent,
    };
  }

  async agentMemory(agentId: string): Promise<AgentMemoryView | undefined> {
    const world = await this.load();
    if (!world.agents.some((agent) => agent.id === agentId)) return undefined;
    return this.readAgentMemory(agentId, 18);
  }

  private diaryBaseline(world: WorldState): Record<string, unknown> {
    return {
      tick: world.tick,
      artifacts: world.artifacts.length,
      activeArtifacts: world.artifacts.filter((artifact) => artifact.health > 0.1).length,
      highestGeneration: Math.max(0, ...world.artifacts.map((artifact) => artifact.generation)),
      actionIds: world.actionLibrary.map((action) => action.id),
      metrics: {
        discoveryFrontierPerformance: world.metrics.discoveryFrontierPerformance,
        validatedInventions: world.metrics.validatedInventions,
        physicalReuseFraction: world.metrics.physicalReuseFraction,
        portfolioResilience: world.metrics.portfolioResilience,
      },
    };
  }

  private ensureDiaryState(world: WorldState): DiaryStateRow {
    const existing = this.ctx.storage.sql
      .exec<DiaryStateRow>(
        `SELECT start_tick AS startTick, next_tick AS nextTick,
                baseline_json AS baselineJson, last_error AS lastError
         FROM world_diary_state WHERE singleton = 1`,
      )
      .toArray()[0];
    if (existing) return existing;
    const baselineJson = JSON.stringify(this.diaryBaseline(world));
    const nextTick = nextWorldDiaryTick(world.tick);
    this.ctx.storage.sql.exec(
      `INSERT INTO world_diary_state
        (singleton, start_tick, next_tick, baseline_json, last_error)
       VALUES (1, ?, ?, ?, '')`,
      world.tick,
      nextTick,
      baselineJson,
    );
    return { startTick: world.tick, nextTick, baselineJson, lastError: "" };
  }

  private appendDiaryEvent(event: WorldEvent): void {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO world_diary_events (id, tick, kind, text)
       VALUES (?, ?, ?, ?)`,
      event.id,
      event.tick,
      event.kind,
      event.text.replace(/\s+/g, " ").trim().slice(0, 240),
    );
  }

  private readWorldDiary(limit = 12): WorldDiaryEntry[] {
    return this.ctx.storage.sql
      .exec<DiaryEntryRow>(
        `SELECT id, start_tick AS startTick, end_tick AS endTick,
                lines_json AS linesJson, model, created_at AS createdAt
         FROM world_diary_entries ORDER BY end_tick DESC LIMIT ?`,
        Math.max(1, Math.min(168, Math.floor(limit))),
      )
      .toArray()
      .map((row) => {
        let lines: string[] = [];
        try {
          lines = normalizeWorldDiaryLines(JSON.parse(row.linesJson));
        } catch {
          lines = [];
        }
        return {
          id: row.id,
          startTick: row.startTick,
          endTick: row.endTick,
          lines,
          model: row.model || undefined,
          createdAt: row.createdAt,
        };
      })
      .filter((entry) => entry.lines.length > 0);
  }

  async worldDiary(): Promise<{ intervalTicks: number; entries: WorldDiaryEntry[] }> {
    await this.load();
    return { intervalTicks: WORLD_DIARY_INTERVAL_TICKS, entries: this.readWorldDiary(168) };
  }

  private async load(): Promise<WorldState> {
    if (this.world) return this.world;
    const stored = await this.ctx.storage.get<WorldState>("world-v2");
    if (stored) {
      for (const agent of stored.agents) {
        if (!agent.name) agent.name = generateAgentName(`${stored.seed}:${agent.id}`);
      }
      this.world = ensureAgentOperatingSystem(stored);
    } else {
      this.world = createInitialWorld(positiveInteger(this.env.WORLD_SEED, 260826081, 0x7fff_ffff));
      // A public observatory should open on a living ecology, not an empty loading screen.
      advanceWorld(this.world, 480);
    }
    this.seedAgentMemories(this.world);
    this.ensureDiaryState(this.world);
    return this.world;
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(
        Date.now() + positiveInteger(this.env.ALARM_INTERVAL_MS, 1_000, 60_000),
      );
    }
  }

  private publicSnapshot(world: WorldState): ReturnType<typeof publicSnapshot> {
    const snapshot = publicSnapshot(world, openRouterEnabled(this.env), OPENROUTER_FREE_MODEL);
    snapshot.diary = this.readWorldDiary(12);
    return snapshot;
  }

  async snapshot(): Promise<ReturnType<typeof publicSnapshot>> {
    await this.ensureAlarm();
    return this.publicSnapshot(await this.load());
  }

  async health(): Promise<Record<string, unknown>> {
    const world = await this.load();
    const diaryState = this.ensureDiaryState(world);
    await this.ensureAlarm();
    return {
      ok: true,
      tick: world.tick,
      agents: world.agents.length,
      artifacts: world.artifacts.length,
      llm: openRouterEnabled(this.env) ? "openrouter-assisted" : "deterministic",
      model: OPENROUTER_FREE_MODEL,
      fallbackModel: null,
      modelRoute: [OPENROUTER_FREE_MODEL],
      lastModel: world.llm.lastModel,
      calls: world.llm.totalCalls,
      callsToday: world.llm.callsToday,
      lastError: world.llm.lastError,
      decisionParallelism: positiveInteger(this.env.LLM_PARALLELISM, 6, 6),
      nullclawPolicy: this.nullclawPolicy() !== undefined,
      actionSandbox: "nullclaw-wasm-dsl",
      actionLibrarySize: world.actionLibrary.length,
      activeCraftingCommitments: world.agents.filter((agent) => agent.craftingTarget).length,
      completedCrafts: world.agents.reduce((total, agent) => total + agent.crafts, 0),
      meanCuriosity:
        world.agents.reduce((total, agent) => total + agent.curiosity, 0) / world.agents.length,
      memoryTokenCapPerAgent: AGENT_MEMORY_TOKEN_CAP,
      worldDecisionIntervalMs: positiveInteger(this.env.ALARM_INTERVAL_MS, 1_000, 60_000),
      decisionsPerWorldTick: world.agents.length,
      modelMacroturnIntervalTicks: MODEL_MACROTURN_INTERVAL_TICKS,
      worldDiaryIntervalTicks: WORLD_DIARY_INTERVAL_TICKS,
      worldDiaryEntries: this.readWorldDiary(168).length,
      nextWorldDiaryTick: diaryState.nextTick,
      worldDiaryLastError: diaryState.lastError || undefined,
    };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("Expected WebSocket", { status: 426 });
    await this.ensureAlarm();
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify(await this.snapshot()));
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    try {
      const world = await this.load();
      const previousMessages = new Set(world.messages.map((message) => message.id));
      const previousEvents = new Set(world.events.map((event) => event.id));
      const candidateTick = world.tick + 1;
      const canAdvance = await this.maybeAskModel(world, candidateTick);
      if (canAdvance) advanceWorld(world, 1);
      for (const message of world.messages.filter(
        (candidate) => !previousMessages.has(candidate.id),
      )) {
        this.appendAgentMemory(
          message.fromId,
          message.tick,
          "said",
          `Said to ${message.toId}: “${message.text}”`,
        );
        this.appendAgentMemory(
          message.toId,
          message.tick,
          "heard",
          `Heard ${message.fromId}: “${message.text}”`,
        );
      }
      for (const event of world.events.filter((candidate) => !previousEvents.has(candidate.id))) {
        this.appendDiaryEvent(event);
        const agent = world.agents.find((candidate) => event.text.startsWith(`${candidate.name} `));
        if (agent) this.appendAgentMemory(agent.id, event.tick, event.kind, event.text);
      }
      await this.maybeWriteWorldDiary(world);
      await this.ctx.storage.put("world-v2", world);
      const payload = JSON.stringify(this.publicSnapshot(world));
      for (const socket of this.ctx.getWebSockets()) {
        try {
          socket.send(payload);
        } catch {
          socket.close(1011, "snapshot delivery failed");
        }
      }
    } finally {
      // Keep the world waking even when model, persistence, or socket delivery fails.
      await this.ctx.storage.setAlarm(
        Date.now() + positiveInteger(this.env.ALARM_INTERVAL_MS, 1_000, 60_000),
      );
    }
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") socket.send("pong");
  }

  private nullclawPolicy(): PolicyExports | undefined {
    if (this.policy) return this.policy;
    try {
      const instance = new WebAssembly.Instance(agentCore);
      this.policy = instance.exports as PolicyExports;
      return this.policy;
    } catch {
      return undefined;
    }
  }

  private async maybeAskModel(world: WorldState, candidateTick: number): Promise<boolean> {
    const dueAgents = decisionAgentsDue(world, candidateTick);
    if (!dueAgents.length) return true;
    if (!openRouterEnabled(this.env)) {
      world.llm.lastError = `${dueAgents.length} decisions waiting · OpenRouter disabled`;
      return false;
    }
    const today = new Date().toISOString().slice(0, 10);
    if (world.llm.callDay !== today) {
      world.llm.callDay = today;
      world.llm.callsToday = 0;
    }
    const dailyLimit = positiveInteger(this.env.MAX_LLM_CALLS_PER_DAY, 21_600, 500_000);
    const remaining = dailyLimit - world.llm.callsToday;
    if (remaining <= 0) {
      world.llm.lastError = `${dueAgents.length} decisions waiting · daily model limit reached`;
      return false;
    }

    // Six matches Cloudflare's simultaneous outbound-connection ceiling.
    // Fixed phases schedule at most two agents per tick. Requests share one
    // candidate tick, then apply in stable agent order so
    // provider response timing cannot change simulation ordering.
    const parallelism = Math.min(positiveInteger(this.env.LLM_PARALLELISM, 6, 6), remaining);
    const agents = dueAgents.slice(0, parallelism);
    const policyCore = this.nullclawPolicy();
    const outcomes = await Promise.all(
      agents.map(async (agent) => {
        const observation = {
          ...decisionObservation(world, agent),
          scheduledDecisionTick: candidateTick,
          longTermMemory: this.modelMemoryContext(agent.id),
        };
        const serialized = JSON.stringify(observation);
        const localTile = world.terrain[agent.y * 96 + agent.x];
        const hazardPercent = Math.round((localTile?.contamination ?? 0) * 100);
        const policy =
          policyCore?.choose_policy(
            serialized.length,
            hazardPercent,
            agent.directive.goal === "build" && agent.builds === 0 ? 3 : 0,
            world.metrics.forkDepth,
          ) ?? 0;
        const policyLabel = policy === 2 ? "urgent" : policy === 1 ? "detailed" : "concise";
        try {
          return {
            agentId: agent.id,
            result: await this.requestDirective(agent.id, serialized, policyLabel),
          };
        } catch (error) {
          const decisionError =
            error instanceof ModelDecisionError
              ? error
              : new ModelDecisionError(
                  error instanceof Error ? error.message : "OpenRouter request failed",
                  true,
                );
          return {
            agentId: agent.id,
            error: decisionError.message,
            retryable: decisionError.retryable,
          };
        }
      }),
    );

    const errors: string[] = [];
    let retryableFailure = agents.length < dueAgents.length;
    for (const outcome of outcomes) {
      if (!outcome.result) {
        errors.push(`${outcome.agentId}: ${outcome.error}`);
        if (outcome.retryable) retryableFailure = true;
        else
          recordFailedDecision(
            world,
            outcome.agentId,
            candidateTick,
            outcome.error ?? "invalid model decision",
          );
        continue;
      }
      const agent = world.agents.find((candidate) => candidate.id === outcome.agentId);
      const candidate = outcome.result.directive.creativeSession;
      const extensionFacilitated = Boolean(
        agent &&
        candidate &&
        validateActionProposal(candidate) &&
        policyCore?.facilitate_extension(
          agent.discoveries + agent.artifactsTouched,
          agent.knownActionIds.length,
          candidate.program.length,
          new TextEncoder().encode(candidate.algorithm).length,
        ) === 1,
      );
      const previousActivity = agent
        ? {
            startTick: Math.max(1, Math.min(agent.script.updatedTick, candidateTick - 1)),
            content: `Executed ${agent.script.icon} ${agent.script.actionId}: ${agent.script.rationale}`,
          }
        : undefined;
      const committed = applyDirective(
        world,
        outcome.agentId,
        outcome.result.directive,
        extensionFacilitated,
        candidateTick,
      );
      if (!committed) {
        errors.push(`${outcome.agentId}: validated directive could not be committed`);
        recordFailedDecision(
          world,
          outcome.agentId,
          candidateTick,
          "validated directive could not be committed",
        );
        continue;
      }
      if (previousActivity) {
        const activityTicks = candidateTick - previousActivity.startTick;
        if (activityTicks > 0)
          this.appendAgentMemory(
            outcome.agentId,
            candidateTick - 1,
            "activity",
            previousActivity.content,
            previousActivity.startTick,
            activityTicks,
          );
      }
      world.llm.callsToday += 1;
      world.llm.totalCalls += 1;
      world.llm.totalCost += outcome.result.cost;
      world.llm.lastModel = outcome.result.model;
    }
    world.llm.lastError = errors.length
      ? `${errors.length}/${dueAgents.length} decisions failed · ${errors.at(-1)}`.slice(0, 160)
      : undefined;
    return !retryableFailure;
  }

  private async maybeWriteWorldDiary(world: WorldState): Promise<void> {
    const state = this.ensureDiaryState(world);
    if (world.tick < state.nextTick) return;
    if (!openRouterEnabled(this.env)) {
      this.deferWorldDiary(world.tick, "OpenRouter disabled");
      return;
    }
    const dailyLimit = positiveInteger(this.env.MAX_LLM_CALLS_PER_DAY, 21_600, 500_000);
    if (world.llm.callsToday >= dailyLimit) {
      this.deferWorldDiary(world.tick, "daily model limit reached");
      return;
    }

    const counts = Object.fromEntries(
      this.ctx.storage.sql
        .exec<DiaryEventCountRow>(
          `SELECT kind, COUNT(*) AS count FROM world_diary_events
           WHERE tick > ? AND tick <= ? GROUP BY kind`,
          state.startTick,
          world.tick,
        )
        .toArray()
        .map((row) => [row.kind, row.count]),
    );
    const recentEvents = this.ctx.storage.sql
      .exec<DiaryEventRow>(
        `SELECT tick, kind, text FROM world_diary_events
         WHERE tick > ? AND tick <= ? ORDER BY tick DESC LIMIT 80`,
        state.startTick,
        world.tick,
      )
      .toArray()
      .reverse();
    let baseline: Record<string, unknown> = {};
    try {
      baseline = JSON.parse(state.baselineJson) as Record<string, unknown>;
    } catch {
      baseline = {};
    }
    const previousActionIds = new Set(
      Array.isArray(baseline.actionIds)
        ? baseline.actionIds.filter((value): value is string => typeof value === "string")
        : [],
    );
    const newActions = world.actionLibrary
      .filter((action) => !previousActionIds.has(action.id))
      .map(({ id, name, algorithm, program }) => ({ id, name, algorithm, program }));
    const evidence = {
      interval: { startTick: state.startTick, endTick: world.tick },
      eventCounts: counts,
      recentEvents,
      newActions,
      before: baseline,
      after: this.diaryBaseline(world),
      newestArtifacts: world.artifacts.slice(-12).map((artifact) => ({
        id: artifact.id,
        generation: artifact.generation,
        parentId: artifact.parentId,
        creatorId: artifact.creatorId,
        controller: artifact.controller.action,
        performance: Math.round(artifact.performance * 1_000) / 1_000,
        uses: artifact.uses,
      })),
    };

    try {
      const result = await this.requestWorldDiary(JSON.stringify(evidence));
      const createdAt = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO world_diary_entries
          (start_tick, end_tick, lines_json, model, cost, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        state.startTick,
        world.tick,
        JSON.stringify(result.lines),
        result.model ?? "",
        result.cost,
        createdAt,
      );
      this.ctx.storage.sql.exec(
        `UPDATE world_diary_state
         SET start_tick = ?, next_tick = ?, baseline_json = ?, last_error = ''
         WHERE singleton = 1`,
        world.tick,
        nextWorldDiaryTick(world.tick),
        JSON.stringify(this.diaryBaseline(world)),
      );
      this.ctx.storage.sql.exec("DELETE FROM world_diary_events WHERE tick <= ?", world.tick);
      world.llm.callsToday += 1;
      world.llm.totalCalls += 1;
      world.llm.totalCost += result.cost;
      world.llm.lastModel = result.model ?? world.llm.lastModel;
    } catch (error) {
      this.deferWorldDiary(
        world.tick,
        error instanceof Error ? error.message : "world diary request failed",
      );
    }
  }

  private deferWorldDiary(tick: number, reason: string): void {
    this.ctx.storage.sql.exec(
      `UPDATE world_diary_state SET next_tick = ?, last_error = ? WHERE singleton = 1`,
      tick + MODEL_MACROTURN_INTERVAL_TICKS,
      reason.replace(/\s+/g, " ").trim().slice(0, 160),
    );
  }

  private async requestWorldDiary(evidence: string): Promise<ModelDiaryResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: "Bearer " + this.env.OPENROUTER_API_KEY,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://stigmergy-world.stas6236.workers.dev",
          "X-OpenRouter-Title": "Stigmergy World Diary",
        },
        body: JSON.stringify({
          model: OPENROUTER_FREE_MODEL,
          session_id: "stigmergy-world-diary",
          messages: [
            {
              role: "system",
              content:
                "You are the concise observer diary for a persistent SwarmWorld-inspired simulation. Convert one authoritative trace interval into 1-5 short, readable lines. Prioritize genuinely new or evolving phenomena: newly authored bounded actions or skills, newly mapped resources, artifact growth or inheritance, adoption, collaboration, and meaningful setbacks. Use only supplied trace evidence. Distinguish events from outcomes; do not invent causes, success, novelty, or scientific validation. Omit routine repetition and bot-by-bot narration. Each line must stand alone, use plain English, and stay under 140 characters.",
            },
            { role: "user", content: `Authoritative interval evidence: ${evidence}` },
          ],
          response_format: worldDiaryResponseFormat,
          provider: { require_parameters: true },
          max_tokens: 300,
          temperature: 0.35,
        }),
      });
      let data: OpenRouterResponse;
      try {
        data = (await response.json()) as OpenRouterResponse;
      } catch {
        throw new ModelDecisionError("World diary returned invalid response JSON", true);
      }
      if (!response.ok)
        throw new ModelDecisionError(
          data.error?.message ?? `World diary HTTP ${response.status}`,
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new ModelDecisionError("World diary returned no content", true);
      let parsed: { lines?: unknown };
      try {
        parsed = JSON.parse(content) as { lines?: unknown };
      } catch {
        throw new ModelDecisionError("World diary was not valid JSON", false);
      }
      const lines = normalizeWorldDiaryLines(parsed.lines);
      if (!lines.length)
        throw new ModelDecisionError("World diary contained no readable lines", false);
      return { lines, model: data.model, cost: data.usage?.cost ?? 0 };
    } catch (error) {
      if (error instanceof ModelDecisionError) throw error;
      throw new ModelDecisionError(
        error instanceof Error ? error.message : "World diary transport failed",
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestDirective(
    agentId: string,
    observation: string,
    policy: string,
  ): Promise<ModelDirectiveResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://stigmergy-world.stas6236.workers.dev",
          "X-OpenRouter-Title": "Stigmergy World",
        },
        body: JSON.stringify({
          model: OPENROUTER_FREE_MODEL,
          session_id: `stigmergy-${agentId}`,
          messages: [
            {
              role: "system",
              content:
                "You are one initially identical embodied agent in a persistent material world. This is your fixed scheduled macroturn. The activity you choose now repeats cyclically until your next AI opportunity in 60 world ticks. SOUL.md is policy, USER.md names the beneficiary, and MEMORY.md is fallible experience. Choose an existing actionId from availableActions and one Unicode icon. Carried water is automatically consumed when energy is low. Gathering tidal water is an emergency refill, not the default: choose it when energy is below 0.55 and water inventory is below 1.5; once water inventory reaches 3, choose an underrepresented non-water material, build, inspect, maintain, explore, craft, or create. Never choose water merely because the local tile is wet. A pending craftingTarget is a commitment: continue goal craft or create until its missing materials are gathered and the thing is built. MaterialPurposes explains why inventory is reserved. Use goal craft with craftActionId to learn one listed craftableAction. Outside the emergency-water condition, when creativeSessionEligible is true and energy is above 0.25, choose goal create: propose one genuinely new reusable action, two physical ingredients, and a concrete purpose. Otherwise return creativeSession as null. This is a Creative Session, not instant invention. The deterministic sandbox must gather and consume both ingredients before registering the action; failed or duplicate mixes do not satisfy curiosity. New programs may compose only listed bounded primitives and cannot create resources or declare outcomes. speech must exchange one useful observed fact in one 3-8 word sentence of basic caveman telegraphic English, like 'Water low here, seek tidal.' Never use two sentences. The deterministic sandbox executes one primitive per tick and the world decides consequences. note: max 12 words.",
            },
            {
              role: "user",
              content: `NullClaw context policy: ${policy}. Local observation: ${observation}`,
            },
          ],
          response_format: agentDirectiveResponseFormat,
          provider: { require_parameters: true },
          max_tokens: 1024,
          temperature: 0.72,
        }),
      });
      let data: OpenRouterResponse;
      try {
        data = (await response.json()) as OpenRouterResponse;
      } catch {
        throw new ModelDecisionError("OpenRouter returned invalid response JSON", true);
      }
      if (!response.ok) {
        const retryable =
          response.status === 408 ||
          response.status === 409 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500;
        throw new ModelDecisionError(
          data.error?.message ?? `OpenRouter HTTP ${response.status}`,
          retryable,
        );
      }
      const choice = data.choices?.[0];
      const content = choice?.message?.content;
      if (!content)
        throw new ModelDecisionError(
          choice?.error?.message ??
            `OpenRouter returned no directive (${choice?.finish_reason ?? "no choice"})`,
          true,
        );
      let parsed: Partial<AgentDirective>;
      try {
        parsed = JSON.parse(content) as Partial<AgentDirective>;
      } catch {
        throw new ModelDecisionError("OpenRouter directive was not valid JSON", false);
      }
      const creativeSession =
        parsed.creativeSession == null
          ? undefined
          : (parsed.creativeSession as CreativeSessionProposal);
      if (
        !isGoal(parsed.goal) ||
        !isMaterial(parsed.targetMaterial) ||
        !isAction(parsed.controllerAction) ||
        typeof parsed.actionId !== "string" ||
        typeof parsed.craftActionId !== "string" ||
        typeof parsed.speech !== "string" ||
        !assignableActionIcons.includes(parsed.icon as (typeof assignableActionIcons)[number]) ||
        (creativeSession !== undefined && !isCreativeSessionShape(creativeSession))
      ) {
        throw new ModelDecisionError("OpenRouter directive failed local schema validation", false);
      }
      return {
        directive: {
          goal: parsed.goal,
          targetMaterial: parsed.targetMaterial,
          controllerAction: parsed.controllerAction,
          note: String(parsed.note ?? "follow local evidence").slice(0, 120),
          source: "openrouter",
          model: data.model,
          actionId: parsed.actionId.slice(0, 32),
          icon: parsed.icon,
          craftActionId: parsed.craftActionId.slice(0, 32),
          creativeSession,
          speech: parsed.speech.slice(0, 80),
        },
        model: data.model,
        cost: data.usage?.cost ?? 0,
      };
    } catch (error) {
      if (error instanceof ModelDecisionError) throw error;
      throw new ModelDecisionError(
        error instanceof Error ? error.message : "OpenRouter transport failed",
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isGoal(value: unknown): value is AgentDirective["goal"] {
  return (
    typeof value === "string" &&
    ["explore", "gather", "build", "inspect", "maintain", "craft", "create"].includes(value)
  );
}

function isMaterial(value: unknown): value is MaterialKind {
  return (
    typeof value === "string" &&
    ["water", "fungus", "mineral", "cellulose", "chitin"].includes(value)
  );
}

function isAction(value: unknown): value is ControllerAction {
  return (
    typeof value === "string" &&
    ["collect-water", "remediate", "heal", "grow", "signal"].includes(value)
  );
}

function isActionProposalShape(value: unknown): value is AgentActionProposal {
  if (!value || typeof value !== "object") return false;
  const proposal = value as Partial<AgentActionProposal>;
  return (
    typeof proposal.name === "string" &&
    typeof proposal.algorithm === "string" &&
    assignableActionIcons.includes(proposal.icon as (typeof assignableActionIcons)[number]) &&
    Array.isArray(proposal.program) &&
    proposal.program.length <= 4 &&
    proposal.program.every((step) =>
      modelActionPrimitives.includes(step as (typeof modelActionPrimitives)[number]),
    )
  );
}

function isCreativeSessionShape(value: unknown): value is CreativeSessionProposal {
  if (!isActionProposalShape(value)) return false;
  const session = value as Partial<CreativeSessionProposal>;
  return (
    Array.isArray(session.ingredients) &&
    session.ingredients.length === 2 &&
    session.ingredients.every(isMaterial) &&
    typeof session.purpose === "string" &&
    session.purpose.length <= 120
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const world = env.WORLD.getByName("planet-alpha");

    if (url.pathname === "/api/snapshot" && request.method === "GET")
      return json(await world.snapshot());
    if (url.pathname === "/api/health" && request.method === "GET")
      return json(await Promise.resolve(world.health()));
    if (url.pathname === "/api/agent-memory" && request.method === "GET") {
      const agentId = url.searchParams.get("id") ?? "";
      if (!/^A\d{3}$/u.test(agentId)) return json({ error: "Invalid agent ID" }, { status: 400 });
      const memory = await world.agentMemory(agentId);
      return memory ? json(memory) : json({ error: "Agent not found" }, { status: 404 });
    }
    if (url.pathname === "/api/world-diary" && request.method === "GET")
      return json(await world.worldDiary());
    if (url.pathname === "/api/ws") return world.fetch(request);
    if (url.pathname.startsWith("/api/") && request.method !== "GET")
      return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET" } });
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, { status: 404 });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
