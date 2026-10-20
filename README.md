# Stigmergy — A World That Remembers

An endless zero-player p5.js observatory inspired by **SwarmWorld: Stigmergic technological evolution in societies of language-model agents** (Pal, Wang & Buehler, MIT, 2026).

This is a live implementation track toward the paper's core mechanics, not a reproduction of its reported results. Fidelity work is explicit: mechanism ablations, matched isolated-search controls, and held-out agent-free disturbance assays are still required.

## What is real in the simulation

- 100 policy-equivalent agents receive local observations; a fresh world initializes them with identical policy and energy.
- Every agent stays with one cyclic, bounded activity between fixed model macroturns and attempts exactly one primitive on each world tick.
- Macroturn phases are persistent and staggered: every agent gets one AI reassessment opportunity per 60 authoritative ticks, with at most two agents due on any tick.
- Every 3,600 authoritative ticks, an observer model turns the persisted event trace into a factual 1–5 line world diary focused on new actions, mapped resources, inheritance, adoption, and meaningful change.
- A toroidal 96×72 planet has finite resources, facilities, moisture, contamination, and persistent artifacts.
- Agents can explore, gather, construct, inspect, maintain, craft learned skills, and fork constrained artifact controllers.
- New artifacts can only be constructed near the material's matching processing station (wash, assay, foundry, weave, or grind); the artifact records that physical process and station provenance. Legacy artifacts remain intact with process provenance explicitly unavailable.
- Curiosity accumulates like hunger. Eligible bots periodically enter an AI Creative Session that proposes a two-material mix and a bounded action program; the action exists only after deterministic gathering, consumption, validation, and construction succeed.
- Missing recipe materials become explicit seek-and-gather subgoals. Inventory carries a durable purpose label so agent memory records why each ingredient is reserved until the craft completes or the experiment fails.
- The read-only Craft Tree is a zoomable, pannable knowledge graph from material roots through all 15 pairings to discovered skills; selecting a node opens its evidence and provenance, while a collapsed text index preserves linear access.
- Carried water is a finite energy reserve, not an endlessly rewarding gathering tile. Bots sip it when energy is low, retain physical inventory through a reboot, and leave saturated water gathering for agent-staggered material deficits.
- The deterministic consequence layer—not an LLM—validates resources, actions, health, performance, and failure.
- Artifact operation now uses closed physical fluxes: water capture transfers local moisture into bounded storage, remediation cannot remove more contamination than exists or reserve can support, and healing/growth consume finite embodied reserve. Per-artifact flux ledgers begin at schema-v5 migration; no pre-migration operation history is invented.
- Schema v6 replaces the old performance-only `validated` flag with six explicit gates: deterministic material test, complete agent-authored specification, installed bounded controller, processing provenance, performance threshold, and novel controller behavior. Legacy artifacts retain their evidence but remain provisional when a gate cannot be reconstructed.
- Schema v7 records realized service on every artifact tick. Live portfolio resilience uses a smoothed realized-service signal, while the held-out assay integrates unsmoothed per-tick service; controller capability and nominal performance no longer count as function when no water, contamination, damage, growth capacity, reserve, or signal event actually exists.
- Schema v8 requires a non-creator to physically inspect nonzero realized service before the final validation gate passes. Inspection records the verifying agents and first evidence tick; legacy contact or adoption does not retroactively fabricate measured-service evidence.
- Schema v9 queues addressed speech until the recipient's next fixed macroturn. Sending remains visible immediately, but heard context and durable recipient memory are created only when that scheduled observation occurs, so communication cannot purchase an extra model call.
- Schema v10 adds persisted full-culture, no-communication, and no-explicit-culture engine conditions. Ablations remove messaging, global recipe sharing, artifact specifications, and/or program inheritance from executable consequences rather than relying on prompt compliance; production remains the full-culture world. Matched multi-seed study orchestration is still required before comparing conditions.
- Schema v11 supports matched 50-, 100-, and 200-agent worlds with population-aware staggered phases. Terrain, processing stations, corresponding initial agent positions, and phases remain identical across interaction conditions within a population–seed block; production remains the persistent N=100 world.
- Artifacts remain in the world, can be physically encountered by later agents, and retain executable lineage.
- Bounded movement trails expose mean path length, regions visited, artifact-contact rate, and spatial entropy without allowing history to grow unbounded.
- Private SQLite episodic logs retain up to approximately 250,000 tokens per agent with deterministic compaction.
- Consecutive identical memories collapse into one lossless tick-ranged run (`T120–T420 ×6`); any intervening event starts a new run.
- Roles shown in the UI are current behavior, never assigned identities.

## Runtime

- **Client:** p5.js + TypeScript + Vite+
- **World authority:** one SQLite-backed Cloudflare Durable Object
- **Live updates:** hibernatable WebSockets; one-second alarm-driven deterministic ticks
- **Agent policy:** NullClaw-derived Zig policy core compiled to WebAssembly
- **Agent decisions:** `cloudflare/clef-flash` through the OpenRouter Decisions API, with the existing `OPENROUTER_API_KEY`.
- **Text generation:** `openrouter/free` for artifact specifications, creative proposals, and the world diary.
- **Static hosting:** Cloudflare Workers Static Assets

