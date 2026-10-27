import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createClefClient } from "./clef-client";
import type { DecisionQuestion } from "./harness-types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const state = { agent: { id: "A001" }, energy: 0.9 };

function questions(): Record<string, DecisionQuestion> {
  return {
    inv: {
      type: "choice",
      instructions: "Choose one edit or keep the base harness.",
      criteria: { keep: "Keep the base harness.", e1: "Refill water before energy falls." },
    },
    dom: {
      type: "choice",
      instructions: "Choose one workspace fact or keep the base harness.",
      criteria: { keep: "Keep the base harness.", e2: "Mineral is viable at 20,2." },
    },
  };
}

function responseBody() {
  return {
    model: "cloudflare/clef-flash",
    answers: {
      inv: { type: "choice", choice: "e1", confidence: 0.8, probabilities: { keep: 0.2, e1: 0.8 } },
      dom: {
        type: "choice",
        choice: "keep",
        confidence: 0.6,
        probabilities: { keep: 0.6, e2: 0.4 },
      },
    },
    usage: { cost: 0.00003 },
  };
}

describe("Clef client", () => {
  it("posts the decision request and returns validated answers", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer existing-key");
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(headers.get("HTTP-Referer")).toBe("https://stigmergy-world.stas6236.workers.dev");
      expect(headers.get("X-OpenRouter-Title")).toBe("Stigmergy World");
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      expect(JSON.parse(init.body)).toEqual({
        model: "cloudflare/clef-flash",
        state,
        questions: questions(),
      });
      return Response.json(responseBody());
    });
    const result = await createClefClient("existing-key", fetch).decide(state, questions());
    expect(result).toEqual({
      model: "cloudflare/clef-flash",
      cost: 0.00003,
      answers: {
        inv: { choice: "e1", confidence: 0.8, probabilities: { keep: 0.2, e1: 0.8 } },
        dom: { choice: "keep", confidence: 0.6, probabilities: { keep: 0.6, e2: 0.4 } },
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the global fetch by default", async () => {
    const fetch = vi.fn(async () => Response.json(responseBody()));
    vi.stubGlobal("fetch", fetch);
    await expect(createClefClient("key").decide(state, questions())).resolves.toMatchObject({
      cost: 0.00003,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a question with one option before any network call", async () => {
    const fetch = vi.fn(async () => Response.json(responseBody()));
    const forced = questions();
    forced.dom!.criteria = { keep: "Keep the base harness." };
    await expect(createClefClient("key", fetch).decide(state, forced)).rejects.toMatchObject({
      name: "ClefDecisionError",
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "missing",
    "extra",
    "unknown",
    "nonfinite",
    "distribution",
    "negative",
    "confidence",
    "type",
    "missing-label",
    "extra-label",
    "model",
    "usage",
  ])("rejects a %s answer as non-retryable", async (failure) => {
    const body = responseBody();
    const answers = body.answers as Record<string, unknown>;
    const inv = body.answers.inv as { choice: string; confidence: number; type: string } & {
      probabilities: Record<string, number>;
    };
    if (failure === "missing") delete answers.dom;
    if (failure === "extra") answers.unexpected = body.answers.inv;
    if (failure === "unknown") inv.choice = "e9";
    if (failure === "nonfinite") inv.probabilities.e1 = NaN;
    if (failure === "distribution") inv.probabilities.e1 = 0.2;
    if (failure === "negative") Object.assign(inv.probabilities, { keep: 1.2, e1: -0.2 });
    if (failure === "confidence") inv.confidence = 2;
    if (failure === "type") inv.type = "score";
    if (failure === "missing-label") delete inv.probabilities.keep;
    if (failure === "extra-label") inv.probabilities.e9 = 0;
    if (failure === "model") Object.assign(body, { model: "" });
    if (failure === "usage") body.usage.cost = -1;
    const fetch = vi.fn(async () => Response.json(body));
    await expect(createClefClient("key", fetch).decide(state, questions())).rejects.toMatchObject({
      name: "ClefDecisionError",
      retryable: false,
    });
  });

  it("stops after HTTP 429 and honours Retry-After", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { error: { message: "Provider limit" } },
        { status: 429, headers: { "Retry-After": "120" } },
      ),
    );
    await expect(createClefClient("key", fetch).decide(state, questions())).rejects.toMatchObject({
      message: "Provider limit",
      retryable: false,
      status: 429,
      retryAfterMs: 120_000,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads an HTTP-date Retry-After and floors it at one second", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("busy", {
          status: 429,
          headers: { "Retry-After": new Date(Date.now() - 60_000).toUTCString() },
        }),
    );
    await expect(createClefClient("key", fetch).decide(state, questions())).rejects.toMatchObject({
      message: "Clef HTTP 429",
      retryAfterMs: 1_000,
    });
  });

  it.each([
    [500, true],
    [503, true],
    [402, false],
    [400, false],
  ])("classifies HTTP %i as retryable %s", async (status, retryable) => {
    const fetch = vi.fn(async () => new Response("upstream failure", { status }));
    await expect(createClefClient("key", fetch).decide(state, questions())).rejects.toMatchObject({
      name: "ClefDecisionError",
      retryable,
      status,
      retryAfterMs: 900_000,
    });
  });

  it("rejects invalid JSON on a successful response as non-retryable", async () => {
    const fetch = vi.fn(async () => new Response("{invalid"));
    await expect(createClefClient("key", fetch).decide(state, questions())).rejects.toMatchObject({
      message: "Clef returned invalid response JSON",
      retryable: false,
    });
  });

  it("reports a thrown transport error as retryable", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("network down");
    });
    await expect(createClefClient("key", fetch).decide(state, questions())).rejects.toMatchObject({
      name: "ClefDecisionError",
      message: "network down",
      retryable: true,
    });
  });

  it("aborts after the configured timeout and reports a retryable failure", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal as AbortSignal;
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Request aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const result = expect(
      createClefClient("key", fetch, 5_000).decide(state, questions()),
    ).rejects.toMatchObject({ name: "ClefDecisionError", retryable: true });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(signal?.aborted).toBe(true);
  });
});
