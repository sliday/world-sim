import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { requestClefDirective } from "./clef-decisions";
import { createInitialWorld, decisionObservation } from "./engine";
import { baseHarness, situationFeatures } from "./harness";
import type { AgentHarness } from "./harness-types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function observation() {
  const world = createInitialWorld(42);
  return decisionObservation(world, world.agents[0]!);
}

function responseBody() {
  return {
    model: "cloudflare/clef-flash",
    answers: {
      goal: {
        type: "choice",
        choice: "gather",
        confidence: 1,
        probabilities: { explore: 0, gather: 1, build: 0, inspect: 0, maintain: 0 },
      },
      targetMaterial: {
        type: "choice",
        choice: "water",
        confidence: 1,
        probabilities: { water: 1, fungus: 0, mineral: 0, cellulose: 0, chitin: 0 },
      },
      controllerAction: {
        type: "choice",
        choice: "remediate",
        confidence: 1,
        probabilities: { "collect-water": 0, remediate: 1, heal: 0, grow: 0, signal: 0 },
      },
      holdMacroturns: {
        type: "choice",
        choice: "4",
        confidence: 1,
        probabilities: { "1": 0, "2": 0, "4": 1, "8": 0 },
      },
    },
    usage: { cost: 0.00002, input_tokens: 500, output_tokens: 100 },
  };
}

