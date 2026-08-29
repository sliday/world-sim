import "@hackernoon/pixel-icon-library/fonts/iconfont.css";
import { botPortraitSvg } from "./sim/bot-appearance";
import "./style.css";
import { WorldClient } from "./sim/client";
import { createWorldSketch } from "./sim/renderer";
import type { Agent, MaterialKind, PublicWorldSnapshot, WorldEvent } from "./sim/types";

const materialVisual: Record<MaterialKind, { icon: string; rune: string }> = {
  water: { icon: "hn-cloud-rain", rune: "≈" },
  fungus: { icon: "hn-seedlings", rune: "♣" },
  mineral: { icon: "hn-coin", rune: "◆" },
  cellulose: { icon: "hn-branch", rune: "╫" },
  chitin: { icon: "hn-shapes", rune: "⌬" },
};

interface AgentLongMemory {
  agentId: string;
  tokenCap: number;
  estimatedTokens: number;
  entries: number;
  compactions: number;
  summary: string;
  recent: Array<{
    seq: number;
    tick: number;
    kind: string;
    content: string;
    tokens: number;
    firstTick?: number;
    lastTick?: number;
    repeatCount?: number;
  }>;
}

const app = document.querySelector<HTMLDivElement>("#app")!;

app.innerHTML = `
  <main class="world-shell">
    <div id="world-canvas" aria-label="An endless autonomous world simulation"></div>

    <header class="masthead glass-panel">
      <div class="wordmark" aria-label="Stigmergy">
        <span class="sigil" aria-hidden="true"><i></i><i></i><i></i></span>
        <span>STIGMERGY</span>
      </div>
      <p>A WORLD THAT REMEMBERS</p>
    </header>

    <div class="world-key glass-panel" aria-label="World material symbols">
      <span><i class="hn hn-cloud-rain"></i><b>≈</b> WATER</span>
      <span><i class="hn hn-seedlings"></i><b>♣</b> FUNGUS</span>
      <span><i class="hn hn-coin"></i><b>◆</b> MINERAL</span>
      <span><i class="hn hn-branch"></i><b>╫</b> CELLULOSE</span>
      <span><i class="hn hn-shapes"></i><b>⌬</b> CHITIN</span>
    </div>

    <div class="top-actions">
      <span id="engine-status" class="engine-status"><b></b> CONNECTING</span>
      <button id="about-button" class="pixel-button" type="button"><i class="hn hn-info-circle"></i> ABOUT</button>
    </div>

    <section class="event-panel glass-panel" aria-label="Events in the world">
      <div class="panel-kicker"><span>LIVE TRACE</span><span id="tick-label">TICK 0</span></div>
      <div id="event-list" class="event-list" aria-live="polite"></div>
    </section>

    <section id="agent-inspector" class="agent-inspector glass-panel" aria-label="Selected agent stats" aria-hidden="true" tabindex="-1">
      <div class="agent-inspector-head">
        <div class="agent-identity"><div id="agent-portrait" class="agent-portrait" aria-hidden="true"></div><div><span>SELECTED AGENT</span><strong id="agent-inspector-name">—</strong><small id="agent-inspector-id">—</small></div></div>
        <button id="agent-inspector-close" class="icon-button" type="button" aria-label="Close agent stats"><i class="hn hn-times"></i></button>
      </div>
      <div id="agent-inspector-content"></div>
    </section>

    <section class="metrics glass-panel" aria-label="World metrics">
      <div><span>AGENTS</span><strong id="metric-agents">—</strong></div>
      <div><span>ARTIFACTS</span><strong id="metric-artifacts">—</strong></div>
      <div><span>NOW / PEAK / AUC</span><strong id="metric-best-artifact">—</strong></div>
      <div><span>LINEAGE</span><strong id="metric-lineage">—</strong></div>
      <div><span>ADOPTION</span><strong id="metric-reuse">—</strong></div>
      <div><span>LIVE PORTFOLIO</span><strong id="metric-resilience">—</strong></div>
      <div><span>MEAN PATH</span><strong id="metric-path">—</strong></div>
      <div><span>REGIONS</span><strong id="metric-regions">—</strong></div>
      <div><span>ARTIFACT CONTACT</span><strong id="metric-contact">—</strong></div>
      <div><span>SPATIAL ENTROPY</span><strong id="metric-entropy">—</strong></div>
    </section>

    <div class="observer-hint"><i class="hn hn-eye"></i> TAP AN AGENT FOR STATS · DRAG TO ROAM · SCROLL TO ZOOM</div>
  </main>

  <section id="about-page" class="about-page" aria-hidden="true">
    <nav class="about-nav">
      <div class="wordmark"><span class="sigil" aria-hidden="true"><i></i><i></i><i></i></span><span>STIGMERGY</span></div>
      <button id="about-close" class="pixel-button dark" type="button"><i class="hn hn-times"></i> RETURN TO WORLD</button>
    </nav>

    <article class="about-content">
      <p class="eyebrow">AN AUTONOMOUS PLANET · NO PLAYERS · NO ASSIGNED ROLES</p>
      <h1>THEY DON’T NEED TO<br>UNDERSTAND EACH OTHER.<br><em>THE WORLD REMEMBERS.</em></h1>
      <p class="lede">One hundred policy-equivalent little scientists inhabit a persistent planet. Nobody tells them who should explore, who should build, or what to invent. Every second, each executes a bounded local decision while staggered model macroturns revise plans. Each carries a small soul, user contract, executable action script, and a durable episodic log capped near 250,000 tokens.</p>

      <div class="explain-grid">
        <section><span>01</span><i class="hn hn-location-pin"></i><h2>THEY WANDER</h2><p>Agents see only their local patch. Nearby bots trade one short telegraphic sentence; heard facts enter memory.</p></section>
        <section><span>02</span><i class="hn hn-code-block"></i><h2>THEY BUILD</h2><p>A design is only a claim. The deterministic world checks resources, location, and whether its controller actually works.</p></section>
        <section><span>03</span><i class="hn hn-eye"></i><h2>THEY COPY</h2><p>Most knowledge travels physically: an agent finds a working artifact, inspects it, then forks its controller.</p></section>
        <section><span>04</span><i class="hn hn-users"></i><h2>ROLES EMERGE</h2><p>Explorers, fabricators, caretakers, and code forkers are behaviors—not jobs assigned in advance.</p></section>
      </div>

      <section class="truth-box">
        <div><span class="truth-label">THE IMPORTANT SPLIT</span><h2>THE MODEL PROPOSES.<br>THE WORLD DISPOSES.</h2></div>
        <p>Language models can choose a goal, icon, or propose a plain-language algorithm composed from bounded primitives. NullClaw facilitates admission into a WASM action sandbox. Agents cannot award themselves resources or declare success; every consequence is resolved by the simulation.</p>
      </section>

      <div class="paper-section">
        <div>
          <p class="eyebrow">THE RESEARCH</p>
          <h2>INSPIRED BY SWARMWORLD</h2>
          <p>This is a live implementation track toward SwarmWorld’s core mechanics—not a reproduction of its reported results. It now runs the paper’s long-horizon population size of 100 with one-second world decisions, local observations, memory, communication, persistent artifacts, executable inheritance, and trajectory statistics. “Valid artifact” currently means passing this world’s local performance threshold; “live portfolio” is a present-world diversity and health heuristic. Neither is the paper’s stricter validated-invention count or agent-free held-out resilience assay. Mechanism ablations, matched isolated-search controls, and agent-free held-out disturbance assays remain the next fidelity gates.</p>
        </div>
        <a class="paper-link" href="https://arxiv.org/abs/2608.26081" target="_blank" rel="noreferrer"><i class="hn hn-book"></i><span>READ THE PREPRINT<small>Pal, Wang & Buehler · MIT · 2026</small></span><i class="hn hn-external-link"></i></a>
      </div>

      <footer class="credits">
        <p>SIMULATION: P5.JS · EDGE STATE: CLOUDFLARE DURABLE OBJECTS · AGENT ROUTING: NULLCLAW EDGE POLICY + OPENROUTER/AUTO</p>
        <p>PIXEL ICONS BY <a href="https://github.com/hackernoon/pixel-icon-library" target="_blank" rel="noreferrer">HACKERNOON</a>, USED UNMODIFIED UNDER <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a> · PIXELIFY SANS UNDER OFL 1.1</p>
      </footer>
    </article>
  </section>
`;

