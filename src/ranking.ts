import "@hackernoon/pixel-icon-library/fonts/iconfont.css";
import "./style.css";
import "./ranking.css";
import { botPortraitSvg } from "./sim/bot-appearance";
import { advanceWorld, createInitialWorld } from "./sim/engine";
import {
  computeHierarchy,
  DEFERENCE_WEIGHTS,
  HIERARCHY_MIN_EDGES,
  HIERARCHY_MIN_TRIADS,
  HIERARCHY_NULL_SAMPLES,
  HIERARCHY_SNAPSHOT_INTERVAL_TICKS,
  type DeferenceRelation,
  type HierarchyApiResponse,
  type HierarchyHistory,
  type HierarchyHistoryPoint,
  type HierarchyReport,
  type RankedAgent,
} from "./sim/hierarchy";
import { MAX_ARTIFACT_FOSSILS, MAX_SKILL_FOSSILS } from "./sim/pruning";
import type { WorldState } from "./sim/types";

type PageMode = "loading" | "authoritative" | "stale" | "fallback";

const relationLabels: Record<DeferenceRelation, string> = {
  adopt: "USED",
  inspect: "MEASURED",
  maintain: "REPAIRED",
  fork: "FORKED",
  lineage: "LINEAGE",
  learn: "LEARNED",
};

const root = document.querySelector<HTMLDivElement>("#ranking")!;

