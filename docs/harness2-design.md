# Harness² in Stigmergy: design

Source: Xu et al., "Harness²: Recursive Agent Harnessing for an Open World", arXiv 2610.14224 (2026).
Shared types: `src/sim/harness-types.ts`. This file fixes the module boundaries so builders can work in parallel.

## Mapping

| Paper | This world |
|---|---|
| Frozen model M | `cloudflare/clef-flash` through the OpenRouter Decisions API |
| Task q_t | One agent macroturn that the scheduler selects for an improvement round |
| Execution | Clef decision under a harness, then a deterministic rollout of a cloned world for `PROBE_HORIZON_TICKS` (120). Trajectory = per-tick focal-agent record. Deliverable = the activity outcome. |
| Execution harness H (C1–C8) | `AgentHarness`: C1 `procedure`, C2+C8 `guards` (enforced in code), C3 `memory` (verified workspace facts), C4 `guidance` (option criteria), C6 `skills` (triggers for known learned actions). C5 subagents and C7 scripts have no counterpart: a decision has one context, and executable programs are crafted culture that a harness must not mint. |
| H0 | `baseHarness()`: every component empty. A decision under H0 sends exactly today's request. |
| Probe under matched conditions | `structuredClone` of the world at the decision tick; identical RNG state, terrain, and neighbours; only the harness differs. |
| Harness Editor (INV, DOM) | Deterministic diagnosers turn reference trajectories into candidate edits, each tied to a trajectory moment; Clef chooses among them (plus `keep`). k candidates per scope are sampled without replacement from Clef's probabilities with a seeded RNG. |
| Composer | One Clef call with a kept/dropped question per pooled edit, then hard rules: drop UNSAFE edits, resolve conflicts, respect limits. k compositions sampled from those probabilities. |
| Final selection (k > 1) | One Clef call over anonymized, shuffled deliverable summaries (references and successors). No harness or run id reaches it. |
| Experience Reflector | Per-edit verdict questions (`helped`, `hurt`, `no-observed-effect`, `confounded`) with deterministic overrides; at most one experience entry (cue, lesson, evidence, confidence) or NO_ENTRY. |
| Improvement harness R_t / library | Indexed `LibraryEntry` rows in Durable Object SQLite, per interaction condition; shared when `mechanisms.skillLibrary` is on, agent-private otherwise. |
| Next task starts from H0 | Every round starts from H0 and reads the library. The adopted H★ stays the agent's harness for routine macroturns until its next round. |

No stage sees a score, rubric, or grader. Outcomes are behavioural counts.

## Modules and exact exports

### M1 `src/sim/harness.ts` (+ `harness.test.ts`)
- `baseHarness(): AgentHarness`
- `situationFeatures(state: WorldState, agent: Agent): SituationFeatures` — deterministic, toroidal distances, viable = richness >= 0.12, scan every second tile like `resourcePosition`.
- `evaluateCondition(condition: HarnessCondition, features: SituationFeatures): boolean`
- `applyHarnessToQuestions(questions: Record<string, DecisionQuestion>, harness: AgentHarness, features: SituationFeatures): { questions: Record<string, DecisionQuestion>; applied: string[] }` — returns new objects. Procedure lines append to `goal.instructions` as ` Harness procedure: <line>`. Guidance replaces one option's criteria text when that question and label exist. `forbid` removes a label while its condition holds but never removes the last option. `require` reduces the question to that label while its condition holds (the caller's existing single-option rule then resolves it locally). `applied` lists the ids of components that changed something.
- `harnessState(harness: AgentHarness): Record<string, unknown> | undefined` — `{ harnessMemory: string[] }` from memory fact texts; `undefined` for an empty memory so H0 leaves the state unchanged.
- `applySkillTriggers(directive: AgentDirective, harness: AgentHarness, features: SituationFeatures, knownActionIds: string[]): AgentDirective`
- `applyEdits(base: AgentHarness, edits: HarnessEdit[]): AgentHarness` — pure; adds or removes items by id; ignores duplicate adds; does not bump revision.
- `validateHarness(harness: AgentHarness, context: { knownActionIds: string[] }): HarnessValidation` — limits in `HARNESS_LIMITS`; guard questions limited to `goal`, `targetMaterial`, `controllerAction`, `actionId`, `holdMacroturns` and labels to that question's vocabulary; skills name known actions; facts in bounds with finite coordinates; no text containing `{{`, `{%`, "score", "grader", or "rubric".
- `harnessSignature(harness: AgentHarness): string` — stable hash of the five components.
- `situationCue(features: SituationFeatures): string` — bucketed tokens joined by `|`: `energy:{critical<0.3,low<0.55,ok<0.8,high}`, `water:{none<0.5,low<1.5,ok<3,full}`, `terrain:<kind>`, `richness:{depleted<0.08,thin<0.12,viable<0.4,rich}`, `commitment:{yes,no}`, `build:{ready,none}`, `contamination:{clean<0.2,dirty<0.55,toxic}`, `hoard:{yes,no}` (any non-water material >= 12).

