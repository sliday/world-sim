import "@hackernoon/pixel-icon-library/fonts/iconfont.css";
import { botPortraitSvg } from "./sim/bot-appearance";
import { buildCraftGraphLayout, type CraftGraphNode } from "./sim/craft-graph";
import { buildCraftTree, craftMaterials, type CraftTreePairing } from "./sim/craft-tree";
import "./style.css";
import { WorldClient, type WorldClientStatus } from "./sim/client";
import { createWorldSketch } from "./sim/renderer";
import { formatTickAge } from "./sim/tick-age";
import type {
  Agent,
  MaterialKind,
  PublicWorldSnapshot,
  WorldDiaryEntry,
  WorldEvent,
} from "./sim/types";

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
      <button id="craft-tree-button" class="pixel-button" type="button"><i class="hn hn-code-block"></i> CRAFT TREE</button>
      <button id="about-button" class="pixel-button" type="button"><i class="hn hn-info-circle"></i> ABOUT</button>
    </div>

    <section class="event-panel glass-panel" aria-label="Events in the world">
      <div class="panel-kicker"><span>LIVE TRACE</span><div class="panel-kicker-meta"><span id="tick-label">TICK 0</span><button id="trace-toggle" class="trace-toggle" type="button" aria-expanded="true" aria-label="Collapse live trace">CLOSE</button></div></div>
      <div id="world-diary" class="world-diary"></div>
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

  <section id="craft-tree-page" class="craft-tree-page" aria-hidden="true" inert>
    <nav class="craft-tree-nav">
      <div class="wordmark"><span class="sigil" aria-hidden="true"><i></i><i></i><i></i></span><span>STIGMERGY</span></div>
      <div><span id="craft-tree-tick">TICK 0</span><button id="craft-tree-close" class="pixel-button dark" type="button"><i class="hn hn-times"></i> RETURN TO WORLD</button></div>
    </nav>
    <section id="craft-tree-state" class="craft-tree-state" role="status" aria-live="polite">
      <i class="hn hn-spinner"></i><strong id="craft-tree-state-title">LOADING AUTHORITATIVE WORLD…</strong><p id="craft-tree-state-copy">The Craft Tree will appear after the persistent world responds.</p><button id="craft-tree-retry" class="pixel-button" type="button" hidden>RETRY CONNECTION</button>
    </section>
    <article id="craft-tree-content" class="craft-tree-content" hidden>
      <header class="craft-tree-hero">
        <div><p class="eyebrow">WORLD KNOWLEDGE · READ ONLY</p><h1 id="craft-tree-heading" tabindex="-1">THE FULL<br><em>CRAFT TREE</em></h1><p>Every two-material pairing is a branch. A behavior appears only after agents gather both ingredients, spend them, and the bounded action survives validation.</p></div>
        <dl class="craft-tree-summary">
          <div><dt>PAIRINGS</dt><dd id="craft-tree-pairings">15</dd></div>
          <div><dt>DISCOVERED</dt><dd id="craft-tree-discovered">0 / 15</dd></div>
          <div><dt>BEHAVIORS</dt><dd id="craft-tree-actions">0</dd></div>
          <div><dt>LIVE ATTEMPTS</dt><dd id="craft-tree-attempts">0</dd></div>
        </dl>
      </header>
      <div class="craft-tree-legend" aria-label="Craft tree status legend"><span><i class="discovered"></i> DISCOVERED</span><span><i class="active"></i> IN PROGRESS</span><span><i></i> NO DURABLE BEHAVIOR</span><span class="freshness-key">[NEW] = LAST 5 MIN</span></div>
      <section class="craft-graph-section" aria-labelledby="craft-graph-title">
        <header><div><span>KNOWLEDGE GRAPH</span><strong id="craft-graph-title">MATERIALS → PAIRINGS → SKILLS</strong><small>DRAG TO PAN · USE + / − TO ZOOM · SELECT A NODE</small></div><div class="craft-graph-controls" aria-label="Graph zoom controls"><button id="craft-graph-zoom-out" type="button" aria-label="Zoom out">−</button><output id="craft-graph-zoom">100%</output><button id="craft-graph-zoom-in" type="button" aria-label="Zoom in">+</button><button id="craft-graph-fit" type="button">FIT</button></div></header>
        <div class="craft-graph-shell">
          <div id="craft-graph-viewport" class="craft-graph-viewport" tabindex="0" aria-label="Zoomable craft graph. Drag to pan, use the mouse wheel or controls to zoom, and select a node for details.">
            <div id="craft-graph-stage" class="craft-graph-stage"></div>
          </div>
          <aside id="craft-graph-detail" class="craft-graph-detail" aria-live="polite"><span>SELECT A NODE</span><strong>TRACE THE WORLD’S KNOWLEDGE</strong><p>Materials combine into pairings. Successful physical experiments become bounded reusable skills.</p></aside>
        </div>
      </section>
      <section class="recent-artifacts">
        <header><div><span>RECENT PHYSICAL OUTPUTS</span><strong>ARTIFACTS</strong></div><small>NEWEST 8 · AUTHORITATIVE WORLD AGE</small></header>
        <div id="recent-artifact-list" class="recent-artifact-list"></div>
      </section>
      <p id="craft-tree-announcement" class="sr-only" aria-live="polite"></p>
      <details class="craft-tree-index"><summary>OPEN TEXT INDEX · ALL 15 PAIRINGS</summary><div id="craft-tree-grid" class="craft-tree-grid"></div></details>
    </article>
  </section>

  <section id="about-page" class="about-page" aria-hidden="true" inert>
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
          <p>This is a live implementation track toward SwarmWorld’s core mechanics—not a reproduction of its reported results. It runs 100 agents with local observations, memory, communication, persistent artifacts, executable inheritance, trajectory statistics, and an agent-free eight-schedule held-out assay. A strictly validated invention must now pass six recorded gates: tested material, complete agent-authored specification, installed controller, processing provenance, threshold performance, and behavioral novelty. Legacy threshold-only artifacts remain provisional. Matched mechanism ablations and isolated-search controls remain outstanding.</p>
        </div>
        <a class="paper-link" href="https://arxiv.org/abs/2608.26081" target="_blank" rel="noreferrer"><i class="hn hn-book"></i><span>READ THE PREPRINT<small>Pal, Wang & Buehler · MIT · 2026</small></span><i class="hn hn-external-link"></i></a>
      </div>

      <footer class="credits">
        <p>SIMULATION: P5.JS · EDGE STATE: CLOUDFLARE DURABLE OBJECTS · AGENT ROUTING: NULLCLAW EDGE POLICY + OPENROUTER/FREE</p>
        <p>PIXEL ICONS BY <a href="https://github.com/hackernoon/pixel-icon-library" target="_blank" rel="noreferrer">HACKERNOON</a>, USED UNMODIFIED UNDER <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a> · SILKSCREEN UNDER OFL 1.1</p>
      </footer>
    </article>
  </section>