root.innerHTML = `
  <section class="ranking-page">
    <nav class="ranking-nav">
      <a class="wordmark" href="/" aria-label="Stigmergy, return to the world"><span class="sigil" aria-hidden="true"><i></i><i></i><i></i></span><span>STIGMERGY</span></a>
      <div><span id="ranking-tick">TICK —</span><a class="pixel-button dark" href="/"><i class="hn hn-times"></i> RETURN TO WORLD</a></div>
    </nav>
    <section id="ranking-state" class="ranking-state" role="status" aria-live="polite">
      <i class="hn hn-spinner"></i><strong id="ranking-state-title">LOADING AUTHORITATIVE WORLD…</strong><p id="ranking-state-copy">The ranking appears after the persistent world responds.</p><button id="ranking-retry" class="pixel-button" type="button" hidden>RETRY CONNECTION</button>
    </section>
    <article id="ranking-content" class="ranking-content" hidden>
      <header class="ranking-hero">
        <div>
          <p class="eyebrow">SOCIAL STRUCTURE · MEASURED, NEVER ASSIGNED</p>
          <h1>WHO DEFERS<br><em>TO WHOM</em></h1>
          <p>Each link is an act: one bot used, measured, repaired, forked, or learned another bot’s work. Prestige follows those links. Nobody assigns rank, and no bot can see this page.</p>
        </div>
        <dl class="ranking-summary">
          <div><dt>DEFERENCE LINKS</dt><dd id="summary-links">—</dd><small id="summary-links-note"></small></div>
          <div><dt>PRESTIGE GINI</dt><dd id="summary-gini">—</dd><small id="summary-gini-note"></small></div>
          <div><dt>TOP 10% SHARE</dt><dd id="summary-top">—</dd><small id="summary-top-note"></small></div>
          <div><dt>TRANSITIVITY</dt><dd id="summary-transitivity">—</dd><small id="summary-transitivity-note"></small></div>
        </dl>
      </header>
      <p id="ranking-verdict" class="ranking-verdict"></p>

      <section class="ranking-section" aria-labelledby="ranking-history-title">
        <header><div><span>OVER TIME</span><strong id="ranking-history-title">IS A HIERARCHY FORMING?</strong></div><small id="ranking-history-meta"></small></header>
        <div id="ranking-history" class="ranking-history"></div>
      </section>

      <section class="ranking-section" aria-labelledby="ranking-table-title">
        <header><div><span>NOW</span><strong id="ranking-table-title">PRESTIGE RANKING</strong></div><small id="ranking-table-meta"></small></header>
        <div id="ranking-distribution" class="ranking-distribution"></div>
        <div id="ranking-empty" class="ranking-empty" hidden></div>
        <div class="ranking-table-wrap"><table class="ranking-table"><caption class="sr-only">Bots ordered by measured prestige</caption><thead><tr><th scope="col">RANK</th><th scope="col">BOT</th><th scope="col">PRESTIGE</th><th scope="col">DEFERRED TO BY</th><th scope="col">WHY</th><th scope="col">DEFERS TO</th><th scope="col">MADE</th><th scope="col">HEARD BY <small>NOT RANKED</small></th></tr></thead><tbody id="ranking-rows"></tbody></table></div>
        <button id="ranking-more" class="pixel-button" type="button" hidden></button>
      </section>

      <section class="ranking-notes" aria-labelledby="ranking-notes-title">
        <h2 id="ranking-notes-title">HOW TO READ THIS</h2>
        <div>
          <section><h3>THE LINKS</h3><p>A link from bot A to bot B means A acted on B’s work. Using or inspecting B’s artifact counts ${DEFERENCE_WEIGHTS.adopt}, measuring its service adds ${DEFERENCE_WEIGHTS.inspect}, and repairing it adds ${DEFERENCE_WEIGHTS.maintain}. Forking B’s artifact counts ${DEFERENCE_WEIGHTS.fork}, and older authors in that lineage get ${DEFERENCE_WEIGHTS.lineage}. Learning a skill B authored counts ${DEFERENCE_WEIGHTS.learn}, because the learner spends two gathered materials on it.</p></section>
          <section><h3>PRESTIGE</h3><p>Prestige is PageRank over those links. A link from a bot that others defer to carries more prestige than a link from a bot nobody follows. 1.00 is an equal share. A bot with no incoming links sits at the floor and gets no rank number.</p></section>
          <section><h3>CHANCE</h3><p>Gini and top 10% share measure prestige above the floor. To test them, the page keeps every bot’s outgoing links and re-aims each one at a random bot, ${HIERARCHY_NULL_SAMPLES} times with a fixed seed. Concentration counts as beyond chance when fewer than 5% of those shuffles reach the real Gini (p < 0.05). Chance here ignores geography: a bot camped beside a busy station collects links without anyone choosing it.</p></section>
          <section><h3>A LADDER OR A CROWD</h3><p>Transitivity checks every trio of bots whose pairs all lean one way. 1 means a strict ladder (if A defers to B and B to C, A defers to C), 0 means random direction, and below 0 means cycles. Concentration plus high transitivity is what a hierarchy looks like.</p></section>
          <section><h3>NOT ENOUGH DATA</h3><p>Below ${HIERARCHY_MIN_EDGES} links the page shows no ranking, and below ${HIERARCHY_MIN_TRIADS} fully resolved trios it shows no transitivity. A blank means the world has not produced the evidence yet; it never means zero.</p></section>
          <section><h3>SPEECH IS NOT RANKED</h3><p>Bots address the nearest bot, recipients cannot refuse a message, and nothing in the world records whether a listener acted on it. Heard-by counts stay visible for context and never feed prestige.</p></section>
          <section><h3>BOTS NEVER SEE THIS</h3><p>Rank stays out of every bot’s observation, memory, and model prompt. The measurement only reads the world, so it cannot create the hierarchy it measures.</p></section>
          <section><h3>WHAT THE WORLD FORGETS</h3><p>The world erodes dead artifacts nobody touches, bots forget skills they stop using, and a skill nobody knows goes extinct. Their links still count: the ranking reads the fossil archive, which keeps the newest ${MAX_ARTIFACT_FOSSILS} eroded artifacts with their users, inspectors, repairers, and forks, and the newest ${MAX_SKILL_FOSSILS} extinct skills with every bot that once knew them. A bot that learned a living skill and later forgot it still counts as a learner. Only fossils pushed out of the archive drop out. History starts when tracking was deployed. The first snapshot is a labeled baseline of that moment, which already includes links built before tracking began.</p></section>
        </div>
      </section>
    </article>
  </section>
`;

const tickLabel = document.querySelector<HTMLElement>("#ranking-tick")!;
const state = document.querySelector<HTMLElement>("#ranking-state")!;
const stateTitle = document.querySelector<HTMLElement>("#ranking-state-title")!;
const stateCopy = document.querySelector<HTMLElement>("#ranking-state-copy")!;
const retryButton = document.querySelector<HTMLButtonElement>("#ranking-retry")!;
const content = document.querySelector<HTMLElement>("#ranking-content")!;
const verdict = document.querySelector<HTMLElement>("#ranking-verdict")!;
const historyHost = document.querySelector<HTMLElement>("#ranking-history")!;
const historyMeta = document.querySelector<HTMLElement>("#ranking-history-meta")!;
const tableMeta = document.querySelector<HTMLElement>("#ranking-table-meta")!;
const distribution = document.querySelector<HTMLElement>("#ranking-distribution")!;
const empty = document.querySelector<HTMLElement>("#ranking-empty")!;
const rows = document.querySelector<HTMLElement>("#ranking-rows")!;
const moreButton = document.querySelector<HTMLButtonElement>("#ranking-more")!;

