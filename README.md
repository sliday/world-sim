# Stigmergy — A World That Remembers

An endless zero-player p5.js observatory inspired by **SwarmWorld: Stigmergic technological evolution in societies of language-model agents** (Pal, Wang & Buehler, MIT, 2026).

This is a live implementation track toward the paper's core mechanics, not a reproduction of its reported results. Fidelity work is explicit: mechanism ablations, matched isolated-search controls, and held-out agent-free disturbance assays are still required.

## What is real in the simulation

- 100 policy-equivalent agents receive local observations; a fresh world initializes them with identical policy and energy.
- Every agent recompiles and executes one bounded local decision on each one-second world tick; expensive model macroturns are staggered separately.
- A toroidal 96×72 planet has finite resources, facilities, moisture, contamination, and persistent artifacts.
- Agents can explore, gather, construct, inspect, maintain, and fork constrained artifact controllers.
- The deterministic consequence layer—not an LLM—validates resources, actions, health, performance, and failure.
- Artifacts remain in the world, can be physically encountered by later agents, and retain executable lineage.
- Bounded movement trails expose mean path length, regions visited, artifact-contact rate, and spatial entropy without allowing history to grow unbounded.
- Private SQLite episodic logs retain up to approximately 250,000 tokens per agent with deterministic compaction.
- Roles shown in the UI are current behavior, never assigned identities.

## Runtime

- **Client:** p5.js + TypeScript + Vite+
- **World authority:** one SQLite-backed Cloudflare Durable Object
- **Live updates:** hibernatable WebSockets; one-second alarm-driven deterministic ticks
- **Agent policy:** NullClaw-derived Zig policy core compiled to WebAssembly
- **Model routing:** `openrouter/free` first, with `openrouter/auto` as an ordered fallback; server-side and schema-constrained
- **Static hosting:** Cloudflare Workers Static Assets

The full native NullClaw daemon does not run inside a Cloudflare Worker. This project uses NullClaw's official edge pattern: networking, secrets, validation, and consequences stay in the Worker host; a tiny Zig/WASM core selects the context policy used for occasional model decisions.

## Local development

```bash
npm install --include=dev
npm run build
npm run dev:edge
```

Open <http://localhost:8787>.

The world runs deterministically without credentials. To test model-assisted decisions, set `OPENROUTER_API_KEY` as a Wrangler secret and set `LLM_ENABLED` to `true`. Model calls are capped by `MAX_LLM_CALLS_PER_DAY` and spaced by `LLM_INTERVAL_TICKS`.

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
- [Pixelify Sans](https://fonts.google.com/specimen/Pixelify+Sans) — SIL Open Font License 1.1
- [p5.js](https://p5js.org/)