`;

const client = new WorldClient();
const canvasHost = document.querySelector<HTMLElement>("#world-canvas")!;
const aboutPage = document.querySelector<HTMLElement>("#about-page")!;
const eventList = document.querySelector<HTMLElement>("#event-list")!;
const worldDiary = document.querySelector<HTMLElement>("#world-diary")!;
const engineStatus = document.querySelector<HTMLElement>("#engine-status")!;
const worldShell = document.querySelector<HTMLElement>(".world-shell")!;
const craftTreePage = document.querySelector<HTMLElement>("#craft-tree-page")!;
const craftTreeContent = document.querySelector<HTMLElement>("#craft-tree-content")!;
const craftTreeState = document.querySelector<HTMLElement>("#craft-tree-state")!;
const craftTreeStateTitle = document.querySelector<HTMLElement>("#craft-tree-state-title")!;
const craftTreeStateCopy = document.querySelector<HTMLElement>("#craft-tree-state-copy")!;
const craftGraphViewport = document.querySelector<HTMLElement>("#craft-graph-viewport")!;
const craftGraphStage = document.querySelector<HTMLElement>("#craft-graph-stage")!;
const craftGraphDetail = document.querySelector<HTMLElement>("#craft-graph-detail")!;
const craftGraphZoom = document.querySelector<HTMLOutputElement>("#craft-graph-zoom")!;
const craftTreeGrid = document.querySelector<HTMLElement>("#craft-tree-grid")!;
const craftTreeAnnouncement = document.querySelector<HTMLElement>("#craft-tree-announcement")!;
const craftTreeRetry = document.querySelector<HTMLButtonElement>("#craft-tree-retry")!;
const recentArtifactList = document.querySelector<HTMLElement>("#recent-artifact-list")!;
const eventPanel = document.querySelector<HTMLElement>(".event-panel")!;
const traceToggle = document.querySelector<HTMLButtonElement>("#trace-toggle")!;
const craftTreeButton = document.querySelector<HTMLButtonElement>("#craft-tree-button")!;
const craftTreeClose = document.querySelector<HTMLButtonElement>("#craft-tree-close")!;
const aboutButton = document.querySelector<HTMLButtonElement>("#about-button")!;
const aboutClose = document.querySelector<HTMLButtonElement>("#about-close")!;
const agentInspector = document.querySelector<HTMLElement>("#agent-inspector")!;
const agentInspectorContent = document.querySelector<HTMLElement>("#agent-inspector-content")!;
let selectedAgentId: string | null = null;
let latestSnapshot = client.snapshot;
let latestClientStatus: WorldClientStatus = client.status;
let craftProjectionKey = "";
let announcedDiscoveredPairings = -1;
let craftTreeReturnFocus: HTMLElement = craftTreeButton;
let selectedCraftGraphNodeId: string | null = null;
let craftGraphScale = 1;
let craftGraphX = 18;
let craftGraphY = 18;
let craftGraphWidth = 1_120;
let craftGraphHeight = 1_600;
let craftGraphDragging = false;
let craftGraphPointer = { x: 0, y: 0 };
let craftGraphHasFitted = false;
const longMemory = new Map<string, AgentLongMemory>();
const renderer = createWorldSketch(canvasHost, client.snapshot, selectAgent);
const mobileTrace = window.matchMedia("(max-width: 600px)");

function setTraceExpanded(expanded: boolean): void {
  eventPanel.classList.toggle("trace-expanded", expanded);
  worldShell.classList.toggle("trace-open", expanded && mobileTrace.matches);
  traceToggle.setAttribute("aria-expanded", String(expanded));
  traceToggle.setAttribute("aria-label", expanded ? "Collapse live trace" : "Expand live trace");
  traceToggle.textContent = expanded ? "CLOSE" : "OPEN";
}

setTraceExpanded(!mobileTrace.matches);
mobileTrace.addEventListener("change", (event) => setTraceExpanded(!event.matches));
traceToggle.addEventListener("click", () =>
  setTraceExpanded(!eventPanel.classList.contains("trace-expanded")),
);

function metric(id: string, value: string): void {
  const element = document.querySelector<HTMLElement>(`#${id}`);
  if (element) element.textContent = value;
}