const COLLAPSED_ROWS = 25;
let mode: PageMode = "loading";
let showAllRows = false;
let latest: { report: HierarchyReport; history?: HierarchyHistory } | undefined;
let fallbackWorld: WorldState | undefined;
let fallbackTimer: number | undefined;

function escapeHtml(value: string): string {
  const element = document.createElement("span");
  element.textContent = value;
  return element.innerHTML;
}

function text(id: string, value: string): void {
  const element = document.querySelector<HTMLElement>(`#${id}`);
  if (element) element.textContent = value;
}

const fixed = (value: number | undefined, digits = 2) =>
  value === undefined ? "—" : value.toFixed(digits);
const percent = (value: number | undefined) =>
  value === undefined ? "—" : `${Math.round(value * 100)}%`;

function renderState(): void {
  const showBanner = mode !== "authoritative";
  state.hidden = !showBanner;
  state.classList.toggle("compact", Boolean(latest));
  retryButton.hidden = mode !== "fallback" && mode !== "stale";
  content.hidden = !latest;
  if (mode === "loading") {
    stateTitle.textContent = "LOADING AUTHORITATIVE WORLD…";
    stateCopy.textContent = "The ranking appears after the persistent world responds.";
  } else if (mode === "fallback") {
    stateTitle.textContent = "LOCAL FALLBACK";
    stateCopy.textContent =
      "The persistent world did not answer. This ranking comes from a local simulation in your browser, and history is unavailable.";
  } else if (mode === "stale") {
    stateTitle.textContent = "CONNECTION LOST";
    stateCopy.textContent = `Showing the last ranking received, from tick ${latest?.report.tick.toLocaleString() ?? "—"}.`;
  }
}

function renderSummary(report: HierarchyReport): void {
  const { metrics } = report;
  const nullModel = metrics.nullModel;
  text("summary-links", metrics.deferenceEdges.toLocaleString());
  text(
    "summary-links-note",
    `${metrics.deferringAgents} BOTS DEFER · ${metrics.deferredToAgents} RECEIVE`,
  );
  text("summary-gini", fixed(metrics.prestigeGini));
  text(
    "summary-gini-note",
    nullModel
      ? `CHANCE ≤ ${nullModel.giniP95.toFixed(2)} · p = ${nullModel.giniPValue.toFixed(2)}`
      : "INSUFFICIENT DATA",
  );
  text("summary-top", percent(metrics.topDecileShare));
  text(
    "summary-top-note",
    nullModel ? `CHANCE ≤ ${percent(nullModel.topDecileP95)}` : "INSUFFICIENT DATA",
  );
  text("summary-transitivity", fixed(metrics.transitivity));
  text(
    "summary-transitivity-note",
    metrics.transitivity === undefined
      ? `INSUFFICIENT DATA · ${metrics.completeTriads} TRIOS`
      : `${metrics.transitiveTriads} / ${metrics.completeTriads} TRIOS ORDERED`,
  );
}

function verdictMarkup(report: HierarchyReport): string {
  const { metrics } = report;
  if (metrics.insufficient.concentration || !metrics.nullModel)
    return `<b>INSUFFICIENT DATA</b> ${escapeHtml(metrics.insufficient.concentration ?? "no concentration measure")}. The page will rank bots once the world produces enough links.`;
  const nullModel = metrics.nullModel;
  const gini = `Prestige Gini ${fixed(metrics.prestigeGini)} against chance ≤ ${nullModel.giniP95.toFixed(2)} (p = ${nullModel.giniPValue.toFixed(2)}).`;
  const ladder =
    metrics.transitivity === undefined
      ? "Too few resolved trios to tell whether it forms a ladder."
      : metrics.transitivity >= 0.5
        ? `Deference also runs one way down a ladder (transitivity ${fixed(metrics.transitivity)}).`
        : `Deference does not form a consistent ladder (transitivity ${fixed(metrics.transitivity)}).`;
  return nullModel.exceedsChance
    ? `<b class="signal">CONCENTRATED BEYOND CHANCE</b> ${gini} A few bots collect more deference than random aim would give them. ${ladder}`
    : `<b>WITHIN CHANCE</b> ${gini} Deference is no more concentrated than random aim would produce. ${ladder}`;
}

