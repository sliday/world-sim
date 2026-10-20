# Stigmergy — A World That Remembers

An endless zero-player p5.js observatory inspired by **SwarmWorld: Stigmergic technological evolution in societies of language-model agents** (Pal, Wang & Buehler, MIT, 2026).

This is a live implementation track toward the paper's core mechanics, not a reproduction of its reported results. Fidelity work is explicit: mechanism ablations, matched isolated-search controls, and held-out agent-free disturbance assays are still required.

## What is real in the simulation

- 100 policy-equivalent agents receive local observations; a fresh world initializes them with identical policy and energy.
- Every agent stays with one cyclic, bounded activity between fixed model macroturns and attempts exactly one primitive on each world tick.
- Macroturn phases are persistent and staggered: every agent gets one AI reassessment opportunity per 60 authoritative ticks, with at most two agents due on any tick.
- Every 3,600 authoritative ticks (about 10 hours at the current 10-second tick), an observer model turns the persisted event trace into a factual 1–5 line world diary focused on new actions, mapped resources, inheritance, adoption, and meaningful change.
- A toroidal 96×72 planet has finite resources, facilities, moisture, contamination, and persistent artifacts.
- Agents can explore, gather, construct, inspect, maintain, craft learned skills, and fork constrained artifact controllers.
- New artifacts can only be constructed near the material's matching processing station (wash, assay, foundry, weave, or grind); the artifact records that physical process and station provenance. Legacy artifacts remain intact with process provenance explicitly unavailable.
- Curiosity accumulates like hunger. Eligible bots periodically enter an AI Creative Session that proposes a two-material mix and a bounded action program; the action exists only after deterministic gathering, consumption, validation, and construction succeed.
- Missing recipe materials become explicit seek-and-gather subgoals. Inventory carries a durable purpose label so agent memory records why each ingredient is reserved until the craft completes or the experiment fails.
- The read-only Craft Tree is a zoomable, pannable knowledge graph from material roots through all 15 pairings to discovered skills; selecting a node opens its evidence and provenance, while a collapsed text index preserves linear access.
- Carried water is a finite energy reserve, not an endlessly rewarding gathering tile. Bots sip it when energy is low, retain physical inventory through a reboot, and leave saturated water gathering for agent-staggered material deficits.
- Tidal tiles hold the only gatherable water. The engine updates each tile once every 23 ticks, and each update refills 0.2% of the gap between a tidal tile's water and its moisture. An untouched drained shore regains about 63% of that gap in 11,500 ticks (about 32 hours at the current 10-second tick), and a crowded shore still runs dry. Other resource tiles regrow by a fixed 0.00008 per update.
- The deterministic consequence layer—not an LLM—validates resources, actions, health, performance, and failure.
- Artifact operation now uses closed physical fluxes: water capture transfers local moisture into bounded storage, remediation cannot remove more contamination than exists or reserve can support, and healing/growth consume finite embodied reserve. Per-artifact flux ledgers begin at schema-v5 migration; no pre-migration operation history is invented.
- Schema v6 replaces the old performance-only `validated` flag with six explicit gates: deterministic material test, complete agent-authored specification, installed bounded controller, processing provenance, performance threshold, and novel controller behavior. Legacy artifacts retain their evidence but remain provisional when a gate cannot be reconstructed.
- Schema v7 records realized service on every artifact tick. Live portfolio resilience uses a smoothed realized-service signal, while the held-out assay integrates unsmoothed per-tick service; controller capability and nominal performance no longer count as function when no water, contamination, damage, growth capacity, reserve, or signal event actually exists.
- Schema v8 requires a non-creator to physically inspect nonzero realized service before the final validation gate passes. Inspection records the verifying agents and first evidence tick; legacy contact or adoption does not retroactively fabricate measured-service evidence.
- Schema v9 queues addressed speech until the recipient's next fixed macroturn. Sending remains visible immediately, but heard context and durable recipient memory are created only when that scheduled observation occurs, so communication cannot purchase an extra model call.
- Schema v10 adds persisted full-culture, no-communication, and no-explicit-culture engine conditions. Ablations remove messaging, global recipe sharing, artifact specifications, and/or program inheritance from executable consequences rather than relying on prompt compliance; production remains the full-culture world. Matched multi-seed study orchestration is still required before comparing conditions.
- Schema v11 supports matched 50-, 100-, and 200-agent worlds with population-aware staggered phases. Terrain, processing stations, corresponding initial agent positions, and phases remain identical across interaction conditions within a population–seed block; production remains the persistent N=100 world.
- Artifacts remain in the world while agents use them, can be physically encountered by later agents, and retain executable lineage; unused ruins erode into a fossil record.
- Bounded movement trails expose mean path length, regions visited, artifact-contact rate, and spatial entropy without allowing history to grow unbounded.
- Private SQLite episodic logs retain up to approximately 250,000 tokens per agent with deterministic compaction.
- Consecutive identical memories collapse into one lossless tick-ranged run (`T120–T420 ×6`); any intervening event starts a new run.
- Roles shown in the UI are current behavior, never assigned identities.

