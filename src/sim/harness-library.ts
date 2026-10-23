import type { LibraryEntry } from "./harness-types";
import type { InteractionCondition } from "./types";

const MIN_CUE_SIMILARITY = 0.5;
const confidenceRank = { high: 3, medium: 2, low: 1 } as const;

function cueTokens(cue: string): Set<string> {
  return new Set(
    cue
      .split("|")
      .map((token) => token.trim())
      .filter(Boolean),
  );
}

/** NO_ENTRY rows rank below every lesson; lessons rank by the Reflector's confidence. */
function entryStrength(entry: LibraryEntry): number {
  return entry.experience ? confidenceRank[entry.experience.confidence] : 0;
}

export function cueSimilarity(a: string, b: string): number {
  const left = cueTokens(a);
  const right = cueTokens(b);
  const shared = [...left].filter((token) => right.has(token)).length;
  const union = left.size + right.size - shared;
  return union ? shared / union : 0;
}

/** Entries recorded under the same interaction condition that this agent may read: its own,
 * plus shared ones while the shared library is on. Closest cue first, then lessons before
 * NO_ENTRY rows by confidence, then newest. */
export function matchLibrary(
  entries: LibraryEntry[],
  cue: string,
  options: { condition: InteractionCondition; agentId: string; shared: boolean; limit?: number },
): LibraryEntry[] {
  const { condition, agentId, shared, limit = 3 } = options;
  return entries
    .filter(
      (entry) =>
        entry.condition === condition &&
        (entry.visibility === agentId || (shared && entry.visibility === "shared")),
    )
    .map((entry) => ({ entry, similarity: cueSimilarity(entry.cue, cue) }))
    .filter(({ similarity }) => similarity >= MIN_CUE_SIMILARITY)
    .sort(
      (a, b) =>
        b.similarity - a.similarity ||
        entryStrength(b.entry) - entryStrength(a.entry) ||
        b.entry.createdTick - a.entry.createdTick ||
        a.entry.id.localeCompare(b.entry.id),
    )
    .slice(0, limit)
    .map(({ entry }) => entry);
}

export function libraryIndex(
  entries: LibraryEntry[],
): Array<{ id: string; cue: string; lesson?: string; confidence?: string }> {
  return entries.map(({ id, cue, experience }) =>
    experience
      ? { id, cue, lesson: experience.lesson, confidence: experience.confidence }
      : { id, cue },
  );
}

/** Evicts NO_ENTRY rows first, then low, medium and high confidence, oldest first within each,
 * and keeps the survivors in their original order. */
export function boundLibrary(entries: LibraryEntry[], max = 400): LibraryEntry[] {
  const evicted = new Set(
    [...entries]
      .sort(
        (a, b) =>
          entryStrength(a) - entryStrength(b) ||
          a.createdTick - b.createdTick ||
          a.id.localeCompare(b.id),
      )
      .slice(0, Math.max(0, entries.length - max)),
  );
  return entries.filter((entry) => !evicted.has(entry));
}