interface ChartSeries {
  label: string;
  className: string;
  values: Array<number | undefined>;
}

/** Charts take their real pixel width, so 10px labels stay 10px at any size. */
function chartSvg(
  width: number,
  ticks: number[],
  series: ChartSeries[],
  domain: [number, number],
  references: Array<{ value: number; label: string }>,
  format: (value: number) => string,
  label: string,
): string {
  const height = 180;
  const left = 46;
  const right = 14;
  const top = 12;
  const bottom = 26;
  const [low, high] = domain[1] > domain[0] ? domain : [domain[0], domain[0] + 1];
  const first = ticks[0] ?? 0;
  const last = ticks.at(-1) ?? first;
  const x = (tick: number) =>
    last === first
      ? (left + width - right) / 2
      : left + ((tick - first) / (last - first)) * (width - left - right);
  const y = (value: number) => top + (1 - (value - low) / (high - low)) * (height - top - bottom);
  const grid = [low, (low + high) / 2, high]
    .map(
      (value) =>
        `<line class="grid" x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}"/><text class="axis" x="${left - 6}" y="${y(value) + 3}" text-anchor="end">${format(value)}</text>`,
    )
    .join("");
  const refs = references
    .filter((reference) => reference.value >= low && reference.value <= high)
    .map(
      (reference) =>
        `<line class="reference" x1="${left}" x2="${width - right}" y1="${y(reference.value)}" y2="${y(reference.value)}"/><text class="reference-label" x="${width - right - 2}" y="${y(reference.value) - 4}" text-anchor="end">${reference.label}</text>`,
    )
    .join("");
  const lines = series
    .map((line) => {
      let path = "";
      let pen = false;
      const marks: string[] = [];
      line.values.forEach((value, position) => {
        if (value === undefined || !Number.isFinite(value)) {
          pen = false;
          return;
        }
        const px = x(ticks[position]!);
        const py = y(Math.min(high, Math.max(low, value)));
        path += `${pen ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)} `;
        pen = true;
        if (line.values.length <= 48 || position === line.values.length - 1)
          marks.push(
            `<rect x="${(px - 2.5).toFixed(1)}" y="${(py - 2.5).toFixed(1)}" width="5" height="5"/>`,
          );
      });
      return `<g class="series ${line.className}">${path ? `<path d="${path.trim()}"/>` : ""}${marks.join("")}</g>`;
    })
    .join("");
  const xLabels =
    ticks.length > 1
      ? `<text class="axis" x="${left}" y="${height - 8}">T${first.toLocaleString()}</text><text class="axis" x="${width - right}" y="${height - 8}" text-anchor="end">T${last.toLocaleString()}</text>`
      : `<text class="axis" x="${(left + width - right) / 2}" y="${height - 8}" text-anchor="middle">T${first.toLocaleString()}</text>`;
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)}">${grid}${refs}${lines}${xLabels}</svg>`;
}

function chartCard(
  title: string,
  note: string,
  svg: string,
  legend: Array<{ label: string; className: string }>,
  wide = false,
): string {
  return `<figure class="ranking-chart${wide ? " wide" : ""}"><figcaption><strong>${title}</strong><span>${note}</span></figcaption>${svg}<div class="ranking-legend">${legend.map((item) => `<span class="${item.className}"><i></i>${item.label}</span>`).join("")}</div></figure>`;
}

function leaderRuns(points: HierarchyHistoryPoint[]): string {
  const runs: Array<{ id: string; count: number }> = [];
  for (const point of points) {
    const id = point.leaders[0]?.id;
    if (!id) continue;
    const last = runs.at(-1);
    if (last?.id === id) last.count += 1;
    else runs.push({ id, count: 1 });
  }
  if (!runs.length) return "No snapshot has had a ranked leader yet.";
  const recent = runs.slice(-5);
  return `${runs.length === 1 ? "One leader so far" : `${runs.length} leadership changes`}: ${recent
    .map((run) => `${escapeHtml(run.id)} ×${run.count}`)
    .join(" → ")}${runs.length > recent.length ? " (latest five)" : ""}.`;
}