function freshnessMarkup(nowTick: number, createdTick: number): string {
  const age = formatTickAge(nowTick, createdTick);
  return `<b class="freshness ${age.isNew ? "new" : ""}">${age.label}</b>`;
}

function eventMarkup(event: WorldEvent, newest: boolean, nowTick: number): string {
  const icon: Record<WorldEvent["kind"], string> = {
    discovery: "hn-location-pin",
    build: "hn-code-block",
    fork: "hn-code",
    repair: "hn-spinner",
    failure: "hn-times-circle",
    decision: "hn-sparkles",
    craft: "hn-code-block",
    creative: "hn-sparkles",
  };
  return `<div class="event ${newest ? "newest" : ""}"><i class="hn ${icon[event.kind]}"></i><p>${escapeHtml(event.text)}<span>T${event.tick.toLocaleString()} · ${freshnessMarkup(nowTick, event.tick)}</span></p></div>`;
}

function diaryMarkup(entry: WorldDiaryEntry | undefined): string {
  if (!entry) return "";
  const lines = entry.lines
    .slice(0, 5)
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join("");
  if (!lines) return "";
  return `<article class="diary-entry">
    <div><span><i class="hn hn-book"></i> WORLD DIARY</span><b>T${entry.startTick.toLocaleString()}–T${entry.endTick.toLocaleString()}</b></div>
    <ul>${lines}</ul>
  </article>`;
}

function escapeHtml(value: string): string {
  const element = document.createElement("span");
  element.textContent = value;
  return element.innerHTML;
}

function materialChip(material: MaterialKind): string {
  const visual = materialVisual[material];
  return `<span class="craft-material ${material}"><i class="hn ${visual.icon}"></i><b>${visual.rune}</b>${escapeHtml(material.toUpperCase())}</span>`;
}

function craftPairingMarkup(
  pairing: CraftTreePairing,
  agentCount: number,
  nowTick: number,
): string {
  const discovered = pairing.actions.length > 0;
  const active = pairing.attempts.length > 0;
  const state = active
    ? `${pairing.attempts.length} IN PROGRESS`
    : discovered
      ? "DISCOVERED"
      : "NO DISCOVERY";
  const actions = pairing.actions
    .map(
      ({ definition, knownBy }) => `<article class="craft-action">
        <div><strong>${escapeHtml(definition.icon)} ${escapeHtml(definition.name)}</strong><span>KNOWN BY ${knownBy} / ${agentCount}</span></div>
        <p>${escapeHtml(definition.algorithm)}</p>
        <code>${escapeHtml(definition.program.join(" → "))}</code>
        <small>${freshnessMarkup(nowTick, definition.createdTick)} · BUILT T${definition.createdTick.toLocaleString()} · ${escapeHtml(definition.authorId)} · ${definition.uses.toLocaleString()} USES</small>
      </article>`,
    )
    .join("");
  const attempts = pairing.attempts
    .map(
      (attempt) =>
        `<div class="craft-attempt"><span>${attempt.mode === "creative" ? "CREATIVE SESSION" : "KNOWN CRAFT"} · ${freshnessMarkup(nowTick, attempt.startedTick)}</span><strong>${escapeHtml(attempt.actionName)}</strong><p>${escapeHtml(attempt.purpose)}</p><small>SINCE T${attempt.startedTick.toLocaleString()} · ${escapeHtml(attempt.agentId)}</small></div>`,
    )
    .join("");
  return `<section class="craft-pairing ${discovered ? "discovered" : ""} ${active ? "active" : ""}">
    <header><div>${materialChip(pairing.ingredients[0])}<i>+</i>${materialChip(pairing.ingredients[1])}</div><span>${state}</span></header>
    ${actions || '<p class="craft-empty">NO DURABLE BEHAVIOR RECORDED</p>'}
    ${attempts}
  </section>`;
}

function applyCraftGraphTransform(): void {
  craftGraphStage.style.transform = `translate(${craftGraphX}px, ${craftGraphY}px) scale(${craftGraphScale})`;
  craftGraphZoom.value = `${Math.round(craftGraphScale * 100)}%`;
}

function setCraftGraphZoom(nextScale: number, anchorX?: number, anchorY?: number): void {
  const scale = Math.max(0.24, Math.min(1.8, nextScale));
  const x = anchorX ?? craftGraphViewport.clientWidth / 2;
  const y = anchorY ?? craftGraphViewport.clientHeight / 2;
  const worldX = (x - craftGraphX) / craftGraphScale;
  const worldY = (y - craftGraphY) / craftGraphScale;
  craftGraphX = x - worldX * scale;
  craftGraphY = y - worldY * scale;
  craftGraphScale = scale;
  applyCraftGraphTransform();
}