const client = new WorldClient();
const canvasHost = document.querySelector<HTMLElement>("#world-canvas")!;
const aboutPage = document.querySelector<HTMLElement>("#about-page")!;
const eventList = document.querySelector<HTMLElement>("#event-list")!;
const engineStatus = document.querySelector<HTMLElement>("#engine-status")!;
const worldShell = document.querySelector<HTMLElement>(".world-shell")!;
const agentInspector = document.querySelector<HTMLElement>("#agent-inspector")!;
const agentInspectorContent = document.querySelector<HTMLElement>("#agent-inspector-content")!;
let selectedAgentId: string | null = null;
let latestSnapshot = client.snapshot;
const longMemory = new Map<string, AgentLongMemory>();
const renderer = createWorldSketch(canvasHost, client.snapshot, selectAgent);

function metric(id: string, value: string): void {
  const element = document.querySelector<HTMLElement>(`#${id}`);
  if (element) element.textContent = value;
}

function eventMarkup(event: WorldEvent, newest: boolean): string {
  const icon: Record<WorldEvent["kind"], string> = {
    discovery: "hn-location-pin",
    build: "hn-code-block",
    fork: "hn-code",
    repair: "hn-spinner",
    failure: "hn-times-circle",
    decision: "hn-sparkles",
  };
  return `<div class="event ${newest ? "newest" : ""}"><i class="hn ${icon[event.kind]}"></i><p>${escapeHtml(event.text)}<span>T${event.tick}</span></p></div>`;
}