function renderHistory(history: HierarchyHistory | undefined, report: HierarchyReport): void {
  if (!history) {
    historyMeta.textContent = "UNAVAILABLE IN LOCAL FALLBACK";
    historyHost.innerHTML = `<p class="ranking-quiet">History lives in the persistent world, which records a snapshot every ${HIERARCHY_SNAPSHOT_INTERVAL_TICKS} ticks. This page could not reach it, so it shows only the local ranking below.</p>`;
    return;
  }
  const points = history.points;
  const nextTick = (points.at(-1)?.tick ?? report.tick) + history.intervalTicks;
  historyMeta.textContent = points.length
    ? `TRACKING SINCE T${(history.startedTick ?? points[0]!.tick).toLocaleString()} · ${points.length} SNAPSHOT${points.length === 1 ? "" : "S"} · EVERY ${history.intervalTicks} TICKS · NEXT T${nextTick.toLocaleString()}`
    : "NO SNAPSHOTS YET";
  if (!points.length) {
    historyHost.innerHTML = `<p class="ranking-quiet">The first snapshot is written on the next world tick.</p>`;
    return;
  }
  const ticks = points.map((point) => point.tick);
  const baseline =
    points[0]!.kind === "baseline"
      ? `<p class="ranking-quiet">The first point is a baseline taken when tracking began at T${points[0]!.tick.toLocaleString()}. It includes links that formed before that moment; nothing earlier is reconstructed.</p>`
      : "";
  const maxLinks = Math.max(1, ...points.map((point) => point.deferenceEdges));
  const maxGeneration = Math.max(1, ...points.map((point) => point.lineageMaxGeneration ?? 0));
  const transitivityLow = Math.min(-1, ...points.map((point) => point.transitivity ?? 0));
  const two = (value: number) => value.toFixed(2);
  const share = (value: number) => `${Math.round(value * 100)}%`;
  const whole = (value: number) => Math.round(value).toLocaleString();
  // Mirrors the chart grid in ranking.css: 3 + 2 columns, one column at 900px.
  const narrow = window.matchMedia("(max-width: 900px)").matches;
  const hostWidth = historyHost.clientWidth || 1200;
  const wide = Math.max(240, Math.floor((narrow ? hostWidth : hostWidth / 2) - 32));
  const regular = Math.max(240, Math.floor((narrow ? hostWidth : hostWidth / 3) - 32));
  historyHost.innerHTML = `${baseline}<div class="ranking-charts">${[
    chartCard(
      "PRESTIGE GINI",
      "0 = equal · 1 = one bot holds all",
      chartSvg(
        wide,
        ticks,
        [
          {
            label: "chance",
            className: "chance",
            values: points.map((point) => point.nullGiniP95),
          },
          {
            label: "measured",
            className: "measured",
            values: points.map((point) => point.prestigeGini),
          },
        ],
        [0, 1],
        [],
        two,
        "Prestige Gini over time against the chance ceiling",
      ),
      [
        { label: "MEASURED", className: "measured" },
        { label: "CHANCE 95TH PCT", className: "chance" },
      ],
      true,
    ),
    chartCard(
      "TOP 10% SHARE",
      "share of earned prestige",
      chartSvg(
        wide,
        ticks,
        [
          {
            label: "chance",
            className: "chance",
            values: points.map((point) => point.nullTopDecileP95),
          },
          {
            label: "measured",
            className: "measured",
            values: points.map((point) => point.topDecileShare),
          },
        ],
        [0, 1],
        [{ value: 0.1, label: "EQUAL" }],
        share,
        "Top ten percent share of prestige over time against the chance ceiling",
      ),
      [
        { label: "MEASURED", className: "measured" },
        { label: "CHANCE 95TH PCT", className: "chance" },
      ],
      true,
    ),
    chartCard(
      "TRANSITIVITY",
      "1 = ladder · 0 = random · <0 = cycles",
      chartSvg(
        regular,
        ticks,
        [
          {
            label: "transitivity",
            className: "ladder",
            values: points.map((point) => point.transitivity),
          },
        ],
        [transitivityLow, 1],
        [{ value: 0, label: "RANDOM" }],
        two,
        "Triad transitivity over time",
      ),
      [{ label: "MEASURED", className: "ladder" }],
    ),
    chartCard(
      "LINEAGE DEPTH",
      "deepest fork generation alive",
      chartSvg(
        regular,
        ticks,
        [
          {
            label: "generation",
            className: "lineage",
            values: points.map((point) => point.lineageMaxGeneration),
          },
        ],
        [0, maxGeneration],
        [],
        whole,
        "Deepest artifact fork generation over time",
      ),
      [{ label: "MAX GENERATION", className: "lineage" }],
    ),
    chartCard(
      "DEFERENCE LINKS",
      "distinct bot-to-bot links",
      chartSvg(
        regular,
        ticks,
        [
          {
            label: "links",
            className: "links",
            values: points.map((point) => point.deferenceEdges),
          },
        ],
        [0, maxLinks],
        [],
        whole,
        "Deference links over time",
      ),
      [{ label: "LINKS", className: "links" }],
    ),
  ].join("")}</div><p class="ranking-quiet">${leaderRuns(points)}</p>`;
}

