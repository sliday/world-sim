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
- **Model routing:** `openrouter/free` only, hard-coded server-side with no paid fallback; schema-constrained
- **Static hosting:** Cloudflare Workers Static Assets

The full native NullClaw daemon does not run inside a Cloudflare Worker. This project uses NullClaw's official edge pattern: networking, secrets, validation, and consequences stay in the Worker host; a tiny Zig/WASM core selects the context policy used for occasional model decisions.

## Decision mechanics

The scheduler follows SwarmWorld's fixed per-agent macroturn phases rather than selecting whichever agents look stale. The paper's primary population study used a 50-tick interval; this observatory deliberately uses 60 ticks so one authoritative tick approximates one second and every agent gets one AI opportunity per minute. A macroturn is resolved before its candidate world tick, and retryable provider failures preserve the activity and scheduled tick instead of silently skipping an agent.

There is one explicit product-driven variation from Algorithm 1: SwarmWorld consumes a finite action queue and waits when it empties, while this world cycles a bounded activity program until the next macroturn. That variation implements the requirement that a bot remain engaged between reassessments. The consequence boundary remains the same: the model chooses a validated activity, and the deterministic simulator attempts exactly one primitive per agent per tick.

The hourly world diary is an observer layer over Algorithm 1's `AppendTrace`, not agent memory or an authoritative consequence. Raw notable events are persisted between diary checkpoints; the model may organize only supplied evidence, and diary failure never blocks world time. Tracking begins at migration, so the first entry does not fabricate earlier history.

Crafting borrows Infinite Craft's legible pairwise-combination loop, but not its unconstrained ontology. A Creative Session may propose a material pair and a reusable program only from the typed action DSL. The host records that proposal as a physical commitment, seeks missing ingredients, and registers the skill only after both ingredients are consumed. Duplicate or invalid mixes consume the attempt without satisfying curiosity. Successful recipes become craftable knowledge that another agent can reproduce from the same materials. This preserves SwarmWorld's separation of cognition, transactional validation, deterministic execution, memory, and trace append.

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
