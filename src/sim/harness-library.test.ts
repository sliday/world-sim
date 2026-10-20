import { describe, expect, it } from "vite-plus/test";
import { boundLibrary, cueSimilarity, libraryIndex, matchLibrary } from "./harness-library";
import type { AgentHarness, ExperienceEntry, LibraryEntry } from "./harness-types";
import type { InteractionCondition } from "./types";

const CUE =
  "energy:critical|water:none|terrain:tidal|richness:depleted|commitment:no|build:none|contamination:clean|hoard:no";

function harness(): AgentHarness {
  return {
    revision: 1,
    origin: "adopted",
    procedure: [],
    guards: [],
    memory: [],
    guidance: [],
    skills: [],
  };
}

function entry(
  id: string,
  options: {
    cue?: string;
    createdTick?: number;
    condition?: InteractionCondition;
    visibility?: string;
    confidence?: ExperienceEntry["confidence"] | null;
  } = {},
): LibraryEntry {
  const confidence = options.confidence === undefined ? "medium" : options.confidence;
  return {
    id,
    createdTick: options.createdTick ?? 100,
    agentId: "A001",
    condition: options.condition ?? "full-culture",
    visibility: options.visibility ?? "shared",
    cue: options.cue ?? CUE,
    experience: confidence
      ? {
          cue: "repeated gathering on depleted ground",
          lesson: `guards: forbid the depleted material (${id})`,
          evidence: "inv-1 stopped failing gather-local",
          confidence,
        }
      : null,
    harness: harness(),
    edits: [],
    rows: [],
  };
}

describe("cue similarity", () => {
  it("is the Jaccard index over cue tokens", () => {
    expect(cueSimilarity("a|b|c", "a|b|c")).toBe(1);
    expect(cueSimilarity("a|b|c", "b|c|d")).toBe(0.5);
    expect(cueSimilarity("a|b", "c|d")).toBe(0);
    expect(cueSimilarity("", "")).toBe(0);
    expect(cueSimilarity(" a | b ", "a|b|a")).toBe(1);
  });
});

describe("library matching", () => {
  const options = { condition: "full-culture" as const, agentId: "A001", shared: true };

  it("keeps interaction conditions apart", () => {
    const entries = [
      entry("full"),
      entry("silent", { condition: "no-communication" }),
      entry("ablated", { condition: "no-explicit-culture" }),
    ];
    expect(matchLibrary(entries, CUE, options).map(({ id }) => id)).toEqual(["full"]);
  });

  it("shows shared entries only while the shared library is on, and private entries only to their agent", () => {
    const entries = [
      entry("shared"),
      entry("mine", { visibility: "A001" }),
      entry("theirs", { visibility: "A002" }),
    ];
    expect(new Set(matchLibrary(entries, CUE, options).map(({ id }) => id))).toEqual(
      new Set(["shared", "mine"]),
    );
    expect(matchLibrary(entries, CUE, { ...options, shared: false }).map(({ id }) => id)).toEqual([
      "mine",
    ]);
    expect(
      matchLibrary(entries, CUE, { ...options, agentId: "A002", shared: false }).map(
        ({ id }) => id,
      ),
    ).toEqual(["theirs"]);
  });

  it("orders by cue similarity, then lesson confidence, then recency, and drops distant cues", () => {
    const near = CUE.replace("energy:critical", "energy:low");
    const far =
      "energy:high|water:full|terrain:plain|richness:rich|commitment:yes|build:ready|contamination:clean|hoard:no";
    const entries = [
      entry("near-high", { cue: near, confidence: "high" }),
      entry("exact-none", { confidence: null, createdTick: 900 }),
      entry("exact-low-old", { confidence: "low", createdTick: 10 }),
      entry("exact-low-new", { confidence: "low", createdTick: 500 }),
      entry("exact-high", { confidence: "high", createdTick: 5 }),
      entry("far", { cue: far, confidence: "high" }),
    ];
    expect(matchLibrary(entries, CUE, { ...options, limit: 10 }).map(({ id }) => id)).toEqual([
      "exact-high",
      "exact-low-new",
      "exact-low-old",
      "exact-none",
      "near-high",
    ]);
    expect(matchLibrary(entries, CUE, options)).toHaveLength(3);
  });
});

describe("library index", () => {
  it("lists every entry with its lesson when one exists", () => {
    expect(
      libraryIndex([entry("lesson", { confidence: "high" }), entry("none", { confidence: null })]),
    ).toEqual([
      {
        id: "lesson",
        cue: CUE,
        lesson: "guards: forbid the depleted material (lesson)",
        confidence: "high",
      },
      { id: "none", cue: CUE },
    ]);
  });
});

describe("library bound", () => {
  it("drops NO_ENTRY rows first, then low confidence, oldest first, preserving order", () => {
    const entries = [
      entry("high-old", { confidence: "high", createdTick: 1 }),
      entry("none-new", { confidence: null, createdTick: 50 }),
      entry("low-old", { confidence: "low", createdTick: 2 }),
      entry("none-old", { confidence: null, createdTick: 3 }),
      entry("low-new", { confidence: "low", createdTick: 40 }),
      entry("medium", { confidence: "medium", createdTick: 4 }),
    ];
    expect(boundLibrary(entries, 6).map(({ id }) => id)).toEqual(entries.map(({ id }) => id));
    expect(boundLibrary(entries, 4).map(({ id }) => id)).toEqual([
      "high-old",
      "low-old",
      "low-new",
      "medium",
    ]);
    expect(boundLibrary(entries, 3).map(({ id }) => id)).toEqual(["high-old", "low-new", "medium"]);
    expect(boundLibrary(entries, 1).map(({ id }) => id)).toEqual(["high-old"]);
  });

  it("defaults to 400 entries", () => {
    const entries = Array.from({ length: 405 }, (_, index) =>
      entry(`e${index}`, { createdTick: index, confidence: index < 5 ? null : "medium" }),
    );
    const bounded = boundLibrary(entries);
    expect(bounded).toHaveLength(400);
    expect(bounded.every((row) => row.experience)).toBe(true);
  });
});