function distributionSvg(report: HierarchyReport): string {
  const width = Math.max(240, (distribution.clientWidth || 1200) - 36);
  const height = 96;
  const values = report.agents.map((agent) => agent.prestige);
  const max = Math.max(1, ...values);
  const slot = width / Math.max(1, values.length);
  const y = (value: number) => height - 14 - (value / max) * (height - 22);
  const bars = report.agents
    .map((agent, position) => {
      const top = y(agent.prestige);
      return `<rect class="${agent.rank === undefined ? "floor" : "ranked"}" x="${(position * slot + 0.5).toFixed(1)}" y="${top.toFixed(1)}" width="${Math.max(1, slot - 1).toFixed(1)}" height="${(height - 14 - top).toFixed(1)}"/>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Prestige of every bot, highest first">${bars}<line class="reference" x1="0" x2="${width}" y1="${y(1).toFixed(1)}" y2="${y(1).toFixed(1)}"/><text class="reference-label" x="${width - 2}" y="${(y(1) - 4).toFixed(1)}" text-anchor="end">EQUAL SHARE 1.00</text><text class="axis" x="0" y="${height - 2}">HIGHEST</text><text class="axis" x="${width}" y="${height - 2}" text-anchor="end">LOWEST · ALL ${values.length} BOTS</text></svg>`;
}

function whyMarkup(agent: RankedAgent): string {
  const chips = (Object.keys(relationLabels) as DeferenceRelation[])
    .filter((relation) => agent.received[relation] > 0)
    .map(
      (relation) =>
        `<span class="chip ${relation}">${relationLabels[relation]} ${agent.received[relation]}</span>`,
    )
    .join("");
  if (!chips) return `<span class="ranking-quiet">no incoming links</span>`;
  const from = agent.topDeferrers
    .map((entry) => `${escapeHtml(entry.id)} ${entry.weight}`)
    .join(" · ");
  return `<div class="chips">${chips}</div><small>MOST FROM ${from}</small>`;
}

function rowMarkup(agent: RankedAgent, report: HierarchyReport, maxPrestige: number): string {
  const width = Math.max(2, Math.round((agent.prestige / maxPrestige) * 100));
  return `<tr class="${agent.rank === undefined ? "unranked" : ""}">
    <td class="rank">${agent.rank === undefined ? "—" : `#${agent.rank}`}</td>
    <td><div class="bot"><span class="portrait" style="--bot-hue: ${agent.color}">${botPortraitSvg(`${report.seed}:${agent.id}`)}</span><span><strong>${escapeHtml(agent.name)}</strong><small>${escapeHtml(agent.id)}</small></span></div></td>
    <td><div class="prestige"><strong>${agent.prestige.toFixed(2)}</strong><span><i style="width: ${width}%"></i></span></div></td>
    <td><strong>${agent.received.deferrers}</strong> <small>BOTS · WEIGHT ${agent.received.weight}</small></td>
    <td class="why">${whyMarkup(agent)}</td>
    <td>${agent.given.targets} <small>BOTS · WEIGHT ${agent.given.weight}</small></td>
    <td>${agent.authored.artifacts} <small>ARTIFACTS</small><br>${agent.authored.skills} <small>SKILLS · ${agent.authored.skillUses} USES</small></td>
    <td class="muted">${agent.speech.heardBy} <small>BOTS</small></td>
  </tr>`;
}

function renderTable(report: HierarchyReport): void {
  const { metrics } = report;
  const ranked = report.agents.filter((agent) => agent.rank !== undefined).length;
  const insufficient = metrics.insufficient.concentration !== undefined;
  const fossils =
    metrics.fossilArtifacts || metrics.fossilSkills
      ? ` · COUNTS ${metrics.fossilArtifacts} ERODED ARTIFACTS, ${metrics.fossilSkills} EXTINCT SKILLS`
      : "";
  tableMeta.textContent =
    (insufficient
      ? "NO RANKING YET · INSUFFICIENT DATA"
      : `${ranked} RANKED · ${report.agents.length - ranked} AT THE FLOOR (${metrics.prestigeFloor.toFixed(2)})`) +
    fossils;
  distribution.innerHTML = distributionSvg(report);
  const evidence = report.agents.filter((agent) => agent.received.weight > 0);
  empty.hidden = !insufficient;
  if (insufficient)
    empty.innerHTML = `<strong>INSUFFICIENT DATA</strong><p>${escapeHtml(metrics.insufficient.concentration!)}. Ranking ${metrics.agents} bots on so little evidence would invent an order, so no bot gets a rank number yet.${evidence.length ? " The bots below have received deference so far." : " No bot has received deference yet."}</p>`;
  const visible = insufficient ? evidence : report.agents;
  const shown = showAllRows ? visible : visible.slice(0, COLLAPSED_ROWS);
  const maxPrestige = Math.max(1, ...report.agents.map((agent) => agent.prestige));
  rows.innerHTML = shown.map((agent) => rowMarkup(agent, report, maxPrestige)).join("");
  rows.closest(".ranking-table-wrap")!.toggleAttribute("hidden", shown.length === 0);
  moreButton.hidden = visible.length <= COLLAPSED_ROWS;
  moreButton.textContent = showAllRows
    ? `SHOW TOP ${COLLAPSED_ROWS}`
    : `SHOW ALL ${visible.length} BOTS`;
}

function render(report: HierarchyReport, history: HierarchyHistory | undefined): void {
  latest = { report, history };
  renderState();
  tickLabel.textContent = `TICK ${report.tick.toLocaleString()}`;
  renderSummary(report);
  verdict.innerHTML = verdictMarkup(report);
  renderHistory(history, report);
  renderTable(report);
}

async function fetchHierarchy(): Promise<HierarchyApiResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch("/api/hierarchy", {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
      throw new Error("API unavailable");
    return (await response.json()) as HierarchyApiResponse;
  } finally {
    window.clearTimeout(timeout);
  }
}

function stopFallback(): void {
  if (fallbackTimer) window.clearInterval(fallbackTimer);
  fallbackTimer = undefined;
  fallbackWorld = undefined;
}

function startFallback(): void {
  mode = "fallback";
  if (fallbackTimer) {
    renderState();
    return;
  }
  // Same seed and pace as the world view's fallback.
  fallbackWorld = createInitialWorld(260826081);
  advanceWorld(fallbackWorld, 360);
  render(computeHierarchy(fallbackWorld), undefined);
  fallbackTimer = window.setInterval(() => {
    if (!fallbackWorld) return;
    advanceWorld(fallbackWorld, 25);
    render(computeHierarchy(fallbackWorld), undefined);
  }, 2_000);
}

async function load(): Promise<void> {
  try {
    const data = await fetchHierarchy();
    stopFallback();
    mode = "authoritative";
    render(data.current, data.history);
  } catch {
    if (latest && mode !== "fallback" && mode !== "loading") {
      mode = "stale";
      renderState();
    } else startFallback();
  }
}

retryButton.addEventListener("click", () => {
  if (mode === "fallback") {
    stopFallback();
    mode = "loading";
    latest = undefined;
    renderState();
  }
  void load();
});
let resizeTimer: number | undefined;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (!latest) return;
    renderHistory(latest.history, latest.report);
    distribution.innerHTML = distributionSvg(latest.report);
  }, 150);
});
moreButton.addEventListener("click", () => {
  showAllRows = !showAllRows;
  if (latest) renderTable(latest.report);
});
window.setInterval(() => {
  if (mode === "authoritative" || mode === "stale") void load();
}, 30_000);

renderState();
void load();