describe("Clef agent decisions", () => {
  it("uses the existing OpenRouter key and maps typed choices to an executable directive", async () => {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer existing-key");
      if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
      const body = JSON.parse(init.body);
      expect(body.model).toBe("cloudflare/clef-flash");
      expect(body.state.agent.id).toBe("A001");
      expect(body.questions.actionId).toBeUndefined();
      expect(Object.keys(body.questions.holdMacroturns.criteria)).toEqual(["1", "2", "4", "8"]);
      expect(body.messages).toBeUndefined();
      return Response.json(responseBody());
    });
    const result = await requestClefDirective("existing-key", observation());
    expect(result.directive).toMatchObject({
      goal: "gather",
      targetMaterial: "water",
      controllerAction: "remediate",
      actionId: "forage",
      source: "openrouter",
      model: "cloudflare/clef-flash",
      holdMacroturns: 4,
    });
    expect(result.cost).toBe(0.00002);
  });

  it.each(["full-culture", "no-communication", "no-explicit-culture"] as const)(
    "preserves the %s communication rule for routine directives",
    async (condition) => {
      const world = createInitialWorld(42);
      world.interactionCondition = condition;
      const state = decisionObservation(world, world.agents[0]!);
      expect(state.localTerrain).toBe("plain");
      vi.stubGlobal("fetch", async () => Response.json(responseBody()));
      const { directive } = await requestClefDirective("key", state);
      expect(directive.speech).toBe(
        condition === "full-culture" ? "Ground here plain." : undefined,
      );
    },
  );

  it.each([
    { energy: 0.4, water: 1.4, eligible: false, goal: "gather", actionId: "forage" },
    { energy: 0.4, water: 1.4, eligible: true, goal: "gather", actionId: "forage" },
    { energy: 0.9, water: 3, eligible: true, goal: "create", actionId: "creative-session" },
    { energy: 0.4, water: 1.5, eligible: true, goal: "create", actionId: "creative-session" },
    { energy: 0.55, water: 1.4, eligible: true, goal: "create", actionId: "creative-session" },
  ])(
    "requires $goal with energy $energy, water $water, and creative eligibility $eligible",
    async ({ energy, water, eligible, goal, actionId }) => {
      const world = createInitialWorld(42);
      const agent = world.agents[0]!;
      agent.energy = energy;
      agent.inventory.water = water;
      const state = { ...decisionObservation(world, agent), creativeSessionEligible: eligible };
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
        const body = JSON.parse(init.body);
        expect(body.questions.goal).toBeUndefined();
        if (goal === "gather") expect(body.questions.targetMaterial).toBeUndefined();
        if (goal === "gather") expect(body.questions.holdMacroturns).toBeUndefined();
        const response = responseBody();
        const answers: Record<string, unknown> = { ...response.answers };
        delete answers.goal;
        if (goal === "gather") delete answers.targetMaterial;
        if (goal === "gather") delete answers.holdMacroturns;
        return Response.json({ ...response, answers });
      });
      expect((await requestClefDirective("key", state)).directive).toMatchObject({
        goal,
        actionId,
        holdMacroturns: goal === "gather" ? 1 : 4,
      });
    },
  );

  it.each([
    { energy: 0.25, water: 3, eligible: true },
    { energy: 0.55, water: 1.4, eligible: false },
    { energy: 0.4, water: 1.5, eligible: false },
  ])(
    "retains normal goals with energy $energy, water $water, and creative eligibility $eligible",
    async ({ energy, water, eligible }) => {
      const world = createInitialWorld(42);
      const agent = world.agents[0]!;
      agent.energy = energy;
      agent.inventory.water = water;
      const state = { ...decisionObservation(world, agent), creativeSessionEligible: eligible };
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
        const body = JSON.parse(init.body);
        expect(Object.keys(body.questions.goal.criteria)).toEqual([
          "explore",
          "gather",
          "build",
          "inspect",
          "maintain",
        ]);
        return Response.json(responseBody());
      });
      expect((await requestClefDirective("key", state)).directive.goal).toBe("gather");
    },
  );

  it("lets Clef hold a commitment with enough water for up to eight macroturns", async () => {
    const world = createInitialWorld(42);
    const agent = world.agents[0]!;
    agent.energy = 0.4;
    agent.inventory.water = 2;
    agent.craftingTarget = {
      mode: "craft",
      actionName: "Woven filter",
      ingredients: ["fungus", "cellulose"],
      purpose: "Filter local contamination",
      startedTick: 0,
    };
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
      const body = JSON.parse(init.body);
      expect(Object.keys(body.questions.holdMacroturns.criteria).length).toBeGreaterThanOrEqual(2);
      const response = responseBody();
      const answers: Record<string, unknown> = {
        ...response.answers,
        holdMacroturns: {
          type: "choice",
          choice: "8",
          confidence: 0.7,
          probabilities: { "1": 0.1, "2": 0.1, "4": 0.1, "8": 0.7 },
        },
      };
      delete answers.goal;
      return Response.json({ ...response, answers });
    });
    const { directive } = await requestClefDirective("key", decisionObservation(world, agent));
    expect(directive).toMatchObject({ goal: "craft", holdMacroturns: 8 });
  });

  it.each(["3", "16"])("rejects a hold of %s macroturns", async (hold) => {
    const body = responseBody();
    body.answers.holdMacroturns.choice = hold;
    vi.stubGlobal("fetch", async () => Response.json(body));
    await expect(requestClefDirective("key", observation())).rejects.toMatchObject({
      retryable: false,
    });
  });

  it.each([
    "missing",
    "extra",
    "unknown",
    "nonfinite",
    "distribution",
    "confidence",
    "type",
    "missing-label",
    "extra-label",
  ])("rejects a %s answer before the simulator receives a directive", async (failure) => {
    const body = responseBody();
    if (failure === "missing") delete (body.answers as Record<string, unknown>).goal;
    if (failure === "extra") Object.assign(body.answers, { unexpected: body.answers.goal });
    if (failure === "unknown") body.answers.goal.choice = "teleport";
    if (failure === "nonfinite") body.answers.goal.probabilities.gather = NaN;
    if (failure === "distribution") body.answers.goal.probabilities.gather = 0.2;
    if (failure === "confidence") body.answers.goal.confidence = 2;
    if (failure === "type") body.answers.goal.type = "score";
    if (failure === "missing-label")
      delete (body.answers.goal.probabilities as Record<string, number>).explore;
    if (failure === "extra-label") Object.assign(body.answers.goal.probabilities, { teleport: 0 });
    vi.stubGlobal("fetch", async () => Response.json(body));
    await expect(requestClefDirective("key", observation())).rejects.toMatchObject({
      retryable: false,
    });
  });

  it.each([402, 429])("stops after HTTP %i without a retry", async (status) => {
    let attempts = 0;
    vi.stubGlobal("fetch", async () => {
      attempts += 1;
      return Response.json(
        { error: { message: "Provider limit" } },
        { status, headers: { "Retry-After": "120" } },
      );
    });
    await expect(requestClefDirective("key", observation())).rejects.toMatchObject({
      retryable: false,
      status,
      retryAfterMs: 120_000,
    });
    expect(attempts).toBe(1);
  });

  it.each([402, 429])(
    "preserves HTTP %i classification when the error body is not JSON",
    async (status) => {
      const fetch = vi.fn(async () => new Response("Provider limit", { status }));
      vi.stubGlobal("fetch", fetch);
      await expect(requestClefDirective("key", observation())).rejects.toMatchObject({
        retryable: false,
        status,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects invalid JSON without returning a directive", async () => {
    vi.stubGlobal("fetch", async () => new Response("{invalid"));
    await expect(requestClefDirective("key", observation())).rejects.toMatchObject({
      name: "ClefDecisionError",
    });
  });

  it("uses a known learned action and its allowed icon", async () => {
    const world = createInitialWorld(42);
    const agent = world.agents[0]!;
    world.actionLibrary.push({
      id: "learned-water",
      name: "Water search",
      icon: "≈",
      algorithm: "Seek water and gather it.",
      program: ["seek-resource", "gather-local"],
      authorId: agent.id,
      createdTick: 0,
      uses: 0,
    });
    agent.knownActionIds.push("learned-water");
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
      const body = JSON.parse(init.body);
      expect(Object.keys(body.questions.actionId.criteria)).toEqual(["default", "learned-water"]);
      const response = responseBody();
      const answer = {
        type: "choice",
        choice: "learned-water",
        confidence: 1,
        probabilities: { default: 0, "learned-water": 1 },
      };
      Object.assign(response.answers, { actionId: answer });
      return Response.json(response);
    });
    const { directive } = await requestClefDirective("key", decisionObservation(world, agent));
    expect(directive).toMatchObject({ goal: "gather", actionId: "learned-water", icon: "≈" });
  });

  it("selects an unknown recipe and runs the built-in craft activity", async () => {
    const world = createInitialWorld(42);
    const agent = world.agents[0]!;
    world.actionLibrary.push({
      id: "woven-filter",
      name: "Woven filter",
      icon: "◇",
      algorithm: "Combine fungus and cellulose.",
      program: ["craft-local"],
      recipe: ["fungus", "cellulose"],
      authorId: "A002",
      createdTick: 0,
      uses: 0,
    });
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
      const body = JSON.parse(init.body);
      expect(body.questions.goal.criteria.craft).toBeDefined();
      expect(body.questions.craftActionId).toBeUndefined();
      const original = responseBody();
      return Response.json({
        ...original,
        answers: {
          ...original.answers,
          goal: {
            type: "choice",
            choice: "craft",
            confidence: 1,
            probabilities: { explore: 0, gather: 0, build: 0, inspect: 0, maintain: 0, craft: 1 },
          },
        },
      });
    });
    const { directive } = await requestClefDirective("key", decisionObservation(world, agent));
    expect(directive).toMatchObject({
      goal: "craft",
      actionId: "craft",
      craftActionId: "woven-filter",
    });
  });

  it("aborts a request after 12 seconds and reports a retryable transport failure", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          signal = init.signal as AbortSignal;
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Request aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const result = expect(requestClefDirective("key", observation())).rejects.toMatchObject({
      name: "ClefDecisionError",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(12_000);
    await result;
    expect(signal?.aborted).toBe(true);
  });

  it.each(["creative", "craft"] as const)(
    "keeps a %s commitment before emergency and creative rules",
    async (mode) => {
      const world = createInitialWorld(42);
      const agent = world.agents[0]!;
      agent.energy = 0.4;
      agent.inventory.water = 1.4;
      agent.craftingTarget = {
        mode,
        actionName: "Woven filter",
        ingredients: ["fungus", "cellulose"],
        purpose: "Filter local contamination",
        startedTick: 0,
      };
      const state = { ...decisionObservation(world, agent), creativeSessionEligible: true };
      const goal = mode === "creative" ? "create" : "craft";
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
        const body = JSON.parse(init.body);
        expect(body.questions.goal).toBeUndefined();
        expect(body.questions.holdMacroturns).toBeUndefined();
        const response = responseBody();
        const answers: Record<string, unknown> = { ...response.answers };
        delete answers.goal;
        delete answers.holdMacroturns;
        return Response.json({ ...response, answers });
      });
      expect((await requestClefDirective("key", state)).directive).toMatchObject({
        goal,
        actionId: mode === "creative" ? "creative-session" : "craft",
        holdMacroturns: 1,
      });
    },
  );
});

