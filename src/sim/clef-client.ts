import { CLEF_MODEL, ClefDecisionError } from "./clef-decisions";
import type {
  ClefClient,
  DecisionAnswer,
  DecisionQuestion,
  DecisionResponse,
} from "./harness-types";

export function createClefClient(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 12_000,
): ClefClient {
  return {
    async decide(
      state: Record<string, unknown>,
      questions: Record<string, DecisionQuestion>,
    ): Promise<DecisionResponse> {
      for (const [id, question] of Object.entries(questions))
        if (Object.keys(question.criteria).length < 2)
          throw new ClefDecisionError(`Clef question ${id} needs at least two options`, false);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl("https://openrouter.ai/api/alpha/decisions", {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://stigmergy-world.stas6236.workers.dev",
            "X-OpenRouter-Title": "Stigmergy World",
          },
          body: JSON.stringify({ model: CLEF_MODEL, state, questions }),
        });
        const data = (await response.json().catch(() => {
          if (response.ok)
            throw new ClefDecisionError("Clef returned invalid response JSON", false);
          return {};
        })) as {
          answers?: Record<string, Partial<DecisionAnswer> & { type?: string }>;
          model?: string;
          usage?: { cost?: number };
          error?: { message?: string };
        };
        if (!response.ok) {
          const retryAfter = response.headers.get("Retry-After");
          const seconds = retryAfter === null ? NaN : Number(retryAfter);
          const retryAfterMs = Number.isFinite(seconds)
            ? Math.max(1_000, seconds * 1_000)
            : Math.max(1_000, Date.parse(retryAfter ?? "") - Date.now()) || 900_000;
          throw new ClefDecisionError(
            data.error?.message ?? `Clef HTTP ${response.status}`,
            response.status !== 429 && response.status >= 500,
            response.status,
            retryAfterMs,
          );
        }
        if (
          !data.answers ||
          !data.model ||
          Object.keys(data.answers).length !== Object.keys(questions).length
        )
          throw new ClefDecisionError("Clef returned missing or unexpected answers", false);
        const answers: Record<string, DecisionAnswer> = {};
        for (const [id, question] of Object.entries(questions)) {
          const answer = data.answers[id];
          const probabilities = answer?.probabilities;
          const labels = Object.keys(question.criteria);
          if (
            answer?.type !== "choice" ||
            !Object.hasOwn(question.criteria, answer.choice ?? "") ||
            !Number.isFinite(answer.confidence) ||
            answer.confidence! < 0 ||
            answer.confidence! > 1 ||
            !probabilities ||
            Object.keys(probabilities).length !== labels.length ||
            labels.some(
              (label) =>
                !Number.isFinite(probabilities[label]) ||
                probabilities[label]! < 0 ||
                probabilities[label]! > 1,
            ) ||
            Math.abs(labels.reduce((sum, label) => sum + probabilities[label]!, 0) - 1) > 0.01
          )
            throw new ClefDecisionError(`Clef returned an invalid ${id} choice`, false);
          answers[id] = {
            choice: answer.choice!,
            confidence: answer.confidence!,
            probabilities: Object.fromEntries(
              labels.map((label) => [label, probabilities[label]!]),
            ),
          };
        }
        const cost = data.usage?.cost ?? 0;
        if (!Number.isFinite(cost) || cost < 0)
          throw new ClefDecisionError("Clef returned invalid usage", false);
        return { answers, model: data.model, cost };
      } catch (error) {
        if (error instanceof ClefDecisionError) throw error;
        throw new ClefDecisionError(
          error instanceof Error ? error.message : "Clef transport failed",
          true,
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