## Runtime

- **Client:** p5.js + TypeScript + Vite+
- **World authority:** one SQLite-backed Cloudflare Durable Object
- **Live updates:** hibernatable WebSockets; alarm-driven deterministic ticks every 10 seconds (`ALARM_INTERVAL_MS`)
- **Agent policy:** NullClaw-derived Zig policy core compiled to WebAssembly
- **Agent decisions:** `cloudflare/clef-flash` through the OpenRouter Decisions API, with the existing `OPENROUTER_API_KEY`.
- **Text generation:** `openrouter/free` for artifact specifications, creative proposals, and the world diary.
- **Static hosting:** Cloudflare Workers Static Assets

The full native NullClaw daemon does not run inside a Cloudflare Worker. This project uses NullClaw's official edge pattern: networking, secrets, validation, and consequences stay in the Worker host; a tiny Zig/WASM core selects the context policy used for occasional model decisions.

## Decision mechanics

Clef chooses the goal, material, controller, learned activity, and hold length in one request per agent. Independent agents share the existing pool of six requests.
Clef rejects choice questions with fewer than two options, so the Worker answers forced choices locally and sends only open ones.
The Worker validates answer IDs, allowed labels, confidence, and probability distributions before it commits a directive.

The simulator retains physical rules and craft commitments. Routine activities need no text generation.
Routine speech states the observed terrain. Communication ablations retain their existing silence.
Builds and new creative sessions use the existing generator for authored descriptions after Clef selects the activity.

The Worker counts attempted API requests against the daily cap, including separate generation calls.
Quota errors stop provider calls until the cooldown expires. A daily generation limit suspends that provider until the next UTC day.

Clef Flash is the 9B member of Cloudflare's Clef decision model family, a Qwen3.5-9B fine-tune served on Workers AI.
A live probe on 2026-10-19 accepted seven decisions in 0.3 to 1 second each, at about $0.00003 per decision. The Worker records the returned model on each accepted directive.
Local tests and a live API probe validate the contract; they do not establish gains in decision quality, cost, or latency.

The scheduler follows SwarmWorld's fixed per-agent macroturn phases rather than selecting whichever agents look stale. The paper's primary population study used a 50-tick interval; this observatory uses 60 ticks. The Worker advances one authoritative tick every 10 seconds, so every agent gets about one AI opportunity every 10 minutes; with the holds described below, a bot reassesses every 10 to 80 minutes. Earlier production ticks ran at one second, so the world's history mixes both rates. The Worker records each configured rate as a tick epoch in the world state, and age labels convert ticks to wall-clock time through those epochs. A macroturn is resolved before its candidate world tick, and retryable provider failures preserve the activity and scheduled tick instead of silently skipping an agent.

The first explicit product-driven variation from Algorithm 1 concerns the action queue: SwarmWorld consumes a finite action queue and waits when it empties, while this world cycles a bounded activity program until the next macroturn. That variation implements the requirement that a bot remain engaged between reassessments. The consequence boundary remains the same: the model chooses a validated activity, and the deterministic simulator attempts exactly one primitive per agent per tick.

The second variation cuts model cost. SwarmWorld spends a model call on every macroturn; here Clef also answers `holdMacroturns` with 1, 2, 4, or 8, and the agent keeps its activity for that many macroturns before its next call. Clef picks long holds for stable work, such as gathering a plentiful material toward a stock target, a long crafting commitment, or long travel to a distant station, and short holds for low energy, unfamiliar terrain, inspection, or an activity about to finish. The Worker forces a hold of 1 when energy is below 0.55 and carried water is below 1.5. Instinct directives and missing holds count as 1, and a failed decision keeps one macroturn. Phases stay fixed: a hold spans whole macroturns, so a held agent skips its phase ticks and at most two agents remain due on any tick.