describe("Clef agent decisions under a harness", () => {
  type Body = {
    state: Record<string, unknown>;
    questions: Record<string, { instructions: string; criteria: Record<string, string> }>;
  };

  /** Answers every open question, choosing `picks[id]` when given and the first label otherwise. */
  function answering(bodies: Body[], picks: Record<string, string> = {}) {
    return async (_url: string, init: RequestInit) => {
      if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
      const body = JSON.parse(init.body) as Body;
      bodies.push(body);
      const answers = Object.fromEntries(
        Object.entries(body.questions).map(([id, question]) => {
          const labels = Object.keys(question.criteria);
          const choice = picks[id] && labels.includes(picks[id]) ? picks[id] : labels[0]!;
          return [
            id,
            {
              type: "choice",
              choice,
              confidence: 1,
              probabilities: Object.fromEntries(
                labels.map((label) => [label, label === choice ? 1 : 0]),
              ),
            },
          ];
        }),
      );
      return Response.json({ model: "cloudflare/clef-flash", answers, usage: { cost: 0.00002 } });
    };
  }

  function learnedWorld() {
    const world = createInitialWorld(42);
    const agent = world.agents[0]!;
    world.actionLibrary.push({
      id: "learned-water",
      name: "Water search",
      icon: "≈",
      algorithm: "Seek water and gather it.",
      program: ["seek-resource", "gather-local"],
      authorId: agent.id,
      createdTick: 0,
      uses: 0,
    });
    agent.knownActionIds.push("learned-water");
    return { world, agent, features: situationFeatures(world, agent) };
  }

  function adopted(changes: Partial<AgentHarness>): AgentHarness {
    return { ...baseHarness(), revision: 1, origin: "adopted", ...changes };
  }

  it("applies procedure, guards, guidance, and memory to the request and skills to the directive", async () => {
    const { world, agent, features } = learnedWorld();
    const harness = adopted({
      procedure: ["Refill water before energy falls below 0.3."],
      guards: [
        {
          id: "no-inspect",
          when: { all: [{ feature: "energy", op: ">=", value: 0 }] },
          effect: { kind: "forbid", question: "goal", label: "inspect" },
          note: "No inherited artifact lies in reach.",
        },
      ],
      memory: [
        {
          id: "mineral-east",
          kind: "resource",
          text: "In this workspace mineral is viable at (20,2).",
          x: 20,
          y: 2,
          material: "mineral",
          verifiedTick: 0,
        },
      ],
      guidance: [
        {
          id: "mineral-hint",
          question: "targetMaterial",
          label: "mineral",
          text: "Mineral lies two tiles east of the foundry.",
        },
      ],
      skills: [
        {
          id: "water-search",
          when: { all: [] },
          goal: "gather",
          actionId: "learned-water",
          note: "Use the learned water search when gathering.",
        },
      ],
    });
    const bodies: Body[] = [];
    vi.stubGlobal("fetch", answering(bodies, { goal: "gather", actionId: "default" }));
    const { directive } = await requestClefDirective("key", decisionObservation(world, agent), {
      harness,
      features,
      knownActionIds: agent.knownActionIds,
    });
    const body = bodies[0]!;
    expect(body.questions.goal!.instructions).toMatch(
      / Harness procedure: Refill water before energy falls below 0\.3\.$/,
    );
    expect(Object.keys(body.questions.goal!.criteria)).toEqual([
      "explore",
      "gather",
      "build",
      "maintain",
    ]);
    expect(body.questions.targetMaterial!.criteria.mineral).toBe(
      "Mineral lies two tiles east of the foundry.",
    );
    expect(body.state.harnessMemory).toEqual(["In this workspace mineral is viable at (20,2)."]);
    expect(directive).toMatchObject({ goal: "gather", actionId: "learned-water", icon: undefined });
  });

  it("resolves a goal that a guard requires locally", async () => {
    const { world, agent, features } = learnedWorld();
    const harness = adopted({
      guards: [
        {
          id: "explore-first",
          when: { all: [{ feature: "energy", op: ">=", value: 0 }] },
          effect: { kind: "require", question: "goal", label: "explore" },
          note: "Nothing viable is mapped nearby.",
        },
      ],
    });
    const bodies: Body[] = [];
    vi.stubGlobal("fetch", answering(bodies));
    const { directive } = await requestClefDirective("key", decisionObservation(world, agent), {
      harness,
      features,
      knownActionIds: agent.knownActionIds,
    });
    expect(bodies[0]!.questions.goal).toBeUndefined();
    expect(directive.goal).toBe("explore");
  });

  it("leaves a guard inert while its condition fails", async () => {
    const { world, agent, features } = learnedWorld();
    const harness = adopted({
      guards: [
        {
          id: "explore-when-drained",
          when: { all: [{ feature: "energy", op: "<", value: 0 }] },
          effect: { kind: "require", question: "goal", label: "explore" },
          note: "Energy never falls below zero.",
        },
      ],
    });
    const bodies: Body[] = [];
    vi.stubGlobal("fetch", answering(bodies));
    await requestClefDirective("key", decisionObservation(world, agent), {
      harness,
      features,
      knownActionIds: agent.knownActionIds,
    });
    await requestClefDirective("key", decisionObservation(world, agent));
    expect(JSON.stringify(bodies[0])).toBe(JSON.stringify(bodies[1]));
  });
});