function fitCraftGraph(fitAll: boolean): void {
  const widthScale = (craftGraphViewport.clientWidth - 36) / craftGraphWidth;
  const heightScale = (craftGraphViewport.clientHeight - 36) / craftGraphHeight;
  const defaultScale =
    craftGraphViewport.clientWidth < 600 ? Math.max(0.58, widthScale) : widthScale;
  craftGraphScale = Math.max(
    0.24,
    Math.min(1.15, fitAll ? Math.min(widthScale, heightScale) : defaultScale),
  );
  craftGraphX = Math.max(
    18,
    (craftGraphViewport.clientWidth - craftGraphWidth * craftGraphScale) / 2,
  );
  craftGraphY = 18;
  applyCraftGraphTransform();
}

function craftGraphEdgePath(from: CraftGraphNode, to: CraftGraphNode): string {
  const x1 = from.x + from.width;
  const y1 = from.y + from.height / 2;
  const x2 = to.x;
  const y2 = to.y + to.height / 2;
  const bend = Math.max(54, (x2 - x1) * 0.46);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

function craftGraphNodeMarkup(
  node: CraftGraphNode,
  tree: ReturnType<typeof buildCraftTree>,
  snapshot: PublicWorldSnapshot,
): string {
  const style = `left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px`;
  if (node.kind === "material" && node.material) {
    const pairings = tree.pairings.filter((pairing) =>
      pairing.ingredients.includes(node.material!),
    );
    const discoveries = pairings.reduce((total, pairing) => total + pairing.actions.length, 0);
    return `<button class="craft-graph-node material" style="${style}" type="button" data-node-id="${node.id}" aria-label="${escapeHtml(node.material)}, ${discoveries} discovered skills">${materialChip(node.material)}<small>${discoveries} SKILLS · ${pairings.length} PAIRINGS</small></button>`;
  }
  const pairing = tree.pairings.find((candidate) => candidate.id === node.pairingId);
  if (!pairing) return "";
  if (node.kind === "pairing") {
    const status = pairing.attempts.length
      ? `${pairing.attempts.length} ACTIVE`
      : pairing.actions.length
        ? `${pairing.actions.length} DISCOVERED`
        : "OPEN";
    return `<button class="craft-graph-node pairing ${pairing.actions.length ? "discovered" : ""} ${pairing.attempts.length ? "active" : ""}" style="${style}" type="button" data-node-id="${node.id}" aria-label="${escapeHtml(pairing.ingredients.join(" plus "))}, ${status.toLowerCase()}"><span>${materialVisual[pairing.ingredients[0]].rune} + ${materialVisual[pairing.ingredients[1]].rune}</span><strong>${escapeHtml(pairing.ingredients.join(" + ").toUpperCase())}</strong><small>${status}</small></button>`;
  }
  const action = pairing.actions.find((candidate) => candidate.definition.id === node.actionId);
  if (!action) return "";
  const age = formatTickAge(snapshot.tick, action.definition.createdTick);
  return `<button class="craft-graph-node action" style="${style}" type="button" data-node-id="${node.id}" aria-label="${escapeHtml(action.definition.name)}, known by ${action.knownBy} agents"><span>${escapeHtml(action.definition.icon)} SKILL · ${age.label}</span><strong>${escapeHtml(action.definition.name)}</strong><small>KNOWN BY ${action.knownBy} / ${snapshot.agents.length} · ${action.definition.uses} USES</small></button>`;
}

function showCraftGraphDetail(
  nodeId: string,
  tree: ReturnType<typeof buildCraftTree>,
  snapshot: PublicWorldSnapshot,
): void {
  selectedCraftGraphNodeId = nodeId;
  for (const node of craftGraphStage.querySelectorAll<HTMLElement>(".craft-graph-node")) {
    const selected = node.dataset.nodeId === nodeId;
    node.classList.toggle("selected", selected);
    node.setAttribute("aria-pressed", String(selected));
  }
  if (nodeId.startsWith("material:")) {
    const material = nodeId.slice("material:".length) as MaterialKind;
    const pairings = tree.pairings.filter((pairing) => pairing.ingredients.includes(material));
    const discovered = pairings.filter((pairing) => pairing.actions.length > 0).length;
    craftGraphDetail.innerHTML = `<span>MATERIAL ROOT</span><strong>${materialChip(material)}</strong><p>${discovered} of ${pairings.length} connected pairings have produced durable skills.</p><small>SELECT A PAIRING TO FOLLOW ITS EXPERIMENTS.</small>`;
    return;
  }
  if (nodeId.startsWith("pairing:")) {
    const pairing = tree.pairings.find((candidate) => `pairing:${candidate.id}` === nodeId);
    if (!pairing) return;
    const skills = pairing.actions.length
      ? `<ul>${pairing.actions.map(({ definition }) => `<li>${escapeHtml(definition.icon)} ${escapeHtml(definition.name)}</li>`).join("")}</ul>`
      : "<p>No durable behavior has survived this pairing yet.</p>";
    craftGraphDetail.innerHTML = `<span>PAIRING · ${pairing.attempts.length} LIVE ATTEMPTS</span><strong>${materialChip(pairing.ingredients[0])}<i>+</i>${materialChip(pairing.ingredients[1])}</strong>${skills}<small>${pairing.actions.length} RECORDED SKILLS</small>`;
    return;
  }
  const actionId = nodeId.slice("action:".length);
  const action = tree.pairings
    .flatMap((pairing) => pairing.actions)
    .find((candidate) => candidate.definition.id === actionId);
  if (!action) return;
  craftGraphDetail.innerHTML = `<span>BOUNDED SKILL · ${freshnessMarkup(snapshot.tick, action.definition.createdTick)}</span><strong>${escapeHtml(action.definition.icon)} ${escapeHtml(action.definition.name)}</strong><p>${escapeHtml(action.definition.algorithm)}</p><code>${escapeHtml(action.definition.program.join(" → "))}</code><small>BUILT T${action.definition.createdTick.toLocaleString()} · ${escapeHtml(action.definition.authorId)} · KNOWN BY ${action.knownBy} / ${snapshot.agents.length} · ${action.definition.uses} USES</small>`;
}

function renderCraftGraph(
  tree: ReturnType<typeof buildCraftTree>,
  snapshot: PublicWorldSnapshot,
): void {
  const graph = buildCraftGraphLayout(tree);
  craftGraphWidth = graph.width;
  craftGraphHeight = graph.height;
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = graph.edges
    .map((edge) => {
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      if (!from || !to) return "";
      return `<path class="${edge.kind}" d="${craftGraphEdgePath(from, to)}"></path>`;
    })
    .join("");
  craftGraphStage.style.width = `${graph.width}px`;
  craftGraphStage.style.height = `${graph.height}px`;
  craftGraphStage.innerHTML = `<svg class="craft-graph-edges" width="${graph.width}" height="${graph.height}" viewBox="0 0 ${graph.width} ${graph.height}" aria-hidden="true">${edges}</svg>${graph.nodes.map((node) => craftGraphNodeMarkup(node, tree, snapshot)).join("")}`;
  for (const node of craftGraphStage.querySelectorAll<HTMLButtonElement>(".craft-graph-node")) {
    node.addEventListener("click", () =>
      showCraftGraphDetail(node.dataset.nodeId!, tree, snapshot),
    );
  }
  const selectedExists = selectedCraftGraphNodeId ? nodesById.has(selectedCraftGraphNodeId) : false;
  const defaultNode =
    graph.nodes.find((node) => node.kind === "action")?.id ??
    graph.nodes.find((node) => node.kind === "pairing")?.id;
  if (selectedExists && selectedCraftGraphNodeId)
    showCraftGraphDetail(selectedCraftGraphNodeId, tree, snapshot);
  else if (defaultNode) showCraftGraphDetail(defaultNode, tree, snapshot);
  if (!craftGraphHasFitted) {
    window.requestAnimationFrame(() => fitCraftGraph(false));
    craftGraphHasFitted = true;
  } else applyCraftGraphTransform();
}

function renderRecentArtifacts(snapshot: PublicWorldSnapshot): void {
  const artifacts = [...snapshot.artifacts].sort((a, b) => b.builtAt - a.builtAt).slice(0, 8);
  recentArtifactList.innerHTML =
    artifacts
      .map((artifact) => {
        const age = formatTickAge(snapshot.tick, artifact.builtAt);
        const failedValidation = Object.entries(artifact.validation ?? {})
          .filter(([, passed]) => !passed)
          .map(([gate]) => gate.replace(/([a-z])([A-Z])/gu, "$1 $2").toUpperCase());
        return `<article class="recent-artifact ${age.isNew ? "new" : ""}">
          <header><strong>${escapeHtml(artifact.name)}</strong>${freshnessMarkup(snapshot.tick, artifact.builtAt)}</header>
          <div>${materialChip(artifact.material)}<span>GEN ${artifact.generation}</span><span>${artifact.process ? `${escapeHtml(artifact.process.toUpperCase())} · ${escapeHtml(artifact.stationId ?? "STATION")}` : "LEGACY PROCESS UNRECORDED"}</span><span>${artifact.validated ? "STRICTLY VALIDATED" : "PROVISIONAL"}</span></div>
          ${artifact.specification ? `<p>${escapeHtml(artifact.specification.claimedFunction)}<br>${escapeHtml(artifact.specification.architecture)} · INSPIRED BY ${escapeHtml(artifact.specification.bioInspiration)}</p>` : ""}
          <p>${Math.round(artifact.performance * 100)}% PERFORMANCE · ${Math.round(artifact.health * 100)}% HEALTH</p>
          <p>REALIZED SERVICE ${Math.round((artifact.lastService ?? 0) * 100)}% NOW · ${Math.round((artifact.serviceEma ?? 0) * 100)}% RECENT<br>${artifact.serviceObservedTicks ? (((artifact.serviceIntegral ?? 0) / artifact.serviceObservedTicks) * 100).toFixed(1) : "0.0"} SERVICE UNITS / 100 TRACKED TICKS</p>
          <p>STORE ${artifact.storedWater?.toFixed(1) ?? "0.0"} WATER · RESERVE ${artifact.reserve?.toFixed(1) ?? "0.0"}<br>FLOW ${artifact.flux?.waterCollected.toFixed(1) ?? "0.0"} CAPTURED · ${artifact.flux?.contaminationRemoved.toFixed(1) ?? "0.0"} REMOVED · ${artifact.flux?.reserveConsumed.toFixed(1) ?? "0.0"} RESERVE USED</p>
          <small>${artifact.validated ? "ALL 6 VALIDATION GATES PASSED" : `MISSING ${failedValidation.join(" · ") || "VALIDATION EVIDENCE"}`}</small>
          <small>BUILT T${artifact.builtAt.toLocaleString()} · ${escapeHtml(artifact.creatorId)} · ${artifact.uses.toLocaleString()} USES</small>
        </article>`;
      })
      .join("") || '<p class="craft-empty">NO PHYSICAL ARTIFACTS YET</p>';
}

function craftTreeProjectionSignature(
  snapshot: PublicWorldSnapshot,
  tree: ReturnType<typeof buildCraftTree>,
): string {
  const artifacts = [...snapshot.artifacts]
    .sort((a, b) => b.builtAt - a.builtAt)
    .slice(0, 8)
    .map((artifact) => [
      artifact.id,
      artifact.uses,
      artifact.validated,
      artifact.process,
      artifact.stationId,
      artifact.specification,
      artifact.validation,
      artifact.lastService?.toFixed(2),
      artifact.serviceEma?.toFixed(2),
      artifact.serviceIntegral?.toFixed(1),
      artifact.serviceObservedTicks,
      artifact.storedWater?.toFixed(1),
      artifact.reserve?.toFixed(1),
      artifact.flux?.waterCollected.toFixed(1),
      artifact.flux?.contaminationRemoved.toFixed(1),
      artifact.flux?.reserveConsumed.toFixed(1),
      formatTickAge(snapshot.tick, artifact.builtAt).label,
    ]);
  return JSON.stringify({
    agents: snapshot.agents.length,
    pairings: tree.pairings.map((pairing) => [
      pairing.id,
      pairing.actions.map(({ definition, knownBy }) => [
        definition.id,
        definition.uses,
        knownBy,
        formatTickAge(snapshot.tick, definition.createdTick).label,
      ]),
      pairing.attempts.map((attempt) => [
        attempt.agentId,
        attempt.mode,
        attempt.actionName,
        attempt.purpose,
        attempt.startedTick,
        formatTickAge(snapshot.tick, attempt.startedTick).label,
      ]),
    ]),
    artifacts,
  });
}

function renderCraftTree(snapshot: PublicWorldSnapshot): void {
  const tree = buildCraftTree(snapshot);
  metric("craft-tree-tick", `TICK ${snapshot.tick.toLocaleString()}`);
  const projectionKey = craftTreeProjectionSignature(snapshot, tree);
  if (projectionKey === craftProjectionKey) return;
  craftProjectionKey = projectionKey;
  metric("craft-tree-pairings", String(tree.pairings.length));
  metric("craft-tree-discovered", `${tree.discoveredPairings} / ${tree.pairings.length}`);
  metric("craft-tree-actions", String(tree.discoveredActions));
  metric("craft-tree-attempts", String(tree.activeAttempts));
  renderCraftGraph(tree, snapshot);
  renderRecentArtifacts(snapshot);
  craftTreeGrid.innerHTML = craftMaterials
    .map((material, index) => {
      const pairings = tree.pairings.filter((pairing) => pairing.ingredients[0] === material);
      const discovered = pairings.filter((pairing) => pairing.actions.length > 0).length;
      return `<section class="craft-branch">
        <header><span>0${index + 1}</span>${materialChip(material)}<small>${discovered} / ${pairings.length} DISCOVERED</small></header>
        <div>${pairings.map((pairing) => craftPairingMarkup(pairing, snapshot.agents.length, snapshot.tick)).join("")}</div>
      </section>`;
    })
    .join("");
  if (announcedDiscoveredPairings !== tree.discoveredPairings) {
    craftTreeAnnouncement.textContent = `${tree.discoveredPairings} of ${tree.pairings.length} pairings discovered.`;
    announcedDiscoveredPairings = tree.discoveredPairings;
  }
}

function renderCraftTreeStatus(status: WorldClientStatus): void {
  latestClientStatus = status;
  const usableSnapshot = status === "authoritative" || status === "stale";
  craftTreeContent.hidden = !usableSnapshot;
  craftTreeState.hidden = status === "authoritative";
  craftTreeState.classList.toggle("compact", status === "stale");
  craftTreeRetry.hidden = status !== "fallback";
  if (status === "loading") {
    craftTreeStateTitle.textContent = "LOADING AUTHORITATIVE WORLD…";
    craftTreeStateCopy.textContent =
      "The Craft Tree will appear after the persistent world responds.";
  } else if (status === "fallback") {
    craftTreeStateTitle.textContent = "AUTHORITATIVE WORLD UNAVAILABLE";
    craftTreeStateCopy.textContent =
      "A local fallback simulation is running, but it is not shown as persistent world knowledge.";
  } else if (status === "stale") {
    craftTreeStateTitle.textContent = "SHOWING LAST AUTHORITATIVE SNAPSHOT";
    craftTreeStateCopy.textContent = "Live updates are interrupted. Reconnecting automatically…";
  }
  if (craftTreePage.classList.contains("visible") && usableSnapshot) {
    craftProjectionKey = "";
    renderCraftTree(latestSnapshot);
  }
}

function inventoryMarkup(agent: Agent): string {
  return Object.entries(agent.inventory)
    .map(([material, amount]) => {
      const visual = materialVisual[material as MaterialKind];
      const purpose = agent.materialPurposes?.[material as MaterialKind];
      return `<div class="${purpose ? "reserved" : ""}"><span><i class="hn ${visual.icon}"></i><b>${visual.rune}</b>${escapeHtml(material.toUpperCase())}${purpose ? "<em>RESERVED</em>" : ""}</span><strong>${Math.round(amount * 10) / 10}</strong></div>`;
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
  const curiosity = Math.round((agent.curiosity ?? 0) * 100);
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
    <div class="agent-state curiosity-state"><span>CURIOSITY</span><span>${curiosity}%${agent.craftingTarget ? " · UNSATISFIED" : ""}</span></div>
    <div class="energy-track curiosity-track" aria-label="Curiosity ${curiosity} percent"><i style="width:${curiosity}%"></i></div>
    ${
      agent.craftingTarget
        ? `<div class="agent-directive crafting-commitment">
      <span>${agent.craftingTarget.mode === "creative" ? "CREATIVE SESSION" : "CRAFTING COMMITMENT"} · ${freshnessMarkup(snapshot.tick, agent.craftingTarget.startedTick)} · SINCE T${agent.craftingTarget.startedTick}</span>
      <strong>${escapeHtml(agent.craftingTarget.ingredients.join(" + ").toUpperCase())} → ${escapeHtml(agent.craftingTarget.actionName.toUpperCase())}</strong>
      <p>${escapeHtml(agent.craftingTarget.purpose)}</p>
      <small>RESERVED MATERIALS STAY PURPOSE-BOUND UNTIL BUILT</small>
    </div>`
        : ""
    }
    <div class="agent-directive">
      <span>${agent.directive.source === "openrouter" ? "OPENROUTER DIRECTIVE" : "LOCAL DIRECTIVE"}</span>
      <strong>${escapeHtml(agent.directive.goal.toUpperCase())} · ${escapeHtml(agent.directive.targetMaterial.toUpperCase())}</strong>
      <p>${escapeHtml(agent.directive.note)}</p>
      <small>${escapeHtml(agent.directive.controllerAction.toUpperCase())}${agent.directive.model ? ` · ${escapeHtml(agent.directive.model)}` : ""}</small>
    </div>
    <div class="agent-directive agent-program">
      <span>ACTION SANDBOX · SCRIPT R${agent.script.revision} · T${agent.script.updatedTick}${action && action.createdTick > 0 ? ` · ${freshnessMarkup(snapshot.tick, action.createdTick)}` : ""}</span>
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
      <div><span>CRAFTS</span><strong>${agent.crafts ?? 0}</strong></div>
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
    if (mobileTrace.matches) setTraceExpanded(false);
    renderAgentInspector(latestSnapshot);
    void loadLongMemory(agentId);
  }
}

function renderChrome(snapshot: PublicWorldSnapshot): void {
  latestSnapshot = snapshot;
  renderer.update(snapshot);
  renderAgentInspector(snapshot);
  if (
    craftTreePage.classList.contains("visible") &&
    (latestClientStatus === "authoritative" || latestClientStatus === "stale")
  )
    renderCraftTree(snapshot);
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
  worldDiary.innerHTML = diaryMarkup(snapshot.diary?.[0]);
  eventList.innerHTML =
    snapshot.events
      .slice(0, 5)
      .map((event, index) => eventMarkup(event, index === 0, snapshot.tick))
      .join("") || '<p class="quiet">The first agents are mapping the planet…</p>';
  const assisted = snapshot.engine.mode === "openrouter-assisted";
  engineStatus.classList.toggle("assisted", assisted);
  engineStatus.innerHTML = `<b></b> ${assisted ? "OPENROUTER/FREE" : "DETERMINISTIC SEED"} · NULLCLAW SANDBOX`;
}

function showAbout(show: boolean, updateHistory = true): void {
  if (show) {
    selectAgent(null);
    showCraftTree(false, false);
    worldShell.inert = true;
    worldShell.setAttribute("aria-hidden", "true");
    aboutPage.inert = false;
  }
  aboutPage.classList.toggle("visible", show);
  aboutPage.setAttribute("aria-hidden", String(!show));
  document.body.classList.toggle("about-open", show);
  if (show) window.requestAnimationFrame(() => aboutClose.focus());
  else {
    aboutPage.inert = true;
    if (!craftTreePage.classList.contains("visible")) {
      worldShell.inert = false;
      worldShell.removeAttribute("aria-hidden");
    }
  }
  if (updateHistory) history.pushState({ about: show }, "", show ? "/about" : "/");
}

function showCraftTree(show: boolean, updateHistory = true): void {
  const wasVisible = craftTreePage.classList.contains("visible");
  if (show) {
    if (!wasVisible) craftGraphHasFitted = false;
    if (
      !wasVisible &&
      document.activeElement instanceof HTMLElement &&
      worldShell.contains(document.activeElement)
    )
      craftTreeReturnFocus = document.activeElement;
    else if (!wasVisible) craftTreeReturnFocus = craftTreeButton;
    selectAgent(null);
    showAbout(false, false);
    craftTreePage.scrollTop = 0;
    worldShell.inert = true;
    worldShell.setAttribute("aria-hidden", "true");
    aboutPage.inert = true;
    craftTreePage.inert = false;
  }
  craftTreePage.classList.toggle("visible", show);
  craftTreePage.setAttribute("aria-hidden", String(!show));
  document.body.classList.toggle("craft-tree-open", show);
  if (show) {
    renderCraftTreeStatus(latestClientStatus);
    if (latestClientStatus === "authoritative" || latestClientStatus === "stale") {
      craftProjectionKey = "";
      renderCraftTree(latestSnapshot);
    }
    window.requestAnimationFrame(() => craftTreeClose.focus());
  } else {
    craftTreePage.inert = true;
    worldShell.inert = false;
    worldShell.removeAttribute("aria-hidden");
    if (wasVisible) window.requestAnimationFrame(() => craftTreeReturnFocus.focus());
  }
  if (updateHistory) history.pushState({ craftTree: show }, "", show ? "/craft-tree" : "/");
}

function syncPageFromLocation(): void {
  if (location.pathname === "/craft-tree") {
    showAbout(false, false);
    showCraftTree(true, false);
  } else if (location.pathname === "/about") {
    showCraftTree(false, false);
    showAbout(true, false);
  } else {
    showAbout(false, false);
    showCraftTree(false, false);
  }
}

aboutButton.addEventListener("click", () => showAbout(true));
aboutClose.addEventListener("click", () => {
  showAbout(false);
  window.requestAnimationFrame(() => aboutButton.focus());
});
craftTreeButton.addEventListener("click", () => showCraftTree(true));
craftTreeClose.addEventListener("click", () => showCraftTree(false));
craftTreeRetry.addEventListener("click", () => void client.retry());
document
  .querySelector("#craft-graph-zoom-out")
  ?.addEventListener("click", () => setCraftGraphZoom(craftGraphScale / 1.2));
document
  .querySelector("#craft-graph-zoom-in")
  ?.addEventListener("click", () => setCraftGraphZoom(craftGraphScale * 1.2));
document.querySelector("#craft-graph-fit")?.addEventListener("click", () => fitCraftGraph(true));
craftGraphViewport.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const bounds = craftGraphViewport.getBoundingClientRect();
    setCraftGraphZoom(
      craftGraphScale * (event.deltaY > 0 ? 0.9 : 1.1),
      event.clientX - bounds.left,
      event.clientY - bounds.top,
    );
  },
  { passive: false },
);
craftGraphViewport.addEventListener("pointerdown", (event) => {
  if ((event.target as Element).closest(".craft-graph-node")) return;
  craftGraphDragging = true;
  craftGraphPointer = { x: event.clientX, y: event.clientY };
  craftGraphViewport.classList.add("dragging");
  craftGraphViewport.setPointerCapture(event.pointerId);
});
craftGraphViewport.addEventListener("pointermove", (event) => {
  if (!craftGraphDragging) return;
  craftGraphX += event.clientX - craftGraphPointer.x;
  craftGraphY += event.clientY - craftGraphPointer.y;
  craftGraphPointer = { x: event.clientX, y: event.clientY };
  applyCraftGraphTransform();
});
const stopCraftGraphDrag = (event: PointerEvent): void => {
  if (!craftGraphDragging) return;
  craftGraphDragging = false;
  craftGraphViewport.classList.remove("dragging");
  if (craftGraphViewport.hasPointerCapture(event.pointerId))
    craftGraphViewport.releasePointerCapture(event.pointerId);
};
craftGraphViewport.addEventListener("pointerup", stopCraftGraphDrag);
craftGraphViewport.addEventListener("pointercancel", stopCraftGraphDrag);
craftGraphViewport.addEventListener("keydown", (event) => {
  if (event.key === "+" || event.key === "=") setCraftGraphZoom(craftGraphScale * 1.2);
  else if (event.key === "-") setCraftGraphZoom(craftGraphScale / 1.2);
  else if (event.key === "0") fitCraftGraph(true);
  else if (event.key === "ArrowLeft") craftGraphX += 32;
  else if (event.key === "ArrowRight") craftGraphX -= 32;
  else if (event.key === "ArrowUp") craftGraphY += 32;
  else if (event.key === "ArrowDown") craftGraphY -= 32;
  else return;
  event.preventDefault();
  applyCraftGraphTransform();
});
document
  .querySelector("#agent-inspector-close")
  ?.addEventListener("click", () => selectAgent(null));
window.addEventListener("popstate", syncPageFromLocation);
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (selectedAgentId) selectAgent(null);
  else if (aboutPage.classList.contains("visible")) showAbout(false);
  else if (craftTreePage.classList.contains("visible")) showCraftTree(false);
});
window.addEventListener("beforeunload", () => {
  client.dispose();
  renderer.remove();
});
window.addEventListener("load", () => {
  if (craftTreePage.classList.contains("visible")) craftTreeClose.focus();
});
window.addEventListener("resize", () => {
  if (craftTreePage.classList.contains("visible")) fitCraftGraph(false);
});

client.subscribe(renderChrome);
client.subscribeStatus(renderCraftTreeStatus);
void client.connect();
syncPageFromLocation();