function escapeHtml(value: string): string {
  const element = document.createElement("span");
  element.textContent = value;
  return element.innerHTML;
}

function inventoryMarkup(agent: Agent): string {
  return Object.entries(agent.inventory)
    .map(([material, amount]) => {
      const visual = materialVisual[material as MaterialKind];
      return `<div><span><i class="hn ${visual.icon}"></i><b>${visual.rune}</b>${escapeHtml(material.toUpperCase())}</span><strong>${Math.round(amount * 10) / 10}</strong></div>`;
    })
    .join("");
}

function longMemoryMarkup(agentId: string): string {
  const memory = longMemory.get(agentId);
  if (!memory)
    return '<div class="agent-long-memory"><span>LONG MEMORY</span><p>Loading durable log…</p></div>';
  const recent = memory.recent
    .slice(-6)
    .reverse()
    .map((entry) => {
      const repeats = Math.max(1, entry.repeatCount ?? 1);
      const firstTick = entry.firstTick ?? entry.tick;
      const lastTick = entry.lastTick ?? entry.tick;
      const ticks =
        repeats > 1 && firstTick !== lastTick ? `T${firstTick}–T${lastTick}` : `T${lastTick}`;
      const count = repeats > 1 ? ` ×${repeats}` : "";
      return `<li><b>${ticks} · ${escapeHtml(entry.kind.toUpperCase())}${count}</b>${escapeHtml(entry.content)}</li>`;
    })
    .join("");
  return `<div class="agent-long-memory">
    <span>LONG MEMORY · ~${memory.estimatedTokens.toLocaleString()} / ${memory.tokenCap.toLocaleString()} TOKENS · ${memory.compactions} COMPACTIONS</span>
    ${memory.summary ? `<details><summary>COMPACTED HISTORY</summary><pre>${escapeHtml(memory.summary)}</pre></details>` : ""}
    <details><summary>RECENT LOG · ${memory.entries} ENTRIES</summary><ol>${recent}</ol></details>
  </div>`;
}