### M1b `src/sim/clef-client.ts` (+ test)
- `createClefClient(apiKey: string, fetchImpl: typeof fetch = fetch, timeoutMs = 12_000): ClefClient` — same endpoint, headers, model, validation, and `ClefDecisionError` semantics (retryable, status, retryAfterMs) as `requestClefDirective` in `clef-decisions.ts`. Import `CLEF_MODEL` and `ClefDecisionError` from there; do not edit `clef-decisions.ts`. Throws before any network call if a question has fewer than two options.

### M2 `src/sim/harness-probe.ts` (+ test)
- `PROBE_HORIZON_TICKS = 120`
- `rolloutDirective(world: WorldState, agentId: string, directive: AgentDirective, decisionTick: number, run: string, harness: AgentHarness, options?: { horizon?: number; probabilities?: Record<string, Record<string, number>>; model?: string }): ExecutionRecord` — never mutates `world`; clones it, requires the clone's agent `nextDecisionTick === decisionTick`, commits with `applyDirective(clone, agentId, directive, false, decisionTick)`, then advances one tick at a time and records each step. Success vs failure per tick from `script.lastResult` (`... precondition failed` and `activity has no bounded primitives` are failures). Reboots from the engine's reboot event for that agent. Inspections and repairs from `lastResult` ("inspected an artifact", "maintained an artifact"). `gathered` sums positive per-tick inventory changes. `producedNothing` = no gather, build, craft, inspection, or repair succeeded.
- `contrastExecutions(references: ExecutionRecord[], candidate: ExecutionRecord): BehavioralContrast` — `unsafe` when the candidate produced nothing while a reference delivered, or rebooted while no reference did.
- `deliverableSummary(outcome: ExecutionOutcome): string` — <= 300 chars, describes only what the activity produced. No run id, no harness.
- `executionDigest(record: ExecutionRecord): string` — <= 400 chars for Clef states: run id, directive, key outcome counts, first failure streak and first productive success as moments.

### M3 `src/sim/harness-diagnose.ts` and `src/sim/harness-library.ts` (+ tests)
- `proposeCandidateEdits(input: { world: WorldState; agentId: string; features: SituationFeatures; references: ExecutionRecord[]; library: LibraryEntry[]; base: AgentHarness; knownActionIds: string[] }): { INV: HarnessEdit[]; DOM: HarnessEdit[] }` — at most 6 per scope, strongest evidence first (repeated across references beats a single run). Every diagnosis edit carries a `moment` from a reference trajectory. Never re-propose an item already in `base`. Library entries matched by cue contribute their harness items as `source: "library"` edits; memory facts must pass `verifyFact` against the current world first.
  - INV diagnosers: repeated primitive failure; reboot or energy crash (earlier refill guard); stall (no productive success and almost no movement); hoarding (a non-water material >= 12 while still gathering it); build-ready matter never built; an applicable known learned action (skill trigger). Guards must name the observed condition and must never make the only energy source unreachable while energy < 0.3.
  - DOM diagnosers: verified viable resource locations; depleted local tiles with guidance on the matching material option; processing station for carried build-ready matter; local contamination hazard with guidance for `remediate`; serviceable visible artifacts with guidance for `inspect`. Fact text starts with "In this workspace".
