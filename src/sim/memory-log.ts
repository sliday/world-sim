export const AGENT_MEMORY_TOKEN_CAP = 250_000;
export const AGENT_MEMORY_COMPACT_TARGET = 175_000;
export const AGENT_MEMORY_CONTEXT_TOKENS = 3_000;

export interface DurableMemoryEntry {
  seq: number;
  tick: number;
  kind: string;
  content: string;
  tokens: number;
}

export interface MemoryCompaction {
  summary: string;
  summaryTokens: number;
  throughSeq: number;
  removed: number;
  kept: DurableMemoryEntry[];
  totalTokens: number;
}

// Deliberately conservative for short English telemetry: three characters
// count as one token, so the persisted log stays below the advertised cap.
export function estimateMemoryTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 3));
}

function kindCounts(entries: DurableMemoryEntry[]): string {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${kind} ${count}`)
    .join(", ");
}

export function compactMemoryLog(
  entries: DurableMemoryEntry[],
  previousSummary = "",
  maximumTokens = AGENT_MEMORY_TOKEN_CAP,
  targetTokens = AGENT_MEMORY_COMPACT_TARGET,
): MemoryCompaction | undefined {
  const ordered = [...entries].sort((a, b) => a.seq - b.seq);
  const currentTokens = ordered.reduce((total, entry) => total + entry.tokens, 0);
  const previousTokens = previousSummary ? estimateMemoryTokens(previousSummary) : 0;
  if (currentTokens + previousTokens <= maximumTokens || ordered.length < 2) return undefined;

  let removedTokens = 0;
  let removeCount = 0;
  while (
    removeCount < ordered.length - 1 &&
    currentTokens - removedTokens + previousTokens > targetTokens
  ) {
    removedTokens += ordered[removeCount]!.tokens;
    removeCount += 1;
  }
  const removedEntries = ordered.slice(0, removeCount);
  const kept = ordered.slice(removeCount);
  const first = removedEntries[0]!;
  const last = removedEntries.at(-1)!;
  const signals = removedEntries
    .filter((entry) => /build|discover|repair|author|heard|said/i.test(entry.content))
    .slice(-24)
    .map((entry) => `- T${entry.tick} ${entry.content}`)
    .join("\n");
  const summaryCharacterCap = Math.min(36_000, Math.max(48, (maximumTokens - targetTokens) * 3));
  const summaryHeader = "# COMPACTED LONG-TERM MEMORY";
  const fullSummary = [
    summaryHeader,
    previousSummary ? previousSummary.replace(/^# COMPACTED LONG-TERM MEMORY\s*/u, "").trim() : "",
    `T${first.tick}–T${last.tick}: ${removedEntries.length} memories compressed (${kindCounts(removedEntries)}).`,
    signals ? `Durable signals:\n${signals}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const summary =
    fullSummary.length <= summaryCharacterCap
      ? fullSummary
      : `${summaryHeader}\n${fullSummary.slice(-(summaryCharacterCap - summaryHeader.length - 1))}`;
  const summaryTokens = estimateMemoryTokens(summary);
  return {
    summary,
    summaryTokens,
    throughSeq: last.seq,
    removed: removedEntries.length,
    kept,
    totalTokens: kept.reduce((total, entry) => total + entry.tokens, summaryTokens),
  };
}