async function loadLongMemory(agentId: string): Promise<void> {
  try {
    const response = await fetch(`/api/agent-memory?id=${encodeURIComponent(agentId)}`);
    if (!response.ok) return;
    longMemory.set(agentId, (await response.json()) as AgentLongMemory);
    if (selectedAgentId === agentId) renderAgentInspector(latestSnapshot);
  } catch {
    // Compact in-snapshot memory remains available if this edge request fails.
  }
}

function renderAgentInspector(snapshot: PublicWorldSnapshot): void {
  if (!selectedAgentId) return;
  const agent = snapshot.agents.find((candidate) => candidate.id === selectedAgentId);
  if (!agent) {
    selectAgent(null);
    return;
  }
  const energy = Math.round(agent.energy * 100);
  const action = snapshot.actionLibrary.find((candidate) => candidate.id === agent.script.actionId);
  const heard = agent.heardMessages
    .slice(-3)
    .reverse()
    .map((message) => {
      const speaker = snapshot.agents.find((candidate) => candidate.id === message.fromId);
      return `<div><span>${escapeHtml(speaker?.name ?? message.fromId)}</span><p>“${escapeHtml(message.text)}”</p><small>T${message.tick}</small></div>`;
    })
    .join("");
  const portrait = document.querySelector<HTMLElement>("#agent-portrait");
  if (portrait) portrait.innerHTML = botPortraitSvg(`${snapshot.seed}:${agent.id}`);
  metric("agent-inspector-name", agent.name);
  metric("agent-inspector-id", agent.id);
  agentInspectorContent.innerHTML = `
    <div class="agent-state"><span class="agent-mode">${escapeHtml(agent.mode.toUpperCase())}</span><span>${energy}% ENERGY</span></div>
    <div class="energy-track" aria-label="Energy ${energy} percent"><i style="width:${energy}%"></i></div>
    <div class="agent-directive">
      <span>${agent.directive.source === "openrouter" ? "OPENROUTER DIRECTIVE" : "LOCAL DIRECTIVE"}</span>
      <strong>${escapeHtml(agent.directive.goal.toUpperCase())} · ${escapeHtml(agent.directive.targetMaterial.toUpperCase())}</strong>
      <p>${escapeHtml(agent.directive.note)}</p>
      <small>${escapeHtml(agent.directive.controllerAction.toUpperCase())}${agent.directive.model ? ` · ${escapeHtml(agent.directive.model)}` : ""}</small>
    </div>
    <div class="agent-directive agent-program">
      <span>ACTION SANDBOX · SCRIPT R${agent.script.revision} · T${agent.script.updatedTick}</span>
      <strong>${escapeHtml(agent.script.icon)} ${escapeHtml(action?.name.toUpperCase() ?? agent.script.actionId.toUpperCase())}</strong>
      <p>${escapeHtml(action?.algorithm ?? agent.script.rationale)}</p>
      <small>${escapeHtml(agent.script.program.join(" → "))}<br>${escapeHtml(agent.script.lastResult)}</small>
    </div>
    <div class="agent-files">
      <details><summary>SOUL.md</summary><pre>${escapeHtml(agent.documents.soulMd)}</pre></details>
      <details><summary>MEMORY.md</summary><pre>${escapeHtml(agent.documents.memoryMd)}</pre></details>
      <details><summary>USER.md</summary><pre>${escapeHtml(agent.documents.userMd)}</pre></details>
    </div>
    ${heard ? `<div class="agent-heard"><span>HEARD NEARBY</span>${heard}</div>` : ""}
    ${longMemoryMarkup(agent.id)}
    <div class="agent-stat-grid">
      <div><span>BUILDS</span><strong>${agent.builds}</strong></div>
      <div><span>DISCOVERIES</span><strong>${agent.discoveries}</strong></div>
      <div><span>ARTIFACT CONTACTS</span><strong>${agent.artifactsTouched}</strong></div>
      <div><span>LAST DECISION</span><strong>T${agent.lastDecisionTick}</strong></div>
      <div><span>PATH LENGTH</span><strong>${agent.trajectory.pathLength.toFixed(1)}</strong></div>
      <div><span>REGIONS VISITED</span><strong>${agent.trajectory.regionsVisited.length}</strong></div>
      <div><span>CONTACT RATE</span><strong>${agent.trajectory.observedTicks ? Math.round((agent.trajectory.artifactContactTicks / agent.trajectory.observedTicks) * 100) : 0}%</strong></div>
      <div><span>TRAIL WINDOW</span><strong>${agent.trail.length}</strong></div>
    </div>
    <div class="inventory-label"><span>INVENTORY</span>${agent.forkedProgramId ? `<small>FORK: ${escapeHtml(agent.forkedProgramId)}</small>` : ""}</div>
    <div class="agent-inventory">${inventoryMarkup(agent)}</div>
  `;
}