- `verifyFact(state: WorldState, fact: HarnessFact): boolean` (in `harness-diagnose.ts`) — resource: tile of that material with richness >= 0.12; depleted: richness < 0.12; station: a station of that kind at the point; hazard: contamination >= 0.45; artifact: an artifact within 1 tile.
- `editId(edit: Omit<HarnessEdit, "id">): string` (in `harness-diagnose.ts`) — stable hash of component, op, and item content (ignore summary, moment, source).
- `cueSimilarity(a: string, b: string): number` (in `harness-library.ts`) — Jaccard over tokens.
- `matchLibrary(entries: LibraryEntry[], cue: string, options: { condition: InteractionCondition; agentId: string; shared: boolean; limit?: number }): LibraryEntry[]`
- `libraryIndex(entries: LibraryEntry[]): Array<{ id: string; cue: string; lesson?: string; confidence?: string }>`
- `boundLibrary(entries: LibraryEntry[], max = 400): LibraryEntry[]` — drop NO_ENTRY rows first, then low confidence, oldest first.

### M4 `src/sim/harness-improver.ts` (+ test)
- `runImprovementRound(input: RoundInput, deps: RoundDeps): Promise<RoundResult>` with
  - `RoundInput = { roundId: string; agentId: string; tick: number; condition: InteractionCondition; mode: "parallel" | "sequential"; k: number /* 1..5 */; base: AgentHarness; seed: number }`
  - `RoundDeps = { clef: ClefClient; cue: string; knownActionIds: string[]; libraryIndex: ReturnType<typeof libraryIndex>; decide(harness, draws, seed): Promise<{ directives: AgentDirective[]; probabilities: Record<string, Record<string, number>>; model: string; cost: number }>; rollout(directive, run, harness, probabilities?): ExecutionRecord; contrast(references, candidate): BehavioralContrast; deliverableSummary(outcome): string; executionDigest(record): string; propose(references, history): { INV: HarnessEdit[]; DOM: HarnessEdit[] }; applyEdits(base, edits): AgentHarness; validate(harness): HarnessValidation; signature(harness): string }`
  - The improver imports only types and `Rng`; real implementations are injected, and it owns the two sampling helpers above. Each `decide` call and each `clef.decide` call counts as one call.
- `sampleChoice(answer: DecisionAnswer, labels: string[], rng: Rng): string` — inverse CDF in label order.
- `sampleDistinct(answer: DecisionAnswer, labels: string[], rng: Rng, count: number): string[]` — without replacement, renormalizing.
- Parallel recursion: references (k draws from one `decide(base)`), Editor (one call; `inv` and `dom` questions over edit ids plus `keep`; omit a scope with no edits), probes (one `decide` per candidate), Composer (one call), successors (one `decide` per distinct non-base composition), selection when k > 1 (one call), Reflector (one call). k = 1 costs 7 calls.
- Sequential recursion: shared references; k chained steps, each proposing one INV and one DOM candidate from the history, probing, composing checkpoint r over every edit seen so far, and executing it; final selection over references and checkpoints when k > 1.
- Stage failures: a retryable transport error aborts the round (the Worker then makes the routine decision). A non-retryable stage error or an invalid harness records a fallback and inherits the stage's input (Editor failure = KEEP_BASE).
- Composer notes follow the paper: `kept|dropped -> <edit summary> -> <moment or base-set pattern with counts>`. UNSAFE edits are dropped with that reason.
- Reflection overrides: an edit whose carrying runs all reproduced a reference directive is `no observed effect`; an edit that only appeared inside multi-edit successors is `confounded`. An experience entry needs at least one `helped` or `hurt` row; the lesson names the component; `confidence` comes from Clef.
- Every Clef question has at least two options. Every Clef state stays under 6,000 JSON characters.

### M5 integration (lead, after the parallel branches land)
`clef-decisions.ts` accepts an optional harness; `Agent.harness`; scheduler and budget env vars; SQLite `harness_library` and `harness_rounds`; `GET /api/harness`; README.
