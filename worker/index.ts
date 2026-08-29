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
  actionPrimitives,
  assignableActionIcons,
  validateActionProposal,
} from "../src/sim/action-sandbox";
import {
  AGENT_MEMORY_CONTEXT_TOKENS,
  AGENT_MEMORY_TOKEN_CAP,
  compactMemoryLog,
  estimateMemoryTokens,
  type DurableMemoryEntry,
} from "../src/sim/memory-log";
import type {
  AgentActionProposal,
  AgentDirective,
  ControllerAction,
  MaterialKind,
  WorldState,
} from "../src/sim/types";

interface Env {
  WORLD: DurableObjectNamespace<WorldRoom>;
  ASSETS: Fetcher;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL: string;
  OPENROUTER_FALLBACK_MODEL?: string;
  LLM_ENABLED: string;
  LLM_PARALLELISM: string;
  MAX_LLM_CALLS_PER_DAY: string;
  WORLD_SEED: string;
  ALARM_INTERVAL_MS: string;
}

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

interface MemoryEntryRow extends DurableMemoryEntry {
  [key: string]: SqlStorageValue;
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
        goal: { type: "string", enum: ["explore", "gather", "build", "inspect", "maintain"] },
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
        actionProposal: {
          type: "object",
          properties: {
            name: { type: "string", maxLength: 32 },
            icon: { type: "string", enum: assignableActionIcons },
            algorithm: { type: "string", maxLength: 180 },
            program: {
              type: "array",
              items: { type: "string", enum: actionPrimitives },
              maxItems: 4,
            },
          },
          required: ["name", "icon", "algorithm", "program"],
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
        "actionProposal",
        "speech",
      ],
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

function openRouterModels(env: Env): string[] {
  const primary = env.OPENROUTER_MODEL?.trim() || "openrouter/free";
  const fallback = env.OPENROUTER_FALLBACK_MODEL?.trim();
  return fallback && fallback !== primary ? [primary, fallback] : [primary];
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
      `);
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
    const recent = this.ctx.storage.sql
      .exec<MemoryEntryRow>(
        "SELECT seq, tick, kind, content, tokens FROM agent_memory_entries WHERE agent_id = ? ORDER BY seq DESC LIMIT ?",
        agentId,
        Math.max(1, Math.min(40, Math.floor(limit))),
      )
      .toArray()
      .reverse();
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
        "SELECT seq, tick, kind, content, tokens FROM agent_memory_entries WHERE agent_id = ? ORDER BY seq ASC",
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

  private appendAgentMemory(agentId: string, tick: number, kind: string, content: string): void {
    const bounded = content.replace(/\s+/g, " ").trim().slice(0, 600);
    if (!bounded) return;
    this.ctx.storage.sql.exec(
      "INSERT INTO agent_memory_entries (agent_id, tick, kind, content, tokens) VALUES (?, ?, ?, ?, ?)",
      agentId,
      tick,
      kind.slice(0, 24),
      bounded,
      estimateMemoryTokens(bounded),
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
    return this.world;
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(
        Date.now() + positiveInteger(this.env.ALARM_INTERVAL_MS, 1_000, 60_000),
      );
    }
  }

  async snapshot(): Promise<ReturnType<typeof publicSnapshot>> {
    await this.ensureAlarm();
    return publicSnapshot(
      await this.load(),
      openRouterEnabled(this.env),
      this.env.OPENROUTER_MODEL,
    );
  }

  async health(): Promise<Record<string, unknown>> {
    const world = await this.load();
    await this.ensureAlarm();
    return {
      ok: true,
      tick: world.tick,
      agents: world.agents.length,
      artifacts: world.artifacts.length,
      llm: openRouterEnabled(this.env) ? "openrouter-assisted" : "deterministic",
      model: this.env.OPENROUTER_MODEL,
      fallbackModel: this.env.OPENROUTER_FALLBACK_MODEL,
      modelRoute: openRouterModels(this.env),
      lastModel: world.llm.lastModel,
      calls: world.llm.totalCalls,
      callsToday: world.llm.callsToday,
      lastError: world.llm.lastError,
      decisionParallelism: positiveInteger(this.env.LLM_PARALLELISM, 6, 6),
      nullclawPolicy: this.nullclawPolicy() !== undefined,
      actionSandbox: "nullclaw-wasm-dsl",
      actionLibrarySize: world.actionLibrary.length,
      memoryTokenCapPerAgent: AGENT_MEMORY_TOKEN_CAP,
      worldDecisionIntervalMs: positiveInteger(this.env.ALARM_INTERVAL_MS, 1_000, 60_000),
      decisionsPerWorldTick: world.agents.length,
      modelMacroturnIntervalTicks: MODEL_MACROTURN_INTERVAL_TICKS,
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
        const agent = world.agents.find((candidate) => event.text.startsWith(`${candidate.name} `));
        if (agent) this.appendAgentMemory(agent.id, event.tick, event.kind, event.text);
      }
      await this.ctx.storage.put("world-v2", world);
      const payload = JSON.stringify(
        publicSnapshot(world, openRouterEnabled(this.env), this.env.OPENROUTER_MODEL),
      );
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
      const candidate = outcome.result.directive.actionProposal;
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
          models: openRouterModels(this.env),
          session_id: `stigmergy-${agentId}`,
          messages: [
            {
              role: "system",
              content:
                "You are one initially identical embodied agent in a persistent material world. This is your fixed scheduled macroturn. The activity you choose now repeats cyclically until your next AI opportunity in 60 world ticks. SOUL.md is policy, USER.md names the beneficiary, and MEMORY.md is fallible experience. Choose an existing actionId from availableActions and one Unicode icon. You may propose one new action only when local evidence suggests a useful reusable algorithm; never restate or rename an available action. New programs may compose only listed bounded primitives; they cannot create resources or declare outcomes. If no new action is warranted, return actionProposal with empty name and algorithm, the chosen icon, and an empty program. speech must exchange one useful observed fact in one 3-8 word sentence of basic caveman telegraphic English, like 'Water low here, seek tidal.' Never use two sentences. The deterministic sandbox executes one primitive per tick and the world decides consequences. note: max 12 words.",
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
      const actionProposal = parsed.actionProposal as AgentActionProposal | undefined;
      if (
        !isGoal(parsed.goal) ||
        !isMaterial(parsed.targetMaterial) ||
        !isAction(parsed.controllerAction) ||
        typeof parsed.actionId !== "string" ||
        typeof parsed.speech !== "string" ||
        !assignableActionIcons.includes(parsed.icon as (typeof assignableActionIcons)[number]) ||
        !isActionProposalShape(actionProposal)
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
          actionProposal,
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
    ["explore", "gather", "build", "inspect", "maintain"].includes(value)
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
    proposal.program.every((step) => actionPrimitives.includes(step))
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
    if (url.pathname === "/api/ws") return world.fetch(request);
    if (url.pathname.startsWith("/api/") && request.method !== "GET")
      return json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "GET" } });
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, { status: 404 });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