function selectAgent(agentId: string | null): void {
  selectedAgentId = agentId;
  renderer.selectAgent(agentId);
  const selected = agentId !== null;
  worldShell.classList.toggle("agent-selected", selected);
  agentInspector.setAttribute("aria-hidden", String(!selected));
  if (selected) {
    renderAgentInspector(latestSnapshot);
    void loadLongMemory(agentId);
  }
}

function renderChrome(snapshot: PublicWorldSnapshot): void {
  latestSnapshot = snapshot;
  renderer.update(snapshot);
  renderAgentInspector(snapshot);
  metric("metric-agents", String(snapshot.metrics.activeAgents));
  metric("metric-artifacts", String(snapshot.metrics.artifacts));
  metric(
    "metric-best-artifact",
    `${Math.round(snapshot.metrics.bestArtifactPerformance * 100)} / ${Math.round(snapshot.metrics.discoveryFrontierPerformance * 100)} / ${Math.round(snapshot.metrics.discoveryFrontierAuc * 100)}%`,
  );
  metric("metric-lineage", `GEN ${snapshot.metrics.forkDepth}`);
  metric("metric-reuse", `${Math.round(snapshot.metrics.physicalReuseFraction * 100)}%`);
  metric("metric-resilience", `${Math.round(snapshot.metrics.portfolioResilience * 100)}%`);
  metric("metric-path", snapshot.metrics.meanPathLength.toFixed(1));
  metric("metric-regions", snapshot.metrics.meanRegionsVisited.toFixed(1));
  metric("metric-contact", `${Math.round(snapshot.metrics.artifactContactRate * 100)}%`);
  metric("metric-entropy", snapshot.metrics.spatialEntropy.toFixed(2));
  metric("tick-label", `TICK ${snapshot.tick.toLocaleString()}`);
  eventList.innerHTML =
    snapshot.events
      .slice(0, 5)
      .map((event, index) => eventMarkup(event, index === 0))
      .join("") || '<p class="quiet">The first agents are mapping the planet…</p>';
  const assisted = snapshot.engine.mode === "openrouter-assisted";
  engineStatus.classList.toggle("assisted", assisted);
  engineStatus.innerHTML = `<b></b> ${assisted ? "OPENROUTER/AUTO" : "DETERMINISTIC SEED"} · NULLCLAW SANDBOX`;
}

function showAbout(show: boolean, updateHistory = true): void {
  if (show) selectAgent(null);
  aboutPage.classList.toggle("visible", show);
  aboutPage.setAttribute("aria-hidden", String(!show));
  document.body.classList.toggle("about-open", show);
  if (updateHistory) history.pushState({ about: show }, "", show ? "/about" : "/");
}

document.querySelector("#about-button")?.addEventListener("click", () => showAbout(true));
document.querySelector("#about-close")?.addEventListener("click", () => showAbout(false));
document
  .querySelector("#agent-inspector-close")
  ?.addEventListener("click", () => selectAgent(null));
window.addEventListener("popstate", () => showAbout(location.pathname === "/about", false));
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (selectedAgentId) selectAgent(null);
  else if (aboutPage.classList.contains("visible")) showAbout(false);
});
window.addEventListener("beforeunload", () => {
  client.dispose();
  renderer.remove();
});

client.subscribe(renderChrome);
void client.connect();
if (location.pathname === "/about") showAbout(true, false);