The deterministic simulator ends a hold early, without a model call, in three cases: energy falls below 0.55 with carried water below 1.5 or the agent reboots; every primitive in its program fails for a full program cycle; or its crafting commitment completes or fails. In each case the held activity has stopped matching the world. A wake-up moves the next decision to the agent's next phase tick after the current tick and only ever earlier, so no agent becomes due twice or off its phase. Queued speech reaches a holding agent at its next actual decision, early or not. `/api/health` reports `decisionHolds`: the mean scheduled hold, the wake-up count, and decisions avoided, meaning phase ticks that passed without a call because the agent held. A deterministic replay of one hour with every hold set to 8 made 1,167 of 6,000 possible calls; that replay does not predict which holds Clef will choose.

The world diary is an observer layer over Algorithm 1's `AppendTrace`, not agent memory or an authoritative consequence. Raw notable events are persisted between diary checkpoints; the model may organize only supplied evidence, and diary failure never blocks world time. Tracking begins at migration, so the first entry does not fabricate earlier history.

`GET /api/held-out-assay` freezes the current world into eight exact clones, removes all agents, applies deterministic paired schedules seeded 9201–9208 across 288 evaluation ticks, and reports balanced service coverage per schedule plus the mean. The assay never mutates the discovery world. Its disturbance implementation follows the paper's contamination, drought, damage, and resource-variation structure, but remains this observatory's explicit adaptation rather than a reproduction of the authors' unpublished schedule payloads.

Crafting borrows Infinite Craft's legible pairwise-combination loop, but not its unconstrained ontology. A Creative Session may propose a material pair and a reusable program only from the typed action DSL. The host records that proposal as a physical commitment, seeks missing ingredients, and registers the skill only after both ingredients are consumed. Duplicate or invalid mixes consume the attempt without satisfying curiosity. When the NullClaw core refuses a proposal, the bot loses that attempt too and returns to ordinary work until the 600-tick cooldown ends. Successful recipes become craftable knowledge that another agent can reproduce from the same materials. This preserves SwarmWorld's separation of cognition, transactional validation, deterministic execution, memory, and trace append.

## Pruning and forgetting

Culture decays unless agents use it. The engine checks once per macroturn, under every interaction condition.

- Artifacts erode. The engine removes an artifact once it is dead (health at or below the 0.05 service cutoff) and no agent has used, inspected, maintained, adopted, or forked it for 21,600 ticks (360 macroturns, about 60 hours at the current 10-second tick). Any touch restarts the clock.
- Agents forget. An agent loses a learned skill it has not run or crafted for 43,200 ticks (720 macroturns, about 5 days at the current 10-second tick), the way a speaker loses an unused language. Agents keep the seven base actions, any skill they are running, and any recipe they are committed to crafting.
- Skills go extinct. When no agent knows a learned skill and none is crafting it, the engine drops it from the action library, the Craft Tree, and the recipes agents can learn. A later Creative Session that builds the same program registers it again as a novel skill with the same id, satisfies curiosity, and logs it as rediscovered.
- Fossils keep the history. The snapshot's `fossils` field holds the newest 128 extinct skills (author, recipe, program, creation and extinction ticks, every agent that knew and forgot it) and the newest 256 removed artifacts (creator, authors, contributors, adopters, service inspectors, parent, generation, and build, last-touch, and removal ticks), plus all-time counts. `/api/health` reports the counts. Agents never observe fossils, so pruning adds no culture channel to the ablations.

Migration starts each clock from recorded evidence. An artifact no agent ever touched starts at its build tick or its latest child's fork tick, and a skill its author never ran starts at its creation tick. Every other clock starts at migration. On the T400,389 snapshot, the first pass removes 104 never-touched artifacts and 19 skills known only by their idle authors. If the current activity mix held, the other 36 artifacts would erode 21,600 ticks later and the last 17 learned skills would go extinct 43,200 ticks later.

## Hierarchy ranking

`/ranking` asks whether a hierarchy forms among the bots. It ranks each bot by prestige measured from deference between bots, never from an assigned role.

