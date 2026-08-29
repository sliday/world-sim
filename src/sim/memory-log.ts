export const AGENT_MEMORY_TOKEN_CAP = 250_000;
export const AGENT_MEMORY_COMPACT_TARGET = 175_000;
export const AGENT_MEMORY_CONTEXT_TOKENS = 3_000;

export interface DurableMemoryEntry {
  seq: number;
  tick: number;
  kind: string;
  content: string;
  tokens: number;
  firstTick?: number;
  lastTick?: number;
  repeatCount?: number;
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

export function memoryRunKey(kind: string, content: string): string {
  return `${kind.trim().toLowerCase()}\u0000${content.replace(/\s+/g, " ").trim()}`;
}

export function collapseRepeatedMemory(
  entries: readonly DurableMemoryEntry[],
): DurableMemoryEntry[] {
  const collapsed: DurableMemoryEntry[] = [];
  for (const source of [...entries].sort((a, b) => a.seq - b.seq)) {
    const entry = {
      ...source,
      firstTick: source.firstTick ?? source.tick,
      lastTick: source.lastTick ?? source.tick,
      repeatCount: Math.max(1, source.repeatCount ?? 1),
    };
    const previous = collapsed.at(-1);
    if (
      previous &&
      memoryRunKey(previous.kind, previous.content) === memoryRunKey(entry.kind, entry.content)
    ) {
      previous.seq = entry.seq;
      previous.tick = entry.lastTick;
      previous.lastTick = entry.lastTick;
      previous.repeatCount = (previous.repeatCount ?? 1) + entry.repeatCount;
      previous.tokens = Math.max(previous.tokens, entry.tokens);
      continue;
    }
    collapsed.push(entry);
  }
  return collapsed;
}

function kindCounts(entries: DurableMemoryEntry[]): string {
  const counts = new Map<string, number>();
  for (const entry of entries)
    counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + Math.max(1, entry.repeatCount ?? 1));
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
  const removedRuns = collapseRepeatedMemory(removedEntries);
  const kept = ordered.slice(removeCount);
  const first = removedEntries[0]!;
  const last = removedEntries.at(-1)!;
  const signals = removedRuns
    .filter((entry) => /build|discover|repair|author|heard|said/i.test(entry.content))
    .slice(-24)
    .map((entry) => {
      const count = Math.max(1, entry.repeatCount ?? 1);
      const range =
        count > 1 && entry.firstTick !== entry.lastTick
          ? `T${entry.firstTick}–T${entry.lastTick} ×${count}`
          : `T${entry.tick}`;
      return `- ${range} ${entry.content}`;
    })
    .join("\n");
  const summaryCharacterCap = Math.min(36_000, Math.max(48, (maximumTokens - targetTokens) * 3));
  const summaryHeader = "# COMPACTED LONG-TERM MEMORY";
  const fullSummary = [
    summaryHeader,
    previousSummary ? previousSummary.replace(/^# COMPACTED LONG-TERM MEMORY\s*/u, "").trim() : "",
    `T${first.tick}–T${last.tick}: ${removedEntries.length} memories compressed into ${removedRuns.length} runs (${kindCounts(removedRuns)}).`,
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
