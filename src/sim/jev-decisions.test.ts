import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { requestJevDirective } from "./jev-decisions";
import { createInitialWorld, decisionObservation } from "./engine";

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
    model: "typesafe/jev-1.14-20261014",
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
      actionId: {
        type: "choice",
        choice: "default",
        confidence: 1,
        probabilities: { default: 1 },
      },
    },
    usage: { cost: 0.00002, input_tokens: 500, output_tokens: 100 },
  };
}

describe("Jev agent decisions", () => {
  it("uses the existing OpenRouter key and maps typed choices to an executable directive", async () => {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer existing-key");
      if (typeof init.body !== "string") throw new Error("Expected a JSON request body");
      const body = JSON.parse(init.body);
      expect(body.model).toBe("~typesafe/jev-latest");
      expect(body.state.agent.id).toBe("A001");
      expect(body.messages).toBeUndefined();
      return Response.json(responseBody());
    });
    const result = await requestJevDirective("existing-key", observation());
    expect(result.directive).toMatchObject({
      goal: "gather",
      targetMaterial: "water",
      controllerAction: "remediate",
      actionId: "forage",
      source: "openrouter",
      model: "typesafe/jev-1.14-20261014",
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
      const { directive } = await requestJevDirective("key", state);
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
        expect(Object.keys(body.questions.goal.criteria)).toEqual([goal]);
        if (goal === "gather")
          expect(Object.keys(body.questions.targetMaterial.criteria)).toEqual(["water"]);
        const response = responseBody();
        return Response.json({
          ...response,
          answers: {
            ...response.answers,
            goal: { type: "choice", choice: goal, confidence: 1, probabilities: { [goal]: 1 } },
            targetMaterial:
              goal === "gather"
                ? { type: "choice", choice: "water", confidence: 1, probabilities: { water: 1 } }
                : response.answers.targetMaterial,
          },
        });
      });
      expect((await requestJevDirective("key", state)).directive).toMatchObject({ goal, actionId });
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
      expect((await requestJevDirective("key", state)).directive.goal).toBe("gather");
    },
  );

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
    await expect(requestJevDirective("key", observation())).rejects.toMatchObject({
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
    await expect(requestJevDirective("key", observation())).rejects.toMatchObject({
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
      await expect(requestJevDirective("key", observation())).rejects.toMatchObject({
        retryable: false,
        status,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects invalid JSON without returning a directive", async () => {
    vi.stubGlobal("fetch", async () => new Response("{invalid"));
    await expect(requestJevDirective("key", observation())).rejects.toMatchObject({
      name: "JevDecisionError",
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
      response.answers.actionId = answer;
      return Response.json(response);
    });
    const { directive } = await requestJevDirective("key", decisionObservation(world, agent));
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
      expect(body.questions.craftActionId.criteria).toEqual({ "woven-filter": "Woven filter" });
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
          craftActionId: {
            type: "choice",
            choice: "woven-filter",
            confidence: 1,
            probabilities: { "woven-filter": 1 },
          },
        },
      });
    });
    const { directive } = await requestJevDirective("key", decisionObservation(world, agent));
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
    const result = expect(requestJevDirective("key", observation())).rejects.toMatchObject({
      name: "JevDecisionError",
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
        expect(Object.keys(body.questions.goal.criteria)).toEqual([goal]);
        const response = responseBody();
        return Response.json({
          ...response,
          answers: {
            ...response.answers,
            goal: { type: "choice", choice: goal, confidence: 1, probabilities: { [goal]: 1 } },
          },
        });
      });
      expect((await requestJevDirective("key", state)).directive.actionId).toBe(
        mode === "creative" ? "creative-session" : "craft",
      );
    },
  );
});