- A deference link runs from bot A to bot B when A uses or inspects B's artifact (weight 1), measures its service (+1), repairs it (+1), forks it (3, and 1 for each older author in that lineage), or learns a skill B authored (3). Forking and learning weigh more because they cost a build or two gathered materials.
- Speech does not count. Bots address the nearest bot, recipients cannot refuse a message, and the world never records whether a listener acted on it. The page shows heard-by counts for context only.
- Prestige is weighted PageRank over those links with damping 0.85, so deference from a respected bot counts more. 1.00 is an equal share.
- The population metrics are the Gini and top-10% share of prestige above the PageRank floor, triad transitivity (1 for a strict ladder, 0 for random direction), and the deepest fork generation. A seeded null model keeps every bot's outgoing links and re-aims each one at a random bot 100 times. Concentration counts as beyond chance when fewer than 5% of those shuffles reach the measured Gini. The null ignores geography, so a bot beside a busy station can exceed chance without anyone choosing it.
- Below 10 links the page shows no ranking, and below 5 fully resolved triads it shows no transitivity. `src/sim/hierarchy.ts` returns those metrics as undefined, never as 0.
- The Durable Object writes a snapshot to its SQLite `hierarchy_snapshots` table every 600 ticks. Past 720 rows it drops every other row in the older half, so the series keeps its first row and full span at coarser spacing. `GET /api/hierarchy` returns the current ranking and the series.
- Tracking starts at deploy. The first row is a labeled baseline of the state at that moment, which already includes links built earlier; no earlier history is reconstructed.
- Pruning does not erase prestige. `computeHierarchy` reads `world.fossils`, so eroded artifacts keep their users, inspectors, repairers, and forks, and extinct skills keep every bot that knew them. A bot that forgot a living skill (`forgottenBy`) still counts as a learner. Only fossils pushed out of the 256-artifact and 128-skill archive drop out.
- Bots never see their rank. The hierarchy module feeds no observation, memory, or model prompt, and a test checks that measuring leaves the world unchanged.
- Without the Worker, the page computes the current ranking from the local fallback simulation and marks history unavailable.

## Harness² self-learning