The full native NullClaw daemon does not run inside a Cloudflare Worker. This project uses NullClaw's official edge pattern: networking, secrets, validation, and consequences stay in the Worker host; a tiny Zig/WASM core selects the context policy used for occasional model decisions.

## Decision mechanics

Clef chooses the goal, material, controller, and learned activity in one request per agent. Independent agents share the existing pool of six requests.
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

The scheduler follows SwarmWorld's fixed per-agent macroturn phases rather than selecting whichever agents look stale. The paper's primary population study used a 50-tick interval; this observatory deliberately uses 60 ticks so one authoritative tick approximates one second and every agent gets one AI opportunity per minute. A macroturn is resolved before its candidate world tick, and retryable provider failures preserve the activity and scheduled tick instead of silently skipping an agent.

There is one explicit product-driven variation from Algorithm 1: SwarmWorld consumes a finite action queue and waits when it empties, while this world cycles a bounded activity program until the next macroturn. That variation implements the requirement that a bot remain engaged between reassessments. The consequence boundary remains the same: the model chooses a validated activity, and the deterministic simulator attempts exactly one primitive per agent per tick.

The hourly world diary is an observer layer over Algorithm 1's `AppendTrace`, not agent memory or an authoritative consequence. Raw notable events are persisted between diary checkpoints; the model may organize only supplied evidence, and diary failure never blocks world time. Tracking begins at migration, so the first entry does not fabricate earlier history.

`GET /api/held-out-assay` freezes the current world into eight exact clones, removes all agents, applies deterministic paired schedules seeded 9201–9208 across 288 evaluation ticks, and reports balanced service coverage per schedule plus the mean. The assay never mutates the discovery world. Its disturbance implementation follows the paper's contamination, drought, damage, and resource-variation structure, but remains this observatory's explicit adaptation rather than a reproduction of the authors' unpublished schedule payloads.

Crafting borrows Infinite Craft's legible pairwise-combination loop, but not its unconstrained ontology. A Creative Session may propose a material pair and a reusable program only from the typed action DSL. The host records that proposal as a physical commitment, seeks missing ingredients, and registers the skill only after both ingredients are consumed. Duplicate or invalid mixes consume the attempt without satisfying curiosity. Successful recipes become craftable knowledge that another agent can reproduce from the same materials. This preserves SwarmWorld's separation of cognition, transactional validation, deterministic execution, memory, and trace append.

## Hierarchy ranking

`/ranking` asks whether a hierarchy forms among the bots. It ranks each bot by prestige measured from deference between bots, never from an assigned role.

- A deference link runs from bot A to bot B when A uses or inspects B's artifact (weight 1), measures its service (+1), repairs it (+1), forks it (3, and 1 for each older author in that lineage), or learns a skill B authored (3). Forking and learning weigh more because they cost a build or two gathered materials.
- Speech does not count. Bots address the nearest bot, recipients cannot refuse a message, and the world never records whether a listener acted on it. The page shows heard-by counts for context only.
- Prestige is weighted PageRank over those links with damping 0.85, so deference from a respected bot counts more. 1.00 is an equal share.
- The population metrics are the Gini and top-10% share of prestige above the PageRank floor, triad transitivity (1 for a strict ladder, 0 for random direction), and the deepest fork generation. A seeded null model keeps every bot's outgoing links and re-aims each one at a random bot 100 times. Concentration counts as beyond chance when fewer than 5% of those shuffles reach the measured Gini. The null ignores geography, so a bot beside a busy station can exceed chance without anyone choosing it.
- Below 10 links the page shows no ranking, and below 5 fully resolved triads it shows no transitivity. `src/sim/hierarchy.ts` returns those metrics as undefined, never as 0.
- The Durable Object writes a snapshot to its SQLite `hierarchy_snapshots` table every 600 ticks. Past 720 rows it drops every other row in the older half, so the series keeps its first row and full span at coarser spacing. `GET /api/hierarchy` returns the current ranking and the series.
- Tracking starts at deploy. The first row is a labeled baseline of the state at that moment, which already includes links built earlier; no earlier history is reconstructed.
- The ranking reads artifacts and skills that still exist. `computeHierarchy` accepts optional fossil records so retired artifacts and extinct skills keep their links once an archive supplies them.
- Bots never see their rank. The hierarchy module feeds no observation, memory, or model prompt, and a test checks that measuring leaves the world unchanged.
- Without the Worker, the page computes the current ranking from the local fallback simulation and marks history unavailable.

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

## Research and credits

- [SwarmWorld preprint](https://arxiv.org/abs/2608.26081)
- [NullClaw](https://github.com/nullclaw/nullclaw) — MIT
- [HackerNoon Pixel Icon Library](https://github.com/hackernoon/pixel-icon-library) — icons used unmodified under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)
- [Silkscreen](https://fonts.google.com/specimen/Silkscreen) — SIL Open Font License 1.1
- [p5.js](https://p5js.org/)