The Worker runs a version of Harness² (Xu et al., "Harness²: Recursive Agent Harnessing for an Open World", [arXiv 2610.14224](https://arxiv.org/abs/2610.14224)) on the routine Clef decision. An execution harness is a set of typed additions to one agent's request: procedure lines appended to the goal instructions, guards that remove or require an option while a condition on the agent's situation holds, verified workspace facts sent in the state as `harnessMemory`, replacement criteria text for one option, and skill triggers that swap a built-in activity for a learned action the agent knows. Every agent starts with H0, the empty harness. A decision under H0 sends the same bytes as before this feature; a test compares those requests with bodies recorded from the earlier code.

An improvement round replaces one agent's routine Clef call for one macroturn:

1. References. Clef answers the routine questions under H0, and the Worker draws k directives from its probabilities.
2. Rollouts. The Worker clones the world at the decision tick and plays each directive forward for 120 ticks. A clone keeps the RNG state, terrain, and neighbours of the live world; only the harness differs, and the live world never changes.
3. Editor. Deterministic diagnosers read the reference trajectories and propose INV edits (how the agent works: procedure, guards, skill triggers) and DOM edits (what it knows about this place: facts and option guidance). Each edit names the trajectory moment behind it, such as a primitive that failed on consecutive ticks or a viable tile the rollout walked past. Clef weighs the edits against keeping the current harness, one question per scope, and the Worker samples k candidates per scope from its probabilities.
4. Probes. Each picked edit runs on a fresh clone with the references' random seed, so a probe's directive differs from the reference only when the edit moved Clef's probabilities.
5. Composer. Clef marks each pooled edit kept or dropped. Code then drops any edit whose probe produced nothing while a reference delivered, resolves conflicts, and enforces the harness limits.
6. Selection, when k > 1. Clef compares anonymized, shuffled outcome summaries of the references and successors and picks one to deliver. No harness, run id, score, or rubric reaches it.
7. Reflector. Clef labels each edit helped, hurt, no observed effect, or confounded, and code overrides the label when no execution isolates the edit. An edit that helped or hurt can yield one lesson for the library; otherwise the round records NO_ENTRY.

The selected directive goes through the same text generation and commit path as a routine directive. The agent keeps the adopted harness for its routine macroturns until its next round, and the world log gains a line such as "Ada refined its harness: add memory: ..." or "Ada kept its base harness". The SQLite table `harness_library` keeps up to 400 lessons and adopted harnesses per interaction condition. Under full culture every agent reads them; under both ablations each agent reads only its own rows, so the library opens no new culture channel there. `harness_rounds` keeps a compact record of the latest 200 rounds.

This world adapts the paper in five ways:

- Clef edits by choosing among typed edits that code built and validated, and it never writes harness text. A frozen 9B decision model answers choice questions; it does not author programs.
- The harness has no C5 (subagents) and no C7 (scripts). One decision has one context, and a script minted by a harness would bypass the crafting and creative-session rules that make learned actions physical culture.
- Rounds run only on open decisions. When the goal question keeps fewer than two options under H0, as in the emergency water refill, a crafting commitment, or a due creative session, a round cannot change the decision, so the scheduler skips that agent.
- At most one round runs per `HARNESS_ROUND_INTERVAL_TICKS`. Among the due agents with an open decision, the Worker picks one without a harness first, then the one whose harness is oldest.
- Every round starts from H0 and reads the library, as in the paper. A round that keeps the base harness resets the agent to H0.

A failed round, retryable or not, sends the agent back to its routine decision in the same macroturn and records `lastRoundError`. A round never pauses world time by itself: a quota error ends the round, and only the routine fallback call can start the Clef cooldown.

| Variable                       | Default    | Meaning                                                                                                                                                   |
| ------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HARNESS_LEARNING`             | `true`     | `true` runs rounds and applies adopted harnesses. Any other value sends H0 requests and leaves stored harnesses unused.                                   |
| `HARNESS_K`                    | `1`        | 1 to 5: candidates per scope and compositions in parallel mode, chained checkpoints in sequential mode. Values above 5 become 5; anything else becomes 1. |
| `HARNESS_MODE`                 | `parallel` | `parallel` or `sequential`.                                                                                                                               |
| `HARNESS_ROUND_INTERVAL_TICKS` | `60`       | Minimum ticks between rounds: 60 ticks is 10 minutes at the 10-second tick.                                                                               |

A parallel k = 1 round makes at most 7 Clef calls: the reference decision, the Editor, up to two probe decisions, the Composer, one successor decision, and the Reflector. A stage with nothing to decide skips its call, so stubbed rounds on the T400,389 snapshot made 4 and 6 calls. A sequential k = 5 round makes at most 28. Every call counts against `MAX_LLM_CALLS_PER_DAY` and adds its cost to `world.llm.totalCost`, and the Worker skips a round when fewer than 40 daily calls remain or while Clef is on cooldown. At about $0.00003 per decision, a k = 1 round costs about $0.0002, and one round every 10 minutes adds at most about 860 calls and $0.03 a day. With a stubbed transport, the two rounds on the live snapshot took 0.9 and 1.9 seconds in Node.

`GET /api/harness` returns the settings, `nextRoundTick`, `roundsCompleted`, `lastRoundError`, library counts per condition with the 50 newest index rows, the last 20 rounds (tick, agent, cue, adopted run and components, verdict rows, lesson or NO_ENTRY, calls, cost, fallbacks, and any error), and each harnessed agent's revision, adoption tick, and component counts. `/api/health` carries a short `harness` block. The WebSocket snapshot omits harnesses.

Local tests validate mechanics: H0 byte identity, harness application in the routine request, scheduling and budget rules, persistence shapes, and full rounds against a fetch stub that answers by label order. They do not show that harnesses improve decisions; that needs live rounds and a matched comparison against H0. On the T400,389 snapshot, 95 agents sit in the emergency water branch and 5 hold crafting commitments, so no agent has an open decision, and the scheduler would skip rounds until reserves recover.

## Local development

```bash
npm install --include=dev
npm run build
npm run dev:edge
```

Open <http://localhost:8787>.

The browser fallback runs deterministically without credentials. The authoritative Worker requires `OPENROUTER_API_KEY` at each scheduled macroturn and preserves the current activity if a decision is invalid. Retryable provider failures preserve the scheduled opportunity and pause world time rather than skipping an agent. Model calls remain capped by `MAX_LLM_CALLS_PER_DAY`.

## Verification

```bash
npm test
npm run check
npm run build
```

The tests cover deterministic replay, persistent artifact inheritance, emergent behavioral diversity, physical bounds, and rejection of model output outside the narrow action schema.

## Visual system

The map borrows the method—not generated assets—from Stas Kulesh's `blouns/gmi.sh`: layered radial color fields, displaced-looking organic regions, paper grain, and many translucent strata. The rendered planet is procedural and toroidally seamless.

A faint heatmap under the bots shows where they spend their time. Each tick, the engine adds one agent-tick to the tile and activity of every bot and keeps these all-time counts without decay. Counting starts when a world first loads this version; the engine never rebuilds history from the short trails. Each snapshot carries one byte per tile, about 9 KB of base64, holding a log-scaled level between the median and the 99th-percentile tile plus the tile's dominant activity. The renderer blurs that field into a warm glow and tints tiles with the color of any activity that outweighs surveying there. The HEAT button switches to a strong view that mutes the terrain, raises the glow, and shows a legend; your browser remembers the choice.

## Research and credits

- [SwarmWorld preprint](https://arxiv.org/abs/2608.26081)
- [NullClaw](https://github.com/nullclaw/nullclaw) — MIT
- [HackerNoon Pixel Icon Library](https://github.com/hackernoon/pixel-icon-library) — icons used unmodified under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- [Silkscreen](https://fonts.google.com/specimen/Silkscreen) — SIL Open Font License 1.1
- [p5.js](https://p5js.org/)
